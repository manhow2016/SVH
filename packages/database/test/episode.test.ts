/**
 * 多集迁移回填测试（V0.3）。
 *
 * 覆盖两场景：
 * 1. 「数据回填」：已有剧本/场景/时间轴数据的项目没有集（episodes 表为空）——
 *    再次打开数据库时 backfillEpisodes 自动创建「第 1 集」并挂载既有数据；
 * 2. 「旧 schema 升级」：表里还没有 episode_id 列（升级前旧库）——migrateSchema
 *    应加列成功（回归：索引必须在加列之后创建，否则 INIT_SQL 建索引报 no such column）。
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

test("旧库回填：无集项目自动建第 1 集并回挂剧本/场景/时间轴（幂等）", () => {
  dir = mkdtempSync(join(tmpdir(), "svh-ep-mig-"));
  dbPath = join(dir, "test.db");

  // 第一次打开（建表）→ 插入「无集」项目数据（模拟旧库）
  let db: SVHDatabase = createDatabase(dbPath);
  const now = Date.now();
  db.$client.exec(
    `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
       VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
     INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
       VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});
     INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
       VALUES ('prj1','ws1','u1','旧项目',NULL,'short_drama','draft','{}',${now},${now});
     INSERT INTO production_scripts (id, project_id, episode_id, title, content, version, status, created_at, updated_at)
       VALUES ('sct1','prj1',NULL,'老剧本','内容',1,'draft',${now},${now});
     INSERT INTO production_scenes (id, project_id, episode_id, script_id, sort_order, name, description, location, time, characters, visual_style, created_at, updated_at)
       VALUES ('scn1','prj1',NULL,'sct1',0,'场景','d',NULL,NULL,'[]',NULL,${now},${now});
     INSERT INTO production_timelines (id, project_id, episode_id, name, description, duration, fps, width, height, status, version, created_at, updated_at)
       VALUES ('tml1','prj1',NULL,'老时间轴',NULL,0,24,1920,1080,'draft',0,${now},${now});`,
  );
  db.$client.close();

  // 第二次打开：migrateSchema + backfillEpisodes 应建集并回挂
  db = createDatabase(dbPath);
  const episodes = db.$client.prepare("SELECT id, project_id, sort_order, name FROM production_episodes").all() as Array<{
    id: string; project_id: string; sort_order: number; name: string;
  }>;
  assert.equal(episodes.length, 1, "应自动创建第 1 集");
  assert.equal(episodes[0]!.project_id, "prj1");
  assert.equal(episodes[0]!.sort_order, 1);
  assert.equal(episodes[0]!.name, "第 1 集");
  const epId = episodes[0]!.id;

  const script = db.$client.prepare("SELECT episode_id FROM production_scripts WHERE id='sct1'").get() as { episode_id: string | null };
  const scene = db.$client.prepare("SELECT episode_id FROM production_scenes WHERE id='scn1'").get() as { episode_id: string | null };
  const timeline = db.$client.prepare("SELECT episode_id FROM production_timelines WHERE id='tml1'").get() as { episode_id: string | null };
  assert.equal(script.episode_id, epId, "剧本应回挂第 1 集");
  assert.equal(scene.episode_id, epId, "场景应回挂第 1 集");
  assert.equal(timeline.episode_id, epId, "时间轴应回挂第 1 集");

  // 幂等：再次打开不重复建集
  db.$client.close();
  db = createDatabase(dbPath);
  assert.equal(
    (db.$client.prepare("SELECT COUNT(*) AS n FROM production_episodes").get() as { n: number }).n,
    1,
    "重复打开不应重复建集",
  );
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旧 schema 升级：无 episode_id 列的库打开成功（索引在加列后创建）", () => {
  dir = mkdtempSync(join(tmpdir(), "svh-ep-mig2-"));
  dbPath = join(dir, "test.db");
  // 手工构造「旧 schema」核心表（users/workspaces 与 INIT_SQL 同形；其余表由 INIT_SQL 补建）
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
    CREATE TABLE production_scripts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_scenes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
      script_id TEXT, sort_order INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      location TEXT, time TEXT, characters TEXT NOT NULL, visual_style TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE production_timelines (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT, duration REAL NOT NULL DEFAULT 0, fps REAL NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
      VALUES ('u1','u1','u1@x','x','user','active',${now},${now});
    INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
      VALUES ('ws1','ws1','/tmp/ws1','u1',${now},${now});
    INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
      VALUES ('prj1','ws1','u1','旧项目',NULL,'short_drama','draft','{}',${now},${now});
    INSERT INTO production_scripts (id, project_id, title, content, version, status, created_at, updated_at)
      VALUES ('sct1','prj1','老剧本','内容',1,'draft',${now},${now});
  `);
  raw.close();

  // 升级：createDatabase 应成功（加列 + 建索引 + 回填）
  const db: SVHDatabase = createDatabase(dbPath);
  const cols = (t: string): string[] =>
    (db.$client.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols("production_scripts").includes("episode_id"), "scripts 应加 episode_id 列");
  assert.ok(cols("production_scenes").includes("episode_id"), "scenes 应加 episode_id 列");
  assert.ok(cols("production_timelines").includes("episode_id"), "timelines 应加 episode_id 列");
  const ep = db.$client.prepare("SELECT id FROM production_episodes WHERE project_id='prj1'").get() as
    | { id: string }
    | undefined;
  assert.ok(ep, "应回填第 1 集");
  const script = db.$client.prepare("SELECT episode_id FROM production_scripts WHERE id='sct1'").get() as {
    episode_id: string | null;
  };
  assert.equal(script.episode_id, ep!.id, "剧本应挂载到回填集");
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
