import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 必须在任何测试模块被 import 之前加载 .env：
    // PrismaClient 在模块加载时构造并读取 DATABASE_URL。
    setupFiles: ['./test/setup-env.ts'],
    // 冒烟测试会真实读写本地数据库，串行执行避免相互干扰
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
