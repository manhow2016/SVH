import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SVH Web（Vite）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 允许通过域名/隧道访问（SVH_ALLOWED_HOSTS 可用逗号追加，如 "a.com,b.com"）
    allowedHosts: [
      "test1.kv2ray.cc",
      ...(process.env.SVH_ALLOWED_HOSTS ? process.env.SVH_ALLOWED_HOSTS.split(",") : []),
    ],
    proxy: {
      // API 代理到 Fastify Server（可用 SVH_API_TARGET 覆盖，默认 3000）
      "/api": {
        target: process.env.SVH_API_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
