import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKILLS, getSkillById, listSkillPublicViews, validateSkillParams, renderSkillPrompt } from "./definitions";

test("内置技能包含剧本拆解与分镜脚本，且各有一个 primary 参数", () => {
  assert.ok(getSkillById("script-breakdown"), "缺少剧本拆解");
  assert.ok(getSkillById("storyboard"), "缺少分镜脚本");
  for (const s of BUILTIN_SKILLS) {
    const primaries = s.params.filter((p) => p.primary);
    assert.equal(primaries.length, 1, `${s.id} 应有且仅有一个主参数`);
  }
});

test("公开视图不包含提示词模板", () => {
  const views = listSkillPublicViews();
  assert.equal(views.length, BUILTIN_SKILLS.length);
  for (const v of views) {
    assert.ok(!("systemPrompt" in v));
    assert.ok(!("promptTemplate" in v));
  }
});

test("参数校验：必填缺失 / 未知键 / 非法枚举被拒绝", () => {
  const skill = getSkillById("script-breakdown")!;
  assert.throws(() => validateSkillParams(skill, {}), /原始文本/);
  assert.throws(() => validateSkillParams(skill, { source_text: "x", unknown: 1 }), /未知参数/);
  assert.throws(
    () => validateSkillParams(skill, { source_text: "x", format: "not-exist" }),
    /格式/, // 非法枚举值
  );
});

test("参数校验：数字参数转换，缺省值生效", () => {
  const skill = getSkillById("script-breakdown")!;
  const out = validateSkillParams(skill, { source_text: "故事…", episodes: "10" });
  assert.equal(out.episodes, 10);
});

test("提示词渲染：占位符全部替换", () => {
  const skill = getSkillById("script-breakdown")!;
  const prompt = renderSkillPrompt(skill, { source_text: "S", episodes: 5, format: "script" });
  assert.ok(!prompt.includes("{{") && prompt.includes("S"));
});
