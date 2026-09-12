/**
 * 事件发布器测试
 *
 * 需要 Redis。连接不可用时整组跳过（而不是失败），
 * 这样在没有 Redis 的机器上依然能跑通其余测试 —— 与 @svh/queue 的约定一致。
 */
import { createServer, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '@svh/config';

import { createEventPublisher, eventStreamKey, type EventPublisher } from '../src/index.js';

/** 从环境变量里取 Redis 连接信息 */
function redisUrl(): string {
  return process.env.REDIS_URL ?? '';
}

/*
 * .env 必须在**模块作用域**加载，不能放进 beforeAll。
 *
 * describe.skipIf 在**收集阶段**求值，早于任何 beforeAll 钩子；
 * 若把加载推迟到 beforeAll，这里读到的 REDIS_URL 永远是空串，
 * 整组用例（包括「Redis 不可用时返回 null」这条关键约定）会被静默跳过 ——
 * 测试全绿但什么都没验证。其它包的测试同样依赖 .env，只是它们没有
 * 收集期求值的判断，因此放在 beforeAll 里也看不出问题。
 */
loadEnvFile(process.cwd());

const url = redisUrl();
const canRun = url.length > 0;

let publisher: EventPublisher;
/** 每个用例用独立会话 id，避免用例之间互相干扰 */
let counter = 0;
function nextSessionId(): string {
  counter += 1;
  return `sess_test_pub_${Date.now()}_${counter}`;
}

/** 直接读流内容做断言（不复用订阅器，避免用被测对象验证被测对象） */
async function readStream(sessionId: string): Promise<Array<Record<string, string>>> {
  const { Redis } = await import('ioredis');
  const { parseRedisConnection } = await import('@svh/queue');
  const client = new Redis(parseRedisConnection(url));
  try {
    const raw: unknown = await client.xrange(eventStreamKey(sessionId), '-', '+');
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
      const fields = (entry as [string, string[]])[1];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (typeof key === 'string' && typeof value === 'string') out[key] = value;
      }
      return out;
    });
  } finally {
    client.disconnect();
  }
}

afterAll(async () => {
  if (publisher !== undefined) await publisher.close();
});

describe.skipIf(!canRun)('事件发布器', () => {
  beforeAll(async () => {
    const { parseRedisConnection } = await import('@svh/queue');
    publisher = createEventPublisher({ connection: parseRedisConnection(url) });
  });

  it('发布后事件进入对应会话的流', async () => {
    const sessionId = nextSessionId();
    const result = await publisher.publish({
      sessionId,
      type: 'task.progress',
      data: { progress: 42, message: '正在生成第 3 个镜头' },
    });

    expect(result).not.toBeNull();
    expect(result?.streamId).toMatch(/^\d+-\d+$/);

    const entries = await readStream(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('task.progress');
    expect(entries[0]?.sessionId).toBe(sessionId);
    expect(JSON.parse(entries[0]?.data ?? 'null')).toEqual({
      progress: 42,
      message: '正在生成第 3 个镜头',
    });
  });

  it('seq 在同一会话内单调递增', async () => {
    const sessionId = nextSessionId();
    const first = await publisher.publish({ sessionId, type: 'agent.message', data: {} });
    const second = await publisher.publish({ sessionId, type: 'agent.message', data: {} });
    const third = await publisher.publish({ sessionId, type: 'agent.message', data: {} });

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(third?.seq).toBe(3);
  });

  it('不同会话的序号互不影响', async () => {
    const a = nextSessionId();
    const b = nextSessionId();
    await publisher.publish({ sessionId: a, type: 'agent.message', data: {} });
    const firstOfB = await publisher.publish({ sessionId: b, type: 'agent.message', data: {} });
    expect(firstOfB?.seq).toBe(1);
  });

  it('不同会话的事件写入不同的流', async () => {
    const a = nextSessionId();
    const b = nextSessionId();
    await publisher.publish({ sessionId: a, type: 'agent.message', data: { to: 'a' } });
    await publisher.publish({ sessionId: b, type: 'agent.message', data: { to: 'b' } });

    const entriesA = await readStream(a);
    expect(entriesA).toHaveLength(1);
    expect(JSON.parse(entriesA[0]?.data ?? 'null')).toEqual({ to: 'a' });
  });

  it('为事件流设置过期时间，避免长期堆积', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'agent.message', data: {} });

    const { Redis } = await import('ioredis');
    const { parseRedisConnection } = await import('@svh/queue');
    const client = new Redis(parseRedisConnection(url));
    try {
      const ttl = await client.ttl(eventStreamKey(sessionId));
      expect(ttl).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });
});

/*
 * 失败路径单独成组，**刻意不加 skipIf**。
 *
 * 组内用例要么指向一个必然连不上的端口，要么自建一个「只 accept、不回包」的
 * 本地 TCP 服务，因此都不需要可用的 Redis —— 把它们和被 gate 的分组放在一起，
 * 会让「发布失败返回 null 且不抛异常」这条全任务最核心的约定在没有 Redis 的
 * 机器上被静默跳过。而这条约定在仓库里没有别的用例覆盖。
 *
 * 全局约束的原话是「**需要外部服务**的用例在服务不可用时跳过」，
 * 这两条不需要外部服务，所以它们必须始终运行。
 */
describe('事件发布器的失败路径', () => {
  it('Redis 不可用时返回 null 而不抛异常（推送不应拖垮业务）', async () => {
    // 指向一个必然连不上的端口
    const broken = createEventPublisher({
      connection: { host: '127.0.0.1', port: 1 },
    });
    const result = await broken.publish({
      sessionId: nextSessionId(),
      type: 'agent.message',
      data: {},
    });
    expect(result).toBeNull();
    await broken.close();
  });

  /*
   * 「连接在，但对端不回包」是断连之外的另一类故障：TCP 握手成功，
   * ioredis 认为连接可用，于是既不报错也不重连，命令就永远悬在那里。
   * 实测没有 commandTimeout 时 incr 与 quit 都会无限挂起，
   * 这正是 `await publish` 永不返回的根因。
   */
  it('连接在但对端不回包时，命令超时让发布在有限时间内返回 null', async () => {
    const sockets: Socket[] = [];
    let closing = false;
    // 只 accept、从不 write：模拟半开 TCP / Redis 被 STOP / 网络分区
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      // 收尾阶段的迟到重连直接掐掉，避免 server.close() 一直等下去
      if (closing) socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('未拿到监听端口');

    const silent = createEventPublisher({
      connection: { host: '127.0.0.1', port: address.port },
    });
    const startedAt = Date.now();
    try {
      const result = await silent.publish({
        sessionId: nextSessionId(),
        type: 'agent.message',
        data: {},
      });
      const elapsed = Date.now() - startedAt;

      expect(result).toBeNull();
      // TCP 确实建立了：否则测到的是「连不上」而不是「不回包」
      expect(sockets.length).toBeGreaterThan(0);
      // 既没有被立刻拒绝，也没有无限挂起
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await silent.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
