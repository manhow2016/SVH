import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 事件流测试共享同一个 Redis 库，串行执行避免用例之间互相看到对方的流
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
