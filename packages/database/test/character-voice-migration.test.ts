/**
 * character.voice_asset_id 迁移测试（角色面板重构 · 配音音色）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDatabase, type SVHDatabase } from "../src/index";

test("旧 schema 升级：production_characters 无 voice_asset_id 列自动加列（幂等）", () => {
  const dir = mkdtempSync(join(tmpdir(), "svh-char-voice-mig-"));
  const dbPath = join(dir, "test.db");
  const now = Date.now();
  const raw = new Database(dbPath);
  // 最少依赖表（createDatabase 的 INIT_SQL 会对已存在表走幂等建表）
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      description TEXT, type TEXT NOT NULL, status TEXT NOT NULL, settings TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_characters (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', personality TEXT,
      appearance TEXT NOT NULL DEFAULT '{}', reference_asset_id TEXT,
      visual_profile TEXT, voice TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
      VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
    INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
      VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});
    INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
      VALUES ('prj1','ws1','u1','旧项目',NULL,'short_drama','draft','{}',${now},${now});
    INSERT INTO production_characters (id, project_id, name, description, personality, appearance, reference_asset_id, visual_profile, voice, created_at, updated_at)
      VALUES ('ch1','prj1','小明','测试',NULL,'{}',NULL,NULL,NULL,${now},${now});
  `);
  raw.close();

  const db: SVHDatabase = createDatabase(dbPath);
  try {
    const cols = (db.$client.prepare("PRAGMA table_info(production_characters)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(cols.includes("voice_asset_id"), "旧角色表应自动加 voice_asset_id 列");
    // 幂等：二次启动不再报错（同进程再跑一次 createDatabase，走同一迁移探测）
    const db2: SVHDatabase = createDatabase(dbPath);
    db2.$client.close();
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
