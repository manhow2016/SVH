/**
 * 资产库页面测试。
 *
 * 守四件事：
 *   1. 三态齐全（加载 / 空 / 错误）—— 规范禁止空白页面，也禁止只写「出错了」；
 *   2. **两种空态不混用**：项目里没有资产 ≠ 筛选后没有结果；
 *   3. 搜索是 debounce 的、筛选是即时的、翻页靠「加载更多」追加；
 *   4. 深链 `?asset=` 能直接打开抽屉，失效时提示一次并把参数清掉。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AssetLibraryPage } from '../src/features/assets/AssetLibraryPage.js';
import type { AssetDetail, AssetSummary } from '../src/lib/api-types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pageOf(items: AssetSummary[], hasMore = false, total = items.length): unknown {
  return { items, total, page: 1, pageSize: 50, hasMore };
}

const SU_WAN: AssetSummary = {
  id: 'a1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  coverUrl: null,
};

const CHANG_AN: AssetSummary = {
  id: 'a2',
  type: 'scene',
  name: '长安城朱雀大街',
  slug: '长安城朱雀大街',
  coverUrl: 'https://example.com/changan.jpg',
};

const SU_WAN_DETAIL: AssetDetail = {
  ...SU_WAN,
  projectId: 'p1',
  description: '女主',
  metadata: { appearance: { hair: '黑色长直发' } },
  tags: [],
  status: 'active',
  files: [],
  updatedAt: '2026-09-13T10:00:00.000Z',
};

interface RecordedRequest {
  url: string;
  method: string;
}

/**
 * 装一个按 URL 分派的假后端（本文件专用，与工作台接线测试里的同名函数互不相干）。
 *
 * `assets` 是 `/api/assets` 的响应构造器，由各用例决定返回什么；
 * 单个资产的详情固定返回 `SU_WAN_DETAIL`。
 */
function setup(assets: (url: string) => Response) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, method: init?.method ?? 'GET' });

      if (url.includes('/api/assets?')) return Promise.resolve(assets(url));
      if (url.startsWith('/api/projects/')) {
        return Promise.resolve(json({ id: 'p1', name: '短剧项目', description: '' }));
      }
      if (url.match(/^\/api\/assets\/[^/?]+$/)) return Promise.resolve(json(SU_WAN_DETAIL));
      return Promise.resolve(json({}, 404));
    }),
  );
  return { requests };
}

/**
 * 把当前查询串渲染出来。
 *
 * `MemoryRouter` 不动 `window.location`，所以「参数有没有被清掉」这件事
 * 只能从路由状态里读。放在测试里而不是页面里 —— 页面不需要这个探针。
 */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

