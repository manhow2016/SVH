/**
 * 工作台接线测试（Task 7）。
 *
 * 这里验证的不是「某个回调被调用」，而是**真实链路**：
 *
 * 1. 发送：输入 → `POST /api/agent/chat` → 回复与结构化载荷落进对话流，
 *    上下文说明进任务面板；失败时给出可见提示且**不清空输入**。
 * 2. 确认：点确认卡 → `POST /api/agent/sessions/:id/confirm` **带上精确 taskIds**
 *    （不传 taskIds 会放行该会话下全部等待任务）→ 提示 + 刷新任务面板。
 * 3. SSE 分派：消息事件追加、task.* 事件刷新面板、asset.changed 拉结果卡、
 *    结果卡按 taskId 去重、未知事件类型留下 console.warn。
 * 4. 中断：停止按钮真的 abort 掉在途请求，且不报「无法连接到服务」这种假故障。
 *
 * 因此用例尽量走真实组件树（Composer / MessageList / TaskPanel / SSE 传输层），
 * 只替换 `fetch` 这一层边界。
 */
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';

const SESSION_ID = 's1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyPage(): Response {
  return json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
}

/** `/api/assets?` 的响应体：`@资产` 索引（窗口固定为 200） */
function assetPage(items: unknown[]): Response {
  return json({ items, total: items.length, page: 1, pageSize: 200, hasMore: false });
}

/** 历史里的一条 Agent 文本消息（保证对话流非空，便于确认加载完成） */
const GREETING = {
  id: 'm1',
  role: 'agent',
  kind: 'text',
  content: '你好，想创作什么？',
  payload: null,
  createdAt: '2026-09-12T10:00:00.000Z',
};

/** 一张要求确认的卡片：planTaskIds 是这次确认覆盖的整组任务 */
const CONFIRMATION_MESSAGE = {
  id: 'm2',
  role: 'agent',
  kind: 'confirmation_request',
  content: '',
  payload: {
    type: 'confirmation_request',
    summary: '将消耗 2 次图片生成额度',
    impacts: [],
    planTaskIds: ['plan_1', 'plan_2'],
  },
  createdAt: '2026-09-12T10:01:00.000Z',
};

/** 一轮对话的响应：文本 + 计划载荷 + 工具轨迹 + 上下文说明 */
function chatResponse(overrides: { message?: string } = {}): unknown {
  return {
    sessionId: SESSION_ID,
    sessionCreated: false,
    message: overrides.message ?? '好的，我先规划一下。',
    payload: {
      type: 'plan',
      goal: '制作 30 秒护肤品广告',
      requiresApproval: true,
      tasks: [{ id: 'plan_1', title: '生成脚本', status: 'pending', dependsOn: [] }],
    },
    state: 'waiting_user',
    analysis: { intent: 'create', confidence: 0.9, targets: [], mentions: ['苏晚'] },
    toolCalls: [
      {
        name: 'asset.search',
        arguments: { keyword: '苏晚' },
        status: 'success',
        requiresConfirmation: false,
        durationMs: 12,
      },
    ],
    contextNotes: ['已装配项目记忆'],
    iterations: 1,
  };
}

/**
 * 可控的事件流端点。
 *
 * 传输层用 fetch + ReadableStream 自解析 SSE（不是原生 EventSource），
 * 因此这里返回一条永不结束的流，并允许用例随时把事件帧推进去。
 */
