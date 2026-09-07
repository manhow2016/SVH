import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadWorkerConfig } from "../src/config";

test("loadWorkerConfig：默认 databaseUrl 与 server 同语义（仓库根相对，不随 cwd 漂移）", () => {
  const cfg = loadWorkerConfig({});
  // 不硬编码绝对路径：断言绝对 + 以 data/svh.db 结尾 + 恰位于仓库根下
  assert.ok(path.isAbsolute(cfg.databaseUrl), `应为绝对路径: ${cfg.databaseUrl}`);
  assert.ok(
    cfg.databaseUrl.endsWith(path.join("data", "svh.db")),
    `应以 data${path.sep}svh.db 结尾: ${cfg.databaseUrl}`,
  );
  assert.equal(cfg.databaseUrl, path.resolve(import.meta.dirname, "../../../data/svh.db"));
  // 显式相对值（含 file: 前缀）同样按仓库根解析；绝对值原样透传
  assert.equal(
    loadWorkerConfig({ SVH_DATABASE_URL: "file:./data/x.db" }).databaseUrl,
    path.resolve(import.meta.dirname, "../../../data/x.db"),
  );
  assert.equal(loadWorkerConfig({ SVH_DATABASE_URL: "/abs/svh.db" }).databaseUrl, "/abs/svh.db");
});
