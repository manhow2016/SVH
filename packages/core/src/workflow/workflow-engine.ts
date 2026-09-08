/**
 * WorkflowEngine（文档 §11：暂停/恢复/取消 + 执行循环入口）。
 *
 * 每个运行实例对应一次 Workflow 执行（WorkflowEngine 不跨 run 复用），
 * 由 server 层工作流服务创建并通过 pause/resume/cancel 控制。
 */
import type { WorkflowEvent } from "./workflow-events";
import { runWorkflowLoop, type WorkflowLoopOptions } from "./workflow-executor";
import type { NodeExecutor } from "./workflow-node";
import type { Workflow } from "./workflow-types";

export class WorkflowEngine {
  private paused = false;
  private waitingUser = false;
  private cancelled = false;
  /** 暂停与等待用户共享等待器（恢复/取消时一并 resolve） */
  private waiters: Array<() => void> = [];
  private readonly abortController = new AbortController();

  /** 暂停执行（仅在等待/节点边界生效；正在执行的节点不受影响） */
  pause(): void {
    if (this.cancelled) return;
    this.paused = true;
  }

  /** 恢复执行（同时解除「暂停」与「等待用户输入」两种挂起） */
  resume(): void {
    if (!this.paused && !this.waitingUser) return;
    this.paused = false;
    this.waitingUser = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** 取消执行（触发 abort 信号 + 终止节点调度） */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.waitingUser = false;
    this.abortController.abort();
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 执行工作流：返回事件流。
   * - 已完成节点自动跳过（支持从失败状态重新执行）
   * - 失败节点级联取消下游；重试由节点 maxRetries 控制
   * - 执行器返回等待哨兵（__waitForUser）时挂起为 waiting_user，resume() 后重入该节点
   */
  run(workflow: Workflow, executor: NodeExecutor, opts: WorkflowLoopOptions = {}): AsyncIterable<WorkflowEvent> {
    return runWorkflowLoop(
      workflow,
      executor,
      {
        signal: this.abortController.signal,
        isCancelled: () => this.cancelled,
        waitWhilePaused: () => {
          if (!this.paused || this.cancelled) return Promise.resolve();
          return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
          });
        },
        waitWhileUser: () => {
          this.waitingUser = true;
          if (this.cancelled) return Promise.resolve();
          return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
          });
        },
      },
      opts,
    );
  }
}
