import { loadConfig } from "./config/index";
import { buildApp } from "./app";

/**
 * SVH Server 入口。
 *
 * 启动：pnpm --filter @svh/server dev（tsx watch）
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  app.log.info({ databaseUrl: config.databaseUrl, workspaceRoot: config.workspaceRoot }, "svh server booting");

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`SVH server listening on http://localhost:${config.port}`);
}

main().catch((err) => {
  // 启动失败：记录后退出，但不泄漏敏感信息
  console.error("[svh] server failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
