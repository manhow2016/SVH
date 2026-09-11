/**
 * Vitest 全局前置：在任何测试模块被 import 之前加载环境变量
 *
 * ── 为什么必须放在 setupFiles 而不是 beforeAll ──
 * ESM 的 import 会被提升到模块顶部执行。`@svh/database` 在**模块加载时**
 * 就构造了 PrismaClient，而 PrismaClient 会在构造时读取 `DATABASE_URL`。
 * 若把 `bootstrapConfig()` 写在 `beforeAll` 里，PrismaClient 早已带着空的
 * 环境变量初始化完毕 —— 表现为「测试全部失败并报 DATABASE_URL 未找到」。
 *
 * `setupFiles` 会在测试文件被 import 之前执行，因此是唯一正确的位置。
 */
import { loadEnvFile } from '@svh/config';

// 从当前工作目录向上查找唯一的 .env（monorepo 根目录那一份）
loadEnvFile(process.cwd());

// 缺少 DATABASE_URL 时直接给出可操作的提示，而不是让 20 个用例各自报错
if (!process.env.DATABASE_URL) {
  throw new Error(
    '测试环境缺少 DATABASE_URL。请先在仓库根目录创建 .env（可复制 .env.example）后重试。',
  );
}
