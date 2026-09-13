/**
 * 端到端链路测试：任务 → Worker → Skill → Model Router → 资产
 *
 * 这是 Phase 2 的核心验收：证明「Skill Registry + 执行引擎 + Task Queue +
 * Worker」四块真的串起来了，而不只是各自能跑单测。
 *
 * 测试策略：
 * - **不依赖 Redis**：用 FakeQueuePool 捕获入队调用，验证「重试调度」
 *   这一关键行为，而不需要真的启动 BullMQ。
 * - **使用 Mock Provider**：确定性输出，使断言稳定。
 * - **真实数据库**：资产、版本、任务状态都是真的写进 PostgreSQL 的，
 *   因此能验证仓储层的幂等与 Fencing 是真的生效。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildJobId } from '@svh/domain';
import {
  buildModelRuntime,
  disconnectPrisma,
  prisma,
  type ModelRuntime,
} from '@svh/database';
import { MockProviderAdapter } from '@svh/model';
import type { TaskJobData, TaskJobResult, TaskQueuePool } from '@svh/queue';
import { createDefaultSkillRegistry, type SkillLogger } from '@svh/skills';

import { buildSkillDeps } from '../src/deps.js';
import { TaskRunner } from '../src/runner.js';

/** 测试用加密密钥（不用于生产） */
const TEST_KEY = 'a'.repeat(64);

/** 捕获入队调用的假队列池，用于验证重试调度而不依赖 Redis */
class FakeQueuePool implements Pick<TaskQueuePool, 'enqueue'> {
  readonly enqueued: Array<{ taskId: string; queueName: string; attempt: number; delayMs?: number }> = [];

  enqueue(input: {
    taskId: string;
    queueName: string;
    attempt: number;
    delayMs?: number;
  }): Promise<string> {
    this.enqueued.push({
      taskId: input.taskId,
      queueName: input.queueName,
      ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
      attempt: input.attempt,
    });
    return Promise.resolve(buildJobId(input.taskId, input.attempt));
  }

  reset(): void {
    this.enqueued.length = 0;
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
let contentId: string;
let runtime: ModelRuntime;
let queuePool: FakeQueuePool;

/** 构造一个运行器；每个用例可注入不同的 Mock 故障或确认策略 */
function makeRunner(options: {
  mockAdapter?: MockProviderAdapter;
  confirmationPolicy?: 'reject' | 'allow';
}): TaskRunner {
  return new TaskRunner({
    registry: createDefaultSkillRegistry(),
    deps: buildSkillDeps({ router: runtime.router, models: runtime.models }),
    queues: queuePool as unknown as TaskQueuePool,
    workerId: 'test-worker',
    logger: silentLogger,
    heartbeatMs: 60_000,
    leaseMs: 60_000,
    confirmationPolicy: options.confirmationPolicy ?? 'reject',
  });
}

beforeAll(async () => {
  const project = await prisma.project.create({
    data: {
      name: `端到端测试 ${Date.now()}`,
      // 项目记忆会被需求分析与画面生成读取，这里给出真实结构
      memory: {
        goals: { objective: '验证任务链路', platforms: ['xiaohongshu'] },
        visual: { style: '电影感、冷调', styleKeywords: ['电影感', '冷调'] },
        production: { defaultShotDuration: 4 },
      },
    },
    select: { id: true },
  });
  projectId = project.id;

  const content = await prisma.content.create({
    data: {
      projectId,
      type: 'advertisement',
      title: '端到端测试内容',
      brief: '一条用于验证链路的广告',
      metadata: { duration: 30, aspectRatio: '9:16' },
    },
    select: { id: true },
  });
  contentId = content.id;

  queuePool = new FakeQueuePool();
  runtime = await buildModelRuntime({
    encryptionKey: TEST_KEY,
    forceMock: true,
  });
});

afterEach(() => {
  queuePool.reset();
});

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await disconnectPrisma();
});

