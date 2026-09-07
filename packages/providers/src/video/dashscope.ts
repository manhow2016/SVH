/**
 * 阿里云百炼（DashScope）异步视频任务适配（文档 §14）。
 *
 * 端点（与 OpenAI-compatible-mode 不同，为 DashScope 原生任务 API）：
 * - 创建：POST {SERVICE_BASE}/services/aigc/video-generation/video-synthesis
 *         （文生视频与图生视频共用此端点，图生视频靠 input.img_url + 模型名区分），
 *         头 X-DashScope-Async: enable
 * - 查询：GET {SERVICE_BASE}/tasks/{task_id}
 * - 取消：POST {SERVICE_BASE}/tasks/{task_id}/cancel
 *
 * 状态映射：PENDING→queued；RUNNING→running；SUCCEEDED→completed；
 *           FAILED→failed（带 message）；CANCELED→cancelled。
 */
import { buildAuthHeaders, isAbortError, truncate } from "../http";
import type {
  CreateVideoTaskResult,
  VideoGenerationInput,
  VideoProvider,
  VideoTask,
  VideoTaskStatus,
} from "./provider";

/** DashScope 原生任务 API 根 */
export const DASHSCOPE_SERVICE_BASE = "https://dashscope.aliyuncs.com/api/v1";

export interface DashScopeVideoOptions {
  apiKey: string;
  /** 默认使用官方服务根；测试可注入 mock 根 */
  serviceBase?: string;
}

interface DashScopeTaskResponse {
  output?: {
    task_id?: string;
    task_status?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
    message?: string;
    video_url?: string;
    results?: Array<{ url?: string }>;
  };
  message?: string;
}

function mapTaskStatus(status: string | undefined): VideoTaskStatus {
  switch (status) {
    case "PENDING":
      return "queued";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELED":
      return "cancelled";
    default:
      return "running";
  }
}

/** 分辨率档位 → 官方要求的 "宽*高" 具体值（size 不接受 480P/720P 写法） */
const RESOLUTION_PRESETS: Record<string, string> = {
  "480p": "832*480",
  "720p": "1280*720",
  "1080p": "1920*1080",
};

function normalizeSize(resolution: string | undefined): string | undefined {
  if (!resolution) return undefined;
  const preset = RESOLUTION_PRESETS[resolution.toLowerCase().replace(/[-\s]/g, "")];
  return preset ?? resolution.replace(/x/gi, "*");
}

export class DashScopeVideoProvider implements VideoProvider {
  readonly id = "dashscope-async";
  private readonly serviceBase: string;
  private readonly apiKey: string;

  constructor(options: DashScopeVideoOptions) {
    this.apiKey = options.apiKey;
    this.serviceBase = options.serviceBase ?? DASHSCOPE_SERVICE_BASE;
  }

  async createTask(input: VideoGenerationInput, signal?: AbortSignal): Promise<CreateVideoTaskResult> {
    // 文生视频与图生视频共用 video-synthesis 端点（官方文档确认；无 -with-image 路径）
    const endpoint = `${this.serviceBase}/services/aigc/video-generation/video-synthesis`;
    const body: Record<string, unknown> = {
      model: input.model,
      input: input.imageUrl ? { img_url: input.imageUrl, prompt: input.prompt ?? "" } : { prompt: input.prompt ?? "" },
    };
    if (input.duration !== undefined || input.resolution !== undefined) {
      const size = normalizeSize(input.resolution);
      body.parameters = {
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(size ? { size } : {}),
      };
    }

    const response = await this.request(endpoint, "POST", body, signal, { "X-DashScope-Async": "enable" });
    const json = (await response.json()) as DashScopeTaskResponse;
    const taskId = json.output?.task_id;
    if (!taskId) {
      throw new Error(`创建视频任务失败：${json.message ?? "未返回 task_id"}`);
    }
    return { providerTaskId: taskId };
  }

  async getTask(providerTaskId: string, signal?: AbortSignal): Promise<VideoTask> {
    const response = await this.request(`${this.serviceBase}/tasks/${providerTaskId}`, "GET", undefined, signal);
    const json = (await response.json()) as DashScopeTaskResponse;
    const output = json.output ?? {};
    const results = output.results ?? [];
    const url = results[0]?.url ?? output.video_url;
    return {
      id: "", // 内部 id 由上层任务系统维护
      providerTaskId,
      status: mapTaskStatus(output.task_status),
      outputUrl: output.task_status === "SUCCEEDED" ? url : undefined,
      error: output.task_status === "FAILED" ? output.message : undefined,
    };
  }

  async cancelTask(providerTaskId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      `${this.serviceBase}/tasks/${providerTaskId}/cancel`,
      "POST",
      undefined,
      signal,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`取消视频任务失败 (${response.status}${detail ? `: ${truncate(detail, 300)}` : ""})`);
    }
  }

  private async request(
    endpoint: string,
    method: "GET" | "POST",
    body: unknown,
    signal?: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(this.apiKey),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error("Video task request aborted", { cause: err });
      }
      throw new Error(`Video task request failed: ${(err as Error).message}`, { cause: err });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Video task request failed (${response.status}${detail ? `: ${truncate(detail, 500)}` : ""})`,
      );
    }
    return response;
  }
}
