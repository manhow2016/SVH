/**
 * 运行器事件上报时机测试（Task 8）
 *
 * 守住的是「**什么时候**广播什么事件」这条接线：
 * 任务状态与进度必须与数据库里的真实跃迁一一对应，且带上正确的会话归属。
 * 只做 EventSink 的单测是不够的 —— 那样证明不了运行器真的调用了它。
 * 另一条守卫是反向的：事件发布再糟（永远不返回）也不能拖住执行路径。
 *
 * 测试策略与 pipeline.test.ts 一致：真实数据库 + 假 Skill + 假队列池，
 * 唯独把事件汇聚器换成可断言的记录器（以及一个真实汇聚器用来验证跳过语义）。
 * 使用假 Skill 是为了让进度、步骤与产出完全确定，不依赖 Mock Provider 的细节。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProviderUnavailableError, buildJobId, type SseEventType } from '@svh/domain';
import {
  buildModelRuntime,
  cancelTask,
  createTask,
  disconnectPrisma,
  prisma,
  type ModelRuntime,
} from '@svh/database';
import type { TaskQueuePool } from '@svh/queue';
import {
  SkillRegistry,
  type SkillExecutionOutput,
  type SkillExecutionContext,
  type SkillLogger,
} from '@svh/skills';

import { buildSkillDeps } from '../src/deps.js';
import { createEventSink, type EventSink } from '../src/events.js';
import { TaskRunner } from '../src/runner.js';

/** 测试用加密密钥（不用于生产） */
const TEST_KEY = 'a'.repeat(64);

/** 记录每一次 emit 的假汇聚器 */
class RecordingEventSink implements EventSink {
  readonly emitted: Array<{ sessionId: string | null | undefined; type: SseEventType; data: unknown }> =
    [];

  emit(input: { sessionId: string | null | undefined; type: SseEventType; data: unknown }): void {
    this.emitted.push(input);
  }

  /** 取指定类型事件里的 status 序列，便于断言状态跃迁顺序 */
  statuses(): string[] {
    return this.emitted
      .filter((event) => event.type === 'task.status')
      .map((event) => String((event.data as { status?: unknown }).status));
  }
}

