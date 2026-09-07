/**
 * 冷启动双进程并发建库测试（终审 Important#1）：
 * worker 引入后 `pnpm dev` 会同时拉起 server + worker 对同一 DB 跑
 * createDatabase（INIT + migrateSchema + runSeeds）。旧实现是进程外
 * check-then-ALTER / DROP+RENAME / 查空-播种，第二进程可能 duplicate column
 * 崩溃或交错毁 settings。现包进 BEGIN IMMEDIATE：第二进程在写锁排队、
 * 事务内重探测自然全跳。本测试 spawn 两子进程同刻起跑实测。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabase } from "../src/client";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "svh-db-conc-"));
  dirs.push(dir);
  return path.join(dir, "test.db");
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PKG_SRC = path.join(import.meta.dirname, "..", "src");

/** 子进程内联脚本：加载 tsx 后 busy-wait 到统一起跑时刻，再调 createDatabase */
const CHILD = `
(async () => {
  const { pathToFileURL } = await import("node:url");
  const mod = await import(pathToFileURL(process.env.SVH_CHILD_SRC + "/client.ts").href);
  while (Date.now() < Number(process.env.SVH_CHILD_GO)) { /* 自旋对齐起跑线 */ }
  try {
    const db = mod.createDatabase(process.env.SVH_CHILD_DB);
    const n = db.$client.prepare("select count(*) c from models").get();
    console.log("child-ok " + n.c);
    process.exit(0);
  } catch (err) {
    console.error("child-fail " + (err && err.stack ? err.stack : err));
    process.exit(1);
  }
})();
`;

function spawnInit(dbFile: string, goAt: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", CHILD],
      {
        cwd: path.join(import.meta.dirname, ".."), // tsx 与依赖解析自本包
        env: { ...process.env, SVH_CHILD_DB: dbFile, SVH_CHILD_SRC: PKG_SRC, SVH_CHILD_GO: String(goAt) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("双进程并发 createDatabase：双双 exit 0，终态 schema 与播种幂等正确", async () => {
  const dbFile = tmpFile();
  // 起跑线留足模块加载时间（tsx 冷启动 ~1-3s），两子进程同刻进 createDatabase
  const goAt = Date.now() + 5000;
  const [a, b] = await Promise.all([spawnInit(dbFile, goAt), spawnInit(dbFile, goAt)]);
  assert.equal(a.code, 0, `child A 失败：${a.err}`);
  assert.equal(b.code, 0, `child B 失败：${b.err}`);
  assert.match(a.out, /child-ok [1-9]\d*/);
  assert.match(b.out, /child-ok [1-9]\d*/);

  // 终态：队列列齐全、settings 已重建为复合主键版、第三进程再开仍幂等
  const db = createDatabase(dbFile);
  const taskCols = (db.$client.prepare("PRAGMA table_info(production_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const col of ["payload", "claimed_by", "heartbeat_at"]) assert.ok(taskCols.includes(col), `缺列 ${col}`);
  const settingCols = (db.$client.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(settingCols.includes("user_id"), "settings 未含 user_id");
  assert.ok((db.$client.prepare("select count(*) c from models").get() as { c: number }).c >= 10, "模型播种缺失");
  db.$client.close();
});
