/**
 * 数据库种子守卫测试：种子仅空表时播种（首次建库）；管理员删除后重启不复活。
 *
 * 历史 bug：INSERT OR IGNORE 每次启动重放，管理员删除的种子模型/套餐重启复活。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  models as modelsTable,
  subscriptionPlans as plansTable,
  membershipTiers as tiersTable,
  type SVHDatabase,
} from "@svh/database";

let dir: string;
let dbPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "svh-seed-guard-"));
  dbPath = join(dir, "test.db");
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("首次建库：种子已插入（模型/会员等级/默认套餐）", () => {
  const db: SVHDatabase = createDatabase(dbPath);
  const models = db.select().from(modelsTable).all();
  const tiers = db.select().from(tiersTable).all();
  const plans = db.select().from(plansTable).all();
  assert.ok(models.length >= 19, `模型种子应存在（当前 ${models.length}）`);
  assert.equal(tiers.length, 3);
  assert.ok(plans.length >= 6);
});

test("管理员删除种子行后重启：不复活，其余种子保留", () => {
  // 第一次构建库（已在上一个测试建好同一个文件）
  const db1: SVHDatabase = createDatabase(dbPath);
  db1.delete(modelsTable).where(eq(modelsTable.id, "m_dash_qwen_max")).run();
  db1.delete(plansTable).where(eq(plansTable.id, "plan_pro_monthly")).run();
  const modelsBefore = db1.select().from(modelsTable).all().length;

  // 模拟服务重启（同一 DB 文件再次 createDatabase → 重放 INIT_SQL + runSeeds）
  const db2: SVHDatabase = createDatabase(dbPath);
  const models = db2.select().from(modelsTable).all();
  const plans = db2.select().from(plansTable).all();

  assert.equal(
    models.some((m) => m.id === "m_dash_qwen_max"),
    false,
    "删除的模型不应复活",
  );
  assert.equal(plans.some((p) => p.id === "plan_pro_monthly"), false, "删除的套餐不应复活");
  assert.equal(models.length, modelsBefore, "其余模型种子保留且不重复插入");
  assert.ok(models.some((m) => m.id === "m_dash_wanx_t2i"), "未删除的模型仍在");
});