function renderPage(initialEntries: string[] = ['/projects/p1/assets']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <LocationProbe />
        <Routes>
          <Route path="/projects/:projectId/assets" element={<AssetLibraryPage />} />
          <Route path="/projects/:projectId" element={<p>工作台</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('AssetLibraryPage 的三态', () => {
  it('加载中显示骨架，加载完显示列表项（名称 + 类型 + @引用名）', async () => {
    setup(() => json(pageOf([SU_WAN, CHANG_AN])));
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    const item = await screen.findByRole('button', { name: /苏晚/ });
    // 类型标签是权威指示；左边 48×48 的方块只是首字占位，不重复整词
    expect(within(item).getByText('角色')).toBeInTheDocument();
    expect(within(item).getByText('角')).toBeInTheDocument();
    expect(within(item).getByText('@苏晚')).toBeInTheDocument();
    // 项目名进副标题，用户得知道自己在哪个项目里
    expect(await screen.findByText(/短剧项目/)).toBeInTheDocument();
  });

  it('项目里没有资产 → 主操作是「新建资产」', async () => {
    setup(() => json(pageOf([])));
    renderPage();

    expect(await screen.findByText('这个项目还没有资产')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建资产' })).toBeInTheDocument();
  });

  it('筛选后没有结果 → 是另一套空态，带「清除筛选」', async () => {
    setup((url) => (url.includes('type=') ? json(pageOf([])) : json(pageOf([SU_WAN]))));
    renderPage();

    await screen.findByRole('button', { name: /苏晚/ });
    await userEvent.click(screen.getByRole('button', { name: '图片' }));

    expect(await screen.findByText('没有匹配的资产')).toBeInTheDocument();
    // 关键：不能说成「这个项目还没有资产」——那会让人以为数据没了
    expect(screen.queryByText('这个项目还没有资产')).not.toBeInTheDocument();
    expect(screen.getByText(/类型：图片/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });

  it('加载失败 → 显示发生了什么 / 原因 / 下一步，并能重试', async () => {
    let attempt = 0;
    setup(() => {
      attempt += 1;
      if (attempt === 1) {
        return json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: '数据库连接失败。',
              suggestions: ['稍后重试'],
              retryable: true,
            },
          },
          500,
        );
      }
      return json(pageOf([SU_WAN]));
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库连接失败。');
    expect(screen.getByText('稍后重试')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});

describe('AssetLibraryPage 的工具栏', () => {
  it('搜索是 debounce 的：连续输入只发最后那一次', async () => {
    const { requests } = setup(() => json(pageOf([SU_WAN])));
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    /*
     * `delay: null` 是必需的，不是风格问题：这条用例断言「两次按键之间没有
     * 跨过 300ms 的防抖窗口」，而 userEvent 默认每次按键之间 await 一个
     * `setTimeout(0)`。机器有负载时那一下可能被拖长，用例就会变成偶发变红 ——
     * 而它一旦偶发变红，就再也证明不了「逐字打请求」这件事。
     */
    const typing = userEvent.setup({ delay: null });
    await typing.type(screen.getByLabelText('搜索资产'), '苏晚');
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes('q=%E8%8B%8F%E6%99%9A'))).toBe(true);
    });
    // 逐字触发的话这里会有两条（q=苏、q=苏晚）
    expect(requests.filter((request) => request.url.includes('q='))).toHaveLength(1);
  });

  it('类型筛选是即时的（不等 debounce）', async () => {
    const { requests } = setup(() => json(pageOf([SU_WAN])));
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    await userEvent.click(screen.getByRole('button', { name: '角色' }));
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes('type=character'))).toBe(true);
    });
  });

  it('「加载更多」把下一页追加到列表后面，而不是替换', async () => {
    setup((url) =>
      url.includes('page=2') ? json(pageOf([CHANG_AN], false, 3)) : json(pageOf([SU_WAN], true, 3)),
    );
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('button', { name: /长安城朱雀大街/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});

describe('AssetLibraryPage 的深链', () => {
  it('直接带 ?asset= 进来就打开详情抽屉', async () => {
    setup(() => json(pageOf([SU_WAN])));
    renderPage(['/projects/p1/assets?asset=a1']);

    expect(await screen.findByRole('dialog', { name: '苏晚' })).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?asset=a1');
  });

  it('点列表项打开抽屉（push，后退键可关），关闭后查询参数被清掉（replace，后退键不会又弹开）', async () => {
    setup(() => json(pageOf([SU_WAN])));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /苏晚/ }));
    expect(await screen.findByRole('dialog', { name: '苏晚' })).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?asset=a1');

    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '苏晚' })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('search')).not.toHaveTextContent('asset=');
  });

  it('深链指向不存在的资产 → 提示一次、清掉参数、退回列表，不静默无视', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/assets?')) return Promise.resolve(json(pageOf([SU_WAN])));
        if (url.startsWith('/api/projects/')) {
          return Promise.resolve(json({ id: 'p1', name: '短剧项目', description: '' }));
        }
        return Promise.resolve(
          json(
            {
              error: {
                code: 'ASSET_NOT_FOUND',
                message: '资产 nope 不存在',
                suggestions: [],
                retryable: false,
              },
            },
            404,
          ),
        );
      }),
    );
    renderPage(['/projects/p1/assets?asset=nope']);

    expect(await screen.findByText(/不存在，或者不属于当前项目/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('search')).not.toHaveTextContent('asset=');
    // 列表照常可用
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});
