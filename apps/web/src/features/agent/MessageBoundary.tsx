import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Icon } from '../../components/Icon.js';
import styles from './MessageBoundary.module.css';

/**
 * 消息级的降级设施：一条消息渲染不出来时的**唯一**出口。
 *
 * - `MessageNotice`：可见的降级提示 —— 未知载荷类型、计划缺步骤、卡片渲染失败都用它；
 * - `MessageBoundary`：逐条消息的错误边界，把渲染异常挡在单条消息之内。
 */

export interface MessageNoticeProps {
  children: ReactNode;
}

/**
 * 消息级的可见降级提示。
 *
 * 载荷渲染不出来时**必须留下信号**：用户要知道这条消息本该还有内容，
 * 排查的人也要一眼看出问题出在协议一侧 —— 静默丢弃会让这条消息
 * 退化成一个只有时间戳的空条目。
 *
 * 形态刻意不是卡片：它不是可操作的对象，只是一句说明，
 * 因此只有一行警示色文字，不再套一层 Card。
 */
export function MessageNotice({ children }: MessageNoticeProps) {
  return (
    <p className={styles.notice} role="note">
      <Icon name="alert" className={styles.noticeIcon} />
      {children}
    </p>
  );
}

export interface MessageBoundaryProps {
  /** 这条消息的正文：卡片渲染失败后，它是用户还能看到的唯一内容 */
  content: string;
  children: ReactNode;
}

interface MessageBoundaryState {
  failed: boolean;
}

/**
 * 单条消息的错误边界。
 *
 * payload 在前端只经过一次**结构收窄**（见 `MessageItem` 的 `asPayload`），
 * 不做完整 schema 校验，因此任何一条超出预期的数据都可能在渲染时抛错。
 * React 19 在没有错误边界时会卸载整棵根树 —— 一条坏消息就足以让整个工作台白屏。
 *
 * 边界刻意落在**每一条消息**上而不是整段对话流上：坏掉的只是那一条，
 * 其余消息照常渲染。降级形态是「正文纯文本 + 可见提示」，
 * 与未知载荷类型的降级保持一致。
 */
export class MessageBoundary extends Component<MessageBoundaryProps, MessageBoundaryState> {
  constructor(props: MessageBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): MessageBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 降级不是静默：日志必须留下痕迹，否则线上只能看到「界面少了一块」
    console.error('消息载荷渲染失败，已降级为纯文本', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className={styles.fallback}>
        {this.props.content.length > 0 ? (
          <p className={styles.content}>{this.props.content}</p>
        ) : null}
        <MessageNotice>这条消息的卡片渲染失败，已降级为纯文本</MessageNotice>
      </div>
    );
  }
}
