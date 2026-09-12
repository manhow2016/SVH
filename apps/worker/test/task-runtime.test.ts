/**
 * 任务运行时测试
 *
 * 验证 Phase 0 审计得出的三条硬性契约是否**真的接进了执行路径**：
 *   1. 幂等三件套：DB 唯一键 + 确定性 jobId + CAS 闸门
 *   2. 状态机白名单：非法转移必须抛错
 *   3. Fencing：失去租约的写入必须被拒绝
 *
 * 这些是最容易「写了但没接上」的地方，因此必须有测试守住。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildJobId, parseJobId } from '@svh/domain';
import {
  cancelTask,
  claimTask,
  completeTask,
  computeRetryDelay,
  createTask,
  disconnectPrisma,
  failTask,
  parkTaskForConfirmation,
  prisma,
  reclaimExpiredTasks,
  renewLease,
  updateTaskProgress,
} from '@svh/database';

let projectId: string;

beforeAll(async () => {
  const project = await prisma.project.create({
    data: { name: `任务运行时测试 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;
});

afterAll(async () => {
  // 级联删除会带走任务、租约与尝试记录
  await prisma.project.deleteMany({ where: { id: projectId } });
  await disconnectPrisma();
});

describe('幂等三件套', () => {
  it('相同幂等键返回同一任务，不会重复创建', async () => {
    const key = `idem-${Date.now()}`;
    const first = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      input: { type: 'character', name: '幂等测试' },
      idempotencyKey: key,
    });
    const second = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      input: { type: 'character', name: '幂等测试' },
      idempotencyKey: key,
    });

    expect(second.taskId).toBe(first.taskId);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    const count = await prisma.agentTask.count({
      where: { projectId, idempotencyKey: key },
    });
    expect(count).toBe(1);
  });

  it('不同幂等键创建不同任务', async () => {
    const a = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      idempotencyKey: `a-${Date.now()}`,
    });
    const b = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      idempotencyKey: `b-${Date.now()}`,
    });
    expect(a.taskId).not.toBe(b.taskId);
  });

  it('jobId 是确定性的，且可反解出任务与尝试序号', async () => {
    const created = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
    });

    expect(created.jobId).toBe(buildJobId(created.taskId, 1));
    const parsed = parseJobId(created.jobId);
    expect(parsed).toEqual({ taskId: created.taskId, attempt: 1 });
  });

  it('未提供幂等键时每次创建新任务', async () => {
    const a = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const b = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    expect(a.taskId).not.toBe(b.taskId);
  });
});

describe('CAS 抢占与租约', () => {
  it('首个 Worker 能抢占，第二个被拒绝', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });

    const first = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    expect(first.ok).toBe(true);

    // 租约仍有效，第二个 Worker 不应抢到
    const second = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('already_leased');
  });

  it('抢占后状态变为 running，尝试次数递增，并创建租约与尝试记录', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    expect(claim.ok).toBe(true);

    const task = await prisma.agentTask.findUnique({
      where: { id: created.taskId },
      include: { lease: true, attemptsLog: true },
    });

    expect(task?.status).toBe('running');
    expect(task?.attempts).toBe(1);
    expect(task?.lease?.workerId).toBe('worker-A');
    expect(task?.lease?.leaseVersion).toBe(1);
    expect(task?.attemptsLog).toHaveLength(1);
    expect(task?.attemptsLog[0]?.attempt).toBe(1);
  });

  it('租约过期后可以被另一个 Worker 接管，且 fencing 令牌递增', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const first = await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: -1000 });
    expect(first.ok).toBe(true);

    const second = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    expect(second.ok).toBe(true);
    expect(second.ok === true && second.leaseVersion).toBe(2);
    expect(second.ok === true && second.attempt).toBe(2);
  });

  it('终态任务不可再被抢占', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    await cancelTask(created.taskId);

    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    expect(claim.ok).toBe(false);
    expect(claim.ok === false && claim.reason).toBe('terminal');
  });

  it('不存在的任务返回 not_found 而不是抛错', async () => {
    const claim = await claimTask({ taskId: 'not-a-real-task', workerId: 'worker-A' });
    expect(claim.ok).toBe(false);
    expect(claim.ok === false && claim.reason).toBe('not_found');
  });
});

describe('Fencing：过期 Worker 的写入必须被拒绝', () => {
  it('旧令牌无法完成已被接管的租约', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });

    // A 抢占后租约立刻过期，B 接管
    const a = await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: -1000 });
    expect(a.ok).toBe(true);
    const b = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('抢占失败');

    // A 用旧令牌尝试完成 —— 必须失败
    const staleWrite = await completeTask(
      { taskId: created.taskId, workerId: 'worker-A', leaseVersion: a.leaseVersion, attempt: a.attempt },
      { result: '来自旧 Worker 的结果' },
    );
    expect(staleWrite).toBe(false);

    // B 用新令牌完成 —— 必须成功
    const freshWrite = await completeTask(
      { taskId: created.taskId, workerId: 'worker-B', leaseVersion: b.leaseVersion, attempt: b.attempt },
      { result: '来自新 Worker 的结果' },
    );
    expect(freshWrite).toBe(true);

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('success');
    // 采纳的是新 Worker 的结果
    expect((task?.output as { result?: string } | null)?.result).toBe('来自新 Worker 的结果');
  });

  it('旧令牌无法续约', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const a = await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: -1000 });
    if (!a.ok) throw new Error('抢占失败');
    const b = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    if (!b.ok) throw new Error('接管失败');

    const staleRenew = await renewLease({
      taskId: created.taskId,
      workerId: 'worker-A',
      leaseVersion: a.leaseVersion,
      attempt: a.attempt,
    });
    expect(staleRenew).toBe(false);

    const freshRenew = await renewLease({
      taskId: created.taskId,
      workerId: 'worker-B',
      leaseVersion: b.leaseVersion,
      attempt: b.attempt,
    });
    expect(freshRenew).toBe(true);
  });

  it('旧令牌无法写入进度', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const a = await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: -1000 });
    if (!a.ok) throw new Error('抢占失败');
    const b = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    if (!b.ok) throw new Error('接管失败');

    const staleProgress = await updateTaskProgress(
      { taskId: created.taskId, workerId: 'worker-A', leaseVersion: a.leaseVersion, attempt: a.attempt },
      50,
      '旧 Worker 的进度',
    );
    expect(staleProgress).toBe(false);
  });
});

describe('进度上报', () => {
  it('进度单调不减：倒退的写入被拒绝', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');
    const ctx = {
      taskId: created.taskId,
      workerId: claim.workerId,
      leaseVersion: claim.leaseVersion,
      attempt: claim.attempt,
    };

    expect(await updateTaskProgress(ctx, 30, '第一步')).toBe(true);
    expect(await updateTaskProgress(ctx, 60, '第二步')).toBe(true);

    // 倒退必须被拒绝 —— 前端进度条不能往回跳
    expect(await updateTaskProgress(ctx, 40, '试图倒退')).toBe(false);

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.progress).toBe(60);
    expect(task?.progressMessage).toBe('第二步');
  });

  it('超出 0~100 的值会被收敛', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');
    const ctx = {
      taskId: created.taskId,
      workerId: claim.workerId,
      leaseVersion: claim.leaseVersion,
      attempt: claim.attempt,
    };

    await updateTaskProgress(ctx, 999);
    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.progress).toBe(100);
  });

  it('只有 running 状态能上报进度', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    // 未抢占（仍是 pending）时无法上报
    const written = await updateTaskProgress(
      { taskId: created.taskId, workerId: 'worker-A', leaseVersion: 1, attempt: 1 },
      50,
    );
    expect(written).toBe(false);
  });
});

describe('失败与重试（领域层重试）', () => {
  it('仍有尝试预算时返回 shouldRetry 与下一次作业 id', async () => {
    const created = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      maxAttempts: 3,
    });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');

    const outcome = await failTask(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      { message: '模型服务暂时不可用', userMessage: '模型服务暂时不可用。', retryable: true },
    );

    expect(outcome.terminal).toBe(false);
    expect(outcome.shouldRetry).toBe(true);
    expect(outcome.nextAttempt).toBe(2);
    expect(outcome.nextJobId).toBe(buildJobId(created.taskId, 2));
    expect(outcome.retryDelayMs).toBeGreaterThan(0);

    // 状态回到 pending，等待重新抢占；进度被重置
    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('pending');
    expect(task?.progress).toBe(0);
    expect(task?.errorMessage).toBe('模型服务暂时不可用。');
    // 租约被释放，下一次尝试需要重新抢占
    const lease = await prisma.taskLease.findUnique({ where: { taskId: created.taskId } });
    expect(lease).toBeNull();
  });

  it('尝试预算耗尽后进入 failed 终态', async () => {
    const created = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      maxAttempts: 1,
    });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');

    const outcome = await failTask(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      { message: '失败', retryable: true },
    );

    expect(outcome.terminal).toBe(true);
    expect(outcome.shouldRetry).toBe(false);

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('failed');
    expect(task?.finishedAt).not.toBeNull();
  });

  it('不可重试的错误立即终止，即使还有尝试预算', async () => {
    const created = await createTask({
      projectId,
      skillId: 'asset.create',
      queueName: 'asset',
      maxAttempts: 5,
    });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');

    const outcome = await failTask(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      { message: '参数不合法', retryable: false },
    );

    expect(outcome.terminal).toBe(true);
    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('failed');
  });

  it('失败会记录到 attempt 审计表（成本归因的数据基础）', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');

    await failTask(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      { message: '连接超时', retryable: true },
      { durationMs: 1234, modelId: 'model_x' },
    );

    const attempts = await prisma.taskAttempt.findMany({ where: { taskId: created.taskId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.error).toBe('连接超时');
    expect(attempts[0]?.durationMs).toBe(1234);
    expect(attempts[0]?.modelId).toBe('model_x');
  });

  it('退避时间随尝试次数增长且有抖动', () => {
    const d1 = computeRetryDelay(1, 1000, 60_000);
    const d5 = computeRetryDelay(5, 1000, 60_000);

    // 第一次退避在 1~2 秒之间
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThan(2500);
    // 第五次显著更大（指数退避）
    expect(d5).toBeGreaterThan(d1);
    // 不超过上限 + 抖动
    expect(computeRetryDelay(100, 1000, 60_000)).toBeLessThanOrEqual(61_000);
  });
});

describe('等待用户确认（高风险操作）', () => {
  it('可以置为 waiting_user 并释放租约', async () => {
    const created = await createTask({
      projectId,
      skillId: 'video.generate',
      queueName: 'ai_video',
      risk: 'high',
    });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');

    const parked = await parkTaskForConfirmation(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      '即将生成 32 个视频，需要确认。',
    );
    expect(parked).toBe(true);

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('waiting_user');
    expect(task?.progressMessage).toContain('需要确认');

    // 租约已释放
    const lease = await prisma.taskLease.findUnique({ where: { taskId: created.taskId } });
    expect(lease).toBeNull();

    // 等待确认的任务不能被抢占执行
    const reClaim = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    expect(reClaim.ok).toBe(false);
  });
});

describe('取消', () => {
  it('pending 与 running 状态都可取消', async () => {
    const pending = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    expect(await cancelTask(pending.taskId, '用户取消')).toBe(true);

    const running = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    await claimTask({ taskId: running.taskId, workerId: 'worker-A' });
    expect(await cancelTask(running.taskId)).toBe(true);

    // 取消后租约被清理
    const lease = await prisma.taskLease.findUnique({ where: { taskId: running.taskId } });
    expect(lease).toBeNull();
  });

  it('终态任务无法再次取消', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    await cancelTask(created.taskId);
    expect(await cancelTask(created.taskId)).toBe(false);
  });
});

describe('对账：回收租约过期的任务', () => {
  it('过期租约的任务被重置为 pending，其 running 尝试被标记失败', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: -1000 });
    expect(claim.ok).toBe(true);

    const reclaimed = await reclaimExpiredTasks();
    expect(reclaimed).toContain(created.taskId);

    const task = await prisma.agentTask.findUnique({
      where: { id: created.taskId },
      include: { attemptsLog: true },
    });
    expect(task?.status).toBe('pending');
    expect(task?.attemptsLog[0]?.status).toBe('failed');
    expect(task?.attemptsLog[0]?.error).toContain('租约过期');

    const lease = await prisma.taskLease.findUnique({ where: { taskId: created.taskId } });
    expect(lease).toBeNull();
  });

  it('租约未过期的任务不会被回收', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    await claimTask({ taskId: created.taskId, workerId: 'worker-A', leaseMs: 60_000 });

    const reclaimed = await reclaimExpiredTasks();
    expect(reclaimed).not.toContain(created.taskId);

    const task = await prisma.agentTask.findUnique({ where: { id: created.taskId } });
    expect(task?.status).toBe('running');
  });
});

describe('状态机白名单真的接进了执行路径', () => {
  it('完成后无法再次完成（终态不可再转移）', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');
    const ctx = {
      taskId: created.taskId,
      workerId: claim.workerId,
      leaseVersion: claim.leaseVersion,
      attempt: claim.attempt,
    };

    expect(await completeTask(ctx, { ok: true })).toBe(true);
    // 第二次写入时状态已是 success，updateMany 的条件不满足
    expect(await completeTask(ctx, { ok: true })).toBe(false);
  });

  it('completed 的任务无法转移到 running', async () => {
    const created = await createTask({ projectId, skillId: 'asset.create', queueName: 'asset' });
    const claim = await claimTask({ taskId: created.taskId, workerId: 'worker-A' });
    if (!claim.ok) throw new Error('抢占失败');
    await completeTask(
      {
        taskId: created.taskId,
        workerId: claim.workerId,
        leaseVersion: claim.leaseVersion,
        attempt: claim.attempt,
      },
      { ok: true },
    );

    const reClaim = await claimTask({ taskId: created.taskId, workerId: 'worker-B' });
    expect(reClaim.ok).toBe(false);
    expect(reClaim.ok === false && reClaim.reason).toBe('terminal');
  });
});
