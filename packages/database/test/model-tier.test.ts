/**
 * 模型方案档位迁移测试（V0.3：系统选模型）。
 *
 * 旧库 models 表无 tier 列 → migrateSchema 应加列（存量行默认 'balanced'，
 * 与 INIT_SQL 新建表 DEFAULT 一致），升级零丢失。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDatabase, type SVHDatabase } from "../src/index";

let dir: string;
let dbPath: string;

test("旧 schema 升级：无 tier 列的 models 表自动加列，存量模型默认 balanced", () => {
  dir = mkdtempSync(join(tmpdir(), "svh-tier-mig-"));
  dbPath = join(dir, "test.db");
  const raw = new Database(dbPath);
  const now = Date.now();
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider_id, model_name)
    );
    INSERT INTO models (id, provider_id, model_name, type, display_name, enabled, sort_order, created_at, updated_at)
      VALUES ('m1','dashscope','qwen-vl','image','通义万相',1,0,${now},${now});
  `);
  raw.close();

  const db: SVHDatabase = createDatabase(dbPath);
  const cols = (db.$client.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("tier"), "models 应加 tier 列");
  const row = db.$client.prepare("SELECT tier FROM models WHERE id='m1'").get() as { tier: string };
  assert.equal(row.tier, "balanced", "存量模型档位应回填为 balanced");
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
