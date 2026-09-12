/**
 * 端到端验收：`POST /api/agent/sessions/:id/confirm` → 真实 Worker 执行器 → 终态
 *
 * ── 为什么这条链路要端到端地测 ──
 * 缺陷的本质是**两段代码各自都「对」、拼起来却断链**：
 * 路由把任务置回 `pending` 并入队，Worker 又按自己的策略把它退回 `waiting_user`。
 * 只测路由（见 smoke.test.ts 的确认用例）或只测 Worker 都无法发现这个断链 ——
 * 前者看不到执行，后者看不到确认动作。因此本文件在同一次测试里串联：
 *
 *   真实 HTTP 路由（app.inject）→ 真实数据库 → 真实 TaskRunner（Mock Provider）
 *
 * 断言两件事：
 *   ① 未经确认的高风险任务 → 执行后停在 `waiting_user`（既有行为不变）；
 *   ② 经 `/confirm` 放行（`confirmedAt` 与 `pending` 同一次写入）→ 执行到 `success`。
 * 第 ② 条正是修复前会失败的那条：当时 `/confirm` 不留批准凭据，任务必然退回
 * `waiting_user`，`attempts` 一路增长却永远没有结果。
 *
 * ── 关于跨包引用 ──
 * 本用例要同时驱动 API 路由与 Worker 执行器，而生产运行时的 `@svh/api` 并不
 * 依赖 `@svh/worker`。因此把 `@svh/worker` 声明为 **devDependency**（依赖关系
 * 只存在于测试期，生产依赖图不变），并按子路径引入运行器与依赖装配。
 * 不采用相对路径跨 app 引入：worker 源码不在 api 的 rootDir 下，
 * `tsc --noEmit` 会直接报 TS6059 而让 typecheck 失败。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildJobId } from '@svh/domain';
import { buildModelRuntime, disconnectPrisma, prisma, type ModelRuntime } from '@svh/database';
import type { TaskQueuePool } from '@svh/queue';
import { createDefaultSkillRegistry, type SkillLogger } from '@svh/skills';

import { buildApp } from '../src/core/app.js';
import { closeQueuePool, enqueueSkillTask, getQueuePool } from '../src/core/tasks.js';
// Worker 的运行器与依赖装配：测试期 devDependency，见文件头「关于跨包引用」
import { buildSkillDeps } from '@svh/worker/src/deps.js';
import { TaskRunner } from '@svh/worker/src/runner.js';

import type { FastifyInstance } from 'fastify';

/** 测试用加密密钥（不用于生产） */
const TEST_KEY = 'a'.repeat(64);

/** 触发动态高风险判定的输入：一次生成 4 张图 */
const HIGH_RISK_INPUT = {
  prompt: '一杯冷萃咖啡放在木桌上，晨光斜射',
  name: '确认闭环批量图',
  count: 4,
};

/** 捕获入队调用的假队列池：执行器不需要 Redis，等待确认的任务也不该入队 */
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

const silentLogger: SkillLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let app: FastifyInstance;
let projectId: string;
let runtime: ModelRuntime;
let queuePool: FakeQueuePool;

