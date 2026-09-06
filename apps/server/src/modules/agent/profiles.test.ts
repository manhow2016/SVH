/**
 * Agent Profile 定义测试（文档 §9：Director / Script / Storyboard）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROFILES, getProfileById } from "./profiles";

/** 当前全部已注册工具名（builtin 4 + production 16） */
const ALL_TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "list_projects",
  "get_project",
  "create_project",
  "update_project",
  "list_scripts",
  "get_script",
  "create_script",
  "update_script",
  "list_characters",
  "create_character",
  "update_character",
  "create_scene",
  "create_storyboard",
  "update_storyboard",
  "create_shot",
  "update_shot",
];

test("AGENT_PROFILES：三个角色齐全且 id/名称唯一", () => {
  const ids = AGENT_PROFILES.map((p) => p.id);
  assert.deepEqual(ids, ["director", "script", "storyboard"]);
  assert.equal(new Set(ids).size, 3);
  assert.ok(AGENT_PROFILES.every((p) => p.systemPrompt.trim().length > 50), "提示词不应为空");
  assert.ok(AGENT_PROFILES.every((p) => p.description.length > 0));
});

test("getProfileById：已知返回、未知 undefined", () => {
  assert.equal(getProfileById("director")?.name, "制作导演");
  assert.equal(getProfileById("unknown"), undefined);
});

test("工具白名单：全部指向已注册工具，且各角色符合职责边界", () => {
  for (const profile of AGENT_PROFILES) {
    assert.ok(profile.allowedTools && profile.allowedTools.length > 0, `${profile.id} 应有工具白名单`);
    for (const tool of profile.allowedTools) {
      assert.ok(
        ALL_TOOL_NAMES.includes(tool),
        `${profile.id} 白名单包含未知工具：${tool}`,
      );
    }
  }

  const director = getProfileById("director")!;
  assert.ok(director.allowedTools!.includes("create_project"));
  assert.ok(director.allowedTools!.includes("list_projects"));

  const script = getProfileById("script")!;
  assert.ok(script.allowedTools!.includes("create_script"));
  assert.ok(script.allowedTools!.includes("update_script"));

  const storyboard = getProfileById("storyboard")!;
  assert.ok(storyboard.allowedTools!.includes("create_scene"));
  assert.ok(storyboard.allowedTools!.includes("create_storyboard"));
  assert.ok(storyboard.allowedTools!.includes("create_shot"));
});

test("禁止项：任何角色都不允许调用媒体生成工具（V0.2 尚无，防越权预埋）", () => {
  const banned = ["generate_image", "generate_video", "generate_audio"];
  for (const profile of AGENT_PROFILES) {
    for (const tool of profile.allowedTools ?? []) {
      assert.ok(!banned.includes(tool), `${profile.id} 不应允许 ${tool}`);
    }
  }
});

test("角色提示词关键要求：Storyboard 强制结构化输出", () => {
  const storyboard = getProfileById("storyboard")!;
  assert.match(storyboard.systemPrompt, /结构化/);
  assert.match(storyboard.systemPrompt, /禁止只返回自然语言/);
  const script = getProfileById("script")!;
  assert.match(script.systemPrompt, /短剧/);
  const director = getProfileById("director")!;
  assert.match(director.systemPrompt, /Production Plan|生产计划/);
});
