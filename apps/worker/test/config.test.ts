import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DEFAULT_LOCALIZE_MAX_BYTES, DEFAULT_LOCALIZE_TIMEOUT_MS } from "@svh/production";
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

test("loadWorkerConfig：workspaceRoot 镜像 server 语义，localize 走 env 可调（资产本地化 spec §4/§11）", () => {
  const cfg = loadWorkerConfig({});
  // 与 server config 的 `SVH_WORKSPACE_ROOT ?? "./data/workspaces"` 同语义：仓库根相对，不随 cwd 漂移
  assert.ok(path.isAbsolute(cfg.workspaceRoot));
  assert.equal(cfg.workspaceRoot, path.resolve(import.meta.dirname, "../../../data/workspaces"));
  assert.equal(loadWorkerConfig({ SVH_WORKSPACE_ROOT: "./ws-x" }).workspaceRoot,
    path.resolve(import.meta.dirname, "../../../ws-x"));
  assert.equal(loadWorkerConfig({ SVH_WORKSPACE_ROOT: "/abs/ws" }).workspaceRoot, "/abs/ws");
  // 默认 500MB / 60s；env 覆盖生效，非法值回退（readLocalizeConfig 语义）
  assert.deepEqual(cfg.localize, {
    maxBytes: DEFAULT_LOCALIZE_MAX_BYTES,
    timeoutMs: DEFAULT_LOCALIZE_TIMEOUT_MS,
  });
  assert.deepEqual(
    loadWorkerConfig({ SVH_LOCALIZE_MAX_BYTES: "1048576", SVH_LOCALIZE_TIMEOUT_MS: "9000" }).localize,
    { maxBytes: 1048576, timeoutMs: 9000 },
  );
  assert.equal(loadWorkerConfig({ SVH_LOCALIZE_MAX_BYTES: "abc" }).localize.maxBytes, DEFAULT_LOCALIZE_MAX_BYTES);
});
