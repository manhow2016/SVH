/**
 * Worker 测试的全局前置：在任何测试模块被 import 之前加载环境变量。
 *
 * 与 apps/api/test/setup-env.ts 同理：ESM 的 import 会被提升，
 * PrismaClient 在模块加载时就构造并读取 DATABASE_URL，
 * 因此 env 加载必须放在 setupFiles 而不是 beforeAll。
 */
import { loadEnvFile } from '@svh/config';

loadEnvFile(process.cwd());

if (!process.env.DATABASE_URL) {
  throw new Error(
    '测试环境缺少 DATABASE_URL。请先在仓库根目录创建 .env（可复制 .env.example）后重试。',
  );
}
