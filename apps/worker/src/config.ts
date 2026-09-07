/**
 * worker 配置（spec §4.4）：全部 env 可覆盖，默认适配本地单文件库。
 * DB 路径解析与 apps/server 同语义：相对路径（含/不含 file: 前缀）一律基于仓库根，
 * 绝对路径原样——防止从 apps/worker 目录启动时按 cwd 静默指向错误空库（Task 8 实测踩坑）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  concurrency: number;
  tickMs: number;
  pollMs: number;
  staleMs: number;
  /** 视频任务最长等待（毫秒），超限置 failed，防僵尸轮询 */
  maxWaitMs: number;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: resolveFromRoot(env.SVH_DATABASE_URL ?? "./data/svh.db"),
    workerId: env.SVH_WORKER_ID ?? `wkr-${process.pid}`,
    concurrency: num(env.SVH_WORKER_CONCURRENCY, 2),
    tickMs: num(env.SVH_WORKER_TICK_MS, 2000),
    pollMs: num(env.SVH_WORKER_POLL_MS, 5000),
    staleMs: num(env.SVH_WORKER_STALE_MS, 60_000),
    maxWaitMs: num(env.SVH_WORKER_MAXWAIT_MS, 900_000),
  };
}
