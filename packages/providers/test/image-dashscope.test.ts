/**
 * DashScope 文生图适配器测试：按模型族路由原生接口。
 *
 * mockFetch 模式断言端点、请求体结构、size 风格转换、
 * 两种响应形态（choices content[].image / results[].url）与错误处理。
 * 端点路由契约（实测钉死）：qwen-image → multimodal-generation；
 * wan/wanx（万相）→ text2image/image-synthesis——混用会 400 `url error`。
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
const TEXT2IMAGE_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis";

function provider(): DashScopeImageProvider {
  return new DashScopeImageProvider({ apiKey: "sk-test" });
}

test("generate：qwen-image 走 multimodal-generation，body 为 messages 结构，size 转 * 风格", async () => {
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

test("generate：wanx 万相走 text2image（input.prompt 而非 messages）；results[].url 解析", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({ output: { results: [{ url: "https://x/a.png" }, { url: "https://x/b.png" }] } }),
      { status: 200 },
    ),
  ]);
  const result = await provider().generate({
    model: "wanx2.1-t2i-turbo",
    prompt: "p",
    size: "1024x1024",
  });
  assert.equal(calls[0]!.url, TEXT2IMAGE_ENDPOINT, "万相必须走 text2image 同步端点");
  const body = JSON.parse(calls[0]!.body) as { model: string; input: { prompt?: string; messages?: unknown }; parameters: { size?: string } };
  assert.equal(body.model, "wanx2.1-t2i-turbo");
  assert.deepEqual(body.input, { prompt: "p" }, "万相请求体为 input.prompt 形态");
  assert.equal(body.parameters.size, "1024*1024");
  assert.equal(result.images.length, 2);
  assert.equal(result.images[1]!.url, "https://x/b.png");
});

test("generate：wan2.2-t2i-plus 同样路由到 text2image（修复 url error 的回归用例）", async () => {
  const calls = mockFetch([
    new Response(JSON.stringify({ output: { results: [{ url: "https://x/w.png" }] } }), { status: 200 }),
  ]);
  const result = await provider().generate({ model: "wan2.2-t2i-plus", prompt: "古风少女", size: "1024x1024" });
  assert.equal(calls[0]!.url, TEXT2IMAGE_ENDPOINT);
  const body = JSON.parse(calls[0]!.body) as { input: { prompt?: string; messages?: unknown } };
  assert.deepEqual(body.input, { prompt: "古风少女" });
  assert.deepEqual(result.images, [{ url: "https://x/w.png" }]);
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

test("generate：自定义 serviceBase（测试端点覆盖；qwen-image 走多模态路径）", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({ output: { choices: [{ message: { content: [{ image: "u" }] } }] } }),
      { status: 200 },
    ),
  ]);
  const p = new DashScopeImageProvider({ apiKey: "k", serviceBase: "http://localhost:9998/api/v1" });
  await p.generate({ model: "qwen-image", prompt: "p" });
  assert.equal(calls[0]!.url, "http://localhost:9998/api/v1/services/aigc/multimodal-generation/generation");
});

test("referenceImageSupport 声明 + 参考图注入：content 先 image 块后 text", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://x/out.png" }] } }] },
      }),
      { status: 200 },
    ),
  ]);
  const inst = provider();
  assert.equal(inst.referenceImageSupport, true);
  const result = await inst.generate({
    model: "qwen-image",
    prompt: "参照该角色形象生成画面",
    referenceImageUrls: ["https://ref/a.png", "https://ref/b.png"],
  });
  const body = JSON.parse(calls[0]!.body) as {
    input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> };
  };
  assert.deepEqual(body.input.messages[0]!.content, [
    { image: "https://ref/a.png" },
    { image: "https://ref/b.png" },
    { text: "参照该角色形象生成画面" },
  ]);
  assert.deepEqual(result.images, [{ url: "https://x/out.png" }]);
});

test("参考图仅接受 http(s)：本地文件路径被丢弃（避免 url error），qwen-image 降级纯文本", async () => {
  const calls = mockFetch([
    new Response(
      JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://x/out.png" }] } }] } }),
      { status: 200 },
    ),
  ]);
  await provider().generate({
    model: "qwen-image",
    prompt: "p",
    referenceImageUrls: ["ref_local_1.png", "file:///tmp/x.png", "https://ref/ok.png"],
  });
  const body = JSON.parse(calls[0]!.body) as {
    input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> };
  };
  assert.deepEqual(body.input.messages[0]!.content, [
    { image: "https://ref/ok.png" },
    { text: "p" },
  ]);
});
