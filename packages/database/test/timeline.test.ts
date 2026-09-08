/**
 * Timeline 表结构 / 级联删除策略测试（V0.3 Phase 2）。
 *
 * 覆盖：
 * - 新库 INIT_SQL 建出 production_timelines / production_timeline_tracks /
 *   production_timeline_clips 三表（幂等重开不报错）；
 * - 删除策略：Project → Timeline → Track → Clip 全级联；
 * - Clip 关联的 Asset / Shot 删除时 SET NULL（保留时间轴布局）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/client";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "svh-db-timeline-"));
  dirs.push(dir);
  return join(dir, "test.db");
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type DB = ReturnType<typeof createDatabase>;

function assertColumns(db: DB, table: string, cols: string[]): void {
  const rows = db.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const names = rows.map((r) => r.name);
  for (const col of cols) {
    assert.ok(names.includes(col), `${table} 缺少列 ${col}`);
  }
}

function count(db: DB, table: string): number {
  return (db.$client.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** 造最小前置行：user + workspace + project（返回 project id） */
function seedProject(db: DB): string {
  const now = 1720000000000;
  db.$client.exec(
    `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
       VALUES ('u1', 'u1', 'u1@x', 'x', 'user', 'active', ${now}, ${now});
     INSERT INTO workspaces (id, name, root_path, user_id, created_at, updated_at)
       VALUES ('ws1', 'ws1', '/tmp/ws1', 'u1', ${now}, ${now});
     INSERT INTO production_projects (id, workspace_id, user_id, name, description, type, status, settings, created_at, updated_at)
       VALUES ('p1', 'ws1', 'u1', 'p1', NULL, 'short_drama', 'active', '{}', ${now}, ${now});`,
  );
  return "p1";
}

/** 插入 timeline + video 轨道 + 一条 clip，返回 { timelineId, trackId, clipId } */
function seedTimeline(db: DB): { timelineId: string; trackId: string; clipId: string } {
  const now = 1720000000000;
  db.$client.exec(
    `INSERT INTO production_timelines (id, project_id, name, description, duration, fps, width, height, status, version, created_at, updated_at)
       VALUES ('tl1', 'p1', '主时间轴', NULL, 0, 24, 1920, 1080, 'draft', 0, ${now}, ${now});
     INSERT INTO production_timeline_tracks (id, timeline_id, type, name, sort_order, muted, locked, created_at, updated_at)
       VALUES ('trk1', 'tl1', 'video', '主视频轨', 0, 0, 0, ${now}, ${now});
     INSERT INTO production_timeline_clips (id, timeline_id, track_id, asset_id, shot_id, start_time, duration, source_start_time, source_duration, sort_order, metadata, created_at, updated_at)
       VALUES ('clp1', 'tl1', 'trk1', NULL, NULL, 0, 5, NULL, NULL, 0, NULL, ${now}, ${now});`,
  );
  return { timelineId: "tl1", trackId: "trk1", clipId: "clp1" };
}

test("新库建出三张 timeline 表且重开幂等", () => {
  const file = tmpFile();
  const db = createDatabase(file);
  assertColumns(db, "production_timelines", [
    "id", "project_id", "name", "description", "duration", "fps", "width", "height",
    "status", "version", "created_at", "updated_at",
  ]);
  assertColumns(db, "production_timeline_tracks", [
    "id", "timeline_id", "type", "name", "sort_order", "muted", "locked", "created_at", "updated_at",
  ]);
  assertColumns(db, "production_timeline_clips", [
    "id", "timeline_id", "track_id", "asset_id", "shot_id", "start_time", "duration",
    "source_start_time", "source_duration", "sort_order", "metadata", "created_at", "updated_at",
  ]);
  db.$client.close();
  const reopened = createDatabase(file); // 幂等：重开不报错
  assertColumns(reopened, "production_timelines", ["id", "project_id"]);
});

