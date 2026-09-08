/**
 * 会话绑定项目迁移测试（V0.3）。
 *
 * 覆盖两场景：
 * 1. 「旧库升级」：sessions 表还没有 project_id 列（升级前旧库）——migrateSchema
 *    应加列成功并建唯一索引（回填在事务内）；
 * 2. 「数据回填」：存量项目没有绑定会话——backfillProjectSessions 自动创建
 *    绑定会话（标题=项目名），幂等不重复。
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

test("旧 schema 升级：旧 sessions（无 project_id 列）自动加列 + 项目回填绑定会话（幂等）", () => {
  dir = mkdtempSync(join(tmpdir(), "svh-ses-mig-"));
  dbPath = join(dir, "test.db");
  // 手工构造「旧 schema」：sessions 无 project_id 列，项目无绑定会话，另有历史孤儿会话
  const raw = new Database(dbPath);
  const now = Date.now();
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
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新会话', status TEXT NOT NULL DEFAULT 'idle',
      model_provider_id TEXT NOT NULL DEFAULT 'openai-compatible', model_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
      VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
    INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
      VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});
    INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
      VALUES ('prj1','ws1','u1','旧项目',NULL,'short_drama','draft','{}',${now},${now});
    -- 历史孤儿会话（无项目绑定，应保留且不重复回填）
    INSERT INTO sessions (id, workspace_id, title, status, model_provider_id, model_id, created_at, updated_at)
      VALUES ('ses_old','ws1','孤儿会话','idle','openai-compatible','',${now},${now});
  `);
  raw.close();

  // 升级：加列 + 唯一索引 + 回填绑定会话
  const db: SVHDatabase = createDatabase(dbPath);
  const cols = (db.$client.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("project_id"), "sessions 应加 project_id 列");

  const sessions = db.$client
    .prepare("SELECT id, project_id, title FROM sessions WHERE project_id IS NOT NULL")
    .all() as Array<{ id: string; project_id: string; title: string }>;
  assert.equal(sessions.length, 1, "项目应回填 1 个绑定会话");
  assert.equal(sessions[0]!.project_id, "prj1");
  assert.equal(sessions[0]!.title, "旧项目", "绑定会话标题应取项目名");

  // 孤儿会话保留
  const orphan = db.$client.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id IS NULL").get() as {
    n: number;
  };
  assert.equal(orphan.n, 1, "历史孤儿会话应保留");

  // 幂等：再次打开不重复回填
  db.$client.close();
  const db2 = createDatabase(dbPath);
  const bound = db2.$client
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = 'prj1'")
    .get() as { n: number };
  assert.equal(bound.n, 1, "重复打开不应重复回填");
  db2.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