/** 捕获入队调用的假队列池（可重试失败路径需要它） */
class FakeQueuePool implements Pick<TaskQueuePool, 'enqueue'> {
  enqueue(input: { taskId: string; attempt: number }): Promise<string> {
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

let projectId: string;
let sessionId: string;
let runtime: ModelRuntime;

beforeAll(async () => {
  const project = await prisma.project.create({
    data: { name: `运行器事件测试 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;

  // 事件必须归属于真实会话：agent_tasks.sessionId 是指向 sessions 的外键
  const session = await prisma.session.create({
    data: { projectId, title: '运行器事件测试会话' },
    select: { id: true },
  });
  sessionId = session.id;

  runtime = await buildModelRuntime({ encryptionKey: TEST_KEY, forceMock: true });
});

afterAll(async () => {
  // 级联删除会带走会话、任务与租约
  await prisma.project.deleteMany({ where: { id: projectId } });
  await disconnectPrisma();
});

/**
 * 构造只实现了一个技能的注册表。
 *
 * 用假 Skill 而不是真实技能：进度、步骤与产出完全确定，
 * 断言不会因为技能实现变化而失效。
 */
function registryWith(
  skillId: string,
  execute: (ctx: SkillExecutionContext) => Promise<SkillExecutionOutput>,
): SkillRegistry {
  const registry = new SkillRegistry();
  registry.loadCatalog();
  registry.register({
    id: skillId,
    execute: async (_input, ctx) => execute(ctx),
  });
  return registry;
}

/** 构造运行器：注入假注册表与可断言的汇聚器 */
function makeRunner(options: {
  registry: SkillRegistry;
  events: EventSink;
  confirmationPolicy?: 'reject' | 'allow';
  /** 心跳间隔（毫秒）；租约失效场景需要它短到能在一次执行内触发续约 */
  heartbeatMs?: number;
}): TaskRunner {
  return new TaskRunner({
    registry: options.registry,
    deps: buildSkillDeps({ router: runtime.router, models: runtime.models }),
    queues: new FakeQueuePool() as unknown as TaskQueuePool,
    workerId: 'test-worker',
    logger: silentLogger,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    leaseMs: 60_000,
    confirmationPolicy: options.confirmationPolicy ?? 'reject',
    events: options.events,
  });
}

/**
 * 等待执行被中断（租约失效的确定信号）。
 *
 * 带截止时间：条件不成立就抛错，而不是让用例悬挂 60 秒后以「超时」收场 ——
 * 抛出的错误会让技能以失败结束，断言随之暴露出真实问题。
 */
async function waitForAbort(signal: AbortSignal, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    if (Date.now() > deadline) throw new Error('等待中断超时：心跳未在预期时间内判定租约失效');
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/** 创建一个属于 sessionId 的任务并执行一次作业 */
async function runJob(
  runner: TaskRunner,
  input: { skillId: string; maxAttempts?: number; withSession?: boolean },
): Promise<string> {
  const created = await createTask({
    projectId,
    skillId: input.skillId,
    queueName: 'asset',
    sessionId: input.withSession === false ? null : sessionId,
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
  });

  await runner.handleJob({ taskId: created.taskId, attempt: 1 });
  return created.taskId;
}

describe('运行器的事件上报时机', () => {
  it('成功路径：抢占后广播 running，进度写入后广播 progress，完成后广播 success 与资产变更', async () => {
    const events = new RecordingEventSink();
    const runner = makeRunner({
      registry: registryWith('asset.create', async (ctx) => {
        await ctx.reportProgress(30, '正在生成');
        await ctx.step('生成中', { index: 1 });
        await ctx.reportProgress(80, '即将完成');
        return {
          output: { slug: '测试角色' },
          assetIds: ['asset_a', 'asset_b'],
          summary: '已创建 2 个资产',
        };
      }),
      events,
    });

    const taskId = await runJob(runner, { skillId: 'asset.create' });

    // 状态跃迁顺序：running（抢占）→ success（完成）
    expect(events.statuses()).toEqual(['running', 'success']);

    // 抢占事件带上尝试次数，供前端区分第几次执行
    const running = events.emitted[0];
    expect(running?.data).toEqual({ taskId, status: 'running', attempt: 1 });

    // 进度事件与写入数据库的进度一一对应
    const progress = events.emitted.filter((event) => event.type === 'task.progress');
    expect(progress.map((event) => event.data)).toEqual([
      { taskId, progress: 30, message: '正在生成' },
      { taskId, progress: 80, message: '即将完成' },
    ]);

    // 每个产出资产各一条资产变更事件
    const assets = events.emitted.filter((event) => event.type === 'asset.changed');
    expect(assets.map((event) => event.data)).toEqual([
      { assetId: 'asset_a', taskId, change: 'created' },
      { assetId: 'asset_b', taskId, change: 'created' },
    ]);

    // 成功事件带上产出数量
    const success = events.emitted.find(
      (event) => event.type === 'task.status' && (event.data as { status?: string }).status === 'success',
    );
    expect(success?.data).toEqual({ taskId, status: 'success', assetCount: 2 });

    // 会话归属来自调用栈上的 task.sessionId，每一处都必须带上
    expect(events.emitted.every((event) => event.sessionId === sessionId)).toBe(true);

    // 事件里的状态必须与数据库的真实状态一致
    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('success');
  });

  it('可重试失败：广播 pending，表示任务已退回排队等待重试', async () => {
    const events = new RecordingEventSink();
    const runner = makeRunner({
      registry: registryWith('asset.create', () => {
        // PROVIDER_UNAVAILABLE 默认可重试（见 @svh/domain 的 defaultRetryable）
        return Promise.reject(
          new ProviderUnavailableError('上游返回 503', {
            userMessage: '模型服务暂时不可用，请稍后重试。',
          }),
        );
      }),
      events,
    });

    const taskId = await runJob(runner, { skillId: 'asset.create', maxAttempts: 3 });

    expect(events.statuses()).toEqual(['running', 'pending']);

    const retry = events.emitted.at(-1);
    expect(retry?.type).toBe('task.status');
    expect(retry?.sessionId).toBe(sessionId);
    // 广播的是面向用户的文案，而不是「上游返回 503」这类技术细节
    expect(retry?.data).toEqual({
      taskId,
      status: 'pending',
      message: '模型服务暂时不可用，请稍后重试。',
    });

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('pending');
  });

  it('尝试预算耗尽：广播 failed 终态并带上面向用户的说明', async () => {
    const events = new RecordingEventSink();
    const runner = makeRunner({
      registry: registryWith('asset.create', () => Promise.reject(new Error('参数不合法'))),
      events,
    });

    const taskId = await runJob(runner, { skillId: 'asset.create', maxAttempts: 1 });

    expect(events.statuses()).toEqual(['running', 'failed']);

    const failed = events.emitted.at(-1);
    expect(failed?.data).toMatchObject({ taskId, status: 'failed' });
    expect(failed?.sessionId).toBe(sessionId);

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('failed');
  });

  it('高风险技能被闸门拦下：广播 waiting_user，用户才知道要确认', async () => {
    const events = new RecordingEventSink();
    const runner = makeRunner({
      // video.generate 在目录里声明了 requiresConfirmation
      registry: registryWith('video.generate', () => Promise.resolve({ output: {} })),
      events,
    });

    const taskId = await runJob(runner, { skillId: 'video.generate' });

    expect(events.statuses()).toEqual(['running', 'waiting_user']);

    const parked = events.emitted.at(-1);
    expect(parked?.data).toMatchObject({ taskId, status: 'waiting_user' });
    expect(parked?.sessionId).toBe(sessionId);

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('waiting_user');
  });

  it('任务不在可执行状态时不产生任何事件', async () => {
    const events = new RecordingEventSink();
    // 假技能若被执行会立刻暴露：它一旦返回就会写入 success 事件
    const runner = makeRunner({
      registry: registryWith('asset.create', () =>
        Promise.resolve({ output: {}, assetIds: [], summary: '不应被执行' }),
      ),
      events,
    });

    const created = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      sessionId,
    });
    await cancelTask(created.taskId);

    const result = await runner.handleJob({ taskId: created.taskId, attempt: 1 });

    expect(result.status).toBe('skipped');
    expect(events.emitted).toHaveLength(0);
  });

  it('没有会话归属的任务（直接 execute 创建）走真实汇聚器时不触碰发布器', async () => {
    const publish = vi.fn().mockResolvedValue(null);
    const runner = makeRunner({
      registry: registryWith('asset.create', () =>
        Promise.resolve({ output: {}, assetIds: ['asset_x'], summary: '无会话任务' }),
      ),
      events: createEventSink({ publish, close: vi.fn() }),
    });

    const taskId = await runJob(runner, { skillId: 'asset.create', withSession: false });

    // 运行器照常执行并广播，但汇聚器按契约把无归属事件丢掉
    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('success');
    expect(publish).not.toHaveBeenCalled();
  });

  it('租约失效后技能才抛错：不再广播 pending/failed，避免与库里的 cancelled 冲突', async () => {
    const events = new RecordingEventSink();
    const runner = makeRunner({
      // 心跳调短：让「续约失败」在一次执行内真的发生（生产环境是 30 秒一跳）
      heartbeatMs: 20,
      registry: registryWith('asset.create', async (ctx) => {
        // 场景起点：用户取消运行中的任务 —— 写 cancelled 并删掉租约
        await cancelTask(ctx.taskId);
        // 心跳的下一次续约会因此命中 0 行，触发 abort（租约失效的确定信号）
        await waitForAbort(ctx.signal);
        // 真实技能在中断时正是抛错的（例如 ValidationError「任务已取消」）；
        // 这里用可重试错误，命中「有预算 ⇒ shouldRetry=true」这条最有欺骗性的分支
        throw new ProviderUnavailableError('任务已取消', { userMessage: '任务已取消' });
      }),
      events,
    });

    const taskId = await runJob(runner, { skillId: 'asset.create', maxAttempts: 3 });

    // 库里的真相：cancelled。failTask 的 CAS 命中 0 行、什么都没写，
    // 若照着它的 shouldRetry 广播 pending，前端会永久停在「排队中」
    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('cancelled');

    // 因此除抢占成功的那条 running 之外，不应再有任何状态事件
    expect(events.statuses()).toEqual(['running']);
  });

  it('发布永不完成时执行照常收尾：emit 绝不被 await', async () => {
    // 永不 settle 的发布：只要执行路径上有一处 await 了 emit（或 emit 变成
    // async 且内部 await 发布），handleJob 就永远回不来，这条用例会超时失败
    const neverSettles = new Promise<never>(() => {
      // 故意不 resolve 也不 reject
    });
    const runner = makeRunner({
      registry: registryWith('asset.create', () =>
        Promise.resolve({ output: {}, assetIds: ['asset_x'], summary: '不该被事件拖住' }),
      ),
      events: createEventSink({ publish: () => neverSettles, close: () => Promise.resolve() }),
    });

    const taskId = await runJob(runner, { skillId: 'asset.create' });

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('success');
  }, 5_000);
});
