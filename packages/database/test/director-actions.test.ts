/**
 * 导演动作仓储集成测试（连真库）
 *
 * 关键语义：
 * 1. requiresConfirmation 由领域函数推导 —— 调用方传什么都不影响结果
 * 2. 确认是**幂等**的：重复确认不重复转移、不覆盖 confirmedAt
 * 3. 执行态写入带 CAS：状态不对时明确失败，而不是把终态改回去
 * 4. 未接入的动作类型在落库前被拒绝
 *
 * ── 两条错误路径必须分开断言（动作类型未接入 vs payload 非法）──
 * `parseActionPayload` 对**未接入**的类型抛 `ValidationError`（文案含「尚未接入」），
 * 对**已接入但 payload 不合法**的输入抛 `ZodError`。仓储若只按
 * `instanceof ValidationError` 分支，后者会漏成 500 —— 所以两种真实错误类型
 * 各断言一次。本包 package.json 里没有直接依赖 `zod`，无法 `instanceof ZodError`，
 * 因此除了断言 `name === 'ZodError'` 与 `issues` 形状外，还用仓库既有的
 * `toSvhError` 断言它在 API 层会被归一为 `VALIDATION_FAILED` / **400**（而不是 500）。
 *
 * ── 「过期写入」用例证明了什么、没证明什么（Ruling 35）──
 * 本文件没有给 `confirmAction` 传「期望状态」的入参，库中状态是在**调用之前**
 * 被改掉的，所以那条用例行为上等价于「拒绝后不能再被确认」：它证明的是
 * **不得静默改写非来源状态**，而**不是**「判据写在数据库的 WHERE 里」。
 * 如实说明：一个无 CAS 的实现（读当前状态 → 校验 → 无条件
 * `update({ where: { id } })`）能通过除并发用例外的全部用例。
 * CAS 真正承重的证据是**变异 C**（删掉 `updateMany` 的 status 条件 → 该用例与
 * 另外 4 条一起变红）；并发用例（见下）只提供**概率性**覆盖，其判别力与实测
 * 失败率记在报告里。
 *
 * ── 状态转移表不变量（Ruling 33）──
 * 曾经有一个真实缺陷：`rejectAction` 的 `from` 里多写了领域表并不允许的
 * `'failed'`，而 CAS 命中时状态机根本不会被咨询 ⇒ 静默写入非法状态。
 * 现在六个写入口的前置集集中在校验表 `DIRECTOR_ACTION_OPERATIONS` 里，
 * 文件末尾的不变量用例遍历整张表对着领域状态机校验 —— 这类错第一次运行就炸。
 *
 * ── 数据边界 ──
 * 用例只碰本文件自建的 project / content，`afterAll` 只删这个 project
 * （director_actions 与 contents 都是 onDelete: Cascade）。payload 里的
 * `shot1` / `asset1` 之类是不存在的 id：`targets` 只是 JSON，没有外键，
 * 这里测的是**状态机与确认规则**，不需要真去造镜头与素材。
 *
 * 注意 id 一律不带下划线：`idSchema` 是 `/^[a-z0-9]+$/i`（规范要求系统内只有
 * 一种 id 风格）。brief 里写的 `shot_1` 会被它判成「ID 格式非法」—— 那样
 * 「payload 非法 → ZodError」那条用例是因为 id 而不是因为目标实体错配抛错，
 * 属于**假绿**，所以这里统一按契约写成 `shot1`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError, canTransitionDirectorAction, toSvhError } from '@svh/domain';

import { disconnectPrisma, prisma } from '../src/index.js';
import {
  cancelAction,
  confirmAction,
  createAction,
  DIRECTOR_ACTION_OPERATIONS,
  getAction,
  listActions,
  markExecuted,
  markExecuting,
  markFailed,
  rejectAction,
} from '../src/director-actions.js';
import type { DirectorActionRow } from '../src/director-actions.js';

let projectId = '';
let contentId = '';

/**
 * 跑一个必然失败的调用并取回错误对象本身。
 *
 * `rejects.toThrow()` 只告诉我们「抛了」，拿不到实例就无法断言**是哪一种**错误 ——
 * 而本文件最关键的区分恰恰是「未接入 → ValidationError」与「payload 非法 → ZodError」。
 */
