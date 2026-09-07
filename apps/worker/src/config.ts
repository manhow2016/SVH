/** worker 配置（spec §4.4）：全部 env 可覆盖，默认适配本地单文件库 */
export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  concurrency: number;
  tickMs: number;
  pollMs: number;
  staleMs: number;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: env.SVH_DATABASE_URL ?? "./data/svh.db",
    workerId: env.SVH_WORKER_ID ?? `wkr-${process.pid}`,
    concurrency: num(env.SVH_WORKER_CONCURRENCY, 2),
    tickMs: num(env.SVH_WORKER_TICK_MS, 2000),
    pollMs: num(env.SVH_WORKER_POLL_MS, 5000),
    staleMs: num(env.SVH_WORKER_STALE_MS, 60_000),
  };
}
