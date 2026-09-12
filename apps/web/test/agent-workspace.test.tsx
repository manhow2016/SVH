/**
 * 工作台骨架测试。
 *
 * 重点验证四件规范要求的事：
 * 1. 刷新后历史消息能从 REST 恢复（两步加载：先取列表拿最新会话 id，再取详情）
 * 2. 没有会话 / 没有消息时显示空状态引导，而不是错误
 * 3. SSE 断线时**显示降级提示**（绝不静默），而链路健康时**不得**显示
 * 4. 三态齐备（骨架 / 空 / 错误），且卸载时事件流请求被真正中止
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

const SESSION = {
  id: 's1',
  projectId: 'p1',
  contentId: null,
  title: '护肤品广告',
  agentState: 'idle',
  status: 'active',
  contextSnapshot: {},
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  messages: [
    {
      id: 'm1',
      role: 'agent',
      kind: 'text',
      content: '你好，想创作什么？',
      payload: null,
      createdAt: '2026-09-12T10:00:00.000Z',
    },
  ],
};

/** REST 端点的假响应 */
type RestHandler = (url: string) => Promise<Response>;

/** 事件流端点的假响应 */
type EventsHandler = (init?: RequestInit) => Promise<Response>;

/**
 * 按 URL 分派假响应。
 *
 * 工作台是**两步加载**：先取会话列表（按 projectId 过滤，拿最新一条的 id），
 * 再取该会话详情。因此 mock 必须区分这两个 URL ——
 * 用「包含 /api/agent/sessions 就返回详情」的粗略匹配会让第一步拿到详情对象、
 * 解析出 undefined 的 items，页面永远停在空会话上。
 */
function stubRestFetch(options: { messages?: unknown[]; listEmpty?: boolean } = {}): RestHandler {
  const messages = options.messages ?? SESSION.messages;

  return (url: string) => {
    // 详情：/api/agent/sessions/<id>
    if (/\/api\/agent\/sessions\/[^?]+/.test(url)) {
      return Promise.resolve(json({ ...SESSION, messages }));
    }
    // 列表：/api/agent/sessions?projectId=...（该项目还没有会话时 items 为空数组）
    if (options.listEmpty === true) {
      return Promise.resolve(json({ items: [], total: 0, page: 1, pageSize: 1, hasMore: false }));
    }
    return Promise.resolve(
      json({
        items: [
          {
            id: SESSION.id,
            projectId: 'p1',
            title: SESSION.title,
            agentState: 'idle',
            status: 'active',
            messageCount: messages.length,
            createdAt: SESSION.createdAt,
            updatedAt: SESSION.updatedAt,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 1,
        hasMore: false,
      }),
    );
  };
}

/**
 * 让事件流挂在「已连上但暂无事件」的状态，避免干扰对 REST 的验证。
 *
 * ── 为什么不再 stub EventSource ──
 * Task 3 的传输层**不用原生 EventSource**（它发不出自定义请求头，新建实例也不继承游标，
 * 无法同时做到「自定义退避」与「带游标续传」），改成了 fetch + ReadableStream 自解析。
 * 因此 stub 全局 EventSource 是无效的 —— 事件端点会真发 fetch、被 REST stub 接住
 * 并返回 JSON，被判为「非事件流」，界面反而会挂上降级条与退避定时器，
 * 用例会以与预期无关的原因失败。
 *
 * 正确做法：让 `/events` 返回一个**永不结束的 `text/event-stream`** ——
 * 这既贴合真实传输层，也让连接稳定停在 open 状态。
 */
function perpetualEvents(onRequest?: (init?: RequestInit) => void): EventsHandler {
  return (init?: RequestInit) => {
    onRequest?.(init);

    // 一个永不结束的事件流：先发 session.ready，然后一直挂着
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: session.ready\ndata: {"seq":1,"type":"session.ready","at":"2026-09-12T10:00:00.000Z","sessionId":"s1","data":{}}\n\n',
          ),
        );
        // 刻意不 close：保持连接开着，直到用例结束
      },
    });

    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  };
}

/**
 * 让事件端点返回一个**正常建立后立刻结束**的流：
 * 传输层会把它当作断线并进入重连，界面据此显示降级条。
 */
