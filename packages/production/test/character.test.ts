/**
 * Character 领域规则测试（文档 §6.3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAppearance,
  normalizeOptionalText,
  validateCharacterDescription,
  validateCharacterName,
} from "../src/index";

test("validateCharacterName / validateCharacterDescription", () => {
  assert.equal(validateCharacterName(" 林墨 "), "林墨");
  assert.throws(() => validateCharacterName(""), /不能为空/);
  assert.throws(() => validateCharacterName(null), /必须为字符串/);
  assert.equal(validateCharacterDescription("主角"), "主角");
  assert.throws(() => validateCharacterDescription("  "), /不能为空/);
});

test("normalizeAppearance：白名单字段、字符串值、截断", () => {
  const appearance = normalizeAppearance({
    gender: "女",
    age: "20",
    hairstyle: "长发",
    unknown: "ignored",
  });
  assert.equal(appearance.gender, "女");
  assert.equal("unknown" in appearance, false, "白名单外的字段不保留");
  assert.equal(appearance.age, "20");
  assert.deepEqual(normalizeAppearance(undefined), {});
  assert.deepEqual(normalizeAppearance({ hairstyle: "  " }), {});
  assert.throws(() => normalizeAppearance({ clothing: 123 }), /字符串/);
  assert.throws(() => normalizeAppearance("not-an-object"), /必须为对象/);
});

test("normalizeOptionalText：空串转 undefined，限长", () => {
  assert.equal(normalizeOptionalText(" 傲娇 ", "personality"), "傲娇");
  assert.equal(normalizeOptionalText("  ", "personality"), undefined);
  assert.equal(normalizeOptionalText(undefined, "personality"), undefined);
  assert.throws(() => normalizeOptionalText(123, "personality"), /必须为字符串/);
  assert.equal(normalizeOptionalText("a".repeat(600), "personality")?.length, 500);
});
