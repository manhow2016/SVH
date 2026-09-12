/**
 * 把 SSE 客户端接进 React。
 *
 * ── 这个 hook 的职责边界 ──
 * 它只负责「连接状态」与「降级信号」，不负责把事件写进消息列表 ——
 * 那是调用方的事（它才知道哪些事件该追加消息、哪些只该刷新任务面板）。
 *
 * ── 降级为何要两个条件 ──
 * `state === 'reconnecting'` 覆盖「连接明确断了」；
 * `isEventStale()` 覆盖「连接看起来是好的，但很久没有业务事件」——
 * 后者正是半开链路（TCP 还在、对端不回包）的形态，
 * 此时客户端会照常收到 ping，仅凭连接状态**完全看不出异常**。
 * 而 Phase 5A 给订阅连接加的 `blockingTimeout` 让这种连接看起来更健康，
 * 所以两个条件都要，缺一不可。
 */
import { useEffect, useRef, useState } from 'react';

import {
  createSessionStream,
  type SessionStream,
  type SseEnvelope,
  type StreamState,
} from '../../lib/sse.js';

export interface UseSessionStreamOptions {
  sessionId: string | null;
  onEvent: (envelope: SseEnvelope) => void;
}

export interface SessionStreamStatus {
  state: StreamState;
  /**
   * 上一次定期检查的结果：连接看起来是好的，但业务事件已经很久没来了。
   *
   * 它是**拉取式**判据的快照，不是实时值 —— 见下面的定时器。
   */
  isEventStale: boolean;
  /** 连接明确断开，或业务事件已陈旧 —— 任一为真即应显示降级提示 */
  degraded: boolean;
  /** 最后一次业务事件的到达时间（毫秒），从未收到则为 null */
  lastEventAt: number | null;
}

/**
 * 陈旧度检查间隔。
 *
 * 必须明显小于 `lib/sse.ts` 的 `staleAfterMs`（默认 45 秒），
 * 否则用户看到降级提示的时刻会比实际降级晚一大截。
 */
const STALE_CHECK_INTERVAL_MS = 5_000;

export function useSessionStream({ sessionId, onEvent }: UseSessionStreamOptions): SessionStreamStatus {
  const [state, setState] = useState<StreamState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [isEventStale, setIsEventStale] = useState(false);

  // 用 ref 持有最新回调，避免把它放进依赖导致每次渲染都重建连接
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (sessionId === null) {
      // 没有会话就没有可订阅的连接：既不算断线，也不算陈旧
      setState('closed');
      setLastEventAt(null);
      setIsEventStale(false);
      return;
    }

    // 换会话时先清掉上一条连接留下的判定，免得旧连接的「陈旧」挂在新会话上
    setState('connecting');
    setLastEventAt(null);
    setIsEventStale(false);

    const stream: SessionStream = createSessionStream({
      sessionId,
      onEvent: (envelope) => {
        setLastEventAt(stream.lastEventAt());
        onEventRef.current(envelope);
      },
      onStateChange: setState,
    });

    /*
     * 定期检查事件陈旧度。
     *
     * 它不是由某个事件触发的，也没有回调可用 —— 半开链路会照常每 15 秒收到一次
     * ping，因此不会有任何东西来通知我们「业务事件已经停了」。
     * 不在这里主动捞一次，这个信号永远不会浮出水面。
     */
    const timer = setInterval(() => {
      setIsEventStale(stream.isEventStale());
    }, STALE_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      // 卸载必须关掉底层连接：否则组件没了，在途的事件流请求还挂着
      stream.close();
    };
  }, [sessionId]);

  return {
    state,
    isEventStale,
    degraded: state === 'reconnecting' || isEventStale,
    lastEventAt,
  };
}
