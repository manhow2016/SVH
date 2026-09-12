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
  /*
   * Redis Stream ID 的合法形态：`<ms>-<seq>`、`<ms>`、`$`。
   *
   * 两段各自限长 15 位（毫秒时间戳约 13 位，15 位足够宽松）：Redis 的 Stream ID
   * 是 64 位无符号整数，不限位数的 `\d+` 会放 `99999999999999999999-0` 进来，
   * 而这类值会让 XRANGE 与 XREAD **双双**报
   * `ERR Invalid stream ID specified as stream command argument` ——
   * 客户端拿到 200 + session.ready 后在毫秒级断流，并按 retry: 3000 反复重试，
   * 正是这个守卫要挡的形态。
   */
  return /^(\d{1,15}(-\d{1,15})?|\$)$/.test(header) ? header : fallback;
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

/**
 * 活跃 SSE 订阅的中止句柄。
 *
 * 必须是**模块级**、而不是 `eventRoutes` 的闭包变量：关闭钩子要在插件作用域
 * **之外**注册（原因见 `registerSseShutdown`），两者得共享同一份集合。
 */
const activeControllers = new Set<AbortController>();

/**
 * 注册 SSE 的关闭钩子（由 `buildApp` 在装配完成后调用一次）。
 *
 * ── 为什么必须有它 ──
 * SSE 是**永不结束**的响应。Fastify 5.12.4 在未传 `serverFactory` 时把
 * `forceCloseConnections` 解析为 `'idle'`，只关空闲连接；在途（对 SSE 而言
 * 是永远在途）响应会让 `server.close()` 的回调**永不触发**，于是 `app.close()`
 * 一直挂住 —— apps/api/src/index.ts 的兜底定时器到点 `process.exit(1)`，
 * 跳过 Redis / Prisma 释放。即「每个带活连接的客户端重启都走优雅关闭超时」。
 *
 * ── 为什么是 preClose，而不是 onClose ──
 * fastify 自己的内部 onClose 钩子（调用 `server.close()` 的那个）是在 `preReady`
 * 阶段 `unshift` 进 avvio 关闭队列的，而该队列是 **LIFO**：晚注册的先跑。
 * 在插件体内注册的 onClose 排在内部钩子**之后**，等 `server.close()` 卡住时它
 * 永远轮不到执行（实测 close 挂死、abort 形同虚设）。`preClose` 则由内部钩子在
 * 调用 `server.close()` **之前**同步 await（见 fastify.js 的内部 onClose），
 * 因此无论注册顺序如何都先于 server.close() 生效。
 *
 * ── 为什么还要 destroy socket ──
 * 只 abort + `raw.end()` 只是把响应**结束**掉，hijack 过的连接会回到 idle
 * keep-alive 状态继续挂在服务器上；`server.close()` 仍要等它自然超时
 * （实测约 4s，且 `closeIdleConnections()` 在关闭开始时就已执行过、不会再跑）。
 * 所以中止后必须把 socket 一并销毁，连接立刻释放，`server.close()` 才能立即回调。
 * 这对 SSE 是正确语义：订阅已经结束，这条连接没有复用的可能。
 *
 * 局部中止 SSE，而不是全局 `forceCloseConnections: true` —— 后者会一并改变
 * 所有路由的关闭语义，超出本阶段需要。
 */
