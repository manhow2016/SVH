/**
 * 队列化列（V0.2 收尾：worker 任务队列）结构测试。
 * 新库：INIT_SQL 直接建列；旧库：migrateSchema ALTER 补列（幂等）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/client";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "svh-db-test-"));
  dirs.push(dir);
  return join(dir, "test.db");
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function columnsOf(db: ReturnType<typeof createDatabase>): string[] {
  return (
    db.$client.prepare("PRAGMA table_info(production_tasks)").all() as Array<{ name: string }>
  ).map((c) => c.name);
}

test("新库 production_tasks 含 payload/claimed_by/heartbeat_at 队列列", () => {
  const db = createDatabase(tmpFile());
  for (const col of ["payload", "claimed_by", "heartbeat_at"]) {
    assert.ok(columnsOf(db).includes(col), `缺少列 ${col}`);
  }
});

test("旧库缺队列列时 createDatabase 自动补列且幂等", () => {
  const file = tmpFile();
  const db = createDatabase(file);
  // 模拟旧库：删掉三个新列（SQLite ≥3.35 支持 DROP COLUMN）
  db.$client.exec(
    "ALTER TABLE production_tasks DROP COLUMN payload;" +
      "ALTER TABLE production_tasks DROP COLUMN claimed_by;" +
      "ALTER TABLE production_tasks DROP COLUMN heartbeat_at;",
  );
  assert.ok(!columnsOf(db).includes("payload"));
  db.$client.close();

  const reopened = createDatabase(file); // 第一次迁移
  const reopened2 = createDatabase(file); // 再开一次验证幂等（不报错）
  for (const col of ["payload", "claimed_by", "heartbeat_at"]) {
    assert.ok(columnsOf(reopened).includes(col), `迁移后缺列 ${col}`);
    assert.ok(columnsOf(reopened2).includes(col));
  }
});
