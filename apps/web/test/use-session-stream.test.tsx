/**
 * 事件流接入 hook 的降级判据测试。
 *
 * ── 为什么这个文件要替掉传输层 ──
 * 「降级」的两个信号来源不同：
 *   ① `state === 'reconnecting'`（连接明确断了）—— 传输层通过 `onStateChange`
 *      **主动推送**，工作台的整体用例（agent-workspace.test.tsx，走真实传输层）
 *      已经覆盖；
 *   ② `isEventStale()`（连接看起来健康、但业务事件早已陈旧）—— **拉取式**判据，
 *      半开链路会照常每 15 秒收到一次 ping，因此**没有任何回调**会来通知我们它陈旧了。
 * ② 正是最容易写漏的那半条，而它在真实传输层下要推进 45 秒假时钟才能复现。
 * 所以这里注入一条完全可控的假流，把「定期检查」与「卸载清理」钉成确定性断言。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionStream,
  type SessionStream,
  type StreamState,
} from '../src/lib/sse.js';
import { useSessionStream } from '../src/features/agent/useSessionStream.js';

// 只替换建流入口：hook 的职责是「订阅 + 定期判陈旧 + 清理」，不是 SSE 解析
vi.mock('../src/lib/sse.js', () => ({ createSessionStream: vi.fn() }));

const createStreamMock = vi.mocked(createSessionStream);

/** 假事件流：状态、陈旧度、关闭全部由用例驱动 */
interface FakeStream {
  /** 交给 hook 的流对象 */
  readonly value: SessionStream;
  /** 陈旧度检查的调用记录 */
  readonly isEventStale: ReturnType<typeof vi.fn>;
  /** close 的调用记录 */
  readonly close: ReturnType<typeof vi.fn>;
  /** 切换「业务事件已陈旧」的判定结果 */
  setStale(stale: boolean): void;
  /** 模拟传输层推送的连接状态变化 */
  emitState(state: StreamState): void;
  /** 模拟业务事件到达 */
  emitEvent(at: number): void;
}

/** 让建流入口按调用顺序返回记录在案的假流 */
function installFakeStreams(): FakeStream[] {
  const streams: FakeStream[] = [];

  createStreamMock.mockImplementation((options) => {
    let state: StreamState = 'connecting';
    let stale = false;
    let lastEventAt: number | null = null;

    const isEventStale = vi.fn(() => stale);
    const close = vi.fn();

    const value: SessionStream = {
      get state() {
        return state;
      },
      isEventStale,
      lastEventAt: () => lastEventAt,
      close,
    };

    streams.push({
      value,
      isEventStale,
      close,
      setStale(next) {
        stale = next;
      },
      emitState(next) {
        state = next;
        options.onStateChange?.(next);
      },
      emitEvent(at) {
        lastEventAt = at;
        options.onEvent({
          seq: 1,
          type: 'task.progress',
          at: '2026-09-12T10:00:00.000Z',
          sessionId: 's1',
          data: {},
        });
      },
    });

    return value;
  });

  return streams;
}

/** 取出第 n 条假流；尚未建立就直接抛错，避免测试里出现非空断言 */
function streamAt(streams: FakeStream[], index: number): FakeStream {
  const stream = streams[index];
  if (stream === undefined) throw new Error(`第 ${index} 条假流尚未建立`);
  return stream;
}

/** 只渲染 hook 返回的状态，便于直接断言 */
function Harness({ sessionId }: { sessionId: string | null }) {
  const status = useSessionStream({ sessionId, onEvent: () => undefined });

  return (
    <div>
      <span data-testid="state">{status.state}</span>
      <span data-testid="degraded">{String(status.degraded)}</span>
      <span data-testid="stale">{String(status.isEventStale)}</span>
      <span data-testid="last-event-at">{String(status.lastEventAt)}</span>
    </div>
  );
}

beforeEach(() => {
  createStreamMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSessionStream', () => {
  it('没有会话时不建连，也不显示降级', () => {
    render(<Harness sessionId={null} />);

    expect(createStreamMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
    expect(screen.getByTestId('degraded')).toHaveTextContent('false');
  });

  it('连接进入 reconnecting 时 degraded 为真', () => {
    const streams = installFakeStreams();
    render(<Harness sessionId="s1" />);

    expect(screen.getByTestId('degraded')).toHaveTextContent('false');

    act(() => {
      streamAt(streams, 0).emitState('reconnecting');
    });

    expect(screen.getByTestId('state')).toHaveTextContent('reconnecting');
    expect(screen.getByTestId('degraded')).toHaveTextContent('true');
  });

  it('业务事件到达后 lastEventAt 更新为连接给出的时间戳', () => {
    const streams = installFakeStreams();
    render(<Harness sessionId="s1" />);

    expect(screen.getByTestId('last-event-at')).toHaveTextContent('null');

    act(() => {
      streamAt(streams, 0).emitEvent(1_757_692_800_000);
    });

    expect(screen.getByTestId('last-event-at')).toHaveTextContent('1757692800000');
  });

  it('事件陈旧时 degraded 为真，且陈旧度是按固定间隔主动检查的', () => {
    vi.useFakeTimers();
    const streams = installFakeStreams();
    render(<Harness sessionId="s1" />);

    act(() => {
      streamAt(streams, 0).emitState('open');
    });

    // 刚建连、还没有业务事件 → 不算陈旧（否则降级条会常驻）
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
    expect(screen.getByTestId('degraded')).toHaveTextContent('false');

    // 链路进入半开：ping 照收，业务事件停止 → 判据变真。
    // 它不会主动回调，只能靠定时器定期捞出来。
    streamAt(streams, 0).setStale(true);
    expect(screen.getByTestId('degraded')).toHaveTextContent('false');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(streamAt(streams, 0).isEventStale).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('stale')).toHaveTextContent('true');
    expect(screen.getByTestId('degraded')).toHaveTextContent('true');

    // 再走一个间隔仍要继续检查（不是只检查一次）
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(streamAt(streams, 0).isEventStale).toHaveBeenCalledTimes(2);
  });

  it('卸载时关闭连接并停掉陈旧度检查', () => {
    vi.useFakeTimers();
    const streams = installFakeStreams();
    const { unmount } = render(<Harness sessionId="s1" />);

    unmount();

    expect(streamAt(streams, 0).close).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // 定时器没被清掉的话，这里会继续读到已卸载组件之外的流状态
    expect(streamAt(streams, 0).isEventStale).not.toHaveBeenCalled();
  });

  it('切换会话时重建连接，并把上一条连接的判定清掉', () => {
    vi.useFakeTimers();
    const streams = installFakeStreams();
    const { rerender } = render(<Harness sessionId="s1" />);

    act(() => {
      streamAt(streams, 0).emitState('open');
      streamAt(streams, 0).emitEvent(1_757_692_800_000);
      streamAt(streams, 0).setStale(true);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('degraded')).toHaveTextContent('true');
    expect(screen.getByTestId('last-event-at')).toHaveTextContent('1757692800000');

    rerender(<Harness sessionId="s2" />);

    // 旧连接必须关掉，新连接不能继承旧会话的陈旧判定
    expect(streamAt(streams, 0).close).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
    expect(screen.getByTestId('degraded')).toHaveTextContent('false');
    expect(screen.getByTestId('last-event-at')).toHaveTextContent('null');
  });
});
