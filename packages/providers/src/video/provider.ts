/**
 * Video Provider 接口（V0.2 文档 §14）。
 *
 * 视频模型必须使用异步任务接口（禁止 await generateVideo）：
 * createTask（提交）→ getTask（轮询）→ cancelTask（取消）。
 * 轮询由调用方驱动（见 poll.ts 纯函数），进度/重试由上层任务系统管理。
 */
export type VideoTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface VideoTask {
  /** 本系统内部任务 id */
  id: string;
  /** 供应商侧任务 id */
  providerTaskId: string;
  status: VideoTaskStatus;
  /** 0-100（供应商不提供时 undefined） */
  progress?: number;
  /** completed 时的视频 URL */
  outputUrl?: string;
  error?: string;
}

export interface VideoGenerationInput {
  model: string;
  /** 文生视频提示词 */
  prompt?: string;
  /** 图生视频参考图 URL（提供时走 image-to-video） */
  imageUrl?: string;
  /** 目标时长（秒，供应商选项；缺省由模型决定） */
  duration?: number;
  /** 分辨率，如 "1280*720" */
  resolution?: string;
}

export interface CreateVideoTaskResult {
  /** 供应商任务 id（用于 getTask/cancelTask） */
  providerTaskId: string;
}

export interface VideoProvider {
  /** 统一注册 id（如 "dashscope-async"） */
  id: string;
  createTask(input: VideoGenerationInput, signal?: AbortSignal): Promise<CreateVideoTaskResult>;
  getTask(providerTaskId: string, signal?: AbortSignal): Promise<VideoTask>;
  cancelTask(providerTaskId: string, signal?: AbortSignal): Promise<void>;
}