/** 创建一个任务并执行一次作业 */
async function runJob(
  runner: TaskRunner,
  input: { skillId: string; input: Record<string, unknown>; maxAttempts?: number },
): Promise<{ taskId: string; result: TaskJobResult }> {
  const task = await prisma.agentTask.create({
    data: {
      projectId,
      contentId,
      skillId: input.skillId,
      queueName: 'asset',
      input: input.input as never,
      maxAttempts: input.maxAttempts ?? 1,
    },
    select: { id: true },
  });

  const job: TaskJobData = { taskId: task.id, attempt: 1 };
  const result = await runner.handleJob(job);
  return { taskId: task.id, result };
}

describe('asset.create 全链路', () => {
  it('执行成功后创建真实资产，并写入首版快照', async () => {
    const runner = makeRunner({});
    const { taskId, result } = await runJob(runner, {
      skillId: 'asset.create',
      input: {
        type: 'character',
        name: '链路测试角色',
        description: '年轻女性，黑色长发',
        metadata: { appearance: { hair: '黑色长直发', age: 24 }, role: '女主' },
        tags: ['测试'],
      },
    });

    expect(result.status).toBe('success');

    // 任务进入终态并带回产出
    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('success');
    expect(task?.progress).toBe(100);

    const output = task?.output as { assetId?: string; slug?: string; summary?: string } | null;
    expect(output?.assetId).toBeTruthy();
    expect(output?.slug).toBe('链路测试角色');

    // 资产真实落库，且 metadata 通过了类型校验
    const asset = await prisma.asset.findUnique({
      where: { id: output?.assetId ?? '' },
      include: { versions: true },
    });
    expect(asset?.type).toBe('character');
    expect(asset?.slug).toBe('链路测试角色');
    expect((asset?.metadata as { appearance?: { hair?: string } })?.appearance?.hair).toBe('黑色长直发');
    expect(asset?.versions).toHaveLength(1);
    expect(asset?.versions[0]?.version).toBe(1);

    // 结果卡片被写入任务输出，供 Agent UI 直接渲染
    const card = (task?.output as { card?: { title?: string } } | null)?.card;
    expect(card?.title).toContain('已创建');
  });

  it('同类资产重名时自动去重 slug', async () => {
    const runner = makeRunner({});
    const first = await runJob(runner, {
      skillId: 'asset.create',
      input: { type: 'scene', name: '重名场景', metadata: { timeOfDay: '夜' } },
    });
    const second = await runJob(runner, {
      skillId: 'asset.create',
      input: { type: 'scene', name: '重名场景', metadata: { timeOfDay: '夜' } },
    });

    const firstSlug = ((await prisma.agentTask.findUnique({ where: { id: first.taskId } }))?.output as {
      slug?: string;
    } | null)?.slug;
    const secondSlug = ((await prisma.agentTask.findUnique({ where: { id: second.taskId } }))?.output as {
      slug?: string;
    } | null)?.slug;

    expect(firstSlug).toBe('重名场景');
    expect(secondSlug).toBe('重名场景-2');
  });

  it('metadata 与资产类型不匹配时任务失败，且不留下脏数据', async () => {
    const runner = makeRunner({});
    const before = await prisma.asset.count({ where: { projectId } });

    const { taskId, result } = await runJob(runner, {
      skillId: 'asset.create',
      input: {
        type: 'character',
        name: '非法角色',
        // 角色的 appearance 必须是对象
        metadata: { appearance: '这是一个字符串' },
      },
    });

    expect(result.status).toBe('failed');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('failed');
    // 用户看到的是可理解的说明，而不是 Zod 的原始英文
    expect(task?.errorMessage).toBeTruthy();
    expect(task?.errorMessage).toContain('character');

    const after = await prisma.asset.count({ where: { projectId } });
    expect(after).toBe(before);
  });
});

