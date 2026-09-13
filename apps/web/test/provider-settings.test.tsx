/**
 * Provider 配置页测试。
 *
 * 最关键的一条：**完整密钥绝不出现在界面上**。
 * 这是安全属性，不是文案问题。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { ToastProvider } from '../src/components/Toast.js';
import { ProviderSettingsPage } from '../src/features/settings/ProviderSettingsPage.js';
import type { ModelProviderView } from '../src/lib/api-types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ProviderSettingsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** 渲染完整 App，用于验证路由与全局入口 */
function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/**
 * 点击按钮。
 *
 * ── 为什么要在 findByRole 之后再取一次 ──
 * 页面从加载态切到空态时，React 可能在 `findByRole` 命中之后还有一次提交，
 * 把刚才那个按钮节点换掉（旧节点已脱离文档）。点击一个脱离文档的节点不会
 * 触发任何处理函数，用例会以「找不到 dialog」这类与真实缺陷无关的方式失败。
 * 因此先等按钮出现，再取**当前文档里**的节点来点。
 */
async function clickButton(name: string): Promise<void> {
  await screen.findByRole('button', { name });
  await userEvent.click(screen.getByRole('button', { name }));
}

/** 从空状态打开「添加模型服务」表单，返回对话框 */
async function openAddDialog(): Promise<HTMLElement> {
  await clickButton('添加模型服务');
  return screen.findByRole('dialog');
}

const EMPTY = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

