/**
 * 迁移范围护栏
 *
 * 「既有表 0 列改动」是本片对外承诺的验收标准之一，但它是**很容易被破坏**
 * 的承诺：将来有人手滑在迁移里加一个 `ALTER TABLE "contents" ADD COLUMN ...`，
 * 所有测试仍然是绿的。这里把该承诺变成一条会红的断言。
 *
 * ── 为什么是「白名单」而不是「既有表黑名单」（Ruling 19）──
 * 最初的写法是逐个既有表去匹配 `ALTER TABLE\s+"contents"`。这种黑名单**可以被
 * 轻易旁路**，实测漏过以下全部写法：
 *   - `ALTER TABLE ONLY "contents" ADD COLUMN ...`（ONLY 插在中间，pg_dump 常见风格）
 *   - `ALTER TABLE public."contents" ADD COLUMN ...`（schema 限定）
 *   - `ALTER TABLE contents ADD COLUMN ...`（未加引号）
 *   - `DROP TABLE "contents";` / `DELETE FROM "contents";`（黑名单根本没检查）
 * 因此改为**反转**：本片的两个迁移（建表 + 级联修正）都只允许碰它们自己新建的
 * 4 张表，任何其它目标一律失败。
 * 白名单不依赖「既有表清单」是否完整 —— 那份清单本身也会过期。
 *
 * 同时守住另外几件容易忘记的事：四张表都建了、没有破坏性语句、
 * CHECK 约束真的写进去了且语义是「恰好一个来源」。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/** 本迁移唯一允许触碰的表：本片新建的四张 */
const ALLOWED_TARGETS = new Set([
  'storyboard_shots',
  'timeline_tracks',
  'timeline_clips',
  'director_actions',
]);

/** CHECK 约束名：定义与挂载表都由下面这条断言钉死 */
const CLIP_CHECK_NAME = 'timeline_clips_exactly_one_source_check';

/**
 * 手写 CHECK 的期望定义（归一化空白后逐字比对）。
 * 注意 `= 1` 不能写成 `<= 1`：后者允许「0 个来源」，直接破坏「恰好一个来源」，
 * 而「存在 CHECK」这种弱断言是发现不了的。
 */
const EXPECTED_CHECK_STATEMENT =
  'ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_exactly_one_source_check" ' +
  'CHECK ((("shotId" IS NOT NULL)::int + ("assetId" IS NOT NULL)::int) = 1)';

function readNewMigration(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('_add_storyboard_and_timeline'));
  expect(dirs, '找不到本片的迁移目录').toHaveLength(1);
  const dir = dirs[0] ?? '';
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
}

/**
 * 本片的第二个迁移：把 `timeline_clips."assetId"` 的外键从 `SET NULL` 改为级联
 * （Ruling 28，与「恰好一个来源」CHECK 互斥的修正）。
 *
 * 它同样只允许碰新表 —— 只护栏第 1 个迁移的话，第二个迁移里一句
 * `ALTER TABLE "contents" …` 不会有任何用例变红。
 */
function readCascadeMigration(): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((name) =>
    name.endsWith('_timeline_clip_asset_cascade'),
  );
  expect(dirs, '找不到级联修正的迁移目录').toHaveLength(1);
  const dir = dirs[0] ?? '';
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
}

/** 把整条语句折叠成一行，失败信息里才能一眼看清是哪句话越界了 */
function readStatementAt(sql: string, start: number): string {
  const end = sql.indexOf(';', start);
  return sql
    .slice(start, end === -1 ? undefined : end + 1)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 只取 CHECK 那一条语句（已归一化空白）。
 * 断言整份 SQL 会连文件内容一起打进失败信息，几十行噪声里反而看不清差异；
 * 截出这一条，失败信息就是「期望 vs 实际」两行 SQL 的直接对照。
 */
function readCheckStatement(flattened: string): string {
  const at = flattened.indexOf(CLIP_CHECK_NAME);
  if (at === -1) return '';
  const start = flattened.lastIndexOf('ALTER TABLE', at);
  return readStatementAt(flattened, start === -1 ? at : start).replace(/;$/, '');
}

interface StatementTarget {
  table: string;
  statement: string;
}

/**
 * 取出所有会改动某张表的语句目标：
 *   - `ALTER TABLE [ONLY] [public.]"表"`（含 ADD COLUMN / ADD CONSTRAINT / ALTER COLUMN …）
 *   - `CREATE [UNIQUE] INDEX … ON "表"`
 * 两类都必须在白名单内，否则「只动新表」的承诺就有缺口
 * （例如 `CREATE INDEX ... ON "contents"` 同样是改动既有表）。
 */
function collectWriteTargets(sql: string): StatementTarget[] {
  const targets: StatementTarget[] = [];

  for (const match of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([A-Za-z_]\w*)"?/gi)) {
    targets.push({ table: match[1] ?? '', statement: readStatementAt(sql, match.index ?? 0) });
  }

  for (const match of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?"?[A-Za-z_]\w*"?\s+ON\s+(?:public\.)?"?([A-Za-z_]\w*)"?/gi)) {
    targets.push({ table: match[1] ?? '', statement: readStatementAt(sql, match.index ?? 0) });
  }

  return targets;
}