function brokenEvents(): EventsHandler {
  return () =>
    Promise.resolve(
      new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
}

/**
 * 组装 fetch 桩：把 `/events` 之外的请求交给 REST 假端点。
 *
 * 两者必须由**同一个** `fetch` 桩分派 —— 简报原先的写法是先 stub 一个 404 的
 * REST 桩、再调 `stubEventStream()` 把 `fetch` 整个换掉，第二次 stub 会覆盖第一次，
 * 「加载失败」的用例因此拿到的是成功响应，断言必红。
 */
function stubFetch(rest: RestHandler, events: EventsHandler) {
  const mock = vi.fn((url: string, init?: RequestInit) =>
    url.includes('/events') ? events(init) : rest(url),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentWorkspace', () => {
  it('刷新时从 REST 恢复历史消息', async () => {
    const fetchMock = stubFetch(stubRestFetch(), perpetualEvents());

    renderWorkspace();

    expect(await screen.findByText('你好，想创作什么？')).toBeInTheDocument();

    // 两步加载的契约：第一步按 projectId 取列表，第二步取该会话详情
    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls[0]).toBe('/api/agent/sessions?projectId=p1&pageSize=1');
    expect(urls[1]).toBe('/api/agent/sessions/s1');

    // 链路健康时不得出现降级提示 —— 否则「断线显示降级」的用例是恒真的
    expect(screen.queryByText(/实时连接已中断/)).not.toBeInTheDocument();
  });

  it('无消息时显示空状态并引导用户表达需求', async () => {
    stubFetch(stubRestFetch({ messages: [] }), perpetualEvents());

    renderWorkspace();

    expect(await screen.findByText('开始你的第一个创作')).toBeInTheDocument();
    // 说明里必须给一个具体例子，而不是泛泛的「请输入需求」
    expect(screen.getByText(/帮我做一个 30 秒的护肤品广告/)).toBeInTheDocument();
  });

  it('项目还没有会话时显示空对话流而不是错误', async () => {
    stubFetch(stubRestFetch({ listEmpty: true }), perpetualEvents());

    renderWorkspace();

    expect(await screen.findByText('开始你的第一个创作')).toBeInTheDocument();
    expect(screen.queryByText('加载会话失败')).not.toBeInTheDocument();
  });

  it('会话加载中显示骨架而不是裸加载文案', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const { container } = renderWorkspace();

    expect(container.querySelectorAll('[data-skeleton-line]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Loading/i)).not.toBeInTheDocument();
  });

  it('会话加载失败时显示错误状态与后端建议', async () => {
    const notFound: RestHandler = () =>
      Promise.resolve(
        json(
          {
            error: {
              code: 'NOT_FOUND',
              message: '会话不存在，可能已被删除。',
              suggestions: ['返回项目列表重新进入'],
              retryable: false,
            },
          },
          404,
        ),
      );
    stubFetch(notFound, perpetualEvents());

    renderWorkspace();

    expect(await screen.findByText('会话不存在，可能已被删除。')).toBeInTheDocument();
    expect(screen.getByText('返回项目列表重新进入')).toBeInTheDocument();
    // 没有会话就没有可订阅的连接，此时不该挂降级条
    expect(screen.queryByText(/实时连接已中断/)).not.toBeInTheDocument();
  });

  it('事件流断开时显示降级提示，绝不静默', async () => {
    stubFetch(stubRestFetch(), brokenEvents());

    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    expect(await screen.findByText(/实时连接已中断/)).toBeInTheDocument();
  });

  it('卸载时中止事件流请求，不留悬挂的连接', async () => {
    const signals: AbortSignal[] = [];
    stubFetch(
      stubRestFetch(),
      perpetualEvents((init) => {
        const signal = init?.signal;
        if (signal !== undefined && signal !== null) signals.push(signal);
      }),
    );

    const { unmount } = renderWorkspace();
    await screen.findByText('你好，想创作什么？');
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    unmount();

    // close() 必须 abort 掉在途的事件流请求，否则组件没了、流还挂着
    expect(signals[0]?.aborted).toBe(true);
  });
});