export function registerSseShutdown(app: FastifyInstance): void {
  app.addHook('preClose', (done) => {
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    done();
  });
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
    activeControllers.add(controller);
    request.raw.on('close', abort);
    request.raw.on('error', abort);

    /*
     * 会话不存在 / 通道不可用这两条提前返回的路径同样要把 controller 摘出活跃集合。
     * 漏摘不只是内存泄漏：`preClose` 钩子会去中止一个早已结束的订阅，让「关闭时
     * 到底中止了谁」变得不可读。
     */
    const release = (): void => {
      activeControllers.delete(controller);
      request.raw.off('close', abort);
      request.raw.off('error', abort);
    };

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (session === null) {
      release();
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
      release();
      // 事件通道不可用时明确报错，而不是建立一条永远不会推送的连接
      throw new Error('实时推送通道暂时不可用，请稍后重试');
    }

    /*
     * 客户端的续传游标必须在**写出任何帧之前**解析出来，因为它决定 ready 帧
     * 要不要带 `id:`（见下）。这是**外部可控输入**，必须校验格式：非法游标
     * （例如被篡改的 Last-Event-ID、超出 64 位的数字）会让 XRANGE 与 XREAD
     * 双双以命令级错误失败，订阅器虽会在连续 3 次失败后结束订阅（不会死循环），
     * 但对客户端表现为「毫秒级建连又断开、浏览器反复重试」—— 在路由层挡住更干净。
     * 合法形态：`<ms>-<seq>`、`<ms>`、`$`。无法识别时回退到基准游标。
     */
    const rawLastEventId = request.headers['last-event-id'];
    const clientCursor =
      typeof rawLastEventId === 'string' && rawLastEventId.length > 0
        ? parseLastEventId(rawLastEventId, ready.streamId)
        : null;

    // ── 接管响应（此后必须由本函数的收尾逻辑结束它） ──
    reply.hijack();
    const raw = reply.raw;

    // 订阅连接在 subscribe() 内部按订阅创建与释放。
    // `subscribeConnection()` 的解析失败同样由外层 finally 兜住。
    const stream = createEventStream({ connection: subscribeConnection() });
    let lastSeq = ready.seq;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关闭 Nginx 等反向代理的缓冲，否则事件会被攒着一起发
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: ${RETRY_MS}\n\n`);

    /*
     * 带**合法**客户端游标时，ready 帧刻意不带 `id:`。
     *
     * ready 帧本可携带本次的**新基准**，而它晚于客户端游标 C。一旦写进 `id:`，
     * 客户端会立刻把续传游标推进到新基准，而 `(C, 新基准)` 区间要等订阅器补发
     * 才会到达；客户端若恰好在这约一个 Redis RTT 的窗口内断线，它存下的是新
     * 基准 —— 那段区间**此后再不补发**。这正是本任务要消灭的「重连后事件静默
     * 丢失」，只是窗口更小。不带 `id:` 就没有这个窗口：客户端的游标停在 C，
     * 直到补发的帧（各自带自己的 `id:`）到达才前移。
     *
     * 非法游标已回退到基准游标，与「没带游标」等价，可以照常下发 `id:`。
     */
    raw.write(
      frame(
        { seq: ready.seq, type: 'session.ready', at: ready.at, sessionId, data: readyPayload },
        clientCursor === null ? ready.streamId : undefined,
      ),
    );

    try {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: clientCursor ?? ready.streamId,
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
    } catch (err) {
      /*
       * 中止触发的拒绝是预期收尾，不能上抛。
       *
       * 关闭流程（preClose 钩子）与客户端断开都会 abort：订阅器的取消哨兵会
       * 立刻拒绝挂起的 await。此时响应已被 hijack，Fastify 既不会也不能再发
       * 响应，异常穿出去只会留下一条「响应未结束」的悬挂请求 —— 正是关闭挂住
       * 的同一个病根。真实故障（非中止）仍照常上抛。
       */
      if (!controller.signal.aborted) throw err;
    } finally {
      release();
      if (!raw.writableEnded) raw.end();
      /*
       * 被中止的订阅必须**销毁 socket**，不能只是结束响应。
       *
       * hijack 过的 SSE 连接在 `raw.end()` 之后会回到 idle keep-alive 状态继续
       * 挂在服务器上，`server.close()` 仍要等它自然超时（实测约 4s），而
       * `closeIdleConnections()` 早在关闭开始时就跑过了、不会再执行。订阅既已结束，
       * 这条连接没有复用的可能，直接销毁才是正确语义。
       *
       * 正常收尾（客户端自己断开）时 socket 已经没了，destroy() 是空操作；
       * `app.inject()`（测试）没有真实 TCP socket，用可选链绕开。
       */
      if (controller.signal.aborted) request.raw.socket?.destroy();
    }
  });
}
