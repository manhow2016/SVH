/**
 * 确认链路的闭环验收：用户批准必须真的被执行消费掉。
 *
 * ── 守住的是什么 ──
 * 修复前的缺陷：`/confirm` 把任务从 `waiting_user` 改回 `pending` 并入队，
 * 但没有留下「用户已批准」的任何标记；Worker 取到任务后再次撞上同一个确认
 * 闸门，又把它退回 `waiting_user` —— 用户点了「确认执行」也永远等不到结果，
 * 任务在「入队 → waiting_user」之间无限循环（实测 attempts=2 仍是 waiting_user）。
 *
 * 因此本文件断言的是**闭环**，而不是某一个函数的返回值：
 *   ① 未确认的高风险任务 → 停（park）在 `waiting_user`，不产生任何资产；
 *   ② 确认之后（`confirmedAt` 与 `pending` 写入同一次更新）→ 真正执行到终态 `success`。
 * 第 ② 条是本缺陷的核心验收：它必须能**证伪** —— 把运行器里「读 confirmedAt
 * 决定 policy」的逻辑去掉，第 ② 条会重新退回 `waiting_user` 并失败。
 *
 * ── 测试策略 ──
 * - **真实数据库**：状态跃迁、租约、attempts 都真的落库，断言的是库里的状态。
 * - **真实 TaskRunner**：不走任何桩，直接跑 `handleJob`，与生产执行链一致。
 * - **假队列池**：只捕获入队调用，不依赖 Redis（等待确认的任务本就不该入队）。
 * - **Mock Provider**：确定性产出，使「执行到终态」的断言稳定。
 *
 * 确认动作在这里用与 API `/confirm` 相同的写法落库（状态与 `confirmedAt`
 * 在同一次 `updateMany` 里写入）。「路由真的写了这个字段」由
 * `apps/api/test/confirmation-loop.test.ts` 经真实 HTTP 路由断言；
 * 两个文件合起来覆盖「点击确认 → 字段落库 → Worker 放行」的完整链路。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildJobId } from '@svh/domain';
import { buildModelRuntime, disconnectPrisma, prisma, type ModelRuntime } from '@svh/database';
import type { TaskJobData, TaskQueuePool } from '@svh/queue';
import { createDefaultSkillRegistry, type SkillLogger } from '@svh/skills';

import { buildSkillDeps } from '../src/deps.js';
import { TaskRunner } from '../src/runner.js';

/** 测试用加密密钥（不用于生产） */
const TEST_KEY = 'a'.repeat(64);

/** 捕获入队调用的假队列池：等待确认的任务不得入队，这一点要能被断言 */
class FakeQueuePool implements Pick<TaskQueuePool, 'enqueue'> {
  readonly enqueued: Array<{ taskId: string; queueName: string; attempt: number }> = [];

  enqueue(input: { taskId: string; queueName: string; attempt: number }): Promise<string> {
    this.enqueued.push({
      taskId: input.taskId,
      queueName: input.queueName,
      attempt: input.attempt,
    });
    return Promise.resolve(buildJobId(input.taskId, input.attempt));
  }
}

/** 静默日志器：测试输出只保留断言结果 */
const silentLogger: SkillLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 触发动态高风险判定的输入：一次生成 4 张图（单张属于常规操作） */
const HIGH_RISK_INPUT = {
  prompt: '一杯冷萃咖啡放在木桌上，晨光斜射',
  name: '确认闭环批量图',
  count: 4,
};

let projectId: string;
let runtime: ModelRuntime;
let queuePool: FakeQueuePool;

/** 构造运行器：确认策略用生产默认值 reject，覆盖只能来自任务的 confirmedAt */
function makeRunner(): TaskRunner {
  return new TaskRunner({
    registry: createDefaultSkillRegistry(),
    deps: buildSkillDeps({ router: runtime.router, models: runtime.models }),
    queues: queuePool as unknown as TaskQueuePool,
    workerId: 'confirmation-loop-worker',
    logger: silentLogger,
    heartbeatMs: 60_000,
    leaseMs: 60_000,
    confirmationPolicy: 'reject',
  });
}

