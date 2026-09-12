import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Icon } from '../../components/Icon.js';
import { ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { ApiError, apiFetch } from '../../lib/api.js';
import type { PageBody, SessionMessage, SessionSummary } from '../../lib/api-types.js';
import { MessageList } from './MessageList.js';
import { useSessionStream } from './useSessionStream.js';
import styles from './AgentWorkspace.module.css';

/** 会话详情。`api-types.ts` 只保留了列表摘要（SessionSummary），详情在此按需声明。 */
interface SessionDetail {
  id: string;
  projectId: string | null;
  title: string;
  agentState: string;
  messages: SessionMessage[];
}

/**
 * 页面状态。
 *
 * 用可辨识联合而不是 `{ loading, error }` 两个独立字段：
 * 后者允许「同时在加载又有错误」这类自相矛盾的状态存在。
 */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: SessionDetail; messages: SessionMessage[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/**
 * 单次拉取历史消息的条数上限。
 *
 * 取值与端点的最大值一致（`limit` 上限 200）；默认值 50 会在长会话里
 * 静默截断历史，因此这里必须显式传。更早的消息要靠分页补齐。
 */
const SESSION_MESSAGE_LIMIT = 200;

/** 尚无会话时的占位会话：`id` 为空即表示「还没建会话」，此时不建立 SSE 连接 */
function emptySession(projectId: string | null): SessionDetail {
  return { id: '', projectId, title: '', agentState: 'idle', messages: [] };
}

export function AgentWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      /*
       * 两步加载：先取会话列表（按 projectId 过滤，拿最新一条的 id），再取详情。
       *
       * 为什么不是一步：后端**没有**「按项目取最新会话」的专用端点，
       * 而列表端点已经支持 projectId 过滤与分页。
       */
      const page = await apiFetch<PageBody<SessionSummary>>(
        `/api/agent/sessions?projectId=${projectId ?? ''}&pageSize=1`,
      );

      const latest = page.items[0];
      if (latest === undefined) {
        // 该项目还没有会话：显示空对话流，等用户说出第一个需求时再创建（Task 7）
        setState({ kind: 'ready', session: emptySession(projectId ?? null), messages: [] });
        return;
      }

      /*
       * 详情请求必须显式带 `limit`：端点的默认值是 50（上限 200，
       * 见 apps/api/src/routes/agent.ts 的 listMessagesQuerySchema）。
       * 会话按项目复用并长期累积，不带参数时刷新会**静默丢掉最早的一批消息**，
       * 与「REST 全量历史、刷新不丢消息」的承诺直接矛盾 —— Task 6 之后
       * 被丢掉的可能是早先的计划卡 / 确认卡。
       *
       * ── 已知限制 ──
       * 200 是当前端点允许的上限，也是这里能一次拿到的**全部**。
       * 超过 200 条消息的会话，更早的历史需要分页加载（端点已支持 `before` 游标），
       * 本任务尚未实现「加载更早的消息」入口 —— 这是明确的待办，不是「已经全量」。
       */
      const detail = await apiFetch<SessionDetail>(
        `/api/agent/sessions/${latest.id}?limit=${SESSION_MESSAGE_LIMIT}`,
      );
      setState({ kind: 'ready', session: detail, messages: detail.messages ?? [] });
    } catch (err) {
      // 直接消费 ApiError 携带的后端文案：规范要求错误说明
      // 「发生了什么 / 可能原因 / 下一步怎么做」，这三件事后端已经给了
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载会话失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * 历史与实时分工：REST 负责**全量历史**（刷新不丢消息），SSE 只接**增量**。
   * 因此这里把「还没有会话」表达为 null —— 没有会话就没有可订阅的连接。
   */
  const sessionId = state.kind === 'ready' && state.session.id.length > 0 ? state.session.id : null;

  const stream = useSessionStream({
    sessionId,
    onEvent: (envelope) => {
      // Task 6 会在这里按事件类型把消息与任务状态分派到各自的容器
      void envelope;
    },
  });

  return (
    <div className={styles.workspace}>
      <div className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            {state.kind === 'ready' ? state.session.title || '新会话' : '工作台'}
          </h1>
        </header>

        {/*
          降级提示：连接断了、或业务事件陈旧时都显示。
          绝不静默 —— 用户必须知道当前进度可能不是最新的。
        */}
        {stream.degraded ? (
          <div className={styles.degraded} role="status">
            <Icon name="alert" />
            <span>实时连接已中断，正在重连。当前进度可能不是最新的。</span>
          </div>
        ) : null}

        <div className={styles.scroll}>
          {state.kind === 'loading' ? <SkeletonLines lines={6} /> : null}
          {state.kind === 'error' ? (
            <ErrorState
              title="加载会话失败"
              reason={state.message}
              {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
              {...(state.retryable
                ? {
                    onRetry: () => {
                      void load();
                    },
                  }
                : {})}
            />
          ) : null}
          {state.kind === 'ready' ? <MessageList messages={state.messages} /> : null}
        </div>

        <div className={styles.composerSlot}>输入区将在 Task 7 接入</div>
      </div>

      <aside className={styles.side}>
        <h2>任务</h2>
        <p className={styles.placeholder}>任务面板将在 Task 7 接入</p>
      </aside>
    </div>
  );
}