describe('asset.update 全链路', () => {
  it('深合并 metadata 并产生新版本', async () => {
    const runner = makeRunner({});
    const created = await runJob(runner, {
      skillId: 'asset.create',
      input: {
        type: 'character',
        name: '待修改角色',
        metadata: { appearance: { hair: '黑色', age: 28, gender: 'female' } },
      },
    });
    const assetId = ((await prisma.agentTask.findUnique({ where: { id: created.taskId } }))?.output as {
      assetId?: string;
    } | null)?.assetId;
    expect(assetId).toBeTruthy();

    const { result } = await runJob(runner, {
      skillId: 'asset.update',
      input: {
        assetId,
        patch: { metadata: { appearance: { hair: '中国红' } } },
        changelog: '服装颜色 → 中国红',
      },
    });

    expect(result.status).toBe('success');

    const asset = await prisma.asset.findUnique({
      where: { id: assetId ?? '' },
      include: { versions: { orderBy: { version: 'asc' } } },
    });

    const appearance = (asset?.metadata as { appearance?: { hair?: string; age?: number; gender?: string } })
      ?.appearance;
    // 深合并：发色被改，但年龄与性别必须保留
    expect(appearance?.hair).toBe('中国红');
    expect(appearance?.age).toBe(28);
    expect(appearance?.gender).toBe('female');

    expect(asset?.versions).toHaveLength(2);
    expect(asset?.versions[1]?.changelog).toBe('服装颜色 → 中国红');
  });
});

describe('高风险技能的确认闸门（技术文档第 47 条）', () => {
  /**
   * 确认语义分两层：
   * - **静态**：技能天然高成本（如 video.generate），definition.requiresConfirmation
   * - **动态**：成本随本次规模变化（如一次生成多张图），由 skill.isHighRisk(input) 判定
   *
   * 单张图片属于常规操作，不触发确认；批量生成必须先确认。
   */
  const singleImage = { prompt: '一杯冷萃咖啡放在木桌上，晨光斜射', name: '单张画面' };
  const batchImages = { ...singleImage, count: 4, name: '批量画面' };

  it('单张图片不触发确认（常规操作）', async () => {
    const runner = makeRunner({ confirmationPolicy: 'reject' });

    const { taskId, result } = await runJob(runner, {
      skillId: 'image.generate',
      input: singleImage,
    });

    expect(result.status).toBe('success');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    const produced = (task?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];
    expect(produced).toHaveLength(1);

    const asset = await prisma.asset.findUnique({ where: { id: produced[0] ?? '' } });
    expect(asset?.type).toBe('image');
  });

  it('批量生成触发确认，置为 waiting_user 且不产生任何资产', async () => {
    const runner = makeRunner({ confirmationPolicy: 'reject' });
    const before = await prisma.asset.count({ where: { projectId } });

    const { taskId, result } = await runJob(runner, {
      skillId: 'image.generate',
      input: batchImages,
    });

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('等待用户确认');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.status).toBe('waiting_user');
    expect(task?.progressMessage).toContain('需要你确认');

    // 关键：未被确认的高成本操作绝不扣费
    const after = await prisma.asset.count({ where: { projectId } });
    expect(after).toBe(before);

    // 也没有安排重试
    expect(queuePool.enqueued).toHaveLength(0);
  });

  it('授权策略下批量生成可执行，并按张数产出多个资产', async () => {
    const runner = makeRunner({ confirmationPolicy: 'allow' });

    const { taskId, result } = await runJob(runner, {
      skillId: 'image.generate',
      input: { ...batchImages, name: '已授权批量图' },
    });

    expect(result.status).toBe('success');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    const assetIds = (task?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];

    // 一次生成 4 张 → 4 个资产，且 id 互不重复
    expect(assetIds).toHaveLength(4);
    expect(new Set(assetIds).size).toBe(4);

    const images = await prisma.asset.count({ where: { projectId, type: 'image' } });
    expect(images).toBeGreaterThanOrEqual(4);
  });

  it('画面提示词会带上项目记忆里的风格关键词', async () => {
    const runner = makeRunner({ confirmationPolicy: 'reject' });
    const { taskId } = await runJob(runner, {
      skillId: 'image.generate',
      input: { prompt: '产品特写', name: '风格一致性测试图' },
    });

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    const produced = (task?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];
    const asset = await prisma.asset.findUnique({ where: { id: produced[0] ?? '' } });
    const prompt = (asset?.metadata as { generation?: { prompt?: string } })?.generation?.prompt ?? '';

    // 项目记忆里的「电影感、冷调」应当被拼进提示词
    expect(prompt).toContain('电影感');
    expect(prompt).toContain('冷调');
  });

  it('生成的模型与提示词被写入资产 metadata，便于复现', async () => {
    const runner = makeRunner({ confirmationPolicy: 'reject' });
    const { taskId } = await runJob(runner, {
      skillId: 'image.generate',
      input: { prompt: '复现性测试', name: '复现测试图' },
    });

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    const produced = (task?.output as { producedAssetIds?: string[] } | null)?.producedAssetIds ?? [];
    const asset = await prisma.asset.findUnique({ where: { id: produced[0] ?? '' } });
    const generation = (asset?.metadata as {
      generation?: { skillId?: string; modelId?: string; taskId?: string };
    })?.generation;

    expect(generation?.skillId).toBe('image.generate');
    expect(generation?.modelId).toBeTruthy();
    // 回指任务，便于从资产追溯到是哪次任务产出的
    expect(generation?.taskId).toBe(taskId);
  });
});

