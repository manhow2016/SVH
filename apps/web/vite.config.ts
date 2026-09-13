import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Vite 配置。
 *
 * `/api` 代理到本地 API 进程：这样前端代码里统一用相对路径 `/api/...`，
 * 开发时不需要 CORS，也不需要在前端维护「后端地址」这个配置项。
 *
 * ── 为什么要配 `allowedHosts` ──
 * Vite 6 起给开发服务器加了 DNS rebinding 防护：Host 头不是本机名字就直接
 * 挡在门外，页面只有一句
 * 「Blocked request. This host ("…") is not allowed.」。
 * 用隧道 / 反向代理访问（例如 `test1.kv2ray.cc` → `127.0.0.1:5173`）必然撞上，
 * 而且它挡的是**页面本身**，不是某个接口 —— 看起来像服务没起来。
 *
 * 域名**不写死在源码里**，放在仓库根目录的 `.env`（已被 .gitignore 覆盖），
 * 与其它配置同一处，换域名不用改代码：
 *
 *   VITE_ALLOWED_HOSTS=test1.kv2ray.cc,another.example.com
 *
 * 逗号分隔；条目写成 `.example.com` 这种带前导点的形式表示放行它的全部子域。
 * 本机名字始终放行（显式列出来，改这个变量不会把 localhost 访问弄坏）。
 */
export default defineConfig(({ mode }) => {
  /*
   * `import.meta.url` 在这里指向的是**本配置文件**而不是打包后的临时产物 ——
   * Vite 打包配置时会把它重写成原文件的 file URL（`bundleConfigFile` 里的
   * `import.meta.url` define）。所以往上两级就是仓库根，与 `@svh/config` 的
   * `loadEnvFile` 读的是同一份 `.env`。
   */
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, repoRoot, '');

  const tunnelHosts = (env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...tunnelHosts],
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
  };
});
