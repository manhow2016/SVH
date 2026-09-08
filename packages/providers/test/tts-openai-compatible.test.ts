/**
 * OpenAI Compatible TTS 适配器测试：JSON { url } 与二进制音频两种响应形态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleTTSService } from "../src/index";

function collect(sequence: Array<Response | Error>): Array<{ url: string; body: string | null; auth: string | null }> {
  const calls: Array<{ url: string; body: string | null; auth: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    throw new Error("fetch failed（模拟网络异常）");
  }) as typeof fetch;
  return calls;
}

test("synthesize：JSON { url } 形态 → 直连远程 URL", async () => {
  const calls = collect([
    new Response(JSON.stringify({ url: "https://cdn/audio.mp3" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]);
  const svc = new OpenAICompatibleTTSService({ baseUrl: "http://gw/v1", apiKey: "sk-1" });
  const result = await svc.synthesize({ model: "tts-1", input: "你好，世界" });
  assert.equal(calls[0]!.url, "http://gw/v1/audio/speech");
  assert.equal(calls[0]!.auth, "Bearer sk-1");
  const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
  assert.equal(body.model, "tts-1");
  assert.equal(body.input, "你好，世界");
  assert.equal(result.url, "https://cdn/audio.mp3");
});

test("synthesize：二进制音频形态 → 转 base64 + contentType", async () => {
  collect([
    new Response(new Uint8Array([0x49, 0x44, 0x33]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }),
  ]);
  const svc = new OpenAICompatibleTTSService({ baseUrl: "http://gw/v1", apiKey: "sk-1" });
  const result = await svc.synthesize({ model: "tts-1", input: "hi", voice: "alloy" });
  assert.equal(result.b64Json, Buffer.from([0x49, 0x44, 0x33]).toString("base64"));
  assert.equal(result.contentType, "audio/mpeg");
});

test("synthesize：非 2xx 抛错携带状态码；baseUrl 缺失抛错", async () => {
  collect([new Response("bad key", { status: 401 })]);
  const svc = new OpenAICompatibleTTSService({ baseUrl: "http://gw/v1", apiKey: "sk-1" });
  await assert.rejects(svc.synthesize({ model: "tts-1", input: "x" }), /401/);

  const noBase = new OpenAICompatibleTTSService({});
  await assert.rejects(noBase.synthesize({ model: "tts-1", input: "x" }), /baseUrl 未配置/);
});
