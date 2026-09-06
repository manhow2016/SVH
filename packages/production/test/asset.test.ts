/**
 * Asset 领域规则测试（文档 §7）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAssetType,
  validateAssetGeneration,
  validateAssetUrl,
  validateWorkspacePath,
} from "../src/index";

test("isAssetType", () => {
  assert.equal(isAssetType("image"), true);
  assert.equal(isAssetType("video"), true);
  assert.equal(isAssetType("reference"), true);
  assert.equal(isAssetType("gif"), false);
});

test("validateAssetUrl：http(s) 绝对地址", () => {
  assert.equal(validateAssetUrl(" https://cdn.example.com/a.png "), "https://cdn.example.com/a.png");
  assert.equal(validateAssetUrl(""), undefined);
  assert.equal(validateAssetUrl(undefined), undefined);
  assert.throws(() => validateAssetUrl("ftp://x.com/a"), /http/);
  assert.throws(() => validateAssetUrl("/local/path.png"), /http/);
});

test("validateWorkspacePath：相对路径且禁止逃逸", () => {
  assert.equal(validateWorkspacePath("assets/role.png"), "assets/role.png");
  assert.equal(validateWorkspacePath(""), undefined);
  assert.throws(() => validateWorkspacePath("/abs/path"), /相对路径/);
  assert.throws(() => validateWorkspacePath("../escape.png"), /逃逸/);
});

test("validateAssetGeneration：providerId 必填", () => {
  assert.deepEqual(
    validateAssetGeneration({ providerId: "dashscope", modelId: "wanx", taskId: "t1" }),
    { providerId: "dashscope", modelId: "wanx", taskId: "t1" },
  );
  assert.equal(validateAssetGeneration(undefined), undefined);
  assert.throws(() => validateAssetGeneration({ providerId: "" }), /providerId/);
  assert.throws(() => validateAssetGeneration({ providerId: 1 as never }), /providerId/);
});
