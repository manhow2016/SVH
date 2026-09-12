import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置。
 *
 * `/api` 代理到本地 API 进程：这样前端代码里统一用相对路径 `/api/...`，
 * 开发时不需要 CORS，也不需要在前端维护「后端地址」这个配置项。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3030',
        changeOrigin: true,
        // SSE 必须关闭代理层缓冲，否则事件会被攒着一起发
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
