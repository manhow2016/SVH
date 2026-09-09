/**
 * worker 配置（spec §4.4）：全部 env 可覆盖，默认适配本地单文件库。
 * DB 路径解析与 apps/server 同语义：相对路径（含/不含 file: 前缀）一律基于仓库根，
 * 绝对路径原样——防止从 apps/worker 目录启动时按 cwd 静默指向错误空库（Task 8 实测踩坑）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalizeConfig } from "@svh/production";

/** 仓库根（apps/worker/src → SVH 根），与 server config 的推导深度一致（dist 构建后同级） */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 相对路径基于仓库根解析（镜像 server config 的同名私有函数，刻意不跨 app import） */
function resolveFromRoot(p: string): string {
  if (p.startsWith("file:")) {
    const stripped = p.slice("file:".length);
    return path.isAbsolute(stripped) ? stripped : path.resolve(REPO_ROOT, stripped);
  }
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  /** 全局并发（同时处理任务数上限） */
  concurrency: number;
  /** provider 并发预算（0 = 不限）：同一供应商同时 running 任务数上限 */
  providerBudget: number;
  /** project 并发预算（0 = 不限）：同一项目同时 running 任务数上限 */
  projectBudget: number;
  tickMs: number;
  pollMs: number;
  staleMs: number;
  /** 视频任务最长等待（毫秒），超限置 failed，防僵尸轮询 */
  maxWaitMs: number;
  /**
   * 工作区根（资产转存落盘的根，绝对路径）。
   * 与 apps/server config 同语义：`SVH_WORKSPACE_ROOT ?? "<仓库根>/data/workspaces"`——
   * 两端必须指向同一目录，否则 server 的 media 路由读不到 worker 转存的产物。
   */
  workspaceRoot: string;
  /**
   * 全局资产库根（「我的资产」文件库；与 apps/server config 同语义：
   * `SVH_ASSETS_ROOT ?? "<仓库根>/data/assets"`）。资产库生成任务完成后，
   * worker 把产物文件发布到这里的 <文件夹>/<类型目录>/ 下。
   */
  assetsRoot: string;
  /** 转存单文件上限与单次超时（SVH_LOCALIZE_MAX_BYTES / SVH_LOCALIZE_TIMEOUT_MS，非法值回退默认） */
  localize: { maxBytes: number; timeoutMs: number };
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 预算解析：允许 0（不限）的整数，非法/负数回退 fallback */
function budget(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: resolveFromRoot(env.SVH_DATABASE_URL ?? "./data/svh.db"),
    workerId: env.SVH_WORKER_ID ?? `wkr-${process.pid}`,
    concurrency: num(env.SVH_WORKER_CONCURRENCY, 2),
    providerBudget: budget(env.SVH_WORKER_PROVIDER_BUDGET, 0),
    projectBudget: budget(env.SVH_WORKER_PROJECT_BUDGET, 0),
    tickMs: num(env.SVH_WORKER_TICK_MS, 2000),
    pollMs: num(env.SVH_WORKER_POLL_MS, 5000),
    staleMs: num(env.SVH_WORKER_STALE_MS, 60_000),
    maxWaitMs: num(env.SVH_WORKER_MAXWAIT_MS, 900_000),
    workspaceRoot: resolveFromRoot(env.SVH_WORKSPACE_ROOT ?? "./data/workspaces"),
    assetsRoot: resolveFromRoot(env.SVH_ASSETS_ROOT ?? "./data/assets"),
    localize: readLocalizeConfig(env),
  };
}
