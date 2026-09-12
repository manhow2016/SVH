/**
 * SSE 端点测试
 *
 * 需要 Redis / 数据库的用例放在 `describe.skipIf(!canRun)` 里（见文件末尾的
 * 分组规则）；只走 DB + 错误处理器的用例必须在**不加 gate** 的分组里，
 * 否则在没有 Redis 的机器上会被静默跳过 —— 测试全绿但什么都没验证。
 *
 * 重点验证五件事：
 * 1. 订阅之后发布的事件能被推送（实时性）
 * 2. Last-Event-ID 能补发缺失区间（断点续传），且非法 / 越界游标被挡在订阅器之外
 * 3. 跨会话隔离 —— A 会话的订阅收不到 B 会话的事件
 * 4. 事件通道不可用时明确报错，而不是建立一条永不推送的连接
 * 5. 存在活跃 SSE 连接时 app.close() 仍能及时返回
 */
import { createServer, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '@svh/database';
import { __setEnvForTesting, getEnv, loadEnvFile } from '@svh/config';

import { buildApp } from '../src/core/app.js';
import { closeEventPublisher, publishSessionEvent } from '../src/core/events.js';

// 必须在**模块作用域**加载 .env，不能放进 beforeAll。
//
// `describe.skipIf` 在**收集阶段**求值，早于任何 beforeAll；若把读取推迟到钩子里，
// 判断永远拿到空串，整组用例会被静默跳过。loadEnvFile 不覆盖已存在的变量，
// 重复调用无副作用。
loadEnvFile(process.cwd());

/** 连接参数（同 events.test.ts，见那里的说明） */
const canRun = (process.env.REDIS_URL ?? '').length > 0;

/** 用原始 HTTP 读取 SSE 流。 */
interface SseStream {
  frames: string[];
  close: () => void;
}

let app: FastifyInstance;
let baseUrl: string;
let projectId: string;
let sessionA: string;
let sessionB: string;

/**
 * 用原始 HTTP 打开一条 SSE 流。
 *
 * 不用 `app.inject()`：它会把响应缓冲到结束，而 SSE 是永不结束的流。
 */
async function openStream(sessionId: string, lastEventId?: string): Promise<SseStream> {
  const controller = new AbortController();
  const frames: string[] = [];

  const response = await fetch(`${baseUrl}/api/agent/sessions/${sessionId}/events`, {
    headers: lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {},
    signal: controller.signal,
  });
  expect(response.status).toBe(200);

  const reader = response.body?.getReader();
  void (async () => {
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 主动关闭导致的读取中断是预期行为
    }
  })();

  return { frames, close: () => controller.abort() };
}

/** 等待条件成立 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 把累计的帧文本拼起来判断是否包含某个事件类型 */
function textOf(frames: string[]): string {
  return frames.join('');
}

/**
 * 拆出所有已完整、且带 `event:` 行的 SSE 帧。
 *
 * 不能用 `text.indexOf('event:')` 找首帧：帧首可能是 `id: ...`，那样会在帧内部
 * 错位。也不能直接取第一个块 —— 流开头的 `retry: 3000` 是独立的一块（后面紧跟
 * 空行），它同样以空行分隔。这里按「块内含 event: 行」筛选，语义最直白。
 */
function eventFramesOf(frames: string[]): string[] {
  return textOf(frames)
    .split('\n\n')
    .filter((block) => block.includes('event:'));
}

/** 极简 RESP 应答：够 ioredis 完成握手即可 */
function replyForHandshake(command: string): string | null {
  const bulk = (text: string): string => `$${String(Buffer.byteLength(text))}\r\n${text}\r\n`;
  switch (command) {
    case 'info':
      return bulk('# Server\r\nredis_version:7.0.0\r\n');
    case 'client':
      return '+OK\r\n';
    case 'select':
      return '+OK\r\n';
    default:
      return null;
  }
}

/**
 * 起一个「握手正常、之后只 accept 不回包」的假 Redis。
 *
 * 与 events.test.ts 里那个完全静默的版本不同：**必须让握手成功**，
 * 否则 ioredis 会一直停在 connecting 状态，后续命令被压在离线队列里永不发出，
 * 也就永远等不到发布器的 500ms 命令超时。握手成功后 `incr`/`xadd` 会真的发出来
 * 并挂在那里，于是发布在该超时内失败返回 null —— 正是本用例要构造的形态。
 */
