/**
 * Image Provider 测试（文档 §13.2）：OpenAI 兼容图片端点。
 *
 * mockFetch 模式（与 provider-verify.test.ts 同款）：断言端点/method/头/body 与响应解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleImageProvider } from "../src/index";

function mockFetch(sequence: Array<Response | Error>): Array<{ url: string; method: string; headers: Headers; body: string }> {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, headers, body });
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

test("generate：POST {baseUrl}/images/generations，Bearer 头与 body 字段正确", async () => {
  const calls = mockFetch([
    jsonResponse(200, {
      created: 123,
      data: [{ url: "https://cdn.example.com/a.png", revised_prompt: "r1" }],
    }),
  ]);
  const provider = new OpenAICompatibleImageProvider({
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
    apiKey: "sk-test",
  });
  const result = await provider.generate({
    model: "wanx2.1-t2i-turbo",
    prompt: "雨夜的霓虹街头，国风",
    size: "1024x1024",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.headers.get("Authorization"), "Bearer sk-test");
  assert.equal(calls[0]!.headers.get("Content-Type"), "application/json");
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.model, "wanx2.1-t2i-turbo");
  assert.equal(body.prompt, "雨夜的霓虹街头，国风");
  assert.equal(body.n, 1);
  assert.equal(body.size, "1024x1024");

  assert.equal(result.images[0]?.url, "https://cdn.example.com/a.png");
  assert.equal(result.images[0]?.revisedPrompt, "r1");
  assert.equal(result.created, 123);
});

test("generate：b64_json 分支与无鉴权（apiKey 为空不带头）", async () => {
  const calls = mockFetch([
    jsonResponse(200, { data: [{ b64_json: "AAAA" }] }),
  ]);
  const provider = new OpenAICompatibleImageProvider({ baseUrl: "http://localhost:9999/v1" });
  const result = await provider.generate({ model: "m", prompt: "p" });
  assert.equal(result.images[0]?.b64Json, "AAAA");
  assert.equal(calls[0]!.headers.get("Authorization"), null);
});

test("generate：非 2xx 抛错（状态码与详情）", async () => {
  mockFetch([new Response("bad key detail", { status: 401 })]);
  const provider = new OpenAICompatibleImageProvider({ baseUrl: "https://x.com/v1", apiKey: "k" });
  await assert.rejects(
    provider.generate({ model: "m", prompt: "p" }),
    /401.*bad key detail/,
  );
});

test("generate：空 data 抛错；网络异常抛错", async () => {
  const provider = new OpenAICompatibleImageProvider({ baseUrl: "https://x.com/v1" });
  mockFetch([jsonResponse(200, { data: [] })]);
  await assert.rejects(provider.generate({ model: "m", prompt: "p" }), /no images/);
  mockFetch([new Error("network down")]);
  await assert.rejects(provider.generate({ model: "m", prompt: "p" }), /network down/);
});

test("构造：空 baseUrl 抛错", () => {
  assert.throws(() => new OpenAICompatibleImageProvider({ baseUrl: "  " }), /baseUrl is required/);
});
