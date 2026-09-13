/**
 * .env 文件加载
 *
 * 职责单一：**只负责把 .env 的值填进 process.env，不做校验**。
 * 校验一律由 env.ts 的 Zod Schema 完成。
 *
 * 为什么不依赖 dotenv 包：Node 20.12+ 内置 `process.loadEnvFile()`，
 * 而本仓库要求 Node >= 20 且实际运行在 24，无需额外依赖。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 从给定目录向上查找，返回第一个存在的 .env 文件路径。
 *
 * 需要向上查找的原因：monorepo 中 `packages/*` 与 `apps/*` 的深层目录
 * 都需要找到仓库根目录的同一份 .env，避免配置分散到多个文件。
 */
export function findEnvFile(startDir: string, maxDepth = 6): string | null {
  let current = resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = resolve(current, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break; // 已到文件系统根
    current = parent;
  }
  return null;
}

/**
 * 仓库根目录 —— 找到的那份 `.env` 所在目录。
 *
 * ── 为什么必须有这个函数 ──
 * 配置里有相对路径（`STORAGE_LOCAL_DIR=./storage`），而相对路径默认按**进程 cwd**
 * 解析。monorepo 里 API 与 Worker 的 cwd 分别是 `apps/api` 与 `apps/worker`，
 * 于是同一个配置项指向两个不同的目录 —— 实测直接踩到：Worker 把产物写进
 * `apps/worker/storage/`，API 去 `apps/api/storage/` 找，接口报「文件不存在」，
 * 而落盘那一步是成功的。这种「两边各自都自洽、合起来不对」的现象极难归因。
 *
 * 找不到 `.env` 时（例如生产环境完全靠真实环境变量）退回 `startDir`，
 * 此时相对路径的行为与之前一致。
 */
export function getRepoRoot(startDir: string = process.cwd()): string {
  const envPath = findEnvFile(startDir);
  return envPath === null ? resolve(startDir) : dirname(envPath);
}

/** 加载结果，便于启动日志与排查 */
export interface LoadEnvResult {
  /** 实际加载的文件路径；未找到则为 null */
  path: string | null;
  /** 是否执行了加载 */
  loaded: boolean;
}

/**
 * 加载 .env 到 process.env。
 *
 * 重要语义：**已存在的环境变量不会被覆盖**。
 * 这让「真实环境变量优先于 .env 文件」成为确定行为 —— 容器/K8s 注入的
 * 配置不会被仓库里的 .env 意外盖掉。
 *
 * 由于 `process.loadEnvFile` 会覆盖已有变量，这里先做备份再还原。
 */
export function loadEnvFile(startDir: string = process.cwd()): LoadEnvResult {
  const path = findEnvFile(startDir);
  if (!path) return { path: null, loaded: false };

  // 备份当前已有的值，加载后还原，实现「环境变量优先」
  const preserved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    preserved.set(key, process.env[key]);
  }

  process.loadEnvFile(path);

  for (const [key, value] of preserved) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  return { path, loaded: true };
}
