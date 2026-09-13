/**
 * `@svh/database` 测试的全局前置：在任何测试模块被 import 之前加载环境变量。
 *
 * 与 `apps/api/test/setup-env.ts`、`apps/worker/test/setup-env.ts` 同理：
 * ESM 的 import 会被提升，而 `PrismaClient` 在**模块加载时**就构造并读取
 * `DATABASE_URL`。放进 `beforeAll` 已经太晚 —— 表现是「测试全部失败并报
 * `Environment variable not found: DATABASE_URL`」。
 *
 * 本包此前不需要它：`enum-drift.test.ts` 只把 `schema.prisma` 当文本解析，
 * 从不连库。`model-runtime-fallback.test.ts` 是第一个真的要读写的用例
 * （它要验证 Mock 占位行的写入形状），所以这里补上。
 */
import { loadEnvFile } from '@svh/config';

loadEnvFile(process.cwd());

if (!process.env.DATABASE_URL) {
  throw new Error(
    '测试环境缺少 DATABASE_URL。请先在仓库根目录创建 .env（可复制 .env.example）后重试。',
  );
}
