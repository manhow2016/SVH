/**
 * 迁移范围护栏
 *
 * 「既有表 0 列改动」是本片对外承诺的验收标准之一，但它是**很容易被破坏**
 * 的承诺：将来有人手滑在迁移里加一个 `ALTER TABLE "contents" ADD COLUMN ...`，
 * 所有测试仍然是绿的。这里把该承诺变成一条会红的断言。
 *
 * 同时守住另外两件容易忘记的事：四张表都建了、CHECK 约束真的写进去了。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/** 本片之前既有的表：迁移不得改动它们 */
const EXISTING_TABLES = [
  'users',
  'projects',
  'project_members',
  'contents',
  'content_versions',
  'sessions',
  'messages',
  'assets',
  'asset_versions',
  'asset_references',
  'skills',
  'skill_executions',
  'workflows',
  'workflow_runs',
  'agent_tasks',
  'agent_task_steps',
  'task_leases',
  'task_attempts',
  'model_providers',
  'models',
  'model_tasks',
  'outputs',
];

function readNewMigration(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('_add_storyboard_and_timeline'));
  expect(dirs, '找不到本片的迁移目录').toHaveLength(1);
  const dir = dirs[0] ?? '';
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
}

describe('迁移范围', () => {
  it('不改动任何既有表', () => {
    const sql = readNewMigration();
    for (const table of EXISTING_TABLES) {
      const pattern = new RegExp(`ALTER TABLE\\s+"${table}"`, 'i');
      expect(pattern.test(sql), `迁移不应 ALTER 既有表 ${table}`).toBe(false);
    }
  });

  it('四张新表都建了', () => {
    const sql = readNewMigration();
    for (const table of ['storyboard_shots', 'timeline_tracks', 'timeline_clips', 'director_actions']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE\\s+"${table}"`, 'i'));
    }
  });

  it('clip 的「恰好一个来源」有 CHECK 兜底', () => {
    const sql = readNewMigration();
    expect(sql).toMatch(/CHECK/i);
    expect(sql).toMatch(/"shotId" IS NOT NULL/);
    expect(sql).toMatch(/"assetId" IS NOT NULL/);
  });
});
