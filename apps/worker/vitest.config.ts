import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 必须在任何测试模块被 import 之前加载 .env：
    // PrismaClient 在模块加载时构造并读取 DATABASE_URL。
    setupFiles: ['./test/setup-env.ts'],
    // 端到端测试会真实读写数据库与 Redis，串行执行避免相互干扰
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
