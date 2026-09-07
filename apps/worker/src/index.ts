/**
 * Worker 主循环（spec §4.1）：tick = 心跳 → 按空闲槽原子 claim → 异步跑 handler。
 * 启动无特殊恢复：崩溃遗留 running 任务由 stale 心跳回收自动接管。
 * 本模块无顶层副作用，入口见 src/main.ts。
 */
import type { SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import { claimTasks, heartbeat } from "./queue";
import type { WorkerConfig } from "./config";
import { runTask, type HandlerDeps } from "./handlers";

export type { HandlerDeps } from "./handlers";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * tick 内 DB 读写（heartbeat/claim）在跨进程写锁竞争下可能瞬时抛
 * `database is locked`（Task 4 评审承传#1）：绝不双领依旧成立，
 * 这里 catch + 日志，本轮放弃、下轮重试，永不让 tick 上抛击穿进程。
 */
export function createWorkerLoop(
  db: SVHDatabase,
  production: ProductionService,
  config: WorkerConfig,
  deps: HandlerDeps,
  log: (msg: string, extra?: Record<string, unknown>) => void = (m) => console.log(`[worker] ${m}`),
): { tick: () => void; active: () => number; stop: () => Promise<void> } {
  let activeCount = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      heartbeat(db, config.workerId);
    } catch (err) {
      log(`transient 心跳锁冲突，下轮重试：${errMessage(err)}`);
      return; // 锁竞争期：本轮直接放弃
    }
    const slots = config.concurrency - activeCount;
    if (slots <= 0) return;
    let claimed: ReturnType<typeof claimTasks>;
    try {
      claimed = claimTasks(db, config.workerId, { limit: slots, staleMs: config.staleMs });
    } catch (err) {
      log(`transient claim 锁冲突，下轮重试：${errMessage(err)}`);
      return;
    }
    for (const task of claimed) {
      activeCount += 1;
      log(`任务开始 ${task.kind} ${task.id}`);
      void runTask(db, production, task, deps)
        .catch((err) => log(`任务异常 ${task.id}: ${errMessage(err)}`))
        .finally(() => {
          activeCount -= 1;
        });
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    const deadline = Date.now() + 5000; // best-effort：等运行中 handler 收尾（spec §4.4）
    while (activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  return { tick, active: () => activeCount, stop };
}