async function startHalfOpenRedis(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  let closing = false;

  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    if (closing) {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk: Buffer) => {
      // 一条 TCP 包里可能挤着多条命令（ioredis 的握手与离线队列冲刷）
      for (const part of chunk.toString('utf8').split(/(?=\*\d+\r\n)/)) {
        const name = /^\*\d+\r\n\$\d+\r\n([^\r\n]+)\r\n/.exec(part)?.[1]?.toLowerCase();
        if (name === undefined) continue;
        const reply = replyForHandshake(name);
        // 非握手命令一律不回包：模拟半开 TCP / Redis 被 STOP / 网络分区
        if (reply !== null && !socket.destroyed) socket.write(reply);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('未拿到监听端口');

  return {
    port: address.port,
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe.skipIf(!canRun)('SSE 端点', () => {
  beforeAll(async () => {
    app = await buildApp({ logLevel: 'silent' });
    await app.ready();
    // 只监听一次：Fastify 重复 listen 会抛 "Already listening"
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const project = await prisma.project.create({
      data: { name: `SSE 测试项目 ${Date.now()}` },
      select: { id: true },
    });
    projectId = project.id;

    const a = await prisma.session.create({
      data: { projectId, title: 'A', agentState: 'idle' },
      select: { id: true },
    });
    const b = await prisma.session.create({
      data: { projectId, title: 'B', agentState: 'idle' },
      select: { id: true },
    });
    sessionA = a.id;
    sessionB = b.id;
  });

  afterAll(async () => {
    await closeEventPublisher();
    await prisma.project.deleteMany({ where: { id: projectId } });
    await app.close();
  });

  it('建连后立即下发 session.ready 与重连间隔', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    const text = textOf(frames);
    expect(text).toContain('retry:');
    expect(text).toContain('event: session.ready');
    close();
  });

  it('订阅之后发布的事件被实时推送', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', { taskId: 'task_1', progress: 66 });

    await waitFor(() => textOf(frames).includes('task.progress'));
    expect(textOf(frames)).toContain('"progress":66');
    close();
  });

  it('Last-Event-ID 能补发缺失区间', async () => {
    // 先在无人订阅时发布两条事件
    const first = await publishSessionEvent(sessionA, 'agent.message', { n: 1 });
    await publishSessionEvent(sessionA, 'agent.message', { n: 2 });
    expect(first).not.toBeNull();

    const { frames, close } = await openStream(sessionA, first?.streamId);
    await waitFor(() => textOf(frames).includes('"n":2'));

    const text = textOf(frames);
    // 起点自身不应被补发，但起点之后的一条必须补发
    expect(text).toContain('"n":2');
    expect(text).not.toContain('"n":1');
    close();
  });

  /*
   * ── 重连时客户端的续传游标不能被 ready 帧提前推进 ──
   *
   * ready 帧的 `id:` 是本次的**新基准**，晚于客户端游标 C。若把它写在 ready 帧上，
   * 客户端会立刻把游标推进到新基准，而 `(C, 新基准)` 区间要等订阅器补发才到；
   * 客户端恰好在这个约一个 Redis RTT 的窗口内断线，存下的就是新基准 —— 那段区间
   * 此后再不补发。所以带**合法**游标时 ready 帧必须不带 `id:`。
   *
   * 断言「首帧不含 id:」是最直接的证伪：去掉 events.ts 里的条件，首帧立刻带上 id。
   */
  it('带合法 Last-Event-ID 重连时，ready 帧不带 id（不提前推进客户端游标）', async () => {
    const first = await publishSessionEvent(sessionA, 'agent.message', { n: 1 });
    expect(first).not.toBeNull();

    const { frames, close } = await openStream(sessionA, first?.streamId);
    await waitFor(() => textOf(frames).includes('session.ready'));

    const blocks = eventFramesOf(frames);
    expect(blocks[0]).toContain('event: session.ready');
    expect(blocks[0]).not.toContain('id:');

    // 对照：不带游标时 ready 帧照常带 id（证明上一条不是「所有 ready 都不带 id」）
    const fresh = await openStream(sessionA);
    await waitFor(() => textOf(fresh.frames).includes('session.ready'));
    expect(eventFramesOf(fresh.frames)[0]).toContain('id:');

    close();
    fresh.close();
  });

  /*
   * Last-Event-ID 是**外部可控输入**，必须校验后才允许进入订阅器。
   *
   * 不校验时，非法游标会让 XRANGE 与 XREAD 双双以命令级错误失败：订阅器连续
   * 3 次读取失败后结束订阅（不会死循环），但客户端看到的是「毫秒级建连又断开」。
   * 因此断言不能只停在 session.ready —— 那条帧在订阅开始**之前**就已写出，
   * 即使订阅当场死掉也能看到。必须再发一条事件，证明订阅真的活着。
   *
   * 取值刻意用 ASCII：HTTP 头是 ByteString，非 ASCII 字符在 fetch 层就被拒绝，
   * 根本到不了服务端（`fetch` 抛 "Cannot convert argument to a ByteString"）。
   */
  it('Last-Event-ID 非法时回退到基准游标，订阅照常收到后续事件', async () => {
    const { frames, close } = await openStream(sessionA, 'tampered-cursor');
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', {
      taskId: 'task_bad_cursor',
      progress: 7,
    });
    await waitFor(() => textOf(frames).includes('task_bad_cursor'));

    expect(textOf(frames)).toContain('"progress":7');
    close();
  });

  /*
   * ── 数字越界的游标同样必须被挡住 ──
   *
   * Redis 的 Stream ID 是 64 位无符号整数。`/^(\d+-\d+|\d+|0|\$)$/` 这类
   * 「不限制位数」的正则会放 `99999999999999999999-0`（20 位）进来，而它会让
   * XRANGE 与 XREAD **双双**报 `ERR Invalid stream ID specified as stream
   * command argument`：客户端拿到 200 + session.ready 后在毫秒级断流，
   * 再按 retry 反复重试 —— 与不校验完全一样的后果。
   *
   * 实测（真实 Redis）确认这个形态**不是**「合法但取不到数据」：
   *   XRANGE svh:… 99999999999999999999-0 +   → ERR Invalid stream ID …
   *   XREAD  … STREAMS svh:… 99999999999999999999-0 → ERR Invalid stream ID …
   * 而 15 位以内的值（如 `999999999999999`）两条命令都不报错。
   *
   * 断言方式与上一个用例一致：必须再发一条事件，证明订阅真的活着，
   * 而不是只看那条「订阅开始前就写出」的 ready 帧。
   */
  it('Last-Event-ID 数字超出 64 位范围时同样回退，订阅照常收到后续事件', async () => {
    const { frames, close } = await openStream(sessionA, '99999999999999999999-0');
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', {
      taskId: 'task_overflow_cursor',
      progress: 8,
    });
    await waitFor(() => textOf(frames).includes('task_overflow_cursor'), 2000);

    expect(textOf(frames)).toContain('"progress":8');
    close();
  });

  /*
   * 收紧后的正则不能误伤合法形态。
   *
   * 用**真实事件 ID 的时间戳部分**当游标：它一定是 13 位、一定合法、而且一定
   * ≤ 当前时间，因此严格晚于它的后续事件都能取到。
   *
   * 这里刻意不用 `999999999999999`（15 位上界）来测：那个值虽然能过两条命令的
   * 校验，但它表示一个远期时间戳，后面的挑选严格大于它的记录 —— 用它当游标会
   * 永远收不到新事件。那是「游标太超前」的正常语义，不是校验缺陷，拿来当断言
   * 会把正常行为误判成 bug。
   */
  it('Last-Event-ID 为合法的 13 位真实时间戳时不影响订阅', async () => {
    const baseline = await publishSessionEvent(sessionA, 'agent.message', { n: 90 });
    expect(baseline).not.toBeNull();
    // `<ms>-<seq>` → 只取毫秒段，得到一个「合法且不超前」的游标
    const cursorMs = baseline?.streamId.split('-')[0];
    expect(cursorMs).toMatch(/^\d{13}$/);

    const { frames, close } = await openStream(sessionA, cursorMs);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', {
      taskId: 'task_real_cursor',
      progress: 9,
    });
    await waitFor(() => textOf(frames).includes('task_real_cursor'), 2000);

    expect(textOf(frames)).toContain('"progress":9');
    close();
  });

  it('跨会话隔离：A 的订阅收不到 B 的事件', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionB, 'agent.message', { secret: 'B 的内容' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(textOf(frames)).not.toContain('B 的内容');
    close();
  });

  /*
   * ── 事件通道不可用必须明确报错，而不是建立一条永不推送的连接 ──
   *
   * 路由在 `publish` 返回 null 时抛错，而且必须发生在 `hijack()` **之前** ——
   * 一旦接管响应，错误处理器就再也发不出 500 了。删掉那个 throw（改成记日志后
   * 继续建流），本用例立刻变红：状态码会是 200 且 content-type 是 event-stream。
   *
   * 这里刻意不用 `startFakeRedis` 那种「完全静默」的服务：那样 ioredis 连握手都
   * 完不成，命令被压在离线队列里永不发出，等不到发布器的 500ms 命令超时。
   * 本用例用「握手正常、之后不回包」的假 Redis，让发布在该超时内失败返回 null。
   *
   * 断言刻意不检查告警文案：publish 走的是「命令超时」还是「API 侧硬上界」两条
   * 分支都能到达同一个 throw，锁死其中一条只会让用例变脆。
   */
  it('事件通道不可用时返回 500 且不建立 event-stream', async () => {
    const healthyEnv = getEnv();
    const fake = await startHalfOpenRedis();
    // 单例可能已被前一个用例建好，先关掉，确保下一次 getEventPublisher() 重新构造
    await closeEventPublisher();
    __setEnvForTesting({ ...healthyEnv, REDIS_URL: `redis://127.0.0.1:${String(fake.port)}` });

    try {
      /*
       * 加 5s 兜底：若 throw 被删掉，路由会建立一条永不推送的连接，`inject` 会
       * 一直挂着 —— 让用例在 5s 内以「没有报错」失败，而不是撞 20s 测试超时、
       * 只留下一句 Test timed out。
       */
      let timer: NodeJS.Timeout | undefined;
      let response: Awaited<ReturnType<typeof app.inject>>;
      try {
        response = await Promise.race([
          app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionA}/events` }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('事件通道不可用却没有报错：请求被挂起（建立了一条永不推送的连接）'));
            }, 5000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      expect(response.statusCode).toBe(500);
      expect(response.headers['content-type'] ?? '').not.toContain('event-stream');
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
    } finally {
      __setEnvForTesting(healthyEnv);
      await closeEventPublisher();
      await fake.close();
    }
  });

  /*
   * ── 活着的 SSE 连接不得挂住 app.close() ──
   *
   * SSE 响应永不结束，只要它还挂在连接上，`server.close()` 的回调就永远不会触发
   * （Fastify 5 未传 serverFactory 时 forceCloseConnections 解析为 'idle'，
   * 只关空闲连接）。eventRoutes 的 onClose 钩子逐个 abort 活跃订阅来解开这个死结。
   *
   * 用例自带一个独立 app 实例与**一个**活跃连接：先确认它真的建立了
   * （读到 session.ready），再调 close()。刻意不断开客户端 —— 断开就测不出问题。
   * 加 2s 兜底：没有修复时 close() 会一直挂着，让用例在 2s 内失败而不是撞 20s 超时。
   */
  it('存在活跃 SSE 连接时 app.close() 仍能及时返回', async () => {
    const own = await buildApp({ logLevel: 'silent' });
    await own.ready();
    const ownUrl = await own.listen({ port: 0, host: '127.0.0.1' });

    const controller = new AbortController();
    const response = await fetch(`${ownUrl}/api/agent/sessions/${sessionA}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    // 读到 ready 帧 ⇒ 订阅确实已建立并进入推送循环（不是一条正在建的连接）
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value).length).toBeGreaterThan(0);

    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        own.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('app.close() 未能及时返回，被活跃的 SSE 连接挂住'));
          }, 2000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(2000);
  });
});

