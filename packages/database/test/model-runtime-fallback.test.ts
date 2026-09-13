/**
 * Mock 回落的单向棘轮 —— 两条不变量。
 *
 * ── 那个棘轮长什么样 ──
 * `resolveModelRowId` 为了满足 `model_tasks.modelId` 的外键，会在**首次 Mock
 * 调用之后**往库里写一条占位 Provider 与它的模型行。而回落判据早先写的是
 * `models.length === 0`：
 *
 *   空库首次装配 usingMock=true（库中 provider 行 0）
 *   → 跑一次 Mock 调用，库里多出 provider_mock 与它的（capabilities 为空的）模型
 *   → 再次装配：models.length > 0，于是**不再回落**
 *   → 可那些占位行能力标签是空的、Provider 当时还是 kind='custom'（无适配器）
 *   → **所有模型调用直接失败**，且不会自愈，只能手工删库。
 *
 * 这是实测出来的，不是推演。
 *
 * ── 本文件守的两条 ──
 *   ① 回落判据按 Provider 类型算，不按模型条数算（`needsMockFallback`，纯函数）；
 *   ② 占位行本身写得诚实：`kind='mock'`、`capabilities` 取自内置目录
 *      （`resolveModelRowId`，只动 `provider_mock` 这一行，不碰真实 Provider）。
 */
import { afterAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, prisma } from '../src/index.js';
import { needsMockFallback, resolveModelRowId } from '../src/model-runtime.js';

/** 内置目录里的模型 id 之一（`mock` + `mocktextv1`） */
const MOCK_TEXT_MODEL_ID = 'mockmocktextv1';

afterAll(async () => {
  await disconnectPrisma();
});

describe('needsMockFallback —— 判据按 Provider 类型，不按模型条数', () => {
  it('一个模型都没有：必须回落', () => {
    expect(needsMockFallback([], new Map())).toBe(true);
  });

  it('只有 mock 类的模型：仍然必须回落（这就是那个棘轮）', () => {
    const 占位行 = [{ providerId: 'provider_mock' }, { providerId: 'provider_mock' }];
    const kinds = new Map([['provider_mock', 'mock']]);
    // 按 models.length 判断的实现会在这里返回 false —— 链路随即失效
    expect(
      needsMockFallback(占位行, kinds),
      '把占位行当成了可用模型：空库跑过一次 Mock 之后就再也回不来了',
    ).toBe(true);
  });

  it('占位行的 kind 被写错时，靠固定 id 仍然认得出来（双保险）', () => {
    // 早先写的是 kind='custom'（一个没有适配器的种类）
    const kinds = new Map([['provider_mock', 'custom']]);
    expect(needsMockFallback([{ providerId: 'provider_mock' }], kinds)).toBe(true);
  });

  it('有真实模型时不回落（有真实模型就必须用真实的）', () => {
    const kinds = new Map([['p1', 'openai_compatible']]);
    expect(needsMockFallback([{ providerId: 'p1' }], kinds)).toBe(false);
  });

  it('真实模型与 mock 并存时也不回落', () => {
    const kinds = new Map([
      ['p1', 'openai_compatible'],
      ['provider_mock', 'mock'],
    ]);
    expect(needsMockFallback([{ providerId: 'provider_mock' }, { providerId: 'p1' }], kinds)).toBe(
      false,
    );
  });

  it('forceMock 覆盖一切（自动化测试用）', () => {
    const kinds = new Map([['p1', 'openai_compatible']]);
    expect(needsMockFallback([{ providerId: 'p1' }], kinds, true)).toBe(true);
  });
});

describe('resolveModelRowId —— 占位行必须写得诚实', () => {
  it('写入的模型行带能力标签，Provider 标成 mock', async () => {
    const rowId = await resolveModelRowId(MOCK_TEXT_MODEL_ID);

    const model = await prisma.model.findUnique({
      where: { id: rowId },
      select: { modelKey: true, capabilities: true, provider: { select: { kind: true } } },
    });

    // 空能力 = 路由永远选不中它，等于白占一行
    expect(
      model?.capabilities.length ?? 0,
      '占位模型的 capabilities 是空的，任何请求都路由不到它',
    ).toBeGreaterThan(0);

    /*
     * `kind` 必须是 `mock`。
     * 早先写的是 `custom` —— 那是个**没有内置适配器**的种类，
     * 于是这行不只是「没用」，而是「看起来像配置好了但一调用就失败」。
     */
    expect(model?.provider.kind).toBe('mock');
  });

  it('重复调用是幂等的，不会每次多出一行', async () => {
    const 第一次 = await resolveModelRowId(MOCK_TEXT_MODEL_ID);
    const 第二次 = await resolveModelRowId(MOCK_TEXT_MODEL_ID);
    // 进程内有缓存；即便绕过缓存，也会按 id / modelKey 找到同一行
    expect(第二次).toBe(第一次);
  });

  it('非 mock 的 modelId 原样返回，不碰数据库', async () => {
    expect(await resolveModelRowId('cmtzrealmodel1')).toBe('cmtzrealmodel1');
  });
});