describe('重试链路（两层重试的分工）', () => {
  /**
   * 系统里有**两层**重试，职责不同，必须分清楚：
   *
   * 1. **模型层**（ModelRouter）：同一模型内重试 + 切换到备用模型。
   *    处理 Provider 的瞬时抖动，对领域层透明。
   * 2. **领域层**（TaskRunner + task-runtime）：任务级的重新尝试。
   *    当模型层的所有候选都失败后，把任务置回 pending、按退避延迟重新入队。
   *
   * 因此要测领域层重试，「故障必须超出模型层的重试能力」——
   * 用 failFirstN 只会被模型层自己消化掉，任务第一次尝试就成功了。
   * 这一点很反直觉，但正是两层重试分工正确的表现。
   */
  it('模型层用尽重试后，领域层接管：置回 pending 并安排延迟重试', async () => {
    // alwaysFail 会耗尽模型层全部重试与降级候选
    const adapter = new MockProviderAdapter({
      failures: [{ capability: 'image', alwaysFail: true, code: 'PROVIDER_UNAVAILABLE' }],
    });
    const runtimeAlwaysFail = await buildModelRuntime({
      encryptionKey: TEST_KEY,
      forceMock: true,
      mockAdapter: adapter,
    });

    const runner = new TaskRunner({
      registry: createDefaultSkillRegistry(),
      deps: buildSkillDeps({ router: runtimeAlwaysFail.router, models: runtimeAlwaysFail.models }),
      queues: queuePool as unknown as TaskQueuePool,
      workerId: 'retry-worker',
      logger: silentLogger,
      heartbeatMs: 60_000,
      leaseMs: 60_000,
      confirmationPolicy: 'reject',
    });

    const task = await prisma.agentTask.create({
      data: {
        projectId,
        contentId,
        skillId: 'image.generate',
        queueName: 'ai_image',
        input: { prompt: '重试测试画面', name: '重试图' } as never,
        maxAttempts: 3,
      },
      select: { id: true },
    });

    // ── 第 1 次尝试：模型层全部失败 → 领域层安排重试 ──
    const first = await runner.handleJob({ taskId: task.id, attempt: 1 });
    expect(first.status).toBe('retry_scheduled');

    const afterFirst = await prisma.agentTask.findUnique({
      where: { id: task.id },
      include: { attemptsLog: true },
    });
    expect(afterFirst?.status).toBe('pending');
    expect(afterFirst?.attempts).toBe(1);
    // 技术原因进 error，面向用户的说明进 errorMessage
    expect(afterFirst?.error).toBeTruthy();
    expect(afterFirst?.errorMessage).toBeTruthy();
    // 尝试审计已写入（成本归因的数据基础）
    expect(afterFirst?.attemptsLog).toHaveLength(1);
    expect(afterFirst?.attemptsLog[0]?.status).toBe('failed');

    // 延迟重试已入队，且 jobId 可推导
    expect(queuePool.enqueued).toHaveLength(1);
    expect(queuePool.enqueued[0]?.attempt).toBe(2);
    expect(queuePool.enqueued[0]?.delayMs).toBeGreaterThan(0);

    // 租约已释放，等待下一次重新抢占
    const lease = await prisma.taskLease.findUnique({ where: { taskId: task.id } });
    expect(lease).toBeNull();

    // ── 第 2 次尝试：仍然失败，但预算未耗尽 → 继续安排重试 ──
    const second = await runner.handleJob({ taskId: task.id, attempt: 2 });
    expect(second.status).toBe('retry_scheduled');

    const afterSecond = await prisma.agentTask.findUnique({
      where: { id: task.id },
      include: { attemptsLog: true },
    });
    expect(afterSecond?.attempts).toBe(2);
    expect(afterSecond?.attemptsLog).toHaveLength(2);
    expect(queuePool.enqueued).toHaveLength(2);

    // ── 第 3 次尝试：预算耗尽 → 终态失败，不再安排重试 ──
    const third = await runner.handleJob({ taskId: task.id, attempt: 3 });
    expect(third.status).toBe('failed');

    const afterThird = await prisma.agentTask.findUnique({ where: { id: task.id } });
    expect(afterThird?.status).toBe('failed');
    expect(afterThird?.finishedAt).not.toBeNull();
    // 仍然是 2 次入队记录，第三次失败后不再重试
    expect(queuePool.enqueued).toHaveLength(2);
  });

  it('模型层自行消化的瞬时故障不会打扰领域层', async () => {
    // failFirstN: 1 会被模型层用掉（同模型重试成功），任务一次即成功
    const adapter = new MockProviderAdapter({
      failures: [{ capability: 'image', failFirstN: 1, code: 'PROVIDER_UNAVAILABLE' }],
    });
    const runtimeFlaky = await buildModelRuntime({
      encryptionKey: TEST_KEY,
      forceMock: true,
      mockAdapter: adapter,
    });

    const runner = new TaskRunner({
      registry: createDefaultSkillRegistry(),
      deps: buildSkillDeps({ router: runtimeFlaky.router, models: runtimeFlaky.models }),
      queues: queuePool as unknown as TaskQueuePool,
      workerId: 'flaky-worker',
      logger: silentLogger,
      heartbeatMs: 60_000,
      leaseMs: 60_000,
      confirmationPolicy: 'reject',
    });

    const task = await prisma.agentTask.create({
      data: {
        projectId,
        skillId: 'image.generate',
        queueName: 'ai_image',
        input: { prompt: '瞬时故障测试', name: '抖动图' } as never,
        maxAttempts: 3,
      },
      select: { id: true },
    });

    const result = await runner.handleJob({ taskId: task.id, attempt: 1 });
    expect(result.status).toBe('success');

    const after = await prisma.agentTask.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('success');
    expect(after?.attempts).toBe(1);
    // 领域层没有介入，因此没有任何重试入队
    expect(queuePool.enqueued).toHaveLength(0);

    // 降级/重试链路被记录在 model_tasks 的 attemptChain 中
    const modelTasks = await prisma.modelTask.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(modelTasks).toHaveLength(1);
    const chain = modelTasks[0]?.attemptChain as Array<{ ok: boolean }> | null;
    // 第一次失败、第二次成功 —— 两次尝试都被记录
    expect(Array.isArray(chain)).toBe(true);
    expect(chain?.length).toBeGreaterThanOrEqual(2);
    expect(chain?.[0]?.ok).toBe(false);
  });

  it('不可重试的错误类型不会消耗尝试预算', async () => {
    const runner = new TaskRunner({
      registry: createDefaultSkillRegistry(),
      deps: buildSkillDeps({ router: runtime.router, models: runtime.models }),
      queues: queuePool as unknown as TaskQueuePool,
      workerId: 'nonretry-worker',
      logger: silentLogger,
      heartbeatMs: 60_000,
      leaseMs: 60_000,
      confirmationPolicy: 'reject',
    });

    // metadata 与类型不匹配 → ValidationError → 不可重试
    const task = await prisma.agentTask.create({
      data: {
        projectId,
        skillId: 'asset.create',
        queueName: 'asset',
        input: { type: 'character', name: 'X', metadata: { appearance: 'not-an-object' } } as never,
        maxAttempts: 5,
      },
      select: { id: true },
    });

    const result = await runner.handleJob({ taskId: task.id, attempt: 1 });
    expect(result.status).toBe('failed');

    const after = await prisma.agentTask.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('failed');
    expect(after?.attempts).toBe(1);
    expect(queuePool.enqueued).toHaveLength(0);
  });
});

