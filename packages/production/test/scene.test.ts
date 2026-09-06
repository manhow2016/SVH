/**
 * Scene 领域规则测试（文档 §6.4）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextOrder,
  normalizeCharacters,
  normalizeOptionalString,
  sortByOrder,
  validateSceneOrder,
} from "../src/index";

test("normalizeCharacters：字符串数组、trim、去空、保留顺序；非字符串元素抛错", () => {
  assert.deepEqual(normalizeCharacters([" a ", "", "a"]), ["a", "a"]);
  assert.deepEqual(normalizeCharacters(undefined), []);
  assert.deepEqual(normalizeCharacters(["b", "a"]), ["b", "a"]);
  assert.throws(() => normalizeCharacters([123]), /字符串数组/);
  assert.throws(() => normalizeCharacters("a"), /数组/);
});

test("normalizeOptionalString：空串转 undefined", () => {
  assert.equal(normalizeOptionalString(" 室内 ", "location"), "室内");
  assert.equal(normalizeOptionalString("", "location"), undefined);
  assert.equal(normalizeOptionalString(undefined, "location"), undefined);
  assert.throws(() => normalizeOptionalString(1, "location"), /必须为字符串/);
});

test("validateSceneOrder：非负整数", () => {
  assert.equal(validateSceneOrder(0), 0);
  assert.equal(validateSceneOrder(3), 3);
  assert.throws(() => validateSceneOrder(-1), /非负整数/);
  assert.throws(() => validateSceneOrder(1.5), /非负整数/);
  assert.throws(() => validateSceneOrder("1"), /非负整数/);
});

test("nextOrder：空列表为 0，否则最大值+1", () => {
  assert.equal(nextOrder([]), 0);
  assert.equal(nextOrder([0, 1, 5]), 6);
  assert.equal(nextOrder([3, 3]), 4);
});

test("sortByOrder：按 order 稳定排序（id 兜底）", () => {
  const rows = [
    { id: "b", order: 1, title: "b" },
    { id: "a", order: 1, title: "a" },
    { id: "c", order: 0, title: "c" },
  ] as never;
  const sorted = sortByOrder(rows as []);
  assert.deepEqual(
    sorted.map((r: { id: string }) => r.id),
    ["c", "a", "b"],
  );
});
