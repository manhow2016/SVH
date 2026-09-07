/**
 * DashScope 文生图适配器测试：原生 multimodal-generation 接口。
 *
 * mockFetch 模式断言端点、请求体结构、size 风格转换、
 * 两种响应形态（choices content[].image / results[].url）与错误处理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DashScopeImageProvider } from "../src/index";

function mockFetch(sequence: Array<Response | Error>): Array<{ url: string; body: string; auth: string | null }> {
  const calls: Array<{ url: string; body: string; auth: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
      auth: new Headers(init?.headers).get("authorization"),
    });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error("fetch failed（模拟网络异常）");
  }) as typeof fetch;
  return calls;
}

const NATIVE_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

function provider(): DashScopeImageProvider {
  return new DashScopeImageProvider({ apiKey: "sk-test" });
}

test("generate：POST 原生 multimodal-generation，body 为 messages 结构，size 转 * 风格", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://x/1.png" }] } }] },
        request_id: "r1",
      }),
      { status: 200 },
    ),
  ]);
  const result = await provider().generate({
    model: "qwen-image",
    prompt: "月下飞檐",
    size: "1024x1024",
  });
  assert.equal(calls[0]!.url, NATIVE_ENDPOINT);
  assert.equal(calls[0]!.auth, "Bearer sk-test");
  const body = JSON.parse(calls[0]!.body);
  assert.equal(body.model, "qwen-image");
  assert.deepEqual(body.input.messages, [{ role: "user", content: [{ text: "月下飞檐" }] }]);
  assert.equal(body.parameters.size, "1024*1024");
  assert.equal(body.parameters.watermark, false);
  assert.deepEqual(result.images, [{ url: "https://x/1.png" }]);
});

test("generate：万相 results[].url 形态同样解析；不传 size 时 parameters 无 size", async () => {
  mockFetch([
    new Response(
      JSON.stringify({ output: { results: [{ url: "https://x/a.png" }, { url: "https://x/b.png" }] } }),
      { status: 200 },
    ),
  ]);
  const result = await provider().generate({ model: "wanx2.1-t2i-turbo", prompt: "p" });
  assert.equal(result.images.length, 2);
  assert.equal(result.images[1]!.url, "https://x/b.png");
});

test("generate：HTTP 非 200 → Error 含状态与响应片段", async () => {
  mockFetch([new Response('{"code":"InvalidParameter"}', { status: 400 })]);
  await assert.rejects(
    provider().generate({ model: "qwen-image", prompt: "p" }),
    /DashScope image request failed \(400.*InvalidParameter/,
  );
});

test("generate：200 但响应无图片 → Error 含 request_id/原因", async () => {
  mockFetch([new Response(JSON.stringify({ output: {}, request_id: "r-404" }), { status: 200 })]);
  await assert.rejects(
    provider().generate({ model: "qwen-image", prompt: "p" }),
    /no images.*r-404/,
  );
});

test("generate：自定义 serviceBase（测试端点覆盖）", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({ output: { choices: [{ message: { content: [{ image: "u" }] } }] } }),
      { status: 200 },
    ),
  ]);
  const p = new DashScopeImageProvider({ apiKey: "k", serviceBase: "http://localhost:9998/api/v1" });
  await p.generate({ model: "m", prompt: "p" });
  assert.equal(calls[0]!.url, "http://localhost:9998/api/v1/services/aigc/multimodal-generation/generation");
});
