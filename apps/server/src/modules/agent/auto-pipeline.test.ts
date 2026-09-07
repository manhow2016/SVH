/**
 * Chat → Workflow 自动串联单测（文档 §9 Director + §11 Workflow 衔接）。
 *
 * 使用假 WorkflowService / MembershipService，验证触发条件与门控：
 * - 仅 Director + 成功建项触发；
 * - 免费用户（无 workflow.automation）静默跳过；
 * - 项目已有工作流不重复创建；
 * - 任何异常吞掉不外抛。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "@svh/providers";
import {
  AutoPipelineService,
  extractCreatedProjectId,
  type AutoPipelineDeps,
  type AutoPipelineParams,
} from "./auto-pipeline";

// ---------- 假实现 ----------

interface CreateCall {
  projectId: string;
  story?: string;
}
interface WorkflowCalls {
  list: string[];
  create: CreateCall[];
  run: Array<{ id: string; sessionId: string; userId: string }>;
}

function fakeWorkflow(opts: { existing?: number; createFails?: boolean } = {}) {
  const calls: WorkflowCalls = { list: [], create: [], run: [] };
  const service = {
    async listWorkflows(projectId: string) {
      calls.list.push(projectId);
      return Array.from({ length: opts.existing ?? 0 }, (_, i) => ({ id: `wfl_${i}` }));
    },
    async createWorkflow(projectId: string, _userId: string, options: { story?: string }) {
      if (opts.createFails) throw new Error("create boom");
      calls.create.push({ projectId, story: options.story });
      return { id: "wfl_new" };
    },
    async runWorkflow(id: string, ctx: { sessionId: string; userId: string }) {
      calls.run.push({ id, sessionId: ctx.sessionId, userId: ctx.userId });
      return { id, status: "queued" };
    },
  };
  return { service: service as never, calls };
}

function fakeMembership(allowsFeature: boolean) {
  return {
    async assertFeature(_userId: string, feature: string) {
      if (allowsFeature) return;
      throw new Error(`FEATURE_NOT_AVAILABLE: ${feature}`);
    },
  } as never;
}

const MODEL_CONFIG = {
  providerId: "mock",
  baseUrl: "http://x/v1",
  apiKey: "",
  model: "m",
} as unknown as ModelConfig;

function baseParams(over: Partial<AutoPipelineParams> = {}): AutoPipelineParams {
  return {
    profileId: "director",
    projectIds: ["prj_1"],
    userId: "usr_1",
    workspaceId: "ws_1",
    sessionId: "ses_1",
    modelConfig: MODEL_CONFIG,
    story: "拍一部仙侠短剧",
    ...over,
  };
}

function build(
  workflow: { service: never; calls: WorkflowCalls },
  allowsFeature = true,
): { svc: AutoPipelineService; errors: Record<string, unknown>[] } {
  const errors: Record<string, unknown>[] = [];
  const deps: AutoPipelineDeps = {
    workflowService: workflow.service,
    membershipService: fakeMembership(allowsFeature),
    log: {
      info: () => {},
      error: (obj) => errors.push(obj),
    },
  };
  return { svc: new AutoPipelineService(deps), errors };
}

// ---------- extractCreatedProjectId ----------

test("extractCreatedProjectId: create_project 成功输出 → 提取项目 id", () => {
  assert.equal(extractCreatedProjectId("create_project", { id: "prj_9", name: "x" }), "prj_9");
});

test("extractCreatedProjectId: create_project 失败输出（{error}）→ null", () => {
  assert.equal(extractCreatedProjectId("create_project", { error: "boom" }), null);
});

test("extractCreatedProjectId: 其他工具 / 无 id / 非对象 / 空输出 → null", () => {
  assert.equal(extractCreatedProjectId("get_project", { id: "prj_1" }), null);
  assert.equal(extractCreatedProjectId("create_project", { name: "无 id" }), null);
  assert.equal(extractCreatedProjectId("create_project", undefined), null);
  assert.equal(extractCreatedProjectId("create_project", null), null);
  assert.equal(extractCreatedProjectId("create_project", "字符串"), null);
});

// ---------- AutoPipelineService.maybeStart ----------

test("maybeStart: Director 建项成功 → 自动创建并启动工作流（复用当前会话）", async () => {
  const wf = fakeWorkflow();
  const { svc } = build(wf);
  await svc.maybeStart(baseParams());
  assert.deepEqual(wf.calls.create, [{ projectId: "prj_1", story: "拍一部仙侠短剧" }]);
  assert.deepEqual(wf.calls.run, [{ id: "wfl_new", sessionId: "ses_1", userId: "usr_1" }]);
});

test("maybeStart: 多个项目 → 只对最后一个串联", async () => {
  const wf = fakeWorkflow();
  const { svc } = build(wf);
  await svc.maybeStart(baseParams({ projectIds: ["prj_a", "prj_b"] }));
  assert.deepEqual(wf.calls.create, [{ projectId: "prj_b", story: "拍一部仙侠短剧" }]);
});

test("maybeStart: 非 Director / 无 profile / 无项目 → 不触发", async () => {
  const wf = fakeWorkflow();
  const { svc } = build(wf);
  await svc.maybeStart(baseParams({ profileId: "script" }));
  await svc.maybeStart(baseParams({ profileId: undefined }));
  await svc.maybeStart(baseParams({ projectIds: [] }));
  assert.equal(wf.calls.create.length, 0);
  assert.equal(wf.calls.run.length, 0);
});

test("maybeStart: 免费用户（无 workflow.automation）→ 静默跳过且不抛错", async () => {
  const wf = fakeWorkflow();
  const { svc, errors } = build(wf, false);
  await svc.maybeStart(baseParams());
  assert.equal(wf.calls.create.length, 0);
  assert.equal(errors.length, 0); // 门控跳过属于正常路径，不算错误
});

test("maybeStart: 项目已有工作流 → 不重复创建", async () => {
  const wf = fakeWorkflow({ existing: 1 });
  const { svc } = build(wf);
  await svc.maybeStart(baseParams());
  assert.deepEqual(wf.calls.list, ["prj_1"]);
  assert.equal(wf.calls.create.length, 0);
  assert.equal(wf.calls.run.length, 0);
});

test("maybeStart: 内部异常 → 吞掉并记日志，不外抛", async () => {
  const wf = fakeWorkflow({ createFails: true });
  const { svc, errors } = build(wf);
  await svc.maybeStart(baseParams()); // 不应抛
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { error?: string }).error, "create boom");
});
