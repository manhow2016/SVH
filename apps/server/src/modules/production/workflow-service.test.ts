/**
 * WorkflowService 集成测试（文档 §11 / §15 / §20）。
 *
 * 真实 SQLite 临时库 + 假节点执行器（注入 executorFactory），
 * 验证：默认 DAG 创建、执行完成、暂停/恢复、取消、失败重试、状态机约束。
 */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { DrizzleProductionRepository, ProductionService } from "@svh/production";
import type { WorkflowNode } from "@svh/core";
import { WorkflowService, type WorkflowRunContext } from "./workflow-service";

let dir: string;
let db: SVHDatabase;
let production: ProductionService;
let projectId: string;
let userId: string;
let ctxWorkspaceId: string;
let service: WorkflowService;

/** 假执行器行为控制 */
const behavior = {
  /** 指定节点抛错（nodeId → Error message） */
  fail: new Map<string, string>(),
  /** 指定节点阻塞（nodeId → { promise, release }） */
  block: new Map<string, { promise: Promise<void>; release: () => void }>(),
};

/** 注册阻塞器，返回释放函数（调用后执行器放行该节点） */
function setBlocker(nodeId: string): () => void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  behavior.block.set(nodeId, { promise, release });
  return () => behavior.block.get(nodeId)?.release();
}

const fakeExecutorFactory = (_ctx: WorkflowRunContext) => ({
  async execute(node: WorkflowNode) {
    const failMsg = behavior.fail.get(node.id);
    if (failMsg) throw new Error(failMsg);
    const blocker = behavior.block.get(node.id);
    if (blocker) {
      await blocker.promise;
      behavior.block.delete(node.id);
    }
    return { node: node.id, ok: true };
  },
});