/** 真实运行器 + 生产默认策略 reject：放行只能来自任务上的 confirmedAt */
function makeRunner(): TaskRunner {
  return new TaskRunner({
    registry: createDefaultSkillRegistry(),
    deps: buildSkillDeps({ router: runtime.router, models: runtime.models }),
    queues: queuePool as unknown as TaskQueuePool,
    workerId: 'api-confirmation-loop-worker',
    logger: silentLogger,
    heartbeatMs: 60_000,
    leaseMs: 60_000,
    confirmationPolicy: 'reject',
  });
}

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();

  const project = await prisma.project.create({
    data: { name: `确认闭环端到端测试 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;

  queuePool = new FakeQueuePool();
  runtime = await buildModelRuntime({ encryptionKey: TEST_KEY, forceMock: true });
});

afterAll(async () => {
  await app.close();
  // 确认链路的用例会真实入队，释放队列连接，避免进程挂着不放
  await closeQueuePool();
  // 级联删除项目，连带清掉会话、任务与资产
  await prisma.project.deleteMany({ where: { id: projectId } });
  await disconnectPrisma();
});

/** 建一条属于本用例的会话（确认接口按会话找待确认任务） */
async function createSession(): Promise<string> {
  const session = await prisma.session.create({
    data: { projectId, title: '确认闭环端到端会话' },
    select: { id: true },
  });
  return session.id;
}

/** 清理真实 Redis 里的作业：测试进程没有 Worker 消费 */
async function removeQueuedJob(taskId: string, attempt: number): Promise<void> {
  const job = await getQueuePool().queue('ai_image').getJob(buildJobId(taskId, attempt));
  await job?.remove();
}

describe('确认执行 → 真正执行到终态', () => {
  it('经 /confirm 放行后执行到 success，不再退回 waiting_user', async () => {
    const sessionId = await createSession();

    // 模拟 Agent 工具循环撞上高风险技能：先落库为 waiting_user，且不入队
    const created = await enqueueSkillTask({
      skillId: 'image.generate',
      projectId,
      input: HIGH_RISK_INPUT,
      sessionId,
      initialStatus: 'waiting_user',
    });
    expect(created.status).toBe('waiting_user');

    const pendingConfirm = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(pendingConfirm?.status).toBe('waiting_user');
    // 还没确认 → 没有任何批准凭据
    expect(pendingConfirm?.confirmedAt).toBeNull();

    // 用户点「确认执行」：走真实 HTTP 路由
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/agent/sessions/${sessionId}/confirm`,
      payload: { taskIds: [created.taskId] },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { resumed: string[] }).resumed).toContain(created.taskId);

    // 路由改动点：批准凭据必须与 pending 在同一次更新里落库
    const confirmed = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(confirmed?.status).toBe('pending');
    expect(confirmed?.confirmedAt).not.toBeNull();

    // Worker 取到入队后的任务：真实运行器执行
    const runner = makeRunner();
    const result = await runner.handleJob({ taskId: created.taskId, attempt: 1 });

    const finished = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    // 核心验收：不再退回 waiting_user，而是真正跑完
    expect(finished?.status).toBe('success');
    expect(finished?.status).not.toBe('waiting_user');
    expect(result.status).toBe('success');
    expect(finished?.progress).toBe(100);
    // 批准时刻作为审计事实保留
    expect(finished?.confirmedAt).not.toBeNull();

    // 终态不是自证的：产出必须真实落库
    const produced =
      (finished?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];
    expect(produced).toHaveLength(4);
    expect(await prisma.asset.count({ where: { projectId, id: { in: produced } } })).toBe(4);

    // 清理：/confirm 真的入了一个队，测试进程没有消费者
    await removeQueuedJob(created.taskId, 1);
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });

  it('回归对照：未经确认的 pending 高风险任务仍会被拦下（既有行为不变）', async () => {
    const sessionId = await createSession();

    // 不传 initialStatus：任务落库即 pending 并照常入队 —— 这正是修复前
    // `/confirm` 放行后的状态（pending 且没有 confirmedAt），但用户并未批准
    const created = await enqueueSkillTask({
      skillId: 'image.generate',
      projectId,
      input: { ...HIGH_RISK_INPUT, name: '未确认批量图' },
      sessionId,
    });
    expect(created.status).toBe('pending');

    const before = await prisma.asset.count({ where: { projectId } });

    const runner = makeRunner();
    const result = await runner.handleJob({ taskId: created.taskId, attempt: 1 });

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('等待用户确认');

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('waiting_user');
    expect(task?.confirmedAt).toBeNull();
    // 未获批准的高成本操作绝不产出
    expect(await prisma.asset.count({ where: { projectId } })).toBe(before);

    await removeQueuedJob(created.taskId, 1);
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });
});
