/**
 * Storyboard 领域规则测试（文档 §6.5）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStoryboardStatus,
  normalizeOptionalPrompt,
  validateShotType,
  validateStoryboardDescription,
  validateStoryboardDuration,
} from "../src/index";

test("validateStoryboardDuration：正数向上取整", () => {
  assert.equal(validateStoryboardDuration(5), 5);
  assert.equal(validateStoryboardDuration(5.6), 6);
  assert.throws(() => validateStoryboardDuration(0), /正数/);
  assert.throws(() => validateStoryboardDuration(-2), /正数/);
  assert.throws(() => validateStoryboardDuration("5"), /正数/);
});

test("validateShotType：非空限长", () => {
  assert.equal(validateShotType(" medium_shot "), "medium_shot");
  assert.throws(() => validateShotType(""), /不能为空/);
  assert.throws(() => validateShotType("a".repeat(101)), /不能超过/);
});

test("validateStoryboardDescription：非空限长", () => {
  assert.equal(validateStoryboardDescription(" 特写 "), "特写");
  assert.throws(() => validateStoryboardDescription("  "), /不能为空/);
});

test("normalizeOptionalPrompt：空串转 undefined，限长截断", () => {
  assert.equal(normalizeOptionalPrompt(" shot A ", "imagePrompt"), "shot A");
  assert.equal(normalizeOptionalPrompt("", "videoPrompt"), undefined);
  assert.equal(normalizeOptionalPrompt("a".repeat(3000), "imagePrompt")?.length, 2000);
});

test("isStoryboardStatus", () => {
  assert.equal(isStoryboardStatus("draft"), true);
  assert.equal(isStoryboardStatus("approved"), true);
  assert.equal(isStoryboardStatus("published"), false);
});
