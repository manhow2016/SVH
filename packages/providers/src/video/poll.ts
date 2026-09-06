/**
 * 视频任务轮询（文档 §14：异步任务 + 轮询）。
 *
 * 纯函数：interval / timeout / signal / onProgress 均可注入，便于测试。
 */
import type { VideoProvider, VideoTask, VideoTaskStatus } from "./provider";

export interface PollVideoTaskOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** 状态变化回调（progress/status 更新用） */
  onProgress?: (task: VideoTask) => void;
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 轮询直到终态；超时抛错；signal 中止抛错 */
export async function pollVideoTask(
  provider: VideoProvider,
  providerTaskId: string,
  options: PollVideoTaskOptions = {},
): Promise<VideoTask> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("Video task polling aborted");
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("Video task polling timed out");
    }
    const task = await provider.getTask(providerTaskId, options.signal);
    options.onProgress?.(task);
    if (isTerminalVideoStatus(task.status)) {
      return task;
    }
    await sleep(intervalMs, options.signal);
  }
}

export function isTerminalVideoStatus(status: VideoTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