/*
 * 会话不存在只有 DB 查询与错误处理器参与，**不需要 Redis**。
 *
 * 把它留在被 skipIf 的分组里，在没有 REDIS_URL 的机器上就会被静默跳过 ——
 * 仓库里已经因为同一个模式修过三次（b838263、Task 3 fix round 1、Task 6 fix round 1）。
 *
 * ── 为什么要显式注入一份配置 ──
 * `buildApp()` 第一件事是 `getEnv()`，而 @svh/config 对 REDIS_URL 是 fail-fast 校验
 * （空串 / 非 redis:// 前缀直接 EnvValidationError）。也就是说「把 REDIS_URL 置空」
 * 并不能模拟「没有 Redis 的机器」，只会让应用根本装配不起来 —— 那样这条用例仍然
 * 证明不了任何事。这里改为注入一份**结构合法、指向无人监听端口**的配置：
 * 本用例全程不发布、不订阅，REDIS_URL 只用于通过校验。
 * 于是无论外部有没有 REDIS_URL，这条用例都会真实执行。
 */
describe('SSE 端点的会话校验', () => {
  let envBackup: ReturnType<typeof getEnv> | null = null;

  beforeAll(() => {
    try {
      envBackup = getEnv();
    } catch {
      /*
       * `REDIS_URL` 被显式置空（模块作用域的 loadEnvFile 不覆盖已存在的变量，
       * 于是 .env 里的值被空串挡掉）时 getEnv() 会 fail-fast —— 这正是「无 Redis
       * 机器」的形态。此时拿不到完整配置对象，但本用例只需要一份能通过校验、
       * 且全程不被真正使用的配置，手写一份最小合法值即可。
       */
      envBackup = null;
    }
    __setEnvForTesting({
      ...(envBackup ?? ({} as ReturnType<typeof getEnv>)),
      NODE_ENV: envBackup?.NODE_ENV ?? 'test',
      REDIS_URL: 'redis://127.0.0.1:1',
    } as ReturnType<typeof getEnv>);
  });

  afterAll(() => {
    __setEnvForTesting(envBackup);
    envBackup = null;
  });

  it('会话不存在时返回 404 并说明是会话', async () => {
    const own = await buildApp({ logLevel: 'silent' });
    try {
      const response = await own.inject({
        method: 'GET',
        url: '/api/agent/sessions/sess_not_exist/events',
      });
      expect(response.statusCode).toBe(404);
      const body = response.json<{ error: { message: string } }>();
      expect(body.error.message).toContain('会话');
    } finally {
      await own.close();
    }
  });
});
