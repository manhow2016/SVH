/**
 * @svh/realtime 实时事件总线
 *
 * 基于 Redis Stream 实现「会话事件」的发布与订阅，供 SSE 端点转发给前端。
 *
 * ── 隔离约束 ──
 * 本包**不读环境变量**、**不依赖数据库**、**不依赖 HTTP 框架**：
 * 连接参数由调用方注入。这样它既能被 API 使用，也能被 Worker 使用，
 * 而两者对配置与数据库的依赖方式完全不同。
 */
export * from './keys.js';
export * from './ports.js';
export * from './parse.js';
