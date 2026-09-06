import { test } from "node:test";
import assert from "node:assert/strict";
import { getProviderMeta, resolveRuntimeBaseUrl } from "./model-catalog";

test("用户配置了供应商 Key → 使用供应商真实端点（忽略 env 端点覆盖）", () => {
  const provider = getProviderMeta("volcengine")!;
  const result = resolveRuntimeBaseUrl(provider, {
    userApiKey: "sk-user",
    envBaseUrl: "http://localhost:9999/v1", // mock 模拟场景下也必须直达真实端点
  });
  assert.equal(result, provider.baseUrl);
  assert.equal(result, "https://ark.cn-beijing.volces.com/api/v3");
});

test("未配置 Key 且有 env 端点 → 使用 env 端点（mock / 内网网关兜底）", () => {
  const provider = getProviderMeta("dashscope")!;
  const result = resolveRuntimeBaseUrl(provider, {
    userApiKey: "",
    envBaseUrl: "http://localhost:9999/v1",
  });
  assert.equal(result, "http://localhost:9999/v1");
});

test("未配置 Key 且无 env 端点 → 使用供应商目录端点", () => {
  const provider = getProviderMeta("dashscope")!;
  const result = resolveRuntimeBaseUrl(provider, {
    userApiKey: "",
    envBaseUrl: "",
  });
  assert.equal(result, provider.baseUrl);
});

test("全部内置供应商有真实端点（OpenAI 兼容）", () => {
  for (const id of ["volcengine", "dashscope"]) {
    const provider = getProviderMeta(id);
    assert.ok(provider, `缺少供应商 ${id}`);
    assert.match(provider.baseUrl, /^https:\/\//);
    assert.ok(provider.baseUrl.endsWith("/v1") || provider.baseUrl.endsWith("/v3"), `${id} baseUrl 结尾异常`);
  }
});
