/**
 * Worker 主循环（spec §4.1）：tick = 心跳 → 按空闲槽原子 claim → 异步跑 handler。
 * 启动无特殊恢复：崩溃遗留 running 任务由 stale 心跳回收自动接管。
 * 本模块无顶层副作用，入口见 src/main.ts。
 */
import type { SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import { claimTasks, heartbeat, type ClaimedTask } from "./queue";
import type { WorkerConfig } from "./config";
import { errMessage, runTask, type HandlerDeps } from "./handlers";

export type { HandlerDeps } from "./handlers";

export function createWorkerLoop(
  db: SVHDatabase,
  production: ProductionService,
  config: WorkerConfig,
  deps: HandlerDeps,
  log: (msg: string, extra?: Record<string, unknown>) => void = (m) => console.log(`[worker] ${m}`),
): { tick: () => void; active: () => number; stop: () => Promise<void> } {
  let activeCount = 0;
  let stopped = false;

  // 日志器异常绝不击穿主循环（tick 由 setInterval 驱动，同步抛出=进程崩）
  const safeLog = (msg: string): void => {
    try {
      log(msg);
    } catch {
      /* 观测失败不影响调度 */
    }
  };

  /**
   * tick 内 DB 读写在跨进程写锁竞争下可能瞬时抛 `database is locked`
   * （Task 4 评审承传#1 + 修复轮#9）：heartbeat/claim 各自 catch 记一行日志，
   * 外层再兜底一层——「绝不双领」依旧成立，任何异常都不上抛、不泄漏槽位。
   */
  const tick = (): void => {
    if (stopped) return;
    try {
      try {
        heartbeat(db, config.workerId);
      } catch (err) {
        // 心跳只刷新既有 running 行；瞬态失败不影响本轮认领（claim 自带心跳）
        safeLog(`transient 心跳锁冲突，继续本轮认领：${errMessage(err)}`);
      }
      const slots = config.concurrency - activeCount;
      if (slots <= 0) return;
      let claimed: ClaimedTask[];
      try {
        claimed = claimTasks(db, config.workerId, { limit: slots, staleMs: config.staleMs });
      } catch (err) {
        safeLog(`transient claim 锁冲突，下轮重试：${errMessage(err)}`);
        return;
      }
      // 认领者即本 loop；归属自查基准在 ClaimedTask.claimedBy，无需再透传 workerId
      const handlerDeps: HandlerDeps = { ...deps, log: deps.log ?? safeLog };
      for (const task of claimed) {
        activeCount += 1;
        // 日志调用移入 promise 链（评审#9）：log 抛错走 catch，finally 保证槽位归还
        void Promise.resolve()
          .then(() => {
            safeLog(`任务开始 ${task.kind} ${task.id}`);
            return runTask(db, production, task, handlerDeps);
          })
          .catch((err) => safeLog(`任务异常 ${task.id}: ${errMessage(err)}`))
          .finally(() => {
            activeCount -= 1;
          });
      }
    } catch (err) {
      safeLog(`tick 兜底捕获：${errMessage(err)}`);
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
