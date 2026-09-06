/**
 * 视频任务轮询测试（文档 §14：pollVideoTask 纯函数）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollVideoTask, type VideoProvider, type VideoTask } from "../src/index";

function fakeProvider(sequence: VideoTask[]): VideoProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fake",
    calls,
    async createTask() {
      return { providerTaskId: "t" };
    },
    async getTask() {
      const next = sequence.shift();
      if (!next) {
        // 序列耗尽时保持 running（支持超时/中止场景）
        calls.push("running");
        return { id: "", providerTaskId: "t", status: "running" };
      }
      calls.push(next.status);
      return next;
    },
    async cancelTask() {
      calls.push("cancel");
    },
  };
}

test("pollVideoTask：queued→running→completed 依次轮询并返回终态", async () => {
  const provider = fakeProvider([
    { id: "", providerTaskId: "t", status: "queued" },
    { id: "", providerTaskId: "t", status: "running" },
    { id: "", providerTaskId: "t", status: "completed", outputUrl: "https://cdn.example.com/v.mp4" },
  ]);
  const progresses: string[] = [];
  const result = await pollVideoTask(provider, "t", {
    intervalMs: 1,
    onProgress: (task) => progresses.push(task.status),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.outputUrl, "https://cdn.example.com/v.mp4");
  assert.deepEqual(progresses, ["queued", "running", "completed"]);
});

test("pollVideoTask：超时抛错", async () => {
  const provider = fakeProvider([{ id: "", providerTaskId: "t", status: "running" }]);
  await assert.rejects(
    pollVideoTask(provider, "t", { intervalMs: 1, timeoutMs: 30 }),
    /timed out/,
  );
});

test("pollVideoTask：signal 中止抛错", async () => {
  const controller = new AbortController();
  const provider = fakeProvider([{ id: "", providerTaskId: "t", status: "running" }]);
  const promise = pollVideoTask(provider, "t", { intervalMs: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /aborted/);
});
