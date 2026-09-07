/**
 * AgentRunService 自动串联 glue 测试。
 *
 * 用假 Runtime 驱动事件流，验证：
 * - create_project 成功 + run.completed 且 profile=director → 触发 autoPipeline.maybeStart；
 * - tool 失败 / run.error → 不触发；
 * - maybeStart 参数携带正确的 profileId/projectIds/userId/sessionId/story。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@svh/core";
import { AgentRunService, type AgentRunDeps } from "./run-service";
import type { AutoPipelineParams } from "./auto-pipeline";

const SESSION = { id: "ses_1", workspaceId: "ws_1", status: "idle" } as never;

function makeDeps(
  events: AgentEvent[],
  opts: { onAuto?: (p: AutoPipelineParams) => void } = {},
): AgentRunDeps {
  const runtime = {
    async *run() {
      for (const e of events) yield e;
    },
  };
  const sessionService = {
    async get() {
      return SESSION;
    },
    async setStatus() {},
    async addAssistantMessage() {
      return { id: "msg_1" };
    },
    async addToolCallToAssistant() {},
    async addToolMessage() {},
  };
  const autoPipeline = {
    async maybeStart(p: AutoPipelineParams) {
      opts.onAuto?.(p);
    },
  };
  return {
    runtime: runtime as never,
    sessionService: sessionService as never,
    workspaceService: { async getOwned() {} } as never,
    settingsService: {
      async getEffectiveModelConfig() {
        return { providerId: "mock", baseUrl: "http://x/v1", apiKey: "", model: "m" };
      },
    } as never,
    membershipService: { async assertFeature() {} } as never,
    providerRegistry: { register() {} } as never,
    autoPipeline: autoPipeline as never,
    log: { info: () => {}, error: () => {} },
  };
}

function fakeRequest() {
  const raw = { on: () => {}, removeListener: () => {} };
  return { raw } as never;
}

function fakeReply() {
  const raw = {
    writableEnded: true, // 让 writeSSE 跳过（无真实 socket）
    destroyed: false,
    writeHead: () => {},
    write: () => {},
    end: () => {},
  };
  return {
    hijack: () => {},
    raw,
  } as never;
}

async function runStream(deps: AgentRunDeps): Promise<void> {
  await new AgentRunService(deps).streamRun(
    "ses_1",
    "拍一部仙侠短剧",
    "usr_1",
    fakeRequest(),
    fakeReply(),
    "director",
  );
  // maybeStart 为 fire-and-forget：等宏任务排空
  await new Promise((resolve) => setImmediate(resolve));
}

test("glue: director 建项成功且 run 完成 → 触发自动串联并透传参数", async () => {
  const seen: AutoPipelineParams[] = [];
  const events = [
    { type: "tool.completed", toolCallId: "tc1", toolName: "create_project", output: { id: "prj_42" } },
    { type: "run.completed" },
  ] as AgentEvent[];
  await runStream(makeDeps(events, { onAuto: (p) => seen.push(p) }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.profileId, "director");
  assert.deepEqual(seen[0]!.projectIds, ["prj_42"]);
  assert.equal(seen[0]!.userId, "usr_1");
  assert.equal(seen[0]!.workspaceId, "ws_1");
  assert.equal(seen[0]!.sessionId, "ses_1");
  assert.equal(seen[0]!.story, "拍一部仙侠短剧");
});

test("glue: create_project 失败输出（{error}）→ 不触发", async () => {
  let called = false;
  const events = [
    { type: "tool.completed", toolCallId: "tc1", toolName: "create_project", output: { error: "名称重复" } },
    { type: "run.completed" },
  ] as AgentEvent[];
  await runStream(makeDeps(events, { onAuto: () => (called = true) }));
  assert.equal(called, false);
});

test("glue: run.error 终止 → 不触发自动串联", async () => {
  let called = false;
  const events = [
    { type: "tool.completed", toolCallId: "tc1", toolName: "create_project", output: { id: "prj_42" } },
    { type: "run.error", error: "boom" },
  ] as AgentEvent[];
  await runStream(makeDeps(events, { onAuto: () => (called = true) }));
  assert.equal(called, false);
});
