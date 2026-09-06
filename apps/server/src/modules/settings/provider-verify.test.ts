import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyOpenAICompatibleKey } from "./provider-verify";

/** 构造 mock Response（node 18+ 全局 Response 可直接 new） */
function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({}), { status });
}

/** 覆盖全局 fetch：按调用顺序返回预设响应；无响应时抛错（模拟网络异常） */
function mockFetch(sequence: Response[] | Error[] = []): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error("fetch failed（模拟网络异常）");
  }) as typeof fetch;
  return calls;
}

test("GET /models 200 → 验证通过", async () => {
  const calls = mockFetch([jsonResponse(200)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1/",
    apiKey: "test-key",
    minDurationMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://localhost:9999/v1/models");
  assert.equal(calls[0]!.method, "GET");
});

test("GET /models 401 → Key 无效", async () => {
  mockFetch([jsonResponse(401)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "bad-key",
    minDurationMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_key");
});

test("端点不支持 /models（404）→ 降级 chat 成功", async () => {
  const calls = mockFetch([jsonResponse(404), jsonResponse(200)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "key",
    chatModelName: "deepseek-v3-250528",
    minDurationMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, "http://localhost:9999/v1/chat/completions");
  assert.equal(calls[1]!.method, "POST");
});

test("降级 chat 401 → Key 无效", async () => {
  mockFetch([jsonResponse(404), jsonResponse(401)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "bad-key",
    chatModelName: "qwen-max",
    minDurationMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_key");
});

test("端点不支持 /models 且无模型名 → unsupported（不发起 chat 请求）", async () => {
  const calls = mockFetch([jsonResponse(404)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "key",
    minDurationMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported");
  assert.equal(calls.length, 1);
});

test("网络异常 → network", async () => {
  mockFetch([]); // 无预设响应 → fetch 抛错（模拟网络异常）
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "key",
    minDurationMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "network");
});

test("chat 降级其他状态（500）→ network", async () => {
  mockFetch([jsonResponse(404), jsonResponse(500)]);
  const result = await verifyOpenAICompatibleKey({
    baseUrl: "http://localhost:9999/v1",
    apiKey: "key",
    chatModelName: "m",
    minDurationMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "network");
});