test("删除 Project 级联清空 Timeline / Track / Clip", () => {
  const db = createDatabase(tmpFile());
  seedProject(db);
  seedTimeline(db);
  assert.equal(count(db, "production_timelines"), 1);
  assert.equal(count(db, "production_timeline_tracks"), 1);
  assert.equal(count(db, "production_timeline_clips"), 1);

  db.$client.exec("DELETE FROM production_projects WHERE id = 'p1';");

  assert.equal(count(db, "production_timelines"), 0);
  assert.equal(count(db, "production_timeline_tracks"), 0);
  assert.equal(count(db, "production_timeline_clips"), 0, "Clip 应随 Track 级联删除");
});

test("删除 Timeline 级联清空 Track / Clip", () => {
  const db = createDatabase(tmpFile());
  seedProject(db);
  seedTimeline(db);
  db.$client.exec("DELETE FROM production_timelines WHERE id = 'tl1';");
  assert.equal(count(db, "production_timeline_tracks"), 0);
  assert.equal(count(db, "production_timeline_clips"), 0);
});

test("删除 Asset / Shot 时 Clip 关联 SET NULL（保留时间轴布局）", () => {
  const db = createDatabase(tmpFile());
  seedProject(db);
  const now = 1720000000000;
  db.$client.exec(
    `INSERT INTO production_assets (id, project_id, workspace_id, user_id, type, name, url, workspace_path, mime_type, metadata, generation, created_at, updated_at)
       VALUES ('ast1', 'p1', 'ws1', 'u1', 'video', '镜头1', 'https://x/1.mp4', NULL, 'video/mp4', NULL, NULL, ${now}, ${now});
     INSERT INTO production_scenes (id, project_id, script_id, sort_order, name, description, location, time, characters, visual_style, created_at, updated_at)
       VALUES ('scn1', 'p1', NULL, 0, '场景1', 'x', NULL, NULL, '[]', NULL, ${now}, ${now});
     INSERT INTO production_storyboards (id, project_id, scene_id, sort_order, description, duration, shot_type, camera_movement, image_prompt, video_prompt, status, created_at, updated_at)
       VALUES ('sbd1', 'p1', 'scn1', 0, 'x', 5, 'medium', NULL, NULL, NULL, 'draft', ${now}, ${now});
     INSERT INTO production_shots (id, project_id, storyboard_id, sort_order, duration, framing, camera_movement, action, dialogue, image_asset_id, video_asset_id, audio_asset_id, status, visual_style, created_at, updated_at)
       VALUES ('sht1', 'p1', 'sbd1', 0, 5, NULL, NULL, NULL, NULL, NULL, 'ast1', NULL, 'ready', NULL, ${now}, ${now});`,
  );
  db.$client.exec(
    `INSERT INTO production_timelines (id, project_id, name, duration, fps, width, height, status, version, created_at, updated_at)
       VALUES ('tl2', 'p1', 't', 5, 24, 1920, 1080, 'draft', 0, ${now}, ${now});
     INSERT INTO production_timeline_tracks (id, timeline_id, type, name, sort_order, muted, locked, created_at, updated_at)
       VALUES ('trk2', 'tl2', 'video', 'v', 0, 0, 0, ${now}, ${now});
     INSERT INTO production_timeline_clips (id, timeline_id, track_id, asset_id, shot_id, start_time, duration, sort_order, created_at, updated_at)
       VALUES ('clp2', 'tl2', 'trk2', 'ast1', 'sht1', 0, 5, 0, ${now}, ${now});`,
  );

  db.$client.exec(
    "DELETE FROM production_assets WHERE id = 'ast1'; DELETE FROM production_shots WHERE id = 'sht1';",
  );

  const clip = db.$client
    .prepare("SELECT asset_id, shot_id FROM production_timeline_clips WHERE id = 'clp2'")
    .get() as { asset_id: string | null; shot_id: string | null };
  assert.equal(clip.asset_id, null, "Asset 删除后 clip.asset_id 应置 NULL");
  assert.equal(clip.shot_id, null, "Shot 删除后 clip.shot_id 应置 NULL");
  assert.equal(count(db, "production_timeline_clips"), 1, "剪辑本身保留");
});
