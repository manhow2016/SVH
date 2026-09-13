/**
 * 测试与开发期 Worker 的队列隔离。
 *
 * ── 这道护栏守的是什么 ──
 * 测试与 `pnpm worker:dev` 共用同一个 `REDIS_URL` 库。队列前缀一致时，
 * 正在跑的 Worker 会**抢走测试刚建出来的任务**并推到 `running`，
 * 表现成一堆看似与改动无关的失败：
 *
 *   confirmation-loop.test.ts  expected 'running' to be 'pending'
 *                              expected '抢占失败：already_leased' to contain '等待用户确认'
 *   smoke.test.ts              取消任务后…  expected 404 to be 204
 *
 * 实测：Worker 在跑时 `@svh/api` 有 5 条失败；停掉 Worker 后同一份代码 118/118 全过。
 * 这类冲突最坑的地方是它**看起来像「刚才那个改动把测试改坏了」**，
 * 排查成本远高于修它的成本。
 *
 * 现在靠在 `setup-env.ts` 里把 `QUEUE_PREFIX` 设成 `svh-test-api` 隔离。
 * 本文件把这个约定钉住，两件事：
 *   ① 测试进程用的前缀确实不是开发期的（防止那行被误删）；
 *   ② 同一个 jobId 在开发期前缀下**查不到** —— 直接证明 Worker 看不见测试的作业。
 *
 * 只读地借用一次开发期前缀的池：不写、不删开发环境的任何作业。
 */
import { afterAll, describe, expect, it } from 'vitest';

import { getEnv } from '@svh/config';
import { buildJobId } from '@svh/domain';
import { createTaskQueuePool, type TaskQueuePool } from '@svh/queue';

import { closeQueuePool, getQueuePool } from '../src/core/tasks.js';

const QUEUE = 'asset' as const;

/** 开发期 Worker 用的那个前缀（`packages/queue` 的默认值） */
const 开发期前缀 = 'svh';

let 开发期池: TaskQueuePool | null = null;

afterAll(async () => {
  if (开发期池 !== null) await 开发期池.close();
  await closeQueuePool();
});

describe('测试与开发期 Worker 的队列隔离', () => {
  it('测试进程用的不是开发期前缀（setup-env.ts 那行还在）', () => {
    const prefix = getEnv().QUEUE_PREFIX;
    expect(prefix, `队列前缀仍是 ${prefix}，测试会与开发期 Worker 抢任务`).not.toBe(开发期前缀);
    expect(prefix.startsWith('svh-test')).toBe(true);
  });

  it('测试入队的作业，在开发期前缀下查不到（Worker 抢不走）', async () => {
    const taskId = `cmtzisolate${String(Date.now())}`;
    const jobId = buildJobId(taskId, 1);

    await getQueuePool().enqueue({ taskId, queueName: QUEUE, attempt: 1 });

    const 测试侧 = getQueuePool().queue(QUEUE);
    expect(await 测试侧.getJob(jobId), '作业没有进到测试前缀下').toBeDefined();

    开发期池 ??= createTaskQueuePool(getEnv().REDIS_URL, 开发期前缀);
    /*
     * 同一个 jobId、同一个 Redis 库、同一个队列名，只是前缀不同。
     * 这里必须是 undefined —— 为真就说明两边共用命名空间，隔离没生效。
     */
    expect(
      await 开发期池.queue(QUEUE).getJob(jobId),
      '开发期前缀下能看到测试的作业，Worker 会把它抢走',
    ).toBeUndefined();

    // 收尾：别给后续用例留下残留作业
    const job = await 测试侧.getJob(jobId);
    await job?.remove();
  });
});
