/**
 * Script 领域规则测试（文档 §6.2）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpScriptVersion,
  canTransitionScriptStatus,
  isScriptStatus,
  validateScriptContent,
  validateScriptTitle,
} from "../src/index";

test("validateScriptTitle：非空限长", () => {
  assert.equal(validateScriptTitle(" 第一集 "), "第一集");
  assert.throws(() => validateScriptTitle(""), /不能为空/);
  assert.throws(() => validateScriptTitle(1), /必须为字符串/);
});

test("validateScriptContent：字符串且限长", () => {
  assert.equal(validateScriptContent("正文"), "正文");
  assert.throws(() => validateScriptContent(123), /必须为字符串/);
  assert.throws(() => validateScriptContent("a".repeat(500_001)), /不能超过/);
});

test("isScriptStatus：合法值", () => {
  assert.equal(isScriptStatus("draft"), true);
  assert.equal(isScriptStatus("approved"), true);
  assert.equal(isScriptStatus("published"), false);
});

test("剧本状态机与版本递增", () => {
  assert.equal(canTransitionScriptStatus("draft", "reviewing"), true);
  assert.equal(canTransitionScriptStatus("reviewing", "approved"), true);
  assert.equal(canTransitionScriptStatus("approved", "reviewing"), true);
  assert.equal(canTransitionScriptStatus("approved", "draft"), true);
  assert.equal(canTransitionScriptStatus("draft", "approved"), false, "不允许跳过审核直接通过");
  assert.equal(bumpScriptVersion(1), 2);
});