describe('技能未实现时的行为', () => {
  it('返回面向用户的说明，而不是技术堆栈', async () => {
    const runner = makeRunner({});
    const { taskId, result } = await runJob(runner, {
      skillId: 'advertisement.idea',
      input: { objective: {} },
    });

    expect(result.status).toBe('failed');

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    expect(task?.errorMessage).toContain('正在开发中');
    // 不得泄漏技术细节
    expect(task?.errorMessage).not.toContain('at ');
    expect(JSON.stringify(task?.error)).not.toMatch(/\.ts:\d+/);
  });

  it('未实现的技能属于不可重试，不浪费尝试次数', async () => {
    const runner = makeRunner({});
    const { taskId } = await runJob(runner, {
      skillId: 'drama.script',
      input: {},
      maxAttempts: 5,
    });

    const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
    // 一次即终态失败
    expect(task?.status).toBe('failed');
    expect(task?.attempts).toBe(1);
    expect(queuePool.enqueued).toHaveLength(0);
  });
});

/**
 * 结果卡落会话消息。
 *
 * ── 这条守的是什么 ──
 * 此前结果卡只活在**前端内存**里：界面收到 `task.status` 后自行拉任务详情、
 * 在本地拼一条消息。刷新即消失，只能靠「回捞最近 50 个成功任务」兜底 ——
 * 超出窗口的结果卡就永远不见了，而界面仍然宣称历史完整。
 *
 * 现在由 Worker 在任务成功后把它落成一条 `result_card` 会话消息，
 * 「刷新后还在」才是数据库保证的，而不是界面尽力而为的。
 */
