/**
 * Worker 进程入口（package.json dev/start 指向本文件）：
 * 组装 DB / ProductionService / 主循环，setInterval 驱动 tick，
 * SIGINT/SIGTERM 优雅退出（停表 → 收尾运行中任务 → 退出）。
 */
import { createDatabase } from "@svh/database";
import { DrizzleProductionRepository, ProductionService, TimelineService } from "@svh/production";
import { loadWorkerConfig } from "./config";
import { createWorkerLoop } from "./index";

function main(): void {
  const config = loadWorkerConfig();
  const db = createDatabase(config.databaseUrl);
  const production = new ProductionService(new DrizzleProductionRepository(db));
  // V0.3 Phase 8：时间轴状态回写（渲染任务完成后 rendering → completed/failed）
  const timeline = new TimelineService(new DrizzleProductionRepository(db));
  const loop = createWorkerLoop(db, production, config, {
    pollIntervalMs: config.pollMs,
    maxWaitMs: config.maxWaitMs,
    // 转存（spec §4）：workspaceRoot 与 server 同语义，localize 走 env 可调上限/超时；
    // fetchImpl 不注入 → localizeToFile 内部缺省 globalThis.fetch
    workspaceRoot: config.workspaceRoot,
    // 「我的资产」库发布：与 server assetsRoot 同语义（SVH_ASSETS_ROOT ?? <仓库根>/data/assets）
    assetsRoot: config.assetsRoot,
    localizeConfig: config.localize,
    timeline,
  });
  const timer = setInterval(loop.tick, config.tickMs);
  loop.tick(); // 启动立即跑一轮，免等首个 tick
  console.log(
    `[worker] started id=${config.workerId} db=${config.databaseUrl} concurrency=${config.concurrency} providerBudget=${config.providerBudget} projectBudget=${config.projectBudget}`,
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