function createEvents() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let connected = false;
  let seq = 0;

  function frame(type: string, data: unknown): Uint8Array {
    seq += 1;
    const envelope = {
      seq,
      type,
      at: '2026-09-12T10:02:00.000Z',
      sessionId: SESSION_ID,
      data,
    };
    return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`);
  }

  return {
    start(): Promise<Response> {
      const body = new ReadableStream<Uint8Array>({
        start(created) {
          controller = created;
          connected = true;
          // 建连确认：传输层把「首个数据块到达」当作真正连上
          created.enqueue(frame('session.ready', {}));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    },

    /** 事件流是否已经建立（工作台要等会话就绪才会订阅） */
    isConnected(): boolean {
      return connected;
    },

    /**
     * 推一条事件，并等它穿过流解析与 React 状态更新。
     *
     * **必须先等连接建立**：工作台在会话就绪之后才订阅事件流，
     * 而读到这里时渲染的完成不等于副作用已经跑完（passive effect 是另一个任务）。
     * 早推的那一帧没有 controller 可写，会**静默消失** ——
     * 用例于是以「事件好像没生效」这种随机原因失败，而不是稳定地红。
     */
    async push(type: string, data: unknown): Promise<void> {
      await waitFor(
        () => {
          expect(connected, '事件流尚未建立，推事件会被丢掉').toBe(true);
          expect(controller).not.toBeNull();
        },
        { timeout: 3000 },
      );

      await act(async () => {
        controller?.enqueue(frame(type, data));
        // 让读取循环与随后的微任务跑完
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

interface HarnessOptions {
  /** 会话历史里的消息 */
  messages?: unknown[];
  /** 覆盖 `POST /api/agent/chat` 的响应 */
  chat?: (init?: RequestInit) => Promise<Response>;
  /** 覆盖 `GET /api/tasks/:id` 的响应体 */
  taskDetail?: (taskId: string) => unknown;
  /** 覆盖 `GET /api/tasks/:id` 的状态码（用来构造「结果卡拉取失败」） */
  taskDetailStatus?: number;
  /**
   * 覆盖 `GET /api/tasks?…` 的响应。
   *
   * 这个端点有**两个**消费方：任务面板的进度快照，以及工作台
   * 「加载会话后回捞结果卡」的任务清单。返回一个未决的 Promise 可以控制时序，
   * 用来构造「SSE 先到、回捞后到」这类竞态。
   */
  taskList?: () => Promise<Response>;
  /** 覆盖确认端点的响应 */
  confirm?: () => Promise<Response>;
  /** 首次加载会话详情时，光标之前是否还有更早的消息 */
  hasMore?: boolean;
  /** 覆盖「加载更早」那一次（带 `before=` 游标）的响应 */
  earlier?: (before: string) => unknown;
  /** `/api/assets?` 的响应（`@资产` 索引）。返回未决 Promise 可构造「重拉在途」 */
  assetList?: () => Promise<Response>;
  /** `/api/assets?` 的状态码（构造「索引拉不到」的降级路径） */
  assetListStatus?: number;
  /** `/api/assets/resolve-mentions` 的响应 */
  resolveMentions?: () => { mentions: string[]; matched: unknown[]; missing: string[] };
}

function setup(options: HarnessOptions = {}) {
  const events = createEvents();
  const messages = options.messages ?? [GREETING];

  function route(url: string, init?: RequestInit): Promise<Response> {
    // 会话列表：两步加载的第一步，按 projectId 取最新一条
    if (url === '/api/agent/sessions?projectId=p1&pageSize=1') {
      return Promise.resolve(
        json({
          items: [
            {
              id: SESSION_ID,
              projectId: 'p1',
              title: '护肤品广告',
              agentState: 'idle',
              status: 'active',
              messageCount: messages.length,
              createdAt: '2026-09-12T10:00:00.000Z',
              updatedAt: '2026-09-12T10:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 1,
          hasMore: false,
        }),
      );
    }
    // 会话详情：第二步。翻页（带 before= 游标）先分流，否则会被首次加载那条吃掉
    if (url.startsWith(`/api/agent/sessions/${SESSION_ID}?`)) {
      const before = /[?&]before=([^&]+)/.exec(url)?.[1];
      if (before !== undefined) {
        const decoded = decodeURIComponent(before);
        const body = options.earlier?.(decoded) ?? { messages: [], hasMore: false };
        return Promise.resolve(
          json({ id: SESSION_ID, projectId: 'p1', title: '护肤品广告', agentState: 'idle', ...body }),
        );
      }
      return Promise.resolve(
        json({
          id: SESSION_ID,
          projectId: 'p1',
          title: '护肤品广告',
          agentState: 'idle',
          messages,
          hasMore: options.hasMore ?? false,
        }),
      );
    }
    if (url === '/api/assets/resolve-mentions') {
      return Promise.resolve(
        json(options.resolveMentions?.() ?? { mentions: [], matched: [], missing: [] }),
      );
    }
    if (url.startsWith('/api/assets?')) {
      const empty = { items: [], total: 0, page: 1, pageSize: 200, hasMore: false };
      return (
        options.assetList?.() ?? Promise.resolve(json(empty, options.assetListStatus ?? 200))
      );
    }
    /*
     * 新建资产：`POST /api/assets`（不带查询串，上面的 `?` 分支吃不到它）。
     * 「现在新建」那条链路要一路走到 onCreated 才会重拉索引，这里必须给出成功响应，
     * 否则对话框只会显示创建失败，用例等的是一个永远不来的索引重拉。
     */
    if (url === '/api/assets') {
      return Promise.resolve(
        json(
          {
            id: 'a-new',
            projectId: 'p1',
            type: 'character',
            name: '苏晚（已改名）',
            slug: '苏晚',
            description: '',
            metadata: {},
            tags: [],
            coverUrl: null,
            status: 'active',
            files: [],
            updatedAt: '2026-09-13T10:00:00.000Z',
          },
          201,
        ),
      );
    }
    if (url.endsWith('/confirm')) {
      return (
        options.confirm?.() ??
        Promise.resolve(
          json({ resumed: ['plan_1', 'plan_2'], skipped: [], message: '已确认 2 个操作，正在继续执行。' }),
        )
      );
    }
    if (url === '/api/agent/chat') {
      return options.chat?.(init) ?? Promise.resolve(json(chatResponse()));
    }
    if (url.startsWith('/api/tasks?')) {
      return options.taskList?.() ?? Promise.resolve(emptyPage());
    }
    if (url.startsWith('/api/tasks/')) {
      const taskId = url.slice('/api/tasks/'.length);
      return Promise.resolve(
        json(options.taskDetail?.(taskId) ?? { id: taskId, output: null }, options.taskDetailStatus ?? 200),
      );
    }
    if (url.startsWith('/api/skills')) return Promise.resolve(json({ items: [], total: 0 }));
    if (url.startsWith('/api/projects/')) return Promise.resolve(emptyPage());

    // 没打桩的请求直接失败：避免用例在「请求根本没发出去」时仍然通过
    return Promise.resolve(
      json(
        {
          error: {
            code: 'NOT_FOUND',
            message: `用例未打桩的请求：${url}`,
            suggestions: [],
            retryable: false,
          },
        },
        404,
      ),
    );
  }

  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    url.includes('/events') ? events.start() : route(url, init),
  );
  vi.stubGlobal('fetch', fetchMock);

  return { fetchMock, events };
}

/** 取出发往某个端点的请求（按 URL 前缀匹配） */
function callsTo(
  fetchMock: ReturnType<typeof vi.fn>,
  prefix: string,
): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(
    (call): call is [string, RequestInit | undefined] =>
      typeof call[0] === 'string' && call[0].startsWith(prefix),
  );
}

/**
 * 发往**任务面板**的任务列表请求。
 *
 * 首帧有**两路** `/api/tasks?` 请求：面板的进度快照，以及工作台
 * 「加载会话后回捞结果卡」的任务清单（后者按裁定带 `status=success`）。
 * 下面「面板有没有被刷新」这类断言只关心前者，因此必须把回捞那一路排除掉 ——
 * 否则回捞的请求会被算成一次刷新，基线取早取晚都会随机变红。
 *
 * 回捞那一路的 URL 由结果卡那组用例整体断言，改坏了会在那里直接红。
 */
function panelTaskLoads(
  fetchMock: ReturnType<typeof vi.fn>,
): Array<[string, RequestInit | undefined]> {
  return callsTo(fetchMock, '/api/tasks?').filter((call) => !call[0].includes('status=success'));
}

/**
 * 等任务面板的**首帧**拉取发出去，并返回当前计数。
 *
 * 「没有刷新面板」这类断言必须先等首帧落地：任务面板的首次请求由 useEffect 发起，
 * 它是独立于「消息列表渲染完成」的另一个任务 —— 直接取基线会把首帧算成刷新，
 * 用例于是随机变红。
 */
async function taskPanelLoads(fetchMock: ReturnType<typeof vi.fn>): Promise<number> {
  await waitFor(
    () => {
      expect(panelTaskLoads(fetchMock).length).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
  return panelTaskLoads(fetchMock).length;
}

/**
 * 解析请求体。
 *
 * 不做 `String(body)`：body 的类型是 `BodyInit | null | undefined`，
 * 万一实现改传了 FormData，`String()` 会得到 `[object FormData]`，
 * 断言随后失败但原因难以定位。这里显式校验它确实是 JSON 字符串。
 */
function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error(`请求体不是 JSON 字符串：${typeof body}`);
  }
  return JSON.parse(body) as unknown;
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

/*
 * 这些用例要穿过「fetch → ReadableStream 解析 / 两步 REST 加载 → React 状态更新」
 * 好几段异步，默认 1 秒的等待上限在机器有负载时会随机不够 ——
 * 那是会伪装成功能缺陷的假红，因此统一放宽到 5 秒（真失败仍会被断言抓住）。
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentWorkspace 接线：发送', () => {
  it('回复、结构化载荷与工具轨迹落进对话流，上下文说明进任务面板', async () => {
    const { fetchMock } = setup();
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '做一个护肤品广告');
    await userEvent.keyboard('{Enter}');

    // 回复文本与计划卡（载荷）都在 —— POST 响应的 message + payload 合成一条消息
    expect(await screen.findByText('好的，我先规划一下。')).toBeInTheDocument();
    expect(screen.getByText('制作 30 秒护肤品广告')).toBeInTheDocument();

    // 工具轨迹（ToolTrace）确实接进了消息渲染
    expect(screen.getByText('Agent 执行了 1 步')).toBeInTheDocument();
    expect(screen.getByText('asset.search')).toBeInTheDocument();

    // 上下文说明：响应里的 contextNotes + analysis.mentions
    expect(screen.getByText('已装配项目记忆')).toBeInTheDocument();
    expect(screen.getByText('已解析 @引用：苏晚')).toBeInTheDocument();

    const chatCalls = callsTo(fetchMock, '/api/agent/chat');
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]?.[1]?.method).toBe('POST');
    expect(requestBody(chatCalls[0]?.[1])).toEqual({
      projectId: 'p1',
      message: '做一个护肤品广告',
      sessionId: SESSION_ID,
      referencedAssetIds: [],
    });

    // 成功之后输入框才清空
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('发送失败时给出可见错误提示，并保留输入内容', async () => {
    setup({
      chat: () =>
        Promise.resolve(
          json(
            {
              error: {
                code: 'MODEL_UNAVAILABLE',
                message: '模型服务暂时不可用。',
                suggestions: ['稍后重试'],
                retryable: true,
              },
            },
            503,
          ),
        ),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '一段很长的需求描述');
    await userEvent.keyboard('{Enter}');

    // 失败必须可见，不能静默
    expect(await screen.findByText('模型服务暂时不可用。')).toBeInTheDocument();
    // 且用户刚敲的字必须留着
    expect(screen.getByRole('textbox')).toHaveValue('一段很长的需求描述');
  });

  it('停止按钮中断在途请求：不产生假故障提示，输入保留', async () => {
    const signals: AbortSignal[] = [];
    setup({
      chat: (init) => {
        const signal = init?.signal;
        if (signal !== undefined && signal !== null) signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '一段需求');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(signals).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: '停止生成' }));

    // 请求被真正 abort，而不是只改了个界面状态
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
    expect(screen.getByRole('textbox')).toHaveValue('一段需求');
    // 用户主动中断不是故障：不能弹「无法连接到服务，请确认后端已启动」
    expect(screen.queryByText(/无法连接到服务/)).not.toBeInTheDocument();
  });

  it('卸载时中止在途的对话请求，不留悬挂连接', async () => {
    const signals: AbortSignal[] = [];
    setup({
      chat: (init) => {
        const signal = init?.signal;
        if (signal !== undefined && signal !== null) signals.push(signal);
        // 永不返回：模拟一轮还在跑的生成
        return new Promise<Response>(() => undefined);
      },
    });

    const { unmount } = renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '一段需求');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(signals).toHaveLength(1));

    unmount();

    // 组件没了、请求还挂着是不可接受的：连接与模型额度都会被白占
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('AgentWorkspace 接线：确认', () => {
  it('点确认卡带着精确 taskIds 请求确认，提示结果并刷新任务面板', async () => {
    const { fetchMock } = setup({ messages: [GREETING, CONFIRMATION_MESSAGE] });
    renderWorkspace();
    await screen.findByText('需要你确认');

    const panelCallsBefore = await taskPanelLoads(fetchMock);

    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));

    const confirmCalls = fetchMock.mock.calls.filter(
      (call): call is [string, RequestInit | undefined] =>
        typeof call[0] === 'string' && call[0].endsWith('/confirm'),
    );
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]?.[0]).toBe('/api/agent/sessions/s1/confirm');
    expect(confirmCalls[0]?.[1]?.method).toBe('POST');
    /*
     * 精确放行是本用例的全部意义：不传 taskIds 时后端会放行
     * 该会话下**全部** waiting_user 任务，而用户只确认了眼前这一组。
     */
    expect(requestBody(confirmCalls[0]?.[1])).toEqual({
      taskIds: ['plan_1', 'plan_2'],
    });

    expect(await screen.findByText(/已确认 2 个操作/)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(panelTaskLoads(fetchMock).length).toBeGreaterThan(panelCallsBefore);
      },
      { timeout: 3000 },
    );
  });

  it('确认失败时提示原因，而不是假装已放行', async () => {
    const { fetchMock } = setup({
      messages: [GREETING, CONFIRMATION_MESSAGE],
      confirm: () =>
        Promise.resolve(
          json(
            {
              error: {
                code: 'CONFLICT',
                message: '任务状态已变化，请刷新后重试。',
                suggestions: [],
                retryable: false,
              },
            },
            409,
          ),
        ),
    });
    renderWorkspace();
    await screen.findByText('需要你确认');

    const panelCallsBefore = await taskPanelLoads(fetchMock);
    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));

    expect(await screen.findByText('任务状态已变化，请刷新后重试。')).toBeInTheDocument();
    // 没有成功就不该去刷新面板，也不该说「已确认」
    expect(panelTaskLoads(fetchMock).length).toBe(panelCallsBefore);
    expect(screen.queryByText(/已确认/)).not.toBeInTheDocument();
  });
});

describe('AgentWorkspace 接线：SSE 分派', () => {
  it('agent.message 事件把新消息追加进对话流', async () => {
    const { events } = setup();
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await events.push('agent.message', { message: '我还在处理。', state: 'completed' });

    expect(await screen.findByText('我还在处理。')).toBeInTheDocument();
  });

  it('task.status 成功后拉任务详情，把 output.card 作为结果卡追加，且同一 taskId 只追加一次', async () => {
    const { fetchMock, events } = setup({
      taskDetail: (taskId) => ({
        id: taskId,
        skillId: 'image.generate',
        status: 'success',
        progress: 100,
        progressMessage: null,
        errorMessage: null,
        terminal: true,
        updatedAt: '2026-09-12T10:03:00.000Z',
        output: {
          card: { type: 'result_card', title: '画面已生成', media: [], actions: [] },
        },
      }),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    const panelCallsBefore = await taskPanelLoads(fetchMock);

    await events.push('task.status', { taskId: 't1', status: 'success' });
    expect(await screen.findByText('画面已生成')).toBeInTheDocument();
    // 任务状态事件同时刷新任务面板
    await waitFor(
      () => {
        expect(panelTaskLoads(fetchMock).length).toBeGreaterThan(panelCallsBefore);
      },
      { timeout: 3000 },
    );

    // 产出资产的事件会再次指向同一任务：不能变成第二张卡，也不该重复拉详情
    await events.push('asset.changed', { assetId: 'a1', taskId: 't1', change: 'created' });

    expect(screen.getAllByText('画面已生成')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(1);
  });

  it('任务详情里没有结果卡时不追加任何消息', async () => {
    const { fetchMock, events } = setup({
      taskDetail: (taskId) => ({ id: taskId, status: 'success', output: { summary: '完成' } }),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await events.push('task.status', { taskId: 't1', status: 'success' });

    await waitFor(() => expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(1));
    // 对话流没变：没有多出空消息
    expect(screen.getByText('你好，想创作什么？')).toBeInTheDocument();
  });

  it('结果卡拉取失败时留下 console.warn，既不弹提示也不留空消息', async () => {
    /*
     * 结果卡是「任务成功」与「对话流里看得见结果」之间唯一的桥。
     * 拉取失败刻意不弹提示（任务面板已经显示成功），但**不能连日志都没有** ——
     * 否则排查者只能看到「任务成功却没有卡」，与「本来就没有卡」无法区分。
     * 本文件对未知事件类型、缺少文本都留了 warn/error，这条路径口径应当一致。
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { events } = setup({ taskDetailStatus: 500 });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await events.push('task.status', { taskId: 't1', status: 'success' });

    await waitFor(() => {
      const warned = warn.mock.calls.map((call) => String(call[0]));
      expect(warned.some((text) => text.includes('结果卡拉取失败') && text.includes('t1'))).toBe(
        true,
      );
    });
    // 失败不该变成第二个可见提示，也不该往对话流里塞一条空消息
    expect(screen.queryByText('画面已生成')).not.toBeInTheDocument();
    expect(screen.getByText('你好，想创作什么？')).toBeInTheDocument();

    warn.mockRestore();
  });

  it('未知事件类型留下 console.warn 并继续处理后续事件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { events } = setup();
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await events.push('future.event', { hello: 'world' });

    // 不能静默吞掉：新增事件类型时开发期必须能发现
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((text) => text.includes('future.event'))).toBe(true);

    // 而且未知事件不能把这条流带崩
    await events.push('agent.message', { message: '事件流还活着。', state: 'completed' });
    expect(await screen.findByText('事件流还活着。')).toBeInTheDocument();

    warn.mockRestore();
  });

  it('自己那一轮的回显不会让回复出现两次（事件先于响应到达）', async () => {
    let resolveChat: ((response: Response) => void) | null = null;
    const { events } = setup({
      chat: () =>
        new Promise<Response>((resolve) => {
          resolveChat = resolve;
        }),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '第一轮');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(resolveChat).not.toBeNull());

    // 服务端在响应写出之前就把这一轮广播了出去：事件先到
    await events.push('agent.message', { message: '好的。', state: 'completed' });
    expect(screen.queryByText('好的。')).not.toBeInTheDocument();

    await act(async () => {
      resolveChat?.(json(chatResponse({ message: '好的。' })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByText('好的。')).toHaveLength(1);
  });

  it('自己那一轮的回显不会让回复出现两次（事件晚于响应到达）', async () => {
    const { events } = setup();
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await userEvent.type(screen.getByRole('textbox'), '第一轮');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getAllByText('好的，我先规划一下。')).toHaveLength(1));

    // 迟到的回显：同一个副本，不能变成第二条
    await events.push('agent.message', { message: '好的，我先规划一下。', state: 'completed' });
    expect(screen.getAllByText('好的，我先规划一下。')).toHaveLength(1);

    // 回显去重不能把后续真实消息一起吞掉
    await events.push('agent.message', { message: '另一条新消息。', state: 'completed' });
    expect(await screen.findByText('另一条新消息。')).toBeInTheDocument();
  });
});

/**
 * 加载会话后回捞结果卡。
 *
 * ── 这组用例守的是什么 ──
 * 结果卡现在由 Worker **落成会话消息**，所以正常路径下刷新后历史里本来就有卡。
 * 但两件事仍然需要守：
 *   ① 本次修复**之前**产生的会话确实没有落库的卡，回捞是它们唯一的来源；
 *   ② 回捞、SSE、历史消息是**三条会指向同一个 taskId 的路径**，
 *      去重必须全部成立 —— 否则刷新一次多一张，用户看到重复的结果卡。
 *
 * ② 里「历史已有卡」这一路正是本轮新增的：`load()` 会先把已落库的卡按
 * 消息行的 `taskId` 记进去重集合，再回捞。
 */
describe('AgentWorkspace 接线：加载会话后回捞结果卡', () => {
  /** 任务列表里的一条「终态且成功」的任务 */
  function successTask(id: string, updatedAt: string, status = 'success') {
    return {
      id,
      skillId: 'image.generate',
      status,
      progress: 100,
      progressMessage: null,
      errorMessage: null,
      terminal: true,
      updatedAt,
    };
  }

  /** 任务详情：`output.card` 里一张结果卡（Worker 成功产出的形状） */
  function cardDetail(taskId: string, title: string): unknown {
    return {
      ...successTask(taskId, '2026-09-12T10:03:00.000Z'),
      output: { card: { type: 'result_card', title, media: [], actions: [] } },
    };
  }

  function taskPage(items: unknown[]): Response {
    return json({ items, total: items.length, page: 1, pageSize: 50, hasMore: false });
  }

  it('刷新后把终态且成功的任务补成结果卡，顺序按产出时间稳定', async () => {
    const { fetchMock } = setup({
      // 列表按 createdAt 倒序返回：窗口里先给最新的一条
      taskList: () =>
        Promise.resolve(
          taskPage([
            successTask('t2', '2026-09-12T10:05:00.000Z'),
            successTask('t1', '2026-09-12T10:03:00.000Z'),
            // 失败的任务不该补卡 —— 它的 output 里可能也有半成品
            successTask('t3', '2026-09-12T10:04:00.000Z', 'failed'),
          ]),
        ),
      taskDetail: (taskId) =>
        cardDetail(taskId, taskId === 't1' ? '第一张卡' : taskId === 't2' ? '第二张卡' : '失败的卡'),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    // 历史消息里只有一条文本：卡片必须靠回捞补回来
    expect(await screen.findByText('第一张卡')).toBeInTheDocument();
    expect(await screen.findByText('第二张卡')).toBeInTheDocument();

    // 顺序稳定：按产出时间升序追加，而不是照抄后端倒序的返回顺序
    expect(screen.getAllByText(/第[一二]张卡/).map((node) => node.textContent)).toEqual([
      '第一张卡',
      '第二张卡',
    ]);

    // 回捞只认终态且成功的任务，且每条只拉一次详情
    expect(screen.queryByText('失败的卡')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t2')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t3')).toHaveLength(0);

    // 回捞自己带的参数：会话内、只要成功的、一次 50 条
    const backfillCall = callsTo(fetchMock, '/api/tasks?').find((call) =>
      call[0].includes('status=success'),
    );
    expect(backfillCall?.[0]).toBe('/api/tasks?sessionId=s1&status=success&pageSize=50');
  });

  it('历史里已经落了结果卡的任务，不再被回捞补第二张', async () => {
    /*
     * 这条正是本轮修复带来的新路径：Worker 会把卡片落成会话消息，
     * 于是刷新后「历史里没有卡」不再成立。若 `load()` 不先把已落库的卡
     * 记账，回捞就会给同一个任务再补一张 —— 刷新一次多一张。
     *
     * 判据是消息行自带的 `taskId`（不是 `payload.taskId`：技能自己构造的载荷
     * 往往不带它，`asset.create` 的卡就是）。
     */
    const { fetchMock } = setup({
      messages: [
        GREETING,
        {
          id: 'm-card',
          role: 'agent',
          kind: 'result_card',
          content: '画面已生成',
          payload: { type: 'result_card', title: '已落库的卡', media: [], actions: [] },
          // 消息行自带的任务引用 —— Worker 写卡片时一并落库
          taskId: 't1',
          createdAt: '2026-09-12T10:03:30.000Z',
        },
      ],
      taskList: () => Promise.resolve(taskPage([successTask('t1', '2026-09-12T10:03:00.000Z')])),
      taskDetail: (taskId) => cardDetail(taskId, '回捞补出来的卡'),
    });

    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    // 历史里那张卡在
    expect(await screen.findByText('已落库的卡')).toBeInTheDocument();

    // 给回捞留出时间（它会先拉列表）——然后断言：没有第二张，也没拉过这个任务的详情
    await waitFor(() => {
      expect(
        callsTo(fetchMock, '/api/tasks?').some((call) => call[0].includes('status=success')),
      ).toBe(true);
    });
    expect(screen.queryByText('回捞补出来的卡')).not.toBeInTheDocument();
    expect(screen.getAllByText(/卡$/)).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(0);
  });

  it('回捞先补卡、随后 SSE 再指向同一任务：只出现一张卡', async () => {
    const { fetchMock, events } = setup({
      taskList: () => Promise.resolve(taskPage([successTask('t1', '2026-09-12T10:03:00.000Z')])),
      taskDetail: (taskId) => cardDetail(taskId, '画面已生成'),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    // 回捞先把卡补进来
    expect(await screen.findByText('画面已生成')).toBeInTheDocument();

    // 随后 SSE 的 task.status 指向同一个任务：不能变成第二张，也不该重复拉详情
    await events.push('task.status', { taskId: 't1', status: 'success' });

    expect(screen.getAllByText('画面已生成')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(1);
  });

  it('SSE 先推卡、随后回捞再指向同一任务：只出现一张卡', async () => {
    /*
     * 回捞的清单故意压住不返回，让 SSE 那一份副本先到 ——
     * 两个方向都要挡，否则「谁先到」会决定用户看到一张还是两张卡。
     */
    const pendingLists: Array<(response: Response) => void> = [];
    const { fetchMock, events } = setup({
      taskList: () =>
        new Promise<Response>((resolve) => {
          pendingLists.push(resolve);
        }),
      taskDetail: (taskId) => cardDetail(taskId, taskId === 't1' ? '画面已生成' : '第二张卡'),
    });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    await events.push('task.status', { taskId: 't1', status: 'success' });
    expect(await screen.findByText('画面已生成')).toBeInTheDocument();

    // 迟到的清单现在才回来：既有已经补过的 t1，也有一条全新的 t2
    await waitFor(() => expect(pendingLists.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await act(async () => {
      for (const resolve of pendingLists) {
        resolve(
          taskPage([
            successTask('t1', '2026-09-12T10:03:00.000Z'),
            successTask('t2', '2026-09-12T10:05:00.000Z'),
          ]),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // t2 补出来了 → 回捞这一轮**真的跑完了**（不是「因为没跑才没重复」）
    expect(await screen.findByText('第二张卡')).toBeInTheDocument();
    // t1 仍然只有一张卡，详情也只拉过一次
    expect(screen.getAllByText('画面已生成')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/tasks/t1')).toHaveLength(1);
  });

  it('回捞清单拉取失败不打断会话加载，也不影响后续实时链路', async () => {
    const { events } = setup({
      taskList: () =>
        Promise.resolve(
          json({ error: { code: 'INTERNAL', message: '查询失败。', suggestions: [], retryable: true } }, 500),
        ),
    });
    renderWorkspace();

    // 历史照常渲染：补卡失败不该把整个工作台变成错误页
    expect(await screen.findByText('你好，想创作什么？')).toBeInTheDocument();
    expect(screen.queryByText('加载会话失败')).not.toBeInTheDocument();

    // 实时链路仍然可用
    await events.push('agent.message', { message: '我还在处理。', state: 'completed' });
    expect(await screen.findByText('我还在处理。')).toBeInTheDocument();
  });
});

/**
 * 会话历史分页。
 *
 * ── 为什么需要这组用例 ──
 * 会话详情端点一次最多返回 200 条消息，而工作台此前只发一次请求、拿完就算 ——
 * 超过 200 条的会话里，更早的内容**在界面上不存在**，用户也没有任何入口把它取回来。
 *
 * 现在服务端在详情里多带一个 `hasMore`（多取一条判定，不让前端猜「是不是正好满页」），
 * 界面据此显示「加载更早的消息」；点击后按**当前最早那条的 `createdAt`** 作游标
 * 往前取一页，**前插**到对话流顶部。
 *
 * 三条判据：入口该在时在、该消失时消失；前插不丢不重；游标用的是最早那条的时间。
 */
describe('AgentWorkspace 接线：会话历史分页', () => {
  it('没有更早的消息时不显示入口（负向断言）', async () => {
    setup({ hasMore: false });
    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    // 没有这条，下一条对「恒显入口」的实现同样会绿
    expect(screen.queryByRole('button', { name: '加载更早的消息' })).not.toBeInTheDocument();
  });

  it('还有更早的消息时给出入口，点开后前插到顶部且不重复', async () => {
    const 最早 = {
      id: 'm-old',
      role: 'agent',
      kind: 'text',
      content: '更早的一条',
      payload: null,
      createdAt: '2026-09-12T09:00:00.000Z',
    };
    const 历史 = {
      id: 'm-ancient',
      role: 'user',
      kind: 'text',
      content: '最早的问候',
      payload: null,
      createdAt: '2026-09-12T08:00:00.000Z',
    };

    const { fetchMock } = setup({
      messages: [最早, GREETING],
      hasMore: true,
      // 第二页里刻意混入一条已经在列表里的消息：模拟同毫秒边界不稳的情况
      earlier: () => ({ messages: [历史, 最早], hasMore: false }),
    });

    renderWorkspace();
    await screen.findByText('更早的一条');

    const 入口 = await screen.findByRole('button', { name: '加载更早的消息' });
    await userEvent.click(入口);

    // 取回来的历史出现在最前面
    expect(await screen.findByText('最早的问候')).toBeInTheDocument();

    // 顺序：新取到的在前，原有的一条不少
    const 全部 = screen.getAllByText(/问候|更早的一条/).map((node) => node.textContent);
    expect(全部).toEqual(['最早的问候', '更早的一条']);

    // 游标是**当前最早那条**的 createdAt，而不是第一条或最后一条
    const 翻页请求 = callsTo(fetchMock, '/api/agent/sessions/s1?').find((call) =>
      call[0].includes('before='),
    );
    expect(翻页请求?.[0]).toContain(`before=${encodeURIComponent('2026-09-12T09:00:00.000Z')}`);
    expect(翻页请求?.[0]).toContain('limit=200');

    // 已经到头：入口消失，避免用户反复点一个永远取不回东西的按钮
    expect(screen.queryByRole('button', { name: '加载更早的消息' })).not.toBeInTheDocument();
  });
});

/* ─────────────────────────── @资产 接线 ─────────────────────────── */

/** 一条正文里带引用的 Agent 消息 */
function textMessage(id: string, content: string) {
  return {
    id,
    role: 'agent',
    kind: 'text',
    content,
    payload: null,
    createdAt: '2026-09-12T10:05:00.000Z',
  };
}

/** 一张带 assetId 的结果卡 */
const ASSET_RESULT_CARD = {
  id: 'm-card',
  role: 'agent',
  kind: 'result_card',
  content: '',
  payload: {
    type: 'result_card',
    title: '角色已创建',
    category: 'character',
    media: [],
    assetId: 'a1',
    actions: [],
  },
  createdAt: '2026-09-12T10:06:00.000Z',
};

const SU_WAN_ASSET = {
  id: 'a1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  coverUrl: null,
};

describe('@资产 接线', () => {
  it('工作台加载时按项目拉一次资产索引（窗口 200）', async () => {
    const { fetchMock } = setup({
      assetList: () => Promise.resolve(assetPage([SU_WAN_ASSET])),
    });
    renderWorkspace();

    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/assets?').length).toBeGreaterThan(0);
    });
    // 恰好一次：`toBeGreaterThan(0)` 挡不住「每次渲染都重拉一遍」那类回归
    expect(callsTo(fetchMock, '/api/assets?')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/assets?')[0]?.[0]).toContain('projectId=p1');
    expect(callsTo(fetchMock, '/api/assets?')[0]?.[0]).toContain('pageSize=200');
  });

  it('消息里的 @名字 命中项目资产时链到资产详情', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      assetList: () => Promise.resolve(assetPage([SU_WAN_ASSET])),
    });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: '@苏晚' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('项目里没有那个引用 → 保持纯文本，不链错', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '参考 @张三 的风格')],
      assetList: () => Promise.resolve(assetPage([SU_WAN_ASSET])),
    });
    renderWorkspace();

    await screen.findByText(/参考 @张三 的风格/);
    expect(screen.queryByRole('link', { name: '@张三' })).not.toBeInTheDocument();
  });

  it('索引拉不到时正文照常显示为纯文本（降级，不打断阅读）', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      // 不给 assetList：默认桩返回空索引，正文因此无从链接化（降级路径）
    });
    renderWorkspace();

    await screen.findByText(/好的，先定 @苏晚 的外观/);
    expect(screen.queryByRole('link', { name: '@苏晚' })).not.toBeInTheDocument();
    // 「刻意不弹提示」是一条明确的设计决定，得有断言守着 —— 为一条链接能不能点
    // 而打断阅读，代价大于收益（Toast 的错误分支是 role="alert"）
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /*
   * 上一条走的是「索引为空」，这一条走的是「索引请求本身失败」——
   * 两条是不同的代码路径（后者要 `.catch` 真的兜住），而承诺是同一条：
   * 拉不到索引只是降级，正文照常可读。
   */
  it('索引请求失败时正文照常显示为纯文本，对话流不受影响', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      assetListStatus: 500,
    });
    renderWorkspace();

    await screen.findByText(/好的，先定 @苏晚 的外观/);
    expect(screen.queryByRole('link', { name: '@苏晚' })).not.toBeInTheDocument();
    // 对话流本身照常（历史消息都在）
    expect(screen.getByText('你好，想创作什么？')).toBeInTheDocument();
  });

  it('结果卡上的 assetId 深链到资产详情', async () => {
    setup({ messages: [GREETING, ASSET_RESULT_CARD] });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: '查看资产详情' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('引用了项目里没有的资产 → 输入区上方提示，并可不阻塞地发出去', async () => {
    const { fetchMock } = setup({
      resolveMentions: () => ({ mentions: ['苏晚'], matched: [], missing: ['苏晚'] }),
    });
    renderWorkspace();
    await screen.findByLabelText('需求输入');

    await userEvent.type(screen.getByLabelText('需求输入'), '让 @苏晚 穿红衣服');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText(/项目里还没有 @苏晚/)).toBeInTheDocument();
    // 不阻止发送：消息真的发出去了
    expect(callsTo(fetchMock, '/api/agent/chat')).toHaveLength(1);
  });

  it('「现在新建」打开创建对话框并预填名称', async () => {
    const { fetchMock } = setup({
      resolveMentions: () => ({ mentions: ['苏晚'], matched: [], missing: ['苏晚'] }),
    });
    renderWorkspace();
    await screen.findByLabelText('需求输入');

    await userEvent.type(screen.getByLabelText('需求输入'), '让 @苏晚 穿红衣服');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '现在新建' }));

    expect(screen.getByRole('dialog', { name: '新建资产 · 选择类型' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '角色' }));
    expect(screen.getByLabelText('名称')).toHaveValue('苏晚');

    // 建完之后索引要重拉：否则刚打的那个 @名字 仍然是纯文本，
    // 「现在新建」这条链路就只做了一半
    const before = callsTo(fetchMock, '/api/assets?').length;
    await userEvent.type(screen.getByLabelText('名称'), '（已改名）');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/assets?').length).toBeGreaterThan(before);
    });
  });

  /*
   * 索引清空只该随**项目切换**发生，不该随「新建资产后的重拉」发生。
   *
   * 反例（曾经就是这样）：把清空写进拉取 effect，而那个 effect 的依赖里有
   * `assetIndexToken` —— 每次新建都先丢掉**同项目仍然有效**的旧索引，
   * 正文里已经可点的 @链接 会退回纯文本一个往返；这次重拉若失败，
   * `.catch` 静默吞掉且没有回滚，链接就一直不可点。
   * 所以这里让**第二次**（重拉）响应挂着不回，专门盯住那个窗口。
   */
  it('新建后重拉索引在途时，已经可点的 @链接 不会退回纯文本', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      resolveMentions: () => ({ mentions: ['苏晚'], matched: [], missing: ['苏晚'] }),
      assetList: () => {
        calls += 1;
        // 首帧：索引立刻到位，@苏晚 已经可点
        if (calls === 1) return Promise.resolve(assetPage([SU_WAN_ASSET]));
        // 新建后的重拉：刻意挂着不回，这正是旧实现会吞掉链接的窗口
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(assetPage([SU_WAN_ASSET]));
          };
        });
      },
    });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: '@苏晚' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('需求输入'), '让 @苏晚 穿红衣服');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '现在新建' }));
    await userEvent.click(screen.getByRole('button', { name: '角色' }));
    await userEvent.type(screen.getByLabelText('名称'), '（已改名）');

    const before = screen.getAllByRole('link', { name: '@苏晚' }).length;
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    // 重拉确实在途（第二次请求已发出、尚未回来）
    await waitFor(() => {
      expect(calls).toBeGreaterThan(1);
    });
    // 同项目的旧索引仍然有效：链接一个都不该消失
    expect(screen.getAllByRole('link', { name: '@苏晚' })).toHaveLength(before);
    release?.();
  });
});
