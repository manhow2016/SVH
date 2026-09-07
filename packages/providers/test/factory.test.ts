/**
 * 供应商路由工厂测试：dashscope → 原生适配器；其余图片 → OpenAI 兼容；非 dashscope 视频 → 抛错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createImageProvider, createVideoProvider } from "../src/index";

const config = { providerId: "x", model: "m", baseUrl: "https://example.com/v1", apiKey: "k" };

test("createImageProvider：dashscope 走原生适配器，其余走 OpenAI 兼容", () => {
  assert.equal(createImageProvider({ providerId: "dashscope", config }).id, "dashscope-image");
  assert.equal(
    createImageProvider({ providerId: "volcengine", config }).id,
    "openai-compatible-image",
  );
});

test("createVideoProvider：仅 dashscope；其他供应商明确报错", () => {
  assert.equal(createVideoProvider({ providerId: "dashscope", config }).id, "dashscope-async");
  assert.throws(
    () => createVideoProvider({ providerId: "volcengine", config }),
    /仅支持百炼/,
  );
});