async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`抛出的不是 Error 实例：${String(error)}`);
  }
  throw new Error('预期抛错，但调用成功了');
}

/** 本项目的动作总数：用于断言「被拒绝的写入连库都没碰」 */
function countActions(): Promise<number> {
  return prisma.directorAction.count({ where: { projectId } });
}

beforeAll(async () => {
  const project = await prisma.project.create({ data: { name: `动作测试-${Date.now()}` } });
  projectId = project.id;
  const content = await prisma.content.create({
    data: { projectId, type: 'advertisement', title: '测试内容' },
  });
  contentId = content.id;
});

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } });
  await disconnectPrisma();
});

describe('导演动作仓储', () => {
  it('单个镜头的更新提案无需确认，直接进入 approved', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'update_shot',
      payload: {
        targets: [{ type: 'shot', id: 'shot1' }],
        changes: { description: '改成中景' },
      },
    });
    expect(action.requiresConfirmation).toBe(false);
    expect(action.status).toBe('approved');
    expect(action.batchSize).toBe(1);
  });

  it('批量提案需要确认，落在 awaiting_confirmation', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'update_shot',
      payload: {
        targets: [
          { type: 'shot', id: 'shot1' },
          { type: 'shot', id: 'shot2' },
        ],
        changes: { description: '统一改成短发' },
      },
    });
    expect(action.requiresConfirmation).toBe(true);
    expect(action.status).toBe('awaiting_confirmation');
    expect(action.batchSize).toBe(2);
  });

  it('即便调用方试图传 requiresConfirmation 也不生效', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'user',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shot9' }], changes: {} },
      // @ts-expect-error 该字段不属于入参，运行时也不应被采纳
      requiresConfirmation: false,
    });
    expect(action.requiresConfirmation).toBe(true);
  });

  it('确认是幂等的：重复确认不改变 confirmedAt', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_asset',
      payload: { targets: [{ type: 'asset', id: 'asset1' }], changes: {} },
    });

    const confirmed = await confirmAction(action.id);
    expect(confirmed.status).toBe('approved');
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);

    // 把库里的 confirmedAt 往前拨 60 秒（Ruling 34）：两次 new Date() 之间只隔
    // 几次数据库往返，而 Postgres 的 timestamp(3) 截到毫秒 —— 直接比较两个
    // 「刚刚」的时间戳，「重复确认时顺手重写 confirmedAt」的实现会**偶发通过**。
    // 拨早之后，「原样返回旧值」与「被刷新成 now」变成确定性可分的两种结果。
    const aged = new Date(Date.now() - 60_000);
    await prisma.directorAction.update({ where: { id: action.id }, data: { confirmedAt: aged } });

    const again = await confirmAction(action.id);
    expect(again.status).toBe('approved');
    expect(again.confirmedAt?.getTime()).toBe(aged.getTime());
  });

  it('拒绝后不能再被确认', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'user',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shot7' }], changes: {} },
    });
    await rejectAction(action.id, '用户取消');
    // 断到精确文案：`/非法/` 之类会被任何含「非法」的文案命中（Ruling 36）
    await expect(confirmAction(action.id)).rejects.toThrow(
      /非法的动作状态转移：rejected → approved/,
    );
  });

  it('执行态写入带 CAS：已执行的动作不能再标记失败', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shot8' }], changes: {} },
    });
    await confirmAction(action.id);
    await markExecuting(action.id);
    await markExecuted(action.id, { taskIds: ['task_1'] });

    // 断到精确文案：宽松的 `/非法|executed/` 会被任何含「非法」的文案命中（Ruling 36）
    await expect(markFailed(action.id, '不该发生')).rejects.toThrow(
      /非法的动作状态转移：executed → failed/,
    );
    const fresh = await getAction(action.id);
    expect(fresh.status).toBe('executed');
    expect(fresh.result).toEqual({ taskIds: ['task_1'] });
  });

  it('未接入的动作类型在落库前被拒绝', async () => {
    const before = await countActions();

    const error = await captureError(() =>
      createAction({
        projectId,
        contentId,
        actor: 'agent',
        type: 'run_workflow',
        payload: { targets: [{ type: 'workflow', id: 'w1' }], changes: {} },
      }),
    );

    // 领域层抛的是 ValidationError（不是 ZodError）：类型本身还没接入
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain('尚未接入');
    // 「落库前」不是修辞：库里不能多出这一行
    expect(await countActions()).toBe(before);
  });

  it('已接入但 payload 非法：抛的是 ZodError，且归一为 400 而不是 500', async () => {
    const before = await countActions();

    // update_shot 的目标实体只能是 shot（规范 §4.3）；指向 asset 属于 payload 形状不合法
    const error = await captureError(() =>
      createAction({
        projectId,
        contentId,
        actor: 'agent',
        type: 'update_shot',
        payload: { targets: [{ type: 'asset', id: 'asset1' }], changes: { description: '换成素材' } },
      }),
    );

    // 与「未接入」是两个不同的错误类型 —— 只按 ValidationError 分支会让这条漏成 500
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error.name).toBe('ZodError');

    // 断到**具体是哪条规则**：必须是「目标实体错配」（targets.0.type），
    // 而不是顺带撞上的 id 格式（targets.0.id）—— 否则这条用例是假绿
    const issues = (error as { issues?: { path?: (string | number)[] }[] }).issues ?? [];
    const paths = issues.map((issue) => (issue.path ?? []).join('.'));
    expect(paths).toContain('targets.0.type');
    expect(paths).not.toContain('targets.0.id');

    const normalized = toSvhError(error);
    expect(normalized.code).toBe('VALIDATION_FAILED');
    expect(normalized.httpStatus).toBe(400);

    expect(await countActions()).toBe(before);
  });

  it('待确认列表可按状态过滤', async () => {
    const pendingAction = await createAction({
      projectId,
      contentId,
      actor: 'user',
      type: 'delete_asset',
      payload: { targets: [{ type: 'asset', id: 'assetpending' }], changes: {} },
    });
    expect(pendingAction.status).toBe('awaiting_confirmation');

    const pending = await listActions(projectId, { status: 'awaiting_confirmation' });
    // 先钉住非空：`[].every(...)` 恒为 true，只写 every 会是一条空断言
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.map((action) => action.id)).toContain(pendingAction.id);
    expect(pending.every((action) => action.status === 'awaiting_confirmation')).toBe(true);

    const approved = await listActions(projectId, { status: 'approved' });
    expect(approved.map((action) => action.id)).not.toContain(pendingAction.id);
    // 不带过滤时两边都能看到（过滤是收窄，不是换一份数据）
    const all = await listActions(projectId);
    expect(all.map((action) => action.id)).toEqual(
      expect.arrayContaining([pendingAction.id, ...approved.map((action) => action.id)]),
    );
  });

  it('不得静默改写非来源状态：快照读出后库里状态被改走，原入口必须响亮失败', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'user',
      type: 'delete_asset',
      payload: { targets: [{ type: 'asset', id: 'assetstale' }], changes: {} },
    });

    // 调用方读到并据此渲染确认按钮的快照
    const snapshot = await getAction(action.id);
    expect(snapshot.status).toBe('awaiting_confirmation');

    // 另一个写入者（用户改点了拒绝 / 后台执行器）抢先一步改掉了库里的状态
    await prisma.directorAction.update({
      where: { id: action.id },
      data: { status: 'rejected' },
    });

    // 拿着过期快照推进：必须响亮失败，而不是静默成功、更不是把终态改回去。
    // 注意这条**不**证明 CAS：干预发生在调用之前，`snapshot` 从未被被测代码消费，
    // 行为上等价于「拒绝后不能再被确认」；承接 CAS 证据的是变异 C（见文件头说明）。
    const error = await captureError(() => confirmAction(action.id));
    expect(error.message).toContain('非法的动作状态转移：rejected → approved');
    expect(error.message).toContain(action.id);

    const fresh = await getAction(action.id);
    expect(fresh.status).toBe('rejected');
    expect(fresh.confirmedAt).toBeNull();
  });

  it('并发确认与拒绝：恰好一个成功，库中终态与胜者一致', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'user',
      type: 'delete_asset',
      payload: { targets: [{ type: 'asset', id: 'assetrace' }], changes: {} },
    });

    // 两个入口在同一 tick 发出（数组求值会同步跑到各自的第一个 await），
    // 因此两次「读」在数据库里是真的并发 —— 这正是无 CAS 实现会双双成功的场景。
    const settled = await Promise.allSettled([confirmAction(action.id), rejectAction(action.id)]);

    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<DirectorActionRow> => result.status === 'fulfilled',
    );
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // 胜者的结果与库中终态一致，而不是「两个都成功、后写的覆盖先写的」
    const winner = fulfilled[0];
    if (winner === undefined) {
      throw new Error('预期恰好一个入口成功，但没有任何 fulfilled 结果');
    }
    const fresh = await getAction(action.id);
    expect(fresh.status).toBe(winner.value.status);
    expect(['approved', 'rejected']).toContain(fresh.status);
  });

  it('失败后可以重新批准重试：confirmedAt 被刷新，动作能再次进入 executing', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shotfailed' }], changes: {} },
    });

    // 第一次批准 → 执行 → 失败
    const first = await confirmAction(action.id);
    expect(first.status).toBe('approved');
    expect(first.confirmedAt).toBeInstanceOf(Date);
    await markExecuting(action.id);
    const failed = await markFailed(action.id, '执行时报错');
    expect(failed.status).toBe('failed');

    // 领域状态机允许 failed → approved：失败的动作在用户重新批准后可以重试
    expect(canTransitionDirectorAction('failed', 'approved')).toBe(true);

    // 把首次批准时间往前拨 60 秒：否则两次批准可能落在同一毫秒，
    // 「沿用了旧值」与「写入新值」在断言上就分不出来
    const aged = new Date(Date.now() - 60_000);
    await prisma.directorAction.update({ where: { id: action.id }, data: { confirmedAt: aged } });

    const reApproved = await confirmAction(action.id);
    expect(reApproved.status).toBe('approved');
    expect(reApproved.confirmedAt?.getTime()).toBeGreaterThan(aged.getTime());

    // 重试路径是完整的：重新批准之后还能再被执行器接管
    const executing = await markExecuting(action.id);
    expect(executing.status).toBe('executing');
  });

  it('状态机合法但入口前置集不匹配：proposed 行必须响亮失败，不得静默批准', async () => {
    // 这条必须**直接建行**：`createAction` 只产出 awaiting_confirmation / approved，
    // 本仓储永远不会产生 proposed。但 proposed 是 status 列的默认值，别的写入方
    // （将来的规划器、脚本、历史数据）可以产生它，所以这条分支必须常驻钉住。
    const proposed = await prisma.directorAction.create({
      data: {
        projectId,
        contentId,
        actor: 'agent',
        type: 'delete_shot',
        targets: [{ type: 'shot', id: 'shotproposed' }],
        changes: {},
        status: 'proposed',
        requiresConfirmation: false,
        batchSize: 1,
      },
    });

    // 为什么是**第三分支**而不是第二分支：`proposed → approved` 在领域状态机里
    // 是合法的（`DIRECTOR_ACTION_TRANSITIONS.proposed` 包含 'approved'），
    // 非法转移那条路径根本不会触发 —— 这里失败的原因只能是「confirmAction 的
    // 前置集不认 proposed」。两种文案必须能区分开。
    expect(canTransitionDirectorAction('proposed', 'approved')).toBe(true);

    const error = await captureError(() => confirmAction(proposed.id));
    expect(error.message).not.toContain('非法的动作状态转移');
    expect(error.message).toContain('不接受该状态');
    expect(error.message).toContain(proposed.id);
    expect(error.message).toContain('proposed');
    expect(error.message).toContain('awaiting_confirmation');

    // 响亮失败而不是静默批准：库里状态与 confirmedAt 原样不动
    const fresh = await getAction(proposed.id);
    expect(fresh.status).toBe('proposed');
    expect(fresh.confirmedAt).toBeNull();
  });

  it('执行失败的动作可以取消（语义是取消而不是拒绝），失败原因不被抹掉', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shotcancel' }], changes: {} },
    });
    await confirmAction(action.id);
    await markExecuting(action.id);
    await markFailed(action.id, '执行时报错');

    // 领域表里 failed → cancelled 是合法的（failed 的去处是 approved / cancelled）
    expect(canTransitionDirectorAction('failed', 'cancelled')).toBe(true);

    // 不带理由取消：失败原因留作历史，不被无声覆盖
    const cancelled = await cancelAction(action.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.errorMessage).toBe('执行时报错');
  });

  it('失败的动作不能走 rejectAction：必须响亮失败，且不覆盖失败原因', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shotrejectfailed' }], changes: {} },
    });
    await confirmAction(action.id);
    await markExecuting(action.id);
    await markFailed(action.id, '执行时报错');

    // 领域表里 failed 没有 rejected 这个去处 —— 此前 from 里多写的 'failed'
    // 让 CAS 必命中、状态机永不被咨询，于是静默写入了这条不可达转移（Ruling 33）
    expect(canTransitionDirectorAction('failed', 'rejected')).toBe(false);

    await expect(rejectAction(action.id, '用户拒绝')).rejects.toThrow(
      /非法的动作状态转移：failed → rejected/,
    );

    const fresh = await getAction(action.id);
    expect(fresh.status).toBe('failed');
    expect(fresh.errorMessage).toBe('执行时报错');
  });

  it('终态不可取消：已执行的动作 cancelAction 必须失败', async () => {
    const action = await createAction({
      projectId,
      contentId,
      actor: 'agent',
      type: 'delete_shot',
      payload: { targets: [{ type: 'shot', id: 'shotcanceled' }], changes: {} },
    });
    await confirmAction(action.id);
    await markExecuting(action.id);
    await markExecuted(action.id, { taskIds: [] });

    await expect(cancelAction(action.id, '来不及了')).rejects.toThrow(
      /非法的动作状态转移：executed → cancelled/,
    );

    const fresh = await getAction(action.id);
    expect(fresh.status).toBe('executed');
    expect(fresh.executedAt).toBeInstanceOf(Date);
  });
});

