import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index";

export type SVHDatabase = BetterSQLite3Database<typeof schema>;

/** 初始化建表 SQL（与 drizzle schema 保持一致） */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新会话',
  status TEXT NOT NULL DEFAULT 'idle',
  model_provider_id TEXT NOT NULL DEFAULT 'openai-compatible',
  model_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`;

/**
 * 创建数据库客户端
 *
 * @param databaseUrl 形如 `file:./data/svh.db` 或普通文件路径
 * @returns drizzle 客户端（含 schema）
 */
export function createDatabase(databaseUrl: string): SVHDatabase {
  const filePath = resolveDatabasePath(databaseUrl);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(INIT_SQL);
  migrateLegacyTimestamps(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * 旧库迁移：早期 created_at/updated_at 以「秒」存储（drizzle timestamp 模式），
 * 现改为毫秒精度（timestamp_ms），需将旧行 ×1000 对齐。
 */
function migrateLegacyTimestamps(sqlite: InstanceType<typeof Database>): void {
  const THRESHOLD = 100000000000; // 1e11：秒级值（~1.7e9）远小于此，毫秒级（~1.7e12）远大于此
  const tables: Array<[string, string[]]> = [
    ["workspaces", ["created_at", "updated_at"]],
    ["sessions", ["created_at", "updated_at"]],
    ["messages", ["created_at"]],
    ["settings", ["updated_at"]],
  ];
  for (const [table, columns] of tables) {
    for (const column of columns) {
      sqlite.exec(
        `UPDATE ${table} SET ${column} = ${column} * 1000 WHERE ${column} < ${THRESHOLD};`,
      );
    }
  }
}

/** 解析数据库 URL：剥离 file: 前缀 */
export function resolveDatabasePath(databaseUrl: string): string {
  let p = databaseUrl;
  if (p.startsWith("file:")) {
    p = p.slice("file:".length);
  }
  if (p === "") {
    throw new Error("Invalid database URL: empty path");
  }
  return path.resolve(p);
}
