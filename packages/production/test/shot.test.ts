/**
 * Shot 领域规则测试（文档 §6.6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyShotStatus,
  assertShotsWithinStoryboardDuration,
  canTransitionShotStatus,
  isShotStatus,
  validateShotDuration,
} from "../src/index";

test("validateShotDuration：正数向上取整", () => {
  assert.equal(validateShotDuration(2), 2);
  assert.equal(validateShotDuration(2.4), 2);
  assert.throws(() => validateShotDuration(0), /正数/);
});

test("isShotStatus", () => {
  assert.equal(isShotStatus("pending"), true);
  assert.equal(isShotStatus("ready"), true);
  assert.equal(isShotStatus("done"), false);
});

test("镜头状态机：pending→generating→ready|failed，failed 可重置", () => {
  assert.equal(canTransitionShotStatus("pending", "generating"), true);
  assert.equal(canTransitionShotStatus("generating", "ready"), true);
  assert.equal(canTransitionShotStatus("generating", "failed"), true);
  assert.equal(canTransitionShotStatus("failed", "pending"), true);
  assert.equal(canTransitionShotStatus("pending", "ready"), false);
  assert.equal(canTransitionShotStatus("ready", "failed"), false);
  assert.equal(applyShotStatus("pending", "generating"), "generating");
  assert.throws(() => applyShotStatus("pending", "ready"), /不允许/);
});

test("assertShotsWithinStoryboardDuration：总时长约束", () => {
  assert.doesNotThrow(() => assertShotsWithinStoryboardDuration(5, 5));
  assert.doesNotThrow(() => assertShotsWithinStoryboardDuration(4, 5));
  assert.throws(() => assertShotsWithinStoryboardDuration(6, 5), /不能超过/);
});
