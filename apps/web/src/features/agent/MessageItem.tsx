import type { CardAction, ConfirmationRequestPayload, SessionMessage } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import styles from './MessageList.module.css';

export interface MessageItemProps {
  message: SessionMessage;
  /** 卡片上的「回复」类动作：把文本作为下一条用户消息发出去（Task 6 载荷分发使用） */
  onReply?: (text: string) => void;
  /** 确认请求的批准与拒绝（Task 6 载荷分发使用） */
  onConfirm?: (request: ConfirmationRequestPayload, approved: boolean) => void;
  /** 结果卡与错误卡上的通用动作（Task 6 载荷分发使用） */
  onAction?: (action: CardAction) => void;
}

/**
 * 单条消息。
 *
 * 载荷分发（plan / result_card / confirmation_request / progress / error）
 * 在 Task 6 补全；本任务先渲染纯文本，让工作台骨架先跑通并接受测试。
 *
 * 上面三个回调本任务**刻意不消费** —— 它们只是先把接口占住，
 * 这样 Task 6 补分发时不必回头改 MessageList / AgentWorkspace 的调用点。
 * 因此这里只解构真正用到的 `message`。
 */
export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <article className={`${styles.message} ${isUser ? styles.user : ''}`}>
      {isUser ? (
        <div className={styles.userBubble}>{message.content}</div>
      ) : (
        <div className={styles.agentText}>{message.content}</div>
      )}
      <span className={styles.meta}>{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}
