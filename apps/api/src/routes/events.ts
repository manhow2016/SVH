/**
 * SSE 实时推送端点
 *
 * 对应技术文档第 72 条。协议定义见 `@svh/domain` 的 transport.ts。
 *
 * ── 为什么用 reply.hijack() ──
 * SSE 是**永不结束**的响应，与 Fastify 默认的「处理函数返回后即发送响应」
 * 模型冲突。hijack 明确表示「这个响应由我自己写」，框架不再插手。
 *
 * ── 断点续传的实现顺序（关键） ──
 * 1. 先 XADD 一条 session.ready，拿到它的 Stream ID 作为**基准游标**
 * 2. 把基准游标作为 SSE 的 id: 下发给客户端
 * 3. 若客户端带 Last-Event-ID，则从客户端游标开始订阅 —— 订阅器内部会
 *    先补发 (客户端游标, 当前] 区间，再用同一游标转入实时
 *
 * 第 3 步的「补发与实时共用同一游标」是审计结论 ⑫ 的正面修复：
 * 参考项目的 SSE 在重连后永久静默，正是因为在 replay 与 subscribe
 * 之间存在空窗。这里不存在空窗。
 */
import type { FastifyInstance } from 'fastify';

import { getEnv } from '@svh/config';
import { NotFoundError, type SseEnvelope } from '@svh/domain';
import { prisma } from '@svh/database';
import { parseRedisConnection } from '@svh/queue';
import { createEventStream, type RedisConnectionOptions } from '@svh/realtime';

import { getEventPublisher } from '../core/events.js';
import { parseIdParam } from '../core/validate.js';

/** 重连建议间隔（毫秒），下发给浏览器 */
const RETRY_MS = 3000;

/**
 * 事件订阅使用**独立**连接。
 *
 * 不能复用发布器的连接：XREAD BLOCK 会独占连接，
 * 复用它会让该连接上的所有发布命令一起被阻塞。
 */
function subscribeConnection(): RedisConnectionOptions {
  return parseRedisConnection(getEnv().REDIS_URL);
}

/**
 * 解析并校验 `Last-Event-ID` 请求头。
 *
 * 这是**外部可控输入**，不能直接透传给订阅器：非法游标会让 XRANGE 与 XREAD
 * 双双失败，客户端表现为「建连即断、反复重试」。
 * 无法识别时回退到基准游标（只订阅新事件），而不是报错 ——
 * 断点续传失败不该让实时通道整个不可用。
 */
function parseLastEventId(header: unknown, fallback: string): string {
  if (typeof header !== 'string' || header.length === 0) return fallback;
  // Redis Stream ID 的合法形态：`<ms>-<seq>`、`<ms>`、`0`、`$`
  return /^(\d+-\d+|\d+|0|\$)$/.test(header) ? header : fallback;
}

/** 把一条事件写成 SSE 帧 */
function frame(envelope: SseEnvelope, streamId?: string): string {
  const lines: string[] = [];
  // 心跳不带 id：避免把客户端的续传游标推进到一个非事件上
  if (streamId !== undefined) lines.push(`id: ${streamId}`);
  lines.push(`event: ${envelope.type}`);
  lines.push(`data: ${JSON.stringify(envelope)}`);
  return `${lines.join('\n')}\n\n`;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sessions/:id/events', async (request, reply) => {
    const sessionId = parseIdParam(request);

    /*
     * 取消信号必须在**第一个 await 之前**挂好。
     *
     * close 事件只发一次：若客户端在「建连途中」断开（发起请求后立刻离开页面、
     * 探测工具连上就断），事件会在下面的数据库查询 / 发布 await 期间触发。
     * 等到循环前再挂监听就永远收不到这次通知，那条订阅会留在 XREAD 上永久阻塞
     * —— 连接与 socket 都不释放，且没有任何日志。实测：8 个建连途中断开的
     * 连接会留下 8 条僵尸订阅。
     */
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.raw.on('close', abort);
    request.raw.on('error', abort);

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (session === null) {
      throw new NotFoundError(`会话 ${sessionId} 不存在`, {
        resourceLabel: '会话',
        context: { sessionId },
      });
    }

    // 基准游标必须**先**产生：它同时解决了「流不存在时 XREAD 立即返回空」
    // 的问题（此刻流必定已存在），并作为客户端断线重连的起点。
    const readyPayload = { at: new Date().toISOString() };
    const ready = await getEventPublisher().publish({
      sessionId,
      type: 'session.ready',
      data: readyPayload,
    });

    if (ready === null) {
      // 事件通道不可用时明确报错，而不是建立一条永远不会推送的连接
      throw new Error('实时推送通道暂时不可用，请稍后重试');
    }

    // ── 接管响应 ──
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关闭 Nginx 等反向代理的缓冲，否则事件会被攒着一起发
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: ${RETRY_MS}\n\n`);
    raw.write(
      frame(
        { seq: ready.seq, type: 'session.ready', at: ready.at, sessionId, data: readyPayload },
        ready.streamId,
      ),
    );

    // 客户端重连时带上的续传游标；没有则从本次基准游标开始（只订阅新事件）。
    //
    // 必须校验格式：这个值直接来自请求头，是外部可控输入。
    // 非法游标（例如被篡改的 Last-Event-ID）会让 XRANGE 与 XREAD 双双以命令级错误失败，
    // 订阅器虽会在连续 3 次失败后结束订阅（不会死循环），但对客户端表现为
    // 「毫秒级建连又断开、浏览器反复重试」—— 在路由层挡住更干净。
    // 合法形态：`<ms>-<seq>`、`<ms>`、`0`、`$`。
    const lastEventId = parseLastEventId(request.headers['last-event-id'], ready.streamId);

    // 订阅连接在 subscribe() 内部按订阅创建与释放
    const stream = createEventStream({ connection: subscribeConnection() });
    let lastSeq = ready.seq;

    try {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: lastEventId,
        signal: controller.signal,
      })) {
        if (raw.writableEnded) break;

        if (message.kind === 'idle') {
          // 心跳：既让客户端知道连接还在，也顺便探测本端是否仍可写
          raw.write(
            frame(
              { seq: lastSeq, type: 'ping', at: new Date().toISOString(), sessionId, data: {} },
            ),
          );
          continue;
        }

        const { event } = message;
        lastSeq = event.seq;
        raw.write(
          frame(
            {
              seq: event.seq,
              type: event.type,
              at: event.at,
              sessionId: event.sessionId,
              data: event.data,
            },
            event.streamId,
          ),
        );
      }
    } finally {
      request.raw.off('close', abort);
      request.raw.off('error', abort);
      if (!raw.writableEnded) raw.end();
    }
  });
}
