/**
 * 工作台层「降级提示条」的护栏测试。
 *
 * ── 这条用例补的是什么缺口 ──
 * 「降级」有两个独立来源：
 *   ① 连接明确断了（`state === 'reconnecting'`）—— 工作台层已有用例覆盖；
 *   ② 连接**看起来健康**、但业务事件早已陈旧（`isEventStale()`）—— 半开链路的形态。
 * ② 的判据在 hook 里被测过（use-session-stream.test.tsx），但它在**真正的落点**
 * ——工作台是否把 `degraded` 渲染成提示条——上没有护栏：把 `useSessionStream` 的
 * `degraded` 改回只看 `state === 'reconnecting'`、或把工作台的渲染条件改成同一个，
 * 原有全部用例依旧全绿。而这恰恰是控制方裁定要求防住的那种回归 ——
 * 「降级判据必须覆盖半开链路」在它真正生效的那一层反而没人守。
 *
 * ── 为什么替换的是建流入口而不是 hook ──
 * 用例要覆盖的是「陈旧 → degraded → 提示条」这一整条链路，因此**用真实 hook**，
 * 只把 `createSessionStream` 换成一条可控的假流（与 use-session-stream.test.tsx
 * 同一手法）。若直接 mock 掉 `useSessionStream` 的返回值，工作台与 hook 之间那段
 * 接线就没人测了 —— 而缺口正在那段接线上。
 *
 * 替换按模块整体进行，因此必须与走真实传输层的 agent-workspace.test.tsx
 * 分开成两个文件：`vi.mock` 是文件级的，放一起会让那份文件的 7 条用例
 * 全部失去真实传输层覆盖。
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';
import { createSessionStream, type SessionStream } from '../src/lib/sse.js';

// 只替换建流入口：hook 与工作台的逻辑全部走真实实现
vi.mock('../src/lib/sse.js', () => ({ createSessionStream: vi.fn() }));

const createStreamMock = vi.mocked(createSessionStream);

/** 会话详情假响应（字段与 REST 端点返回一致） */
const SESSION = {
  id: 's1',
  projectId: 'p1',
  title: '护肤品广告',
  agentState: 'idle',
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 假流的陈旧判定开关：用例直接拨动它，模拟「半开链路」 */
let stale = false;

beforeEach(() => {
  stale = false;

  /*
   * 假流刻意**停在 open**：连接看起来完全健康，唯一异常是业务事件陈旧。
   * 界面若只看 `state === 'reconnecting'`，下面的断言必红。
   */
  createStreamMock.mockImplementation(
    () =>
      ({
        get state() {
          return 'open' as const;
        },
        isEventStale: () => stale,
        lastEventAt: () => null,
        close: () => undefined,
      }) satisfies SessionStream,
  );

  // REST 桩：先给列表（拿最新会话 id），再给详情；事件流已被替换，不会真的发请求
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (/\/api\/agent\/sessions\/[^?]+/.test(url)) return Promise.resolve(json(SESSION));
      return Promise.resolve(
        json({
          items: [
            {
              id: SESSION.id,
              projectId: 'p1',
              title: SESSION.title,
              agentState: 'idle',
              status: 'active',
              messageCount: SESSION.messages.length,
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
    }),
  );
});

afterEach(() => {
  createStreamMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

describe('AgentWorkspace 降级提示条', () => {
  it('连接停在 open、业务事件陈旧时显示降级提示，绝不静默', async () => {
    vi.useFakeTimers();

    renderWorkspace();

    // 等 REST 两步加载完成的两轮微任务：列表 → 详情 → setState
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('你好，想创作什么？')).toBeInTheDocument();

    // 建连瞬间、还没有业务事件：不得因为「还没收到事件」就闪降级条
    expect(screen.queryByText(/实时连接已中断/)).not.toBeInTheDocument();

    // 链路进入半开：ping 照收、业务事件停止。它不会主动回调，
    // 只能靠 hook 的定期检查（5s）把 `isEventStale()` 捞出来。
    stale = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText(/实时连接已中断/)).toBeInTheDocument();
  });

  it('事件不陈旧、连接也正常时不显示降级提示', async () => {
    vi.useFakeTimers();

    renderWorkspace();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('你好，想创作什么？')).toBeInTheDocument();

    // 推进两个检查周期：既不陈旧、也没断线，提示条就不该出现
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // 没有这条负向断言，上一条用例对「恒显降级条」的实现同样会绿
    expect(screen.queryByText(/实时连接已中断/)).not.toBeInTheDocument();
  });
});
