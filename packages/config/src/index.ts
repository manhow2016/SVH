/**
 * @svh/config —— 配置访问入口
 *
 * ── 使用约定（必须遵守） ──
 *
 * 1. **服务入口第一件事**是调用 `loadEnvFile()`，然后 `getEnv()`：
 *    ```ts
 *    import { bootstrapConfig } from '@svh/config';
 *    const env = bootstrapConfig();   // 加载 .env → Zod 校验 → fail-fast
 *    ```
 * 2. **业务代码禁止直接读 process.env**。一律 `getEnv()`，
 *    这样才有单一事实来源与类型安全。审计结论 ⑪ 的根因就是散落的
 *    `process.env.X ?? '默认值'`。
 * 3. `getEnv()` 是**惰性单例**：首次调用时校验并缓存。若此前没有加载 .env，
 *    会因缺少必填项而立即失败 —— 这是期望行为（fail-fast 优于静默降级）。
 */
import { resolve } from 'node:path';

import { getRepoRoot, loadEnvFile, type LoadEnvResult } from './loader.js';
import { parseEnv, type Env } from './env.js';

export * from './env.js';
export { loadEnvFile, findEnvFile, getRepoRoot } from './loader.js';
export type { LoadEnvResult } from './loader.js';

let cachedEnv: Env | null = null;

/**
 * 获取解析后的环境配置（惰性单例）。
 *
 * @throws {EnvValidationError} 配置缺失或非法时抛出，包含全部问题清单
 */
export function getEnv(): Env {
  if (cachedEnv === null) {
    cachedEnv = parseEnv();
  }
  return cachedEnv;
}

/**
 * 服务启动引导：加载 .env → 校验环境变量。
 *
 * 这是 API / Worker 入口应当调用的唯一配置函数。
 */
export function bootstrapConfig(options: { startDir?: string } = {}): {
  env: Env;
  envFile: LoadEnvResult;
} {
  const envFile = loadEnvFile(options.startDir ?? process.cwd());
  const env = getEnv();
  return { env, envFile };
}

/**
 * 仅测试使用：覆盖或清空缓存的环境配置。
 * 生产代码不得调用。
 */
export function __setEnvForTesting(env: Env | null): void {
  cachedEnv = env;
}

/** 当前是否为生产环境 */
export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

/**
 * 派生配置：常用组合值，避免各处重复拼装。
 *
 * 注意这里**没有** useMockProvider —— 是否使用 Mock 由数据库里
 * 是否存在可用的真实模型自动决定（见 @svh/database 的 buildModelRuntime），
 * 而不是由环境变量开关控制。
 */
export function derivedConfig(): {
  apiBaseUrl: string;
  storagePublicBaseUrl: string;
  /**
   * 素材落盘根目录，**已解析为绝对路径**（相对于仓库根，而不是进程 cwd）。
   *
   * 见 `getRepoRoot` 的说明：API 与 Worker 的 cwd 不同，相对路径会让两边
   * 指向不同目录。这里统一解析一次，两个消费方直接用绝对值。
   */
  storageLocalDir: string;
  isProduction: boolean;
} {
  const env = getEnv();
  return {
    apiBaseUrl: env.API_PUBLIC_URL,
    storagePublicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    storageLocalDir: resolve(getRepoRoot(), env.STORAGE_LOCAL_DIR),
    isProduction: env.NODE_ENV === 'production',
  };
}
