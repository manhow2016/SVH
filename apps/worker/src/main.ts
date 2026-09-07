/**
 * Worker 进程入口（package.json dev/start 指向本文件）：
 * 组装 DB / ProductionService / 主循环，setInterval 驱动 tick，
 * SIGINT/SIGTERM 优雅退出（停表 → 收尾运行中任务 → 退出）。
 */
import { createDatabase } from "@svh/database";
import { DrizzleProductionRepository, ProductionService } from "@svh/production";
import { loadWorkerConfig } from "./config";
import { createWorkerLoop } from "./index";

function main(): void {
  const config = loadWorkerConfig();
  const db = createDatabase(config.databaseUrl);
  const production = new ProductionService(new DrizzleProductionRepository(db));
  const loop = createWorkerLoop(db, production, config, {
    pollIntervalMs: config.pollMs,
    maxWaitMs: config.maxWaitMs,
  });
  const timer = setInterval(loop.tick, config.tickMs);
  loop.tick(); // 启动立即跑一轮，免等首个 tick
  console.log(
    `[worker] started id=${config.workerId} db=${config.databaseUrl} concurrency=${config.concurrency}`,
  );
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[worker] ${sig}，停止认领并收尾退出`);
      clearInterval(timer);
      void loop.stop().then(() => process.exit(0));
    });
  }
}

main();
