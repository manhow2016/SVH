/**
 * Workflow 引擎纯逻辑测试（文档 §11 / §12）。
 *
 * 覆盖：拓扑排序与环检测、正常执行顺序、输入合并、失败重试、
 * 失败级联取消下游、暂停/恢复、取消。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowEngine,
  topoSort,
  resolveNodeInput,
  type NodeExecutor,
  type Workflow,
  type WorkflowNode,
  type WorkflowEvent,
} from "../src/index";

function makeWorkflow(nodes: WorkflowNode[]): Workflow {
  return { id: "wfl_1", projectId: "prj_1", status: "draft", nodes };
}

function node(id: string, dependsOn: string[] = [], maxRetries = 0): WorkflowNode {
  return {
    id,
    type: `${id}.generate`,
    name: id,
    status: "pending",
    dependsOn,
    retryCount: 0,
    maxRetries,
  };
}

async function collect(events: AsyncIterable<WorkflowEvent>): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

test("topoSort：正常拓扑与循环依赖检测", () => {
  const nodes = [node("script"), node("characters", ["script"]), node("scenes", ["script"]), node("storyboard", ["scenes", "characters"])];
  assert.deepEqual(topoSort(nodes), ["script", "characters", "scenes", "storyboard"]);
  assert.throws(() => topoSort([node("a", ["b"]), node("b", ["a"])]), /循环依赖/);
  assert.throws(() => topoSort([node("a", ["missing"])]), /不存在/);
  assert.throws(() => topoSort([node("a"), node("a")]), /重复/);
});

test("resolveNodeInput：显式 input 优先，单依赖取输出，多依赖按 id 合并", () => {
  const outputs = new Map<string, unknown>([
    ["script", { text: "剧本" }],
    ["scenes", { list: [1, 2] }],
  ]);
  assert.deepEqual(resolveNodeInput(node("x", [], 0), outputs), {});
  assert.deepEqual(resolveNodeInput(node("x", ["script"]), outputs), { text: "剧本" });
  const merged = resolveNodeInput(node("x", ["script", "scenes"]), outputs) as Record<string, unknown>;
  assert.deepEqual(merged, { script: { text: "剧本" }, scenes: { list: [1, 2] } });
  // 显式 input 优先级最高
  const explicit = resolveNodeInput({ ...node("x", ["script"]), input: { prompt: "直接输入" } }, outputs);
  assert.deepEqual(explicit, { prompt: "直接输入" });
});

test("正常执行：按拓扑顺序完成，事件序列正确", async () => {
  const workflow = makeWorkflow([
    node("script"),
    node("characters", ["script"]),
    node("storyboard", ["characters"]),
  ]);
  const order: string[] = [];
  const executor: NodeExecutor = {
    execute: async (n) => {
      order.push(n.id);
      return { from: n.id };
    },
  };
  const events = await collect(new WorkflowEngine().run(workflow, executor));
  assert.deepEqual(order, ["script", "characters", "storyboard"]);
  assert.equal(events[0]?.type, "workflow.started");
  assert.equal(events.at(-1)?.type, "workflow.completed");
  assert.equal(workflow.status, "completed");
  assert.ok(workflow.nodes.every((n) => n.status === "completed"));
  const completed = events.filter((e) => e.type === "node.completed");
  assert.equal(completed.length, 3);
});

test("节点失败重试：第 1 次失败、第 2 次成功 → 重试事件后 completed", async () => {
  const workflow = makeWorkflow([node("script", [], 1)]);
  let calls = 0;
  const executor: NodeExecutor = {
    execute: async () => {
      calls += 1;
      if (calls === 1) throw new Error("第一次失败");
      return { ok: true };
    },
  };
  const events = await collect(new WorkflowEngine().run(workflow, executor));
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === "node.retrying"), "应发出重试事件");
  assert.equal(workflow.status, "completed");
  assert.equal(workflow.nodes[0]?.retryCount, 1);
});

test("重试耗尽：节点 failed，下游级联 cancelled，工作流 failed", async () => {
  const workflow = makeWorkflow([node("script", [], 0), node("storyboard", ["script"])]);
  const executor: NodeExecutor = {
    execute: async (n) => {
      if (n.id === "script") throw new Error("脚本失败");
      return { ok: true };
    },
  };
  const events = await collect(new WorkflowEngine().run(workflow, executor));
  assert.equal(events.at(-1)?.type, "workflow.failed");
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.nodes[0]?.status, "failed");
  assert.equal(workflow.nodes[1]?.status, "cancelled", "依赖失败的节点被级联取消");
  assert.ok(events.some((e) => e.type === "node.cancelled" && e.nodeId === "storyboard"));
});

test("暂停/恢复：暂停后节点边界阻塞，恢复后继续执行", async () => {
  const workflow = makeWorkflow([node("a"), node("b", ["a"])]);
  const engine = new WorkflowEngine();
  const started: string[] = [];
  const executor: NodeExecutor = {
    execute: async (n) => {
      started.push(n.id);
      return { ok: n.id };
    },
  };
  engine.pause();
  const run = collect(engine.run(workflow, executor));
  // 暂停期间给事件循环一个机会：a 不应开始
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(started, [], "暂停期间节点不应开始执行");
  engine.resume();
  const events = await run;
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(workflow.status, "completed");
  assert.ok(events.some((e) => e.type === "workflow.resumed") === false, "resume 事件由服务层发出，引擎不生成");
});

test("取消：正在执行的节点被 abort，未完成节点标记 cancelled", async () => {
  const workflow = makeWorkflow([node("a"), node("b", ["a"])]);
  const engine = new WorkflowEngine();
  const executor: NodeExecutor = {
    execute: async (n, _input, signal) => {
      if (n.id === "a") {
        // 模拟长任务：等待 100ms，期间可被 abort
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 100);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(undefined);
          });
        });
        if (signal?.aborted) throw new Error("aborted");
        return { ok: "a" };
      }
      return { ok: "b" };
    },
  };
  const run = collect(engine.run(workflow, executor));
  await new Promise((resolve) => setTimeout(resolve, 30));
  engine.cancel();
  const events = await run;
  assert.equal(workflow.status, "cancelled");
  assert.equal(events.at(-1)?.type, "workflow.cancelled");
  assert.ok(events.some((e) => e.type === "node.cancelled" && e.nodeId === "b"), "未运行节点应被取消");
});

test("重跑：已完成节点跳过并复用输出，仅执行未完成节点", async () => {
  const workflow = makeWorkflow([node("a"), node("b", ["a"])]);
  workflow.nodes[0] = { ...workflow.nodes[0]!, status: "completed", output: { from: "a" } };
  const executed: string[] = [];
  const executor: NodeExecutor = {
    execute: async (n) => {
      executed.push(n.id);
      return { from: n.id };
    },
  };
  const events = await collect(new WorkflowEngine().run(workflow, executor));
  assert.deepEqual(executed, ["b"]);
  assert.equal(workflow.status, "completed");
  assert.ok(events.some((e) => e.type === "node.completed" && e.nodeId === "b"));
});
