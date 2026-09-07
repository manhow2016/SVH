/**
 * DashScope 视频适配器测试（文档 §14 异步任务接口）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DashScopeVideoProvider } from "../src/index";

const SERVICE_BASE = "https://dashscope.aliyuncs.com/api/v1";

function mockFetch(sequence: Array<Response | Error>): Array<{ url: string; method: string; headers: Headers; body: string }> {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error("fetch failed（模拟网络异常）");
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), { status });
}

test("createTask：文生视频端点 + X-DashScope-Async 头 + input.prompt body", async () => {
  const calls = mockFetch([jsonResponse(200, { output: { task_id: "task-1" } })]);
  const provider = new DashScopeVideoProvider({ apiKey: "sk-dash", serviceBase: SERVICE_BASE });
  const result = await provider.createTask({ model: "wanx2.1-t2v-turbo", prompt: "奔跑的赛车" });

  assert.equal(calls[0]!.url, `${SERVICE_BASE}/services/aigc/video-generation/video-synthesis`);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers.get("X-DashScope-Async"), "enable");
  assert.equal(calls[0]!.headers.get("Authorization"), "Bearer sk-dash");
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.model, "wanx2.1-t2v-turbo");
  assert.equal((body.input as Record<string, unknown>).prompt, "奔跑的赛车");
  assert.equal(result.providerTaskId, "task-1");
});

test("createTask：提供 imageUrl 时走图生视频请求（同端点，input.img_url）", async () => {
  const calls = mockFetch([jsonResponse(200, { output: { task_id: "task-2" } })]);
  const provider = new DashScopeVideoProvider({ apiKey: "k" });
  await provider.createTask({
    model: "wanx2.1-i2v-turbo",
    prompt: "让画面动起来",
    imageUrl: "https://cdn.example.com/frame.png",
    duration: 5,
    resolution: "1280*720",
  });
  assert.equal(
    calls[0]!.url,
    `${SERVICE_BASE}/services/aigc/video-generation/video-synthesis`,
  );
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.deepEqual(body.input, { img_url: "https://cdn.example.com/frame.png", prompt: "让画面动起来" });
  assert.deepEqual(body.parameters, { duration: 5, size: "1280*720" });
});

test("createTask：resolution 档位（480P/720P/1080P）自动转换为官方 宽*高 size", async () => {
  for (const [res, expected] of [
    ["480P", "832*480"],
    ["720P", "1280*720"],
    ["1080P", "1920*1080"],
  ] as const) {
    const calls = mockFetch([jsonResponse(200, { output: { task_id: "t" } })]);
    const provider = new DashScopeVideoProvider({ apiKey: "k" });
    await provider.createTask({ model: "wanx2.1-t2v-turbo", prompt: "p", resolution: res });
    const body = JSON.parse(calls[0]!.body) as { parameters: { size: string } };
    assert.equal(body.parameters.size, expected, `resolution=${res}`);
  }
});

test("getTask：状态映射 PENDING/RUNNING/SUCCEEDED/FAILED", async () => {
  const calls = mockFetch([
    jsonResponse(200, { output: { task_id: "t", task_status: "PENDING" } }),
    jsonResponse(200, { output: { task_id: "t", task_status: "RUNNING" } }),
    jsonResponse(200, { output: { task_id: "t", task_status: "SUCCEEDED", results: [{ url: "https://cdn.example.com/v.mp4" }] } }),
    jsonResponse(200, { output: { task_id: "t", task_status: "FAILED", message: "内容审核未通过" } }),
  ]);
  const provider = new DashScopeVideoProvider({ apiKey: "k" });

  assert.equal((await provider.getTask("t")).status, "queued");
  assert.equal((await provider.getTask("t")).status, "running");
  const done = await provider.getTask("t");
  assert.equal(done.status, "completed");
  assert.equal(done.outputUrl, "https://cdn.example.com/v.mp4");
  const failed = await provider.getTask("t");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "内容审核未通过");
  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `${SERVICE_BASE}/tasks/t`);
});

test("cancelTask：POST /tasks/{id}/cancel", async () => {
  const calls = mockFetch([new Response("{}", { status: 200 })]);
  const provider = new DashScopeVideoProvider({ apiKey: "k" });
  await provider.cancelTask("t-9");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${SERVICE_BASE}/tasks/t-9/cancel`);
});

test("createTask：缺少 task_id 抛错；非 2xx 抛错", async () => {
  const provider = new DashScopeVideoProvider({ apiKey: "k" });
  mockFetch([jsonResponse(200, { message: "rate limited" })]);
  await assert.rejects(provider.createTask({ model: "m", prompt: "p" }), /创建视频任务失败/);
  mockFetch([new Response("forbidden", { status: 403 })]);
  await assert.rejects(provider.createTask({ model: "m", prompt: "p" }), /403/);
});
