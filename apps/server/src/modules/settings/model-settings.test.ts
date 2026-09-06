import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  models as modelsTable,
  settings as settingsTable,
  type SVHDatabase,
} from "@svh/database";
import { ModelService } from "./model-service";
import { SettingsService } from "./service";

/**
 * 模型设置回归测试：管理员删除/替换模型后，用户启用列表残留的失效 id 应被收敛，
 * 读取与保存均不得因「模型不存在」报错卡死。
 */
let dir: string;
let db: SVHDatabase;
let modelService: ModelService;
let settingsService: SettingsService;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "svh-model-settings-"));
  db = createDatabase(join(dir, "test.db"));
  // 模拟管理员删除旧模型：种子数据中的 qwen-max / qwen-plus
  db.delete(modelsTable).where(eq(modelsTable.id, "m_dash_qwen_max")).run();
  db.delete(modelsTable).where(eq(modelsTable.id, "m_dash_qwen_plus")).run();
  modelService = new ModelService(db);
  settingsService = new SettingsService(
    db,
    { baseUrl: "", apiKey: "", model: "" },
    modelService,
  );
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("filterExistingIds：保留现存 id 与顺序，丢弃已删除 id", async () => {
  const result = await modelService.filterExistingIds([
    "m_dash_qwen_turbo",
    "m_dash_qwen_max",
    "m_volc_doubao_15_pro",
    "m_dash_qwen_plus",
  ]);
  assert.deepEqual(result, ["m_dash_qwen_turbo", "m_volc_doubao_15_pro"]);
});

test("updateModelSettings：提交含已删除 id 的列表不再报错，落库为过滤后列表", async () => {
  const out = await settingsService.updateModelSettings("u-write", {
    enabledModels: ["m_dash_qwen_max", "m_dash_qwen_turbo", "m_volc_doubao_15_pro"],
  });
  assert.deepEqual(out.enabledModels, ["m_dash_qwen_turbo", "m_volc_doubao_15_pro"]);
  const read = await settingsService.getModelSettings("u-write");
  assert.deepEqual(read.enabledModels, ["m_dash_qwen_turbo", "m_volc_doubao_15_pro"]);
});

test("getModelSettings：历史残留引用读取时被收敛（聊天/设置不再被孤儿 id 干扰）", async () => {
  // 直接写入历史脏数据（模拟旧版本保存的启用列表）
  await db
    .insert(settingsTable)
    .values({
      key: "model",
      userId: "u-read",
      value: JSON.stringify({ enabledModels: ["m_dash_qwen_max", "m_volc_doubao_15_pro"] }),
      updatedAt: new Date(),
    })
    .run();
  const read = await settingsService.getModelSettings("u-read");
  assert.deepEqual(read.enabledModels, ["m_volc_doubao_15_pro"]);
});

test("getModelSettings：启用列表全部失效时返回 null（等同全部启用）", async () => {
  await db
    .insert(settingsTable)
    .values({
      key: "model",
      userId: "u-read-all-stale",
      value: JSON.stringify({ enabledModels: ["m_dash_qwen_max", "m_dash_qwen_plus"] }),
      updatedAt: new Date(),
    })
    .run();
  const read = await settingsService.getModelSettings("u-read-all-stale");
  assert.equal(read.enabledModels, null);
});

test("updateModelSettings：提交的 id 全部失效时保存为 null（全部启用）", async () => {
  const out = await settingsService.updateModelSettings("u-write-all-stale", {
    enabledModels: ["m_dash_qwen_max", "m_dash_qwen_plus"],
  });
  assert.equal(out.enabledModels, null);
});

test("updateModelSettings：非字符串 id 仍被拒绝（类型校验保留）", async () => {
  await assert.rejects(
    () =>
      settingsService.updateModelSettings("u-write", {
        // @ts-expect-error 故意传入错误类型验证运行时校验
        enabledModels: [123],
      }),
    /enabledModels must be an array of model ids/,
  );
});
