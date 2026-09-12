import type { CardAction, MessagePayload, SessionMessage } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import { ConfirmationCard } from './renderers/ConfirmationCard.js';
import { ErrorCard } from './renderers/ErrorCard.js';
import { PlanCard } from './renderers/PlanCard.js';
import { ProgressLine } from './renderers/ProgressLine.js';
import { ResultCard } from './renderers/ResultCard.js';
import styles from './MessageList.module.css';

export interface MessageItemProps {
  message: SessionMessage;
  /** 「回复」类动作：把文本作为下一条用户消息发出去 */
  onReply?: (message: string) => void;
  /** 放行任务：传 taskIds 表示只放行这些，不传表示放行该会话下全部等待任务 */
  onConfirm?: (input: { taskIds?: string[] }) => void;
  /** 结果卡与错误卡上的通用动作 */
  onAction?: (action: CardAction) => void;
}

/**
 * 把 unknown 的 payload 收窄为判别联合。
 *
 * 后端把 payload 存成 JSON，前端拿到的是 unknown；
 * 这里只做**结构校验**（有没有字符串型的 type），不做完整 schema 校验 ——
 * 完整校验的收益不足以抵消在前端重复维护一份协议的成本：
 * 协议已经在 `@svh/domain` 里定义过一次，前端再抄一份 schema，
 * 两边就会各自演化。真正的护栏是端到端验证。
 *
 * 代价是未知 `type` 会落到分发链的末尾（什么都不渲染），而不是当场报错。
 */
function asPayload(value: unknown): MessagePayload | null {
  if (value === null || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return value as MessagePayload;
}

/** 分发链上的三个出口 */
interface PayloadViewProps {
  payload: MessagePayload;
  onReply: (message: string) => void;
  onConfirm: (input: { taskIds?: string[] }) => void;
  onAction: (action: CardAction) => void;
}

/**
 * 按 `payload.type` 渲染对应卡片。
 *
 * 判别联合的 `switch` 让每个分支里的 `payload` 自动收窄成对应类型，
 * 因此这里不需要任何 `as` 断言。
 *
 * 未知类型返回 null：界面降级为「这条消息只有正文」，
 * 而不是让整段对话流因为一个新协议而崩掉。
 */
function PayloadView({ payload, onReply, onConfirm, onAction }: PayloadViewProps) {
  switch (payload.type) {
    case 'plan':
      return <PlanCard payload={payload} onReply={onReply} />;
    case 'confirmation_request':
      return <ConfirmationCard payload={payload} onConfirm={onConfirm} />;
    case 'result_card':
      return <ResultCard payload={payload} onAction={onAction} />;
    case 'error':
      return <ErrorCard payload={payload} />;
    case 'progress':
      return <ProgressLine payload={payload} />;
    default:
      // 结构收窄只保证 type 是字符串，不保证它是这五个之一
      return null;
  }
}

export function MessageItem({
  message,
  onReply = () => undefined,
  onConfirm = () => undefined,
  onAction = () => undefined,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const payload = asPayload(message.payload);

  return (
    <article className={`${styles.message} ${isUser ? styles.user : ''}`}>
      {isUser ? (
        <div className={styles.userBubble}>{message.content}</div>
      ) : (
        <div className={styles.agentText}>
          {/* 有载荷时正文可能为空（例如纯计划消息），此时不渲染空段落 */}
          {message.content.length > 0 ? <p>{message.content}</p> : null}

          {/* 判别联合分发：五类载荷各自的渲染器 */}
          {payload !== null ? (
            <PayloadView
              payload={payload}
              onReply={onReply}
              onConfirm={onConfirm}
              onAction={onAction}
            />
          ) : null}
        </div>
      )}
      <span className={styles.meta}>{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}