beforeAll(async () => {
  const project = await prisma.project.create({
    data: { name: `确认闭环测试 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;

  queuePool = new FakeQueuePool();
  runtime = await buildModelRuntime({ encryptionKey: TEST_KEY, forceMock: true });
});

afterAll(async () => {
  // 级联删除项目会一并清掉任务、租约与尝试记录
  await prisma.project.deleteMany({ where: { id: projectId } });
  await disconnectPrisma();
});

beforeEach(() => {
  // 入队记录按用例清零：断言「本次执行有没有安排重试」时不受其它用例污染
  queuePool.enqueued.length = 0;
});

/** 落一条高风险任务（初始 pending，等价于「未经确认就进入执行」） */
async function createHighRiskTask(): Promise<string> {
  const task = await prisma.agentTask.create({
    data: {
      projectId,
      skillId: 'image.generate',
      queueName: 'ai_image',
      risk: 'high',
      input: HIGH_RISK_INPUT as never,
      maxAttempts: 3,
    },
    select: { id: true },
  });
  return task.id;
}

/**
 * 复刻 `/confirm` 的放行写入：**状态与 confirmedAt 在同一次 updateMany 里**
 * 落库。分开写会留下「已放行但没有批准凭据」的中间态，正是本缺陷的成因。
 */
async function confirmLikeApi(taskId: string): Promise<void> {
  const updated = await prisma.agentTask.updateMany({
    where: { id: taskId, status: 'waiting_user' },
    data: {
      status: 'pending',
      confirmedAt: new Date(),
      progress: 0,
      progressMessage: null,
      error: null,
      errorMessage: null,
    },
  });
  // 写不进去说明前置状态不对，后面的断言会指向错误的原因，这里先卡住
  expect(updated.count).toBe(1);
}

describe('高风险任务的确认闭环', () => {
  it('未确认：执行后退回 waiting_user，且不产生任何资产、不安排重试', async () => {
    const runner = makeRunner();
    const taskId = await createHighRiskTask();
    const assetsBefore = await prisma.asset.count({ where: { projectId } });

    const job: TaskJobData = { taskId, attempt: 1 };
    const result = await runner.handleJob(job);

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('等待用户确认');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('waiting_user');
    // 未经确认 → 没有任何批准凭据
    expect(task?.confirmedAt).toBeNull();
    expect(task?.progressMessage).toContain('需要你确认');

    // 关键：未获批准的高成本操作绝不扣费、绝不产出
    expect(await prisma.asset.count({ where: { projectId } })).toBe(assetsBefore);
    // 也没有安排重试（任务在等人，不是在退避）
    expect(queuePool.enqueued).toHaveLength(0);
  });

  it('已确认（confirmedAt + pending）：执行到 success，不再退回 waiting_user', async () => {
    const runner = makeRunner();
    const taskId = await createHighRiskTask();

    // ── 第 1 次：未确认，停在 waiting_user（复现用户看到「待确认」的那一步） ──
    const first = await runner.handleJob({ taskId, attempt: 1 });
    expect(first.status).toBe('skipped');

    const parked = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(parked?.status).toBe('waiting_user');
    expect(parked?.confirmedAt).toBeNull();

    // ── 用户点「确认执行」：与 /confirm 完全相同的写入 ──
    await confirmLikeApi(taskId);

    const confirmed = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(confirmed?.status).toBe('pending');
    // 先确认凭据真的落库了，否则第 2 次执行失败的原因会被误判
    expect(confirmed?.confirmedAt).not.toBeNull();

    // ── 第 2 次：Worker 再次取到该任务，必须放行并跑到终态 ──
    const second = await runner.handleJob({ taskId, attempt: 2 });

    const finished = await prisma.agentTask.findUnique({ where: { id: taskId } });
    // 核心断言：不再回到 waiting_user，而是真正的终态
    expect(finished?.status).toBe('success');
    expect(finished?.status).not.toBe('waiting_user');
    expect(second.status).toBe('success');
    expect(second.status).not.toBe('skipped');
    expect(finished?.progress).toBe(100);
    // 批准时刻作为审计事实保留下来，不会被执行覆盖或清空
    expect(finished?.confirmedAt).not.toBeNull();

    // 「执行到终态」不是状态字段的自证：产出必须真实落库
    const produced =
      (finished?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];
    expect(produced).toHaveLength(4);

    const images = await prisma.asset.findMany({
      where: { projectId, id: { in: produced } },
      select: { id: true, type: true },
    });
    expect(images).toHaveLength(4);
    expect(images.every((asset) => asset.type === 'image')).toBe(true);

    // 成功路径不安排重试
    expect(queuePool.enqueued).toHaveLength(0);
  });

  it('运行器级 default=reject 仍然拦得住全新任务（覆盖只对已确认的那一次生效）', async () => {
    const runner = makeRunner();
    const confirmedTaskId = await createHighRiskTask();

    await runner.handleJob({ taskId: confirmedTaskId, attempt: 1 });
    await confirmLikeApi(confirmedTaskId);
    const confirmedRun = await runner.handleJob({ taskId: confirmedTaskId, attempt: 2 });
    expect(confirmedRun.status).toBe('success');

    // 同一个运行器上再跑一条**未经确认**的任务：仍然必须被拦下
    const freshTaskId = await createHighRiskTask();
    const freshRun = await runner.handleJob({ taskId: freshTaskId, attempt: 1 });
    expect(freshRun.status).toBe('skipped');

    const fresh = await prisma.agentTask.findUnique({ where: { id: freshTaskId } });
    expect(fresh?.status).toBe('waiting_user');
    expect(fresh?.confirmedAt).toBeNull();
  });
});
