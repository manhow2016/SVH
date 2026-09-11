/**
 * 队列（Redis）健康检查
 *
 * 刻意不引入 Redis 客户端库：这里只需要回答「Redis 能不能连上并响应 PING」，
 * 用原生 TCP 发一条内联命令即可。引入完整客户端只为做健康检查是不必要的依赖。
 *
 * 注意：BullMQ 的 Worker 端会在 @svh/queue 包中使用真正的 Redis 客户端；
 * 本模块只服务于 readiness 探针。
 */
import { createConnection } from 'node:net';

export interface QueueHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Redis 内联命令的响应前缀 */
const PONG = '+PONG';

/**
 * 解析 redis:// 连接串。
 * 支持 `redis://[:password@]host[:port][/db]` 形式。
 */
export function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const parsed = new URL(url);
  const dbSegment = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(dbSegment ? { db: Number.parseInt(dbSegment, 10) } : {}),
  };
}

/**
 * 检查 Redis 连通性。
 *
 * @param url Redis 连接串
 * @param timeoutMs 超时时间，默认 800ms —— readiness 探针必须快速返回
 */
export function checkQueueHealth(url: string, timeoutMs = 800): Promise<QueueHealth> {
  const start = Date.now();

  return new Promise<QueueHealth>((resolve) => {
    let settled = false;
    const finish = (result: QueueHealth): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    let target: { host: string; port: number; password?: string };
    try {
      const { host, port, password } = parseRedisUrl(url);
      target = { host, port, ...(password ? { password } : {}) };
    } catch (err) {
      resolve({
        ok: false,
        latencyMs: Date.now() - start,
        error: `REDIS_URL 解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const socket = createConnection({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      // 有密码时先 AUTH，再 PING
      if (target.password) {
        socket.write(`AUTH ${target.password}\r\n`);
      }
      socket.write('PING\r\n');
    });

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // 有密码时第一个响应是 +OK，第二个才是 +PONG
      if (buffer.includes(PONG)) {
        finish({ ok: true, latencyMs: Date.now() - start });
      } else if (buffer.startsWith('-')) {
        // Redis 返回错误（如 NOAUTH / 密码错误）
        finish({
          ok: false,
          latencyMs: Date.now() - start,
          error: buffer.trim().slice(0, 200),
        });
      }
    });

    socket.on('timeout', () => {
      finish({ ok: false, latencyMs: Date.now() - start, error: `连接超时（${timeoutMs}ms）` });
    });

    socket.on('error', (err: Error) => {
      finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
    });
  });
}
