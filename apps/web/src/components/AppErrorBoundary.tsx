import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ErrorState } from './StateBlock.js';
import styles from './AppErrorBoundary.module.css';

/**
 * 应用级错误边界：渲染期异常的最后一道防线。
 *
 * ── 为什么必须有这一层 ──
 * React 19 在没有错误边界时会**卸载整棵根树**，用户看到的是一片白屏 ——
 * 没有任何文案、没有任何可点的东西。本项目此前只有**逐条消息**的
 * `MessageBoundary`（见 features/agent/MessageBoundary.tsx），
 * 它挡得住「一条坏消息」，但挡不住渲染期之外的异常：
 * 路由层、页面组件、以及消息列表之外的任何一处抛错，仍然整站白屏。
 *
 * ── 为什么放在 ToastProvider 外面 ──
 * 边界要覆盖 ToastProvider 自身 —— 提供者抛错同样会白屏。
 * 代价是这一层的降级界面**不能用 toast 提示**，所以它自带完整文案与操作入口。
 *
 * ── 为什么不用 window.location.reload() ──
 * 「重试」只重置这一层的状态、重新渲染子树：多数渲染异常来自一次性的坏数据
 * （某条消息、某个字段缺失），重挂一次就能过去；整页刷新会丢掉用户当前的
 * 会话位置与输入框内容，代价大得多。真需要刷新时用户自己会刷。
 */
interface AppErrorBoundaryState {
  failed: boolean;
  /** 原始错误信息：降级界面里要给出**可排查**的一句话，而不是「出错了」 */
  detail: string;
}

export interface AppErrorBoundaryProps {
  children: ReactNode;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { failed: false, detail: '' };
  }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      failed: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 降级不是静默：控制台必须留下组件栈，否则线上只能看到「界面白了」
    console.error('应用渲染失败，已降级为错误说明页', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false, detail: '' });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className={styles.page}>
        <ErrorState
          title="界面遇到了未预期的问题"
          reason={
            // 技术细节只作为一句附注：用户先要知道「发生了什么、还能做什么」
            this.state.detail.length > 0
              ? `页面在渲染时中断了。技术信息：${this.state.detail}`
              : '页面在渲染时中断了。'
          }
          suggestions={[
            '先点「重试」重新渲染一次 —— 多数情况下是某一条数据异常，重挂即可恢复',
            '若重试后仍然如此，回到项目列表换个入口，当前会话的内容不会丢失',
          ]}
          onRetry={this.retry}
        />
        <p className={styles.back}>
          <Link className={styles.link} to="/projects">
            回到项目列表
          </Link>
        </p>
      </div>
    );
  }
}
