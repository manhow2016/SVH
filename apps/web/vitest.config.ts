import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: false,
    testTimeout: 20_000,
    // 前端用例不碰数据库与 Redis，可以并行；串行化会白白拖慢反馈
    fileParallelism: true,
  },
});
