import { EmptyState } from '../../components/StateBlock.js';
import type { CardAction, ConfirmationRequestPayload, SessionMessage } from '../../lib/api-types.js';
import { MessageItem } from './MessageItem.js';
import styles from './MessageList.module.css';

export interface MessageListProps {
  messages: SessionMessage[];
  /**
   * 发送一条文本消息。
   *
   * 它同时是消息卡片上「回复」类动作的出口（Task 6）与输入区的出口（Task 7），
   * 因此在这里收口，避免两处各写一条发送逻辑。
   */
  onSendMessage?: (text: string) => void;
  /** 确认请求的批准与拒绝（Task 6 载荷分发使用） */
  onConfirm?: (request: ConfirmationRequestPayload, approved: boolean) => void;
  /** 结果卡与错误卡上的通用动作（Task 6 载荷分发使用） */
  onAction?: (action: CardAction) => void;
}

export function MessageList({ messages, onSendMessage, onConfirm, onAction }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <EmptyState
        icon="info"
        title="开始你的第一个创作"
        description="直接说出你想要什么，例如「帮我做一个 30 秒的护肤品广告」。Agent 会先给出制作计划，你确认后再开始生成。"
      />
    );
  }

  return (
    <div className={styles.list}>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          onReply={onSendMessage}
          onConfirm={onConfirm}
          onAction={onAction}
        />
      ))}
    </div>
  );
}
