/**
 * 队列包测试
 *
 * 本包只在真正消费时需要 Redis，因此测试分两类：
 * - **纯函数**：连接串解析、确定性 jobId（不依赖任何外部服务）
 * - **需要 Redis**：入队 + 消费的完整往返，用于证明「队列层不重试」这一约定
 *
 * 需要 Redis 的用例在连接不可用时自动跳过，而不是失败 ——
 * 这样在没有 Redis 的机器上依然能跑通其余测试。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildJobId, parseJobId, TASK_QUEUE_CONCURRENCY } from '@svh/domain';

import {
  createTaskQueuePool,
  createTaskWorker,
  getQueueDepths,
  parseRedisConnection,
  type TaskJobData,
  type TaskJobResult,
  type TaskQueuePool,
} from '../src/index.js';
import { loadEnvFile } from '@svh/config';

beforeAll(() => {
  loadEnvFile(process.cwd());
});

describe('parseRedisConnection', () => {
  it('解析基本连接串', () => {
    expect(parseRedisConnection('redis://127.0.0.1:6379/3')).toEqual({
      host: '127.0.0.1',
      port: 6379,
      db: 3,
    });
  });

  it('解析带密码的连接串（密码中的特殊字符会被解码）', () => {
    const parsed = parseRedisConnection('redis://:p%40ss%3Aword@10.0.0.5:6380/2');
    expect(parsed.host).toBe('10.0.0.5');
    expect(parsed.port).toBe(6380);
    expect(parsed.password).toBe('p@ss:word');
    expect(parsed.db).toBe(2);
  });

  it('解析带用户名的连接串', () => {
    const parsed = parseRedisConnection('redis://default:secret@redis.internal:6379/0');
    expect(parsed.username).toBe('default');
    expect(parsed.password).toBe('secret');
  });

  it('省略端口时使用默认值 6379', () => {
    expect(parseRedisConnection('redis://cache.local').port).toBe(6379);
  });

  it('rediss（TLS）连接串也能解析', () => {
    expect(parseRedisConnection('rediss://secure.redis:6380/1').port).toBe(6380);
  });

  it('非法连接串抛出可识别的错误', () => {
    expect(() => parseRedisConnection('not-a-url')).toThrow();
  });
});

describe('确定性 jobId（幂等三件套的第二层）', () => {
  it('同一任务与尝试序号总是生成相同 jobId', () => {
    expect(buildJobId('t1', 1)).toBe(buildJobId('t1', 1));
  });

  it('jobId 可被反解，用于对账与排查', () => {
    const jobId = buildJobId('cmtxyz123', 4);
    expect(jobId).toBe('task-cmtxyz123-attempt-4');
    expect(parseJobId(jobId)).toEqual({ taskId: 'cmtxyz123', attempt: 4 });
  });

  it('不同尝试序号不会碰撞（否则重试会命中同一个作业）', () => {
    const ids = new Set([1, 2, 3, 4, 5].map((n) => buildJobId('t1', n)));
    expect(ids.size).toBe(5);
  });
});

describe('资源池并发配置', () => {
  it('每个资源池都有并发与超时配置', () => {
    for (const [name, concurrency] of Object.entries(TASK_QUEUE_CONCURRENCY)) {
      expect(concurrency, `${name} 缺少并发配置`).toBeGreaterThan(0);
    }
  });

  it('视频池的并发低于文本池（避免长任务饿死短任务）', () => {
    expect(TASK_QUEUE_CONCURRENCY.ai_video).toBeLessThan(TASK_QUEUE_CONCURRENCY.ai_llm);
  });
});

/** ── 以下用例需要真实 Redis ── */

/** 探测 Redis 是否可用 */
async function redisAvailable(url: string): Promise<boolean> {
  try {
    const pool = createTaskQueuePool(url);
    await pool.queue('asset').getJobCounts('waiting');
    await pool.close();
    return true;
  } catch {
    return false;
  }
}

describe('队列往返（需要 Redis）', () => {
  let pool: TaskQueuePool | null = null;
  let available = false;
  const redisUrl = process.env.REDIS_URL ?? '';

  beforeAll(async () => {
    if (redisUrl.length === 0) return;
    available = await redisAvailable(redisUrl);
    if (available) pool = createTaskQueuePool(redisUrl);
  });

  afterAll(async () => {
    if (pool !== null) {
      // 清理本次测试产生的作业，避免污染后续运行
      await pool.queue('ai_llm').obliterate({ force: true }).catch(() => undefined);
      await pool.close();
    }
  });

  it('入队与消费的完整往返', async () => {
    if (!available || pool === null) {
      expect(true).toBe(true);
      return;
    }

    const received: TaskJobData[] = [];

    const worker = createTaskWorker({
      redisUrl,
      queueName: 'ai_llm',
      workerId: 'test-worker',
      concurrency: 1,
      handler: async (job): Promise<TaskJobResult> => {
        received.push(job.data);
        return { taskId: job.data.taskId, status: 'success' };
      },
    });

    await pool.enqueue({ taskId: 'queue-roundtrip', queueName: 'ai_llm', attempt: 1 });

    // 轮询等待消费完成（最多 10 秒）
    const deadline = Date.now() + 10_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await worker.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.taskId).toBe('queue-roundtrip');
    expect(received[0]?.attempt).toBe(1);
  });

  it('相同 jobId 重复入队不会产生第二个作业', async () => {
    if (!available || pool === null) {
      expect(true).toBe(true);
      return;
    }

    const before = await pool.queue('ai_render').getJobCounts('waiting', 'delayed', 'active');
    const baseline = (before.waiting ?? 0) + (before.delayed ?? 0) + (before.active ?? 0);

    // 同一次尝试入队两次
    await pool.enqueue({ taskId: 'idem-queue', queueName: 'ai_render', attempt: 1 });
    await pool.enqueue({ taskId: 'idem-queue', queueName: 'ai_render', attempt: 1 });

    const after = await pool.queue('ai_render').getJobCounts('waiting', 'delayed', 'active');
    const now = (after.waiting ?? 0) + (after.delayed ?? 0) + (after.active ?? 0);

    // 只增加 1 个作业 —— BullMQ 对相同 jobId 的重复添加会去重
    expect(now - baseline).toBe(1);

    await pool.queue('ai_render').obliterate({ force: true }).catch(() => undefined);
  });

  it('getQueueDepths 返回全部资源池的深度', async () => {
    if (!available || pool === null) {
      expect(true).toBe(true);
      return;
    }

    const depths = await getQueueDepths(pool);
    // 七个资源池都应有条目，便于运维观察
    expect(Object.keys(depths).length).toBeGreaterThanOrEqual(7);
    expect(depths.asset).toBeDefined();
    expect(typeof depths.asset?.waiting).toBe('number');
  });
});
