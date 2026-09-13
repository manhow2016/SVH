import { EmptyState } from '../../components/StateBlock.js';
import type { CardAction, SessionMessage } from '../../lib/api-types.js';
import { MessageBoundary } from './MessageBoundary.js';
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
  /** 放行任务：传 taskIds 表示只放行这些，不传表示放行该会话下全部等待任务（Task 7 接入） */
  onConfirm?: (input: { taskIds?: string[] }) => void;
  /** 结果卡与错误卡上的通用动作（Task 7 接入） */
  onAction?: (action: CardAction) => void;
  /** slug → 资产 id。空表示不做链接化（正文保持纯文本） */
  assetIndex?: ReadonlyMap<string, string>;
  /** 结果卡深链所需。缺省时不渲染「查看资产详情」 */
  projectId?: string;
}

export function MessageList({
  messages,
  onSendMessage,
  onConfirm,
  onAction,
  assetIndex,
  projectId,
}: MessageListProps) {
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
      {/*
        错误边界逐条消息包：一条载荷踩到渲染器的边界之外时，
        只有那一条降级成「正文 + 可见提示」，整段对话流与整个工作台照常。
      */}
      {messages.map((message) => (
        <MessageBoundary key={message.id} content={message.content}>
          <MessageItem
            message={message}
            onReply={onSendMessage}
            onConfirm={onConfirm}
            onAction={onAction}
            {...(assetIndex !== undefined ? { assetIndex } : {})}
            {...(projectId !== undefined ? { projectId } : {})}
          />
        </MessageBoundary>
      ))}
    </div>
  );
}
