/**
 * 任务面板测试。
 *
 * 重点：任务完成后要能渲染出结果卡（数据来自 task.output.card，
 * 而不是 Agent 轮次返回的载荷）。
 */
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskPanel } from '../src/features/agent/TaskPanel.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 空的任务分页响应 */
function emptyPage(): Promise<Response> {
  return Promise.resolve(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false }));
}

/*
 * 这些用例要穿过「fetch → ReadableStream 解析 / 两步 REST 加载 → React 状态更新」
 * 好几段异步，默认 1 秒的等待上限在机器有负载时会随机不够 ——
 * 那是会伪装成功能缺陷的假红，因此统一放宽到 5 秒（真失败仍会被断言抓住）。
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
  // 轮询用例会换成假时钟；失败时也不能把假时钟留给下一个用例
  vi.useRealTimers();
});

describe('TaskPanel', () => {
  it('无任务时显示空状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false })));
    render(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} />);
    expect(await screen.findByText('还没有任务')).toBeInTheDocument();
  });

  it('展示任务技能名与进度', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          items: [
            {
              id: 't1',
              skillId: 'image.generate',
              status: 'running',
              progress: 40,
              progressMessage: '正在生成第 2 张',
              errorMessage: null,
              updatedAt: new Date().toISOString(),
              terminal: false,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
          hasMore: false,
        }),
      ),
    );

    render(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} />);
    expect(await screen.findByText('image.generate')).toBeInTheDocument();
    expect(screen.getByText('正在生成第 2 张')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  it('展示上下文说明（@引用命中、token 估算）', () => {
    render(
      <TaskPanel sessionId="s1" degraded={false} contextNotes={['已解析 @引用：苏晚']} />,
    );
    expect(screen.getByText('已解析 @引用：苏晚')).toBeInTheDocument();
  });

  it('降级时明确提示正在用轮询，而不是假装实时', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false })));
    render(<TaskPanel sessionId="s1" degraded contextNotes={[]} />);
    expect(await screen.findByText(/正在用轮询获取进度/)).toBeInTheDocument();
  });

  it('还没有会话时不请求任务接口，直接给空状态', async () => {
    const fetchMock = vi.fn().mockImplementation(emptyPage);
    vi.stubGlobal('fetch', fetchMock);

    render(<TaskPanel sessionId={null} degraded={false} contextNotes={[]} />);

    // `sessionId=` 空串会让后端把**全部**任务当成该会话的任务返回，必须完全不发请求
    expect(await screen.findByText('还没有任务')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('拉取失败时说明进度可能不是最新的，而不是静默保留旧快照', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            json({ error: { code: 'INTERNAL', message: '服务暂时不可用。' } }, 500),
          ),
        ),
    );

    render(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} />);

    expect(await screen.findByText(/任务列表暂时拉取失败/)).toBeInTheDocument();
  });

  it('外部刷新信号（SSE 的 task.* 事件）会重新拉取任务列表', async () => {
    const fetchMock = vi.fn().mockImplementation(emptyPage);
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <TaskPanel sessionId="s1" degraded={false} contextNotes={[]} refreshSignal={0} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tasks?sessionId=s1&pageSize=20');

    rerender(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} refreshSignal={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('降级时按固定间隔轮询，卸载后不再拉取', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(emptyPage);
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<TaskPanel sessionId="s1" degraded contextNotes={[]} />);

    // 首次拉取由 effect 同步发起，推进 0ms 只为把微任务跑完
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 间隔与实现里的 POLL_INTERVAL_MS 一致（3 秒）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // 卸载必须清掉定时器：否则组件没了还在打后端
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
