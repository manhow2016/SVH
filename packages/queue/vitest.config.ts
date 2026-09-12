import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 队列往返测试需要读取 REDIS_URL；env 由测试文件内显式加载，
    // 这里只约定串行执行，避免多个用例争抢同一批队列作业。
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
