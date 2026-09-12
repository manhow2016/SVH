/**
 * 窄屏（≤1024px）行为测试。
 *
 * ── 这里能验证什么、不能验证什么 ──
 * jsdom 没有真实布局：它不会计算媒体查询、不会折叠 flex、也不会告诉你
 * 「遮罩压住了面板」。因此本文件只验证**行为**：
 * 窄屏时侧区不再常驻、顶部出现入口、抽屉能开能关、切回宽屏时抽屉收起。
 * 真实的三档视觉检查（无横向滚动 / 按钮不溢出 / 层叠正确）由 Task 9 的
 * headless Chromium 探针覆盖 —— 本阶段已经证明 jsdom 对层叠与布局类缺陷完全失明。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SESSION_DETAIL = {
  id: 's1',
  projectId: 'p1',
  title: '护肤品广告',
  agentState: 'idle',
  messages: [],
};

const SESSION_SUMMARY = {
  id: 's1',
  projectId: 'p1',
  title: '护肤品广告',
  agentState: 'idle',
  status: 'active',
  messageCount: 0,
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
};

/** REST 假响应：区分会话详情 / 会话列表 / 任务列表三个端点 */
function restFetch(url: string): Promise<Response> {
  // 详情：/api/agent/sessions/<id>?limit=...
  if (/\/api\/agent\/sessions\/[^?]+/.test(url)) {
    return Promise.resolve(json(SESSION_DETAIL));
  }
  // 任务面板：/api/tasks?sessionId=...
  if (url.includes('/api/tasks')) {
    return Promise.resolve(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false }));
  }
  // 列表：/api/agent/sessions?projectId=...
  return Promise.resolve(
    json({ items: [SESSION_SUMMARY], total: 1, page: 1, pageSize: 1, hasMore: false }),
  );
}

/**
 * 事件端点必须返回真正的 `text/event-stream`，不能靠 stub 全局 EventSource ——
 * Task 3 的传输层是 fetch + ReadableStream 自解析，stub EventSource 对它无效，
 * 事件请求会落到 REST 分支、被当成「非事件流」从而挂上降级条，
 * 用例会以与预期无关的原因失败。
 */
function stubFetch(onRest?: (url: string) => void): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (!url.includes('/events')) {
        onRest?.(url);
        return restFetch(url);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: session.ready\ndata: {"seq":1,"type":"session.ready","at":"2026-09-12T10:00:00.000Z","sessionId":"s1","data":{}}\n\n',
            ),
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }),
  );
}

/**
 * 可控的 `matchMedia` 桩。
 *
 * 返回一个 `setMatches`，用来模拟「用户拖动窗口 / 旋转屏幕」——
 * 仅把 `matches` 写成常量的话，`change` 监听这条路径完全测不到，
 * 而它正是本任务要求用 matchMedia（而不是读一次 innerWidth）的全部理由。
 */
function stubMatchMedia(initial: boolean): (next: boolean) => void {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: vi.fn(),
    })),
  );

  return (next: boolean) => {
    matches = next;
    for (const listener of [...listeners]) {
      listener({ matches: next } as MediaQueryListEvent);
    }
  };
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <ToastProvider>
        <Routes>
          <Route path="/projects/:projectId" element={<AgentWorkspace />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** 任务面板空态文案：每个 TaskPanel 实例恰好出现一次，用来数「面板有几份」 */
const PANEL_MARK = '还没有任务';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('窄屏布局', () => {
  it('窄屏时提供打开任务抽屉的入口', async () => {
    stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    const trigger = await screen.findByRole('button', { name: '任务' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: '任务' })).toBeInTheDocument();
  });

  it('窄屏时侧区不常驻，任务面板只在抽屉里出现一份', async () => {
    stubMatchMedia(true);
    stubFetch();

    const { container } = renderWorkspace();

    // 入口就位，但抽屉还没开：此时文档里不应该有任何任务面板（侧区没被渲染）
    await screen.findByRole('button', { name: '任务' });
    expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByText(PANEL_MARK)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '任务' }));

    // 抽屉打开后恰好一份 —— 两份意味着侧区与抽屉同时渲染，任务列表会被拉两次
    await screen.findByRole('dialog', { name: '任务' });
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
    expect(container.querySelectorAll('aside')).toHaveLength(1);
  });

  it('抽屉可以从内部关闭，关闭后任务面板不再留在文档里', async () => {
    stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: '任务' }));
    await screen.findByRole('dialog', { name: '任务' });

    await userEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(PANEL_MARK)).not.toBeInTheDocument();
  });

  it('宽屏时没有抽屉入口，任务面板常驻侧区', async () => {
    stubMatchMedia(false);
    stubFetch();

    const { container } = renderWorkspace();

    // 等会话加载完成（标题出现即表示 loadState 进入 ready）
    await screen.findByRole('heading', { name: '护肤品广告' });

    expect(screen.queryByRole('button', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 侧区是一等公民（普通 aside），不是抽屉里的对话框
    expect(container.querySelector('aside')).not.toHaveAttribute('role', 'dialog');
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
  });

  it('拖宽窗口（窄 → 宽）时自动收起抽屉，避免侧区与抽屉双份面板', async () => {
    const setMatches = stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: '任务' }));
    await screen.findByRole('dialog', { name: '任务' });

    // 用户把窗口拉宽：change 事件到达，布局切回宽屏
    setMatches(false);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    });
    // 侧区接管，面板仍然恰好一份 —— 没有出现「侧区 + 抽屉」同时挂载
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
  });
});