function makeContext(): WorkflowRunContext {
  return {
    sessionId: randomId("ses"),
    workspaceId: ctxWorkspaceId,
    userId,
    modelConfig: {
      providerId: "openai-compatible",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "k",
      model: "mock",
    },
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "svh-workflow-"));
  db = createDatabase(join(dir, "test.db"));
  userId = randomId("usr");
  db.insert(users)
    .values({
      id: userId,
      username: "wf-user",
      email: "wf-user@test.local",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  ctxWorkspaceId = randomId("ws");
  db.insert(workspaces)
    .values({
      id: ctxWorkspaceId,
      name: "wf-ws",
      rootPath: join(dir, ctxWorkspaceId),
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  production = new ProductionService(new DrizzleProductionRepository(db));
  service = new WorkflowService({
    db,
    log: { info: () => {}, error: () => {} },
    executorFactory: fakeExecutorFactory,
  });
});

beforeEach(() => {
  behavior.fail.clear();
  behavior.block.clear();
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 轮询等待工作流进入目标状态 */
async function waitStatus(id: string, statuses: string[], timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const wf = (await service.getWorkflow(id)) as { status: string };
    if (statuses.includes(wf.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const wf = (await service.getWorkflow(id)) as { status: string };
  throw new Error(`等待工作流状态超时（当前 ${wf.status}，期望 ${statuses.join("/")}）`);
}

test("createWorkflow：默认生产 DAG 创建成功，story 注入首个节点 prompt", async () => {
  projectId = (await production.createProject({ workspaceId: ctxWorkspaceId, name: "工作流项目" })).id;
  const wf = (await service.createWorkflow(projectId, userId, {
    story: "把这篇故事做成 2 分钟国风短剧",
  })) as {
    id: string;
    status: string;
    nodes: Array<{ id: string; status: string; dependsOn: string[]; input?: unknown }>;
  };
  assert.equal(wf.status, "draft");
  assert.deepEqual(
    wf.nodes.map((n) => n.id).sort(),
    ["characters", "scenes", "script", "storyboard"],
  );
  assert.deepEqual(wf.nodes[0]!.dependsOn, []);
  assert.deepEqual((wf.nodes[0]!.input as { prompt?: string }).prompt, "把这篇故事做成 2 分钟国风短剧");
});

test("createWorkflow：自定义节点含循环依赖被拒绝", async () => {
  await assert.rejects(
    service.createWorkflow(projectId, userId, {
      nodes: [
        { id: "a", type: "x", name: "a", dependsOn: ["b"] },
        { id: "b", type: "y", name: "b", dependsOn: ["a"] },
      ],
    }),
    /循环依赖|不合法/,
  );
});

test("runWorkflow：后台执行完成后全部节点 completed 且输出落库", async () => {
  const wf = (await service.createWorkflow(projectId, userId)) as { id: string };
  await service.runWorkflow(wf.id, makeContext());
  await waitStatus(wf.id, ["completed"]);
  const detail = (await service.getWorkflow(wf.id)) as {
    status: string;
    nodes: Array<{ id: string; status: string; output?: unknown }>;
  };
  assert.equal(detail.status, "completed");
  assert.ok(detail.nodes.every((n) => n.status === "completed"));
  const script = detail.nodes.find((n) => n.id === "script")!;
  assert.equal((script.output as { node: string }).node, "script", "节点输出应持久化");
});

test("暂停/恢复：运行中暂停后恢复直至完成", async () => {
  const wf = (await service.createWorkflow(projectId, userId)) as { id: string };
  const release = setBlocker("script");
  await service.runWorkflow(wf.id, makeContext());
  await waitStatus(wf.id, ["running"]);
  await service.pauseWorkflow(wf.id);
  assert.equal((await service.getWorkflow(wf.id) as { status: string }).status, "paused");
  await service.resumeWorkflow(wf.id);
  release();
  await waitStatus(wf.id, ["completed"]);
});

test("取消：运行中取消 → 工作流 cancelled，未执行节点 cancelled", async () => {
  const wf = (await service.createWorkflow(projectId, userId)) as { id: string };
  const release = setBlocker("script");
  await service.runWorkflow(wf.id, makeContext());
  await waitStatus(wf.id, ["running"]);
  await service.cancelWorkflow(wf.id);
  release();
  await waitStatus(wf.id, ["cancelled", "failed"]);
  const detail = (await service.getWorkflow(wf.id)) as { status: string; nodes: Array<{ id: string; status: string }> };
  for (const node of detail.nodes) {
    if (node.id !== "script") {
      assert.equal(node.status, "cancelled", `节点 ${node.id} 应被取消`);
    }
  }
});

test("失败重试：script 失败 → storyboard 级联取消 → retry 后全部完成", async () => {
  const wf = (await service.createWorkflow(projectId, userId)) as { id: string };
  behavior.fail.set("script", "脚本生成失败");
  await service.runWorkflow(wf.id, makeContext());
  await waitStatus(wf.id, ["failed"]);
  const failed = (await service.getWorkflow(wf.id)) as {
    status: string;
    nodes: Array<{ id: string; status: string; error?: string }>;
  };
  assert.equal(failed.status, "failed");
  assert.equal(failed.nodes.find((n) => n.id === "script")?.status, "failed");
  assert.equal(failed.nodes.find((n) => n.id === "storyboard")?.status, "cancelled");
  behavior.fail.delete("script");
  await service.retryNode(wf.id, "script");
  await waitStatus(wf.id, ["completed", "failed"]);
  const done = (await service.getWorkflow(wf.id)) as { status: string; nodes: Array<{ id: string; status: string }> };
  assert.equal(done.status, "completed");
  assert.ok(done.nodes.every((n) => n.status === "completed"));
});

test("状态机约束：completed 工作流不可再运行；未运行不可暂停/取消", async () => {
  const wf = (await service.createWorkflow(projectId, userId)) as { id: string };
  await service.runWorkflow(wf.id, makeContext());
  await waitStatus(wf.id, ["completed"]);
  await assert.rejects(service.runWorkflow(wf.id, makeContext()), /不可运行/);
  await assert.rejects(service.pauseWorkflow(wf.id), /未在运行/);
  await assert.rejects(service.cancelWorkflow(wf.id), /未在运行/);
});
