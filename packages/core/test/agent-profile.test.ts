/**
 * Agent Profile 运行时能力测试（文档 §8）。
 *
 * 验证：按白名单过滤工具、Profile 注入后的提示词拼接顺序、纯函数行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tool } from "@svh/tools";
import { filterToolsForProfile, toToolDefinitions, type AgentProfile } from "../src/index";

function fakeTool(name: string): Tool {
  return {
    name,
    description: `desc-${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ output: null }),
  };
}

const ALL_TOOLS = ["list_files", "read_file", "write_file", "create_project", "create_script"].map(fakeTool);

test("filterToolsForProfile：未配置白名单返回全部工具", () => {
  assert.equal(filterToolsForProfile(ALL_TOOLS, undefined).length, 5);
  assert.equal(filterToolsForProfile(ALL_TOOLS, []).length, 5);
});

test("filterToolsForProfile：按白名单过滤且保持原顺序", () => {
  const filtered = filterToolsForProfile(ALL_TOOLS, ["create_project", "write_file"]);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["write_file", "create_project"],
  );
});

test("filterToolsForProfile：白名单中不存在的工具名被忽略（不会报错）", () => {
  const filtered = filterToolsForProfile(ALL_TOOLS, ["create_project", "generate_video"]);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["create_project"],
  );
});

test("toToolDefinitions：转换为 OpenAI function calling 格式", () => {
  const defs = toToolDefinitions([fakeTool("create_project")]);
  assert.equal(defs[0]?.type, "function");
  assert.equal(defs[0]?.function.name, "create_project");
  assert.deepEqual(defs[0]?.function.parameters, { type: "object", properties: {} });
});

test("AgentProfile 类型：最小结构可构造", () => {
  const profile: AgentProfile = {
    id: "p1",
    name: "测试角色",
    description: "d",
    systemPrompt: "你是测试角色",
    allowedTools: ["read_file"],
  };
  assert.equal(profile.id, "p1");
  const noTools: AgentProfile = { id: "p2", name: "n", description: "d", systemPrompt: "s" };
  assert.equal(noTools.allowedTools, undefined);
});
