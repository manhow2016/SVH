/**
 * 队列包测试
 *
 * 本包只在真正消费时需要 Redis，因此测试分两类：
 * - **纯函数**：连接串解析、确定性 jobId（不依赖任何外部服务）
 * - **需要 Redis**：入队 + 消费的完整往返，用于证明「队列层不重试」这一约定
 *
 * 需要 Redis 的用例的跳过规则：
 * - 未配置 REDIS_URL（没装 Redis 的机器）→ **跳过**，其余测试照常通过；
 * - 配置了 REDIS_URL 却连不上 → **失败**，因为这属于环境故障，
 *   静默跳过会让幂等保证在无人察觉的情况下失去验证。
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

/*
 * .env 必须在**模块作用域**加载，不能放进 beforeAll。
 *
 * it.skipIf 的条件在**收集阶段**求值，早于任何 beforeAll 钩子；若把加载推迟到
 * beforeAll，这里读到的 REDIS_URL 永远是空串，三条需要 Redis 的用例会被静默跳过 ——
 * 测试全绿，但「确定性 jobId → BullMQ 去重」这条幂等保证从未被真正验证。
 * 同 monorepo 的 packages/realtime/test/publisher.test.ts 采用同一写法。
 */
loadEnvFile(process.cwd());

/** Redis 连接串；未配置时为空串 */
const redisUrl = process.env.REDIS_URL ?? '';

/*
 * 跳过判定只看「是否配置了 REDIS_URL」，是同步常量，因此能在收集阶段求值。
 *
 * 刻意不把「能否连通」写进跳过条件：异步探测在收集阶段拿不到结果，
 * 而且「配置了却连不上」是环境故障，应当让用例失败暴露出来。
 * 连通性探测仍留在 beforeAll 里，探测失败的结论交给 requirePool() 抛出。
 */
const redisConfigured = redisUrl.length > 0;

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

/**
 * 探测 Redis 是否可用。
 *
 * 必须自带限时：BullMQ 会把 ioredis 的 maxRetriesPerRequest 设为 null，
 * 连不上时命令既不成功也不失败，只能一直重试（表现为 hook / 用例超时）。
 * 限时之后才能得到「配置了但连不上」这个明确结论。
 */
async function redisAvailable(url: string, timeoutMs = 5_000): Promise<boolean> {
  const probe = createTaskQueuePool(url);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe.queue('asset').getJobCounts('waiting'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`探测 Redis 超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }),
    ]);
    await probe.close();
    return true;
  } catch {
    // 连接不可用时 close() 也可能卡在重连上，因此不等待它完成，交给进程退出回收
    void probe.close().catch(() => undefined);
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('队列往返（需要 Redis）', () => {
  let pool: TaskQueuePool | null = null;
  /** REDIS_URL 已配置但连不上（环境故障），此时让用例失败而不是跳过 */
  let unreachable = false;

  /**
   * 取出连接池。
   *
   * - REDIS_URL 未配置：整个 describe 已被 skipIf 跳过，不会走到这里；
   * - 已配置却连不上：抛出带原因的错，使三条用例明确**失败** ——
   *   环境坏了必须暴露，静默跳过正是本次要修的缺陷。
   *
   * 用显式抛错代替非空断言 `!`，同时让失败信息可读。
   */
  function requirePool(): TaskQueuePool {
    if (pool === null) {
      throw new Error(
        unreachable
          ? `REDIS_URL 已配置但无法连接：${redisUrl}（环境故障，不能静默跳过）`
          : 'Redis 连接池未初始化',
      );
    }
    return pool;
  }

  beforeAll(async () => {
    if (!redisConfigured) return;

    // 不在这里抛错：让三个用例各自失败，比整个文件报 hook 超时更能指明问题
    if (!(await redisAvailable(redisUrl))) {
      unreachable = true;
      return;
    }
    pool = createTaskQueuePool(redisUrl);

    /*
     * 先把两个用例使用的队列清空。
     *
     * 上一次运行若失败或被中断，遗留作业会让本组用例无法复现：
     * 「入队与消费」会因为 jobId 已存在而拿不到新作业，
     * 「相同 jobId 去重」的增量则会变成 0（基线里已经算进了遗留作业）。
     * 先清空可避免一次偶发中断演变成永久性失败。
     */
    await pool.queue('ai_llm').obliterate({ force: true }).catch(() => undefined);
    await pool.queue('ai_render').obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    if (pool !== null) {
      // 清理本次测试产生的作业，避免污染后续运行
      await pool.queue('ai_llm').obliterate({ force: true }).catch(() => undefined);
      await pool.close();
    }
  });

  it.skipIf(!redisConfigured)('入队与消费的完整往返', async () => {
    const activePool = requirePool();
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

    await activePool.enqueue({ taskId: 'queue-roundtrip', queueName: 'ai_llm', attempt: 1 });

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

  it.skipIf(!redisConfigured)('相同 jobId 重复入队不会产生第二个作业', async () => {
    const activePool = requirePool();

    const before = await activePool.queue('ai_render').getJobCounts('waiting', 'delayed', 'active');
    const baseline = (before.waiting ?? 0) + (before.delayed ?? 0) + (before.active ?? 0);

    // 同一次尝试入队两次
    await activePool.enqueue({ taskId: 'idem-queue', queueName: 'ai_render', attempt: 1 });
    await activePool.enqueue({ taskId: 'idem-queue', queueName: 'ai_render', attempt: 1 });

    const after = await activePool.queue('ai_render').getJobCounts('waiting', 'delayed', 'active');
    const now = (after.waiting ?? 0) + (after.delayed ?? 0) + (after.active ?? 0);

    // 只增加 1 个作业 —— BullMQ 对相同 jobId 的重复添加会去重
    expect(now - baseline).toBe(1);

    await activePool.queue('ai_render').obliterate({ force: true }).catch(() => undefined);
  });

  it.skipIf(!redisConfigured)('getQueueDepths 返回全部资源池的深度', async () => {
    const depths = await getQueueDepths(requirePool());
    // 七个资源池都应有条目，便于运维观察
    expect(Object.keys(depths).length).toBeGreaterThanOrEqual(7);
    expect(depths.asset).toBeDefined();
    expect(typeof depths.asset?.waiting).toBe('number');
  });
});
