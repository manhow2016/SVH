/**
 * Project 领域规则测试（文档 §6.1）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProjectStatus,
  canTransitionProjectStatus,
  isProjectStatus,
  isProjectType,
  normalizeProjectSettings,
  validateProjectDescription,
  validateProjectName,
  type ProjectStatus,
} from "../src/index";

test("isProjectType / isProjectStatus：合法值与非法值", () => {
  assert.equal(isProjectType("short_drama"), true);
  assert.equal(isProjectType("short_video"), true);
  assert.equal(isProjectType("other"), false);
  assert.equal(isProjectType(123), false);
  assert.equal(isProjectStatus("draft"), true);
  assert.equal(isProjectStatus("archived"), true);
  assert.equal(isProjectStatus("deleted"), false);
});

test("validateProjectName：trim、非空、限长", () => {
  assert.equal(validateProjectName("  我的项目  "), "我的项目");
  assert.throws(() => validateProjectName(""), /不能为空/);
  assert.throws(() => validateProjectName("   "), /不能为空/);
  assert.throws(() => validateProjectName(123), /必须为字符串/);
  assert.throws(() => validateProjectName("a".repeat(101)), /不能超过/);
});

test("validateProjectDescription：可选、限长、空串转 undefined", () => {
  assert.equal(validateProjectDescription(" 说明 "), "说明");
  assert.equal(validateProjectDescription("  "), undefined);
  assert.equal(validateProjectDescription(undefined), undefined);
  assert.throws(() => validateProjectDescription(123), /必须为字符串/);
  assert.throws(() => validateProjectDescription("a".repeat(2001)), /不能超过/);
});

test("normalizeProjectSettings：只保留已知字段且做数值约束", () => {
  const settings = normalizeProjectSettings({
    duration: 120,
    style: " chinese_fantasy ",
    generation: { model: "wanx" },
    extra: "ignored",
  });
  assert.deepEqual(settings, {
    duration: 120,
    style: "chinese_fantasy",
    generation: { model: "wanx" },
  });
  assert.throws(() => normalizeProjectSettings({ duration: -1 }), /正数/);
  assert.deepEqual(normalizeProjectSettings({ duration: 1.4 }), { duration: 1 }, "小数时长向上取整为秒");
  assert.deepEqual(normalizeProjectSettings({ style: "  " }), {});
  assert.throws(() => normalizeProjectSettings({ generation: [] as never }), /对象/);
});

test("项目状态机：允许与禁止的跳转", () => {
  assert.equal(canTransitionProjectStatus("draft", "planning"), true);
  assert.equal(canTransitionProjectStatus("planning", "producing"), true);
  assert.equal(canTransitionProjectStatus("producing", "completed"), true);
  assert.equal(canTransitionProjectStatus("completed", "archived"), true);
  assert.equal(canTransitionProjectStatus("archived", "draft"), true);
  assert.equal(canTransitionProjectStatus("draft", "completed"), false);
  assert.equal(canTransitionProjectStatus("producing", "draft"), false);
  assert.throws(() => applyProjectStatus("draft", "completed"), /不允许/);
  const statuses: ProjectStatus[] = ["draft", "planning", "producing", "completed", "archived"];
  for (const s of statuses) {
    assert.equal(applyProjectStatus(s, s), s, "同状态跳转变为 no-op（由 Service 层短路）");
  }
});