describe('结果卡落会话消息', () => {
  it('挂在会话上的任务成功后，结果卡成为一条持久化消息', async () => {
    const session = await prisma.session.create({
      data: { projectId, title: '结果卡落库验证' },
      select: { id: true },
    });

    const task = await prisma.agentTask.create({
      data: {
        projectId,
        contentId,
        sessionId: session.id,
        skillId: 'asset.create',
        queueName: 'asset',
        input: { type: 'prop', name: '结果卡落库道具' } as never,
        maxAttempts: 1,
      },
      select: { id: true },
    });

    const result = await makeRunner({}).handleJob({ taskId: task.id, attempt: 1 });
    expect(result.status).toBe('success');

    const messages = await prisma.sessionMessage.findMany({
      where: { sessionId: session.id },
      select: { kind: true, payload: true, content: true, taskId: true },
    });

    const card = messages.find((message) => message.kind === 'result_card');
    expect(card, '任务成功后没有把结果卡落成会话消息（刷新后卡片会消失）').toBeDefined();

    /*
     * 消息行的 `taskId` 必须指向产出它的任务。
     * 前端拿它去重：刷新时先把历史里已有的卡记账，再回捞补历史 ——
     * 少了这个字段，同一个任务会被补出第二张卡。
     *
     * 刻意断言**列**而不是 `payload.taskId`：载荷由各技能自己构造，
     * `asset.create` 的卡压根不带这个字段（第一版就是按载荷写的，当场红）。
     */
    expect(card?.taskId).toBe(task.id);
    // 消息正文是摘要，不是空串：会话流里没有载荷时也要能读懂这一条
    expect(card?.content.length ?? 0).toBeGreaterThan(0);
  });

  it('没有会话的任务不写会话消息（也没有可写的对象）', async () => {
    const { taskId, result } = await runJob(makeRunner({}), {
      skillId: 'asset.create',
      input: { type: 'prop', name: '无会话道具' },
    });
    expect(result.status).toBe('success');

    expect(await prisma.sessionMessage.count({ where: { taskId } })).toBe(0);
  });
});
