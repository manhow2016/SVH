#!/usr/bin/env node
/**
 * Prisma CLI 的环境变量包装器
 *
 * ── 为什么需要它 ──
 * Prisma 6 只会在「schema 所在目录」及**其上一级**查找 `.env`，
 * 而 SVH 是 monorepo：schema 在 `packages/database/prisma/`，
 * 配置却在仓库根目录。若为迁就 Prisma 而在包内再放一份 `.env`，
 * 就会出现**两份配置、互相漂移**的问题 —— 这正是启动时遇到的实际故障：
 * 根目录 `.env` 已更新为随机密钥，包内旧 `.env` 仍留着占位值。
 *
 * 因此这里做一层极薄的包装：按「本文件 → 逐级向上」查找唯一一份 `.env`，
 * 载入 `process.env`（不覆盖已存在的真实环境变量），再执行 Prisma CLI。
 *
 * 用法：node scripts/prisma-env.mjs <prisma 子命令...>
 * 例如：node scripts/prisma-env.mjs migrate dev --name init
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** 从本脚本所在目录逐级向上查找 .env（最多 6 层） */
function findEnvFile(startDir) {
  let current = resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(current, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const envPath = findEnvFile(scriptDir);
if (envPath) {
  // 备份并还原：让「真实环境变量优先于 .env」成为确定行为
  const preserved = new Map(Object.entries(process.env));
  process.loadEnvFile(envPath);
  for (const [key, value] of preserved) {
    if (value !== undefined) process.env[key] = value;
  }
  console.log(`[svh] 已加载环境变量：${envPath}`);
} else {
  console.warn('[svh] 未找到 .env，将直接使用当前进程的环境变量');
}

if (!process.env.DATABASE_URL) {
  console.error(
    '[svh] DATABASE_URL 未设置。请在仓库根目录创建 .env（可参考 .env.example）后重试。',
  );
  process.exit(1);
}

const prismaBin = resolve(scriptDir, '..', 'node_modules', '.bin', 'prisma');
const args = process.argv.slice(2);

const child = spawn(prismaBin, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[svh] Prisma 被信号中断：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