describe('迁移范围', () => {
  it('迁移目录唯一且命名正确', () => {
    const dirs = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('_add_storyboard_and_timeline'));
    expect(dirs, '找不到本片的迁移目录').toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{14}_add_storyboard_and_timeline$/);
  });

  it('四张新表都建了', () => {
    const sql = readNewMigration();
    for (const table of ['storyboard_shots', 'timeline_tracks', 'timeline_clips', 'director_actions']) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE\\s+"${table}"`, 'i'));
    }
  });

  it('只变更本片新建的四张表（写入目标白名单，覆盖两个迁移）', () => {
    const additive = readNewMigration();
    const cascade = readCascadeMigration();
    const targets = [...collectWriteTargets(additive), ...collectWriteTargets(cascade)];

    // 反空转断言：正则若失效会一条都解析不到，白名单就会「永远绿」。
    // 两个迁移确实都对四张新表有写入语句（建表 / 索引 / 外键 / CHECK / 改外键），
    // 故要求四张都出现过。
    const touched = new Set(targets.map((t) => t.table));
    expect(
      [...ALLOWED_TARGETS].filter((table) => !touched.has(table)),
      '解析不到任何针对该新表的语句，白名单可能已失效',
    ).toEqual([]);

    const violations = targets.filter((t) => !ALLOWED_TARGETS.has(t.table));
    expect(
      violations.map((v) => `越界写入目标「${v.table}」：${v.statement}`),
      '迁移只允许改动本片新建的四张表',
    ).toEqual([]);
  });

  it('是纯加法迁移：不含 DROP / TRUNCATE / DELETE / UPDATE', () => {
    const sql = readNewMigration();

    /*
     * 本迁移是 Prisma 针对 4 张**新表**生成的加法迁移，ADD COLUMN 之外不需要任何
     * DDL/DML 回写，所以这里可以做**整文件**禁令，而不只是「针对既有表」的禁令：
     * 一旦出现这些语句，要么在动既有数据，要么就是生成物被人为改过，两种都该红灯。
     *
     * 唯一需要先剥离的是外键子句里的引用动作 —— `ON DELETE CASCADE` /
     * `ON UPDATE CASCADE` 是约束的一部分，不是破坏性语句；不剥离会把 10 条外键
     * 全部误判为 DELETE/UPDATE。
     */
    const withoutReferentialActions = sql.replace(
      /ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT)/gi,
      '',
    );

    for (const pattern of [/\bDROP\s+TABLE\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\b/i]) {
      expect(withoutReferentialActions, `纯加法迁移不应出现 ${pattern}`).not.toMatch(pattern);
    }
  });

  it('clip 的「恰好一个来源」CHECK 挂在 timeline_clips 上且语义为 = 1', () => {
    const sql = readNewMigration();
    const flattened = sql.replace(/\s+/g, ' ').trim();

    // 约束名只允许出现一次，避免「挂错表 + 又补一条对的」这种双写掩盖
    expect(sql.match(new RegExp(CLIP_CHECK_NAME, 'g')) ?? []).toHaveLength(1);

    // 归一化空白后逐字比对：表名（timeline_clips 而非 storyboard_shots）、
    // 约束名、以及 `= 1`（而非 `<= 1`）三件事被同一条断言钉死。
    expect(readCheckStatement(flattened), 'CHECK 应挂在 timeline_clips 上且语义为「恰好一个来源」').toBe(
      EXPECTED_CHECK_STATEMENT,
    );
  });
});