/**
 * 状态转移表不变量（Ruling 33 的根因修复）。
 *
 * `DIRECTOR_ACTION_OPERATIONS` 是六个写入口 `from` / `to` 的唯一事实来源
 * （函数从它取 spec），所以「遍历这张表」等价于「遍历仓储的每个状态转移调用点」。
 * 一个真实缺陷促成了这条断言：`rejectAction` 的 `from` 曾多写 `'failed'`，
 * 而 CAS 命中时状态机不会被咨询 ⇒ 静默写入领域不可达的 `failed → rejected`。
 * 这类错必须第一次运行就炸出来，而不是靠审阅者读代码发现。
 */
describe('状态转移表不变量', () => {
  it('每个写入口的每个来源状态都必须是领域状态机允许的转移', () => {
    for (const [operation, spec] of Object.entries(DIRECTOR_ACTION_OPERATIONS)) {
      for (const from of spec.from) {
        expect(
          canTransitionDirectorAction(from, spec.to),
          `${operation}: ${from} → ${spec.to} 不在领域状态机里`,
        ).toBe(true);
      }
    }
  });

  it('写入口清单与实现一一对应（新增入口必须登记进表）', () => {
    // 与领域测试的 SPEC_ACTION_TYPES 同一手法：硬编码清单，增删入口都会让这条红
    expect(Object.keys(DIRECTOR_ACTION_OPERATIONS)).toEqual([
      'confirmAction',
      'rejectAction',
      'cancelAction',
      'markExecuting',
      'markExecuted',
      'markFailed',
    ]);
  });
});