/** 后端 toProviderView 的形状。默认值取「一条已配置好的 Provider」。 */
function providerView(overrides: Partial<ModelProviderView> = {}): ModelProviderView {
  return {
    id: 'pv1',
    kind: 'openai_compatible',
    name: '我的中转站',
    baseUrl: 'https://api.example.com/v1',
    enabled: true,
    health: 'unknown',
    apiKeyMask: 'sk-****abcd',
    modelCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

/** 分页外壳 */
function pageOf(items: ModelProviderView[]): unknown {
  return { ...EMPTY, items, total: items.length };
}

/** 未掩码的密钥形态：sk- 后面跟 20 位以上字母数字 */
const UNMASKED_KEY_PATTERN = /sk-[A-Za-z0-9]{20,}/;

/** 测试用完整密钥（长度足以命中未掩码形态） */
const FULL_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProviderSettingsPage', () => {
  it('无 Provider 时提示必须先配置模型', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY)));
    renderPage();

    expect(await screen.findByText('还没有配置模型服务')).toBeInTheDocument();
    expect(screen.getByText(/配置模型后才能开始生成内容/)).toBeInTheDocument();
  });

  it('列出 Provider 时只显示掩码，不显示完整密钥', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...EMPTY,
          total: 1,
          items: [
            {
              id: 'pv1',
              kind: 'openai_compatible',
              name: '我的中转站',
              baseUrl: 'https://api.example.com',
              enabled: true,
              health: 'healthy',
              apiKeyMask: 'sk-****abcd',
              modelCount: 3,
              createdAt: '',
              updatedAt: '',
            },
          ],
        }),
      ),
    );

    const { container } = renderPage();
    expect(await screen.findByText('我的中转站')).toBeInTheDocument();
    expect(screen.getByText('sk-****abcd')).toBeInTheDocument();
    // 整个渲染结果里不得出现未掩码的密钥形态
    expect(container.textContent ?? '').not.toMatch(UNMASKED_KEY_PATTERN);
  });

  it('健康状态用文字表达，不只靠颜色', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...EMPTY,
          total: 2,
          items: [
            { id: 'a', kind: 'openai_compatible', name: 'A', baseUrl: 'u', enabled: true, health: 'healthy', apiKeyMask: null, modelCount: 0, createdAt: '', updatedAt: '' },
            { id: 'b', kind: 'openai_compatible', name: 'B', baseUrl: 'u', enabled: true, health: 'down', apiKeyMask: null, modelCount: 0, createdAt: '', updatedAt: '' },
          ],
        }),
      ),
    );

    renderPage();
    expect(await screen.findByText('正常')).toBeInTheDocument();
    expect(screen.getByText('不可用')).toBeInTheDocument();
  });

  it('测试连接成功后给出反馈', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...EMPTY,
          total: 1,
          items: [
            { id: 'pv1', kind: 'openai_compatible', name: '我的中转站', baseUrl: 'u', enabled: true, health: 'unknown', apiKeyMask: 'sk-****abcd', modelCount: 0, createdAt: '', updatedAt: '' },
          ],
        }),
      )
      // 与真实响应逐字段一致：服务端从不返回 `{ ok }`，成败由 `health` 表达
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'healthy',
          message: null,
          suggestions: [],
          latencyMs: 120,
          modelCount: 0,
          usedTemporaryConfig: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument();
  });

  it('失败时把后端的下一步建议一起说出来，而不是只报「失败」', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'unknown' })])))
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'down',
          message: '无法连接到该模型服务。',
          suggestions: ['检查 API Key 是否正确'],
          latencyMs: 12,
          modelCount: 0,
          usedTemporaryConfig: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    // 原因与建议都要出现：只说「失败」等于把排查工作丢回给用户
    expect(await screen.findByText(/无法连接到该模型服务。/)).toBeInTheDocument();
    expect(await screen.findByText(/检查 API Key 是否正确/)).toBeInTheDocument();
  });

  it('用未保存的临时密钥探测时，结论要标明作用范围', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'unknown' })])))
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'healthy',
          message: null,
          suggestions: [],
          latencyMs: 30,
          modelCount: 0,
          usedTemporaryConfig: true,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    expect(await screen.findByText(/用的是未保存的临时密钥/)).toBeInTheDocument();
  });

  it('按后端实际返回的 health 判定测试结果，并刷新健康徽标', async () => {
    // 后端 /test 返回的是 probeProvider 的结果（没有 ok 字段，成功时 message 为 null）
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'unknown' })])))
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'healthy',
          message: null,
          suggestions: [],
          latencyMs: 88,
          modelCount: 0,
          usedTemporaryConfig: false,
        }),
      )
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'healthy' })])));

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument();
    // 测试后会重新拉取列表：徽标从「未检测」变成「正常」
    expect(await screen.findByText('正常')).toBeInTheDocument();
  });

  it('测试连接失败时带上后端给出的原因', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'unknown' })])))
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'down',
          message: '无法连接到该模型服务，或 API Key 无效。',
          suggestions: ['检查 API Key 是否正确'],
          latencyMs: 12,
          modelCount: 0,
          usedTemporaryConfig: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    expect(await screen.findByText(/无法连接到该模型服务，或 API Key 无效。/)).toBeInTheDocument();
  });

  it('加载中显示骨架行，而不是空状态或错误态', () => {
    // 永不 resolve，让页面停在加载态
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
    const { container } = renderPage();

    expect(container.querySelectorAll('[data-skeleton-line]').length).toBeGreaterThan(0);
    expect(screen.queryByText('还没有配置模型服务')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('加载失败时显示原因与建议，并可重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: '服务暂时不可用，请稍后重试。',
              suggestions: ['稍后重试', '若持续出现请联系管理员'],
              retryable: true,
            },
          },
          500,
        ),
      )
      .mockResolvedValueOnce(json(EMPTY));

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(await screen.findByText('加载模型服务失败')).toBeInTheDocument();
    expect(screen.getByText('服务暂时不可用，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByText('若持续出现请联系管理员')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('还没有配置模型服务')).toBeInTheDocument();
  });

  it('四种健康状态都有中文文案（文字 + 颜色双重表达）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(
          pageOf([
            providerView({ id: 'a', name: '甲', health: 'healthy' }),
            providerView({ id: 'b', name: '乙', health: 'degraded' }),
            providerView({ id: 'c', name: '丙', health: 'down' }),
            providerView({ id: 'd', name: '丁', health: 'unknown' }),
          ]),
        ),
      ),
    );

    renderPage();
    expect(await screen.findByText('甲')).toBeInTheDocument();

    // data-health 是颜色样式的钩子（与 Button 的 data-variant 同一约定）
    expect(screen.getByText('正常')).toHaveAttribute('data-health', 'healthy');
    expect(screen.getByText('不稳定')).toHaveAttribute('data-health', 'degraded');
    expect(screen.getByText('不可用')).toHaveAttribute('data-health', 'down');
    expect(screen.getByText('未检测')).toHaveAttribute('data-health', 'unknown');
  });

  it('未设置密钥的 Provider 明确标注，而不是留空', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(pageOf([providerView({ apiKeyMask: null })]))),
    );

    renderPage();
    expect(await screen.findByText('未设置密钥')).toBeInTheDocument();
  });

  it('只有空状态时才出现一个主操作，且空状态自带入口', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY)));
    renderPage();

    expect(await screen.findByText('还没有配置模型服务')).toBeInTheDocument();
    // 页头与空状态同时出现两个 Primary 会破坏主次关系，这里断言只有一个
    expect(screen.getAllByRole('button', { name: '添加模型服务' })).toHaveLength(1);
  });

  it('提交时密钥上行，但之后界面上任何地方都不保留明文', async () => {
    const created = providerView({ apiKeyMask: 'sk-****6789' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(EMPTY))
      .mockResolvedValueOnce(json(created, 201))
      .mockResolvedValueOnce(json(pageOf([created])));

    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderPage();

    const dialog = await openAddDialog();
    await userEvent.type(within(dialog).getByLabelText('名称'), '我的中转站');
    await userEvent.type(within(dialog).getByLabelText('服务地址'), 'https://api.example.com/v1');
    await userEvent.type(within(dialog).getByLabelText('API Key'), FULL_KEY);
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    // 写路径：密钥确实被送上去（否则等于没保存）
    const postInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(postInit?.method).toBe('POST');
    const rawBody = postInit?.body;
    expect(typeof rawBody).toBe('string');
    const body: { name?: string; baseUrl?: string; apiKey?: string } =
      typeof rawBody === 'string' ? JSON.parse(rawBody) : {};
    expect(body).toEqual({
      kind: 'openai_compatible',
      name: '我的中转站',
      baseUrl: 'https://api.example.com/v1',
      apiKey: FULL_KEY,
    });

    // 读路径：界面只显示服务端返回的掩码
    expect(await screen.findByText('sk-****6789')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 整个文档（含被关闭的对话框残留）都不得出现明文
    for (const text of [container.textContent ?? '', document.body.textContent ?? '']) {
      expect(text).not.toContain(FULL_KEY);
      expect(text).not.toMatch(UNMASKED_KEY_PATTERN);
    }

    // 再次打开表单：明文不能还留在状态里
    const reopened = await openAddDialog();
    expect(within(reopened).getByLabelText('API Key')).toHaveValue('');
    expect(within(reopened).getByLabelText('名称')).toHaveValue('');
  });

  it('提交失败时保留用户已填内容', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(EMPTY))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: 'CONFLICT',
              message: '已经有一个同名配置了，请换个名字。',
              suggestions: [],
              retryable: false,
            },
          },
          409,
        ),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const dialog = await openAddDialog();
    await userEvent.type(within(dialog).getByLabelText('名称'), '我的中转站');
    await userEvent.type(within(dialog).getByLabelText('服务地址'), 'https://api.example.com/v1');
    await userEvent.type(within(dialog).getByLabelText('API Key'), FULL_KEY);
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    expect(await screen.findByText('已经有一个同名配置了，请换个名字。')).toBeInTheDocument();
    // 失败不能清空刚填的内容 —— 用户不该重新输一遍密钥
    expect(within(dialog).getByLabelText('名称')).toHaveValue('我的中转站');
    expect(within(dialog).getByLabelText('服务地址')).toHaveValue('https://api.example.com/v1');
    expect(within(dialog).getByLabelText('API Key')).toHaveValue(FULL_KEY);
  });

  it('缺少必填项时不发请求，直接提示', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(EMPTY));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const dialog = await openAddDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: '添加' }));

    expect(await screen.findByText('名称与服务地址都不能为空')).toBeInTheDocument();
    // 只有初始列表那一次请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('degraded 不算测试通过 —— 只有 healthy 才报成功', async () => {
    /*
     * 边界用例。这里原本是一条「接口文档形态（`ok: false`）同样按失败提示」，
     * 依据是「服务端可能返回 `{ ok }`」这个猜测 —— 实际上服务端从来不返回
     * `ok`，该分支永远不成立，测的是一个不存在的形态。
     * 换成判定条件的真实边界：`health` 有 healthy / degraded / down / unknown
     * 四档，只有 healthy 才算连通成功。
     */
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pageOf([providerView({ health: 'unknown' })])))
      .mockResolvedValueOnce(
        json({
          providerId: 'pv1',
          providerName: '我的中转站',
          health: 'degraded',
          message: '最近几次调用有失败。',
          suggestions: ['稍后重试'],
          latencyMs: 240,
          modelCount: 0,
          usedTemporaryConfig: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await clickButton('测试连接');
    expect(await screen.findByText(/连接失败：最近几次调用有失败。/)).toBeInTheDocument();
  });
});

describe('模型服务入口', () => {
  it('全局导航提供指向 /settings/providers 的入口', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY)));
    renderApp('/projects');

    const link = await screen.findByRole('link', { name: '模型服务' });
    expect(link).toHaveAttribute('href', '/settings/providers');
  });

  it('路由 /settings/providers 渲染 ProviderSettingsPage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY)));
    renderApp('/settings/providers');

    expect(await screen.findByRole('heading', { name: '模型服务' })).toBeInTheDocument();
    expect(await screen.findByText('还没有配置模型服务')).toBeInTheDocument();
  });
});
