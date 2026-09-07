/**
 * 生成服务（V0.2 文档 §13/§14：Storyboard → Image Prompt → Image Generation → Asset；
 * Video 异步任务：提交 → 轮询 → Asset）。
 *
 * 职责：解析用户/环境模型配置（复用 settings 解析优先级）
 * → 调用 Image/Video Provider → 生成结果落库为生产资产（追踪来源 generation）。
 */
import { eq } from "drizzle-orm";
import { randomId } from "@svh/shared";
import {
  DashScopeVideoProvider,
  OpenAICompatibleImageProvider,
  pollVideoTask,
  type ModelConfig,
  type VideoProvider,
} from "@svh/providers";
import { productionTasks as tasksTable, type SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import type { SettingsService } from "../settings/service";
import { ERRORS, ServerError } from "../../lib/errors";

export interface GenerationServiceDeps {
  db: SVHDatabase;
  settings: SettingsService;
  production: ProductionService;
  /** 视频适配器工厂（测试注入假实现；缺省 = DashScope 异步任务适配） */
  videoAdapterFactory?: (input: { modelConfig: ModelConfig; providerId: string }) => VideoProvider;
  /** 轮询间隔毫秒（测试可缩短） */
  pollIntervalMs?: number;
}

/** 生产任务视图（对前端/测试） */
export interface ProductionTaskView {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  progress?: number | null;
  outputUrl?: string | null;
  error?: string | null;
  providerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class GenerationService {
  /** 运行中视频任务的中止控制器（取消用） */
  private readonly taskControllers = new Map<string, AbortController>();

  constructor(private readonly deps: GenerationServiceDeps) {}

  // ================= 文生图（Phase 7） =================

  /** 文生图（OpenAI 兼容图片端点；结果存供应商 URL，无 URL 时 b64 放 metadata） */
  async generateImage(input: {
    projectId: string;
    userId: string;
    prompt: string;
    modelName?: string;
    size?: string;
  }): Promise<unknown> {
    const prompt = input.prompt.trim();
    if (prompt === "") {
      throw ERRORS.INVALID_INPUT("prompt is required");
    }
    const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(
      input.modelName,
      input.userId,
      ["image"],
    );
    if (!config.model) {
      throw ERRORS.INVALID_INPUT("未配置可用的图片模型，请在 Settings 中启用图片模型");
    }

    const provider = new OpenAICompatibleImageProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    let result;
    try {
      result = await provider.generate({
        model: config.model,
        prompt,
        size: input.size,
      });
    } catch (err) {
      // 上游图片服务错误（401 Key 失效 / 额度 / 超时等）→ 502 + 原始信息，便于前端展示可操作提示
      throw new ServerError(
        "IMAGE_PROVIDER_ERROR",
        `图片生成失败：${(err as Error).message}（请检查该图片模型的 API Key 与额度）`,
        502,
        { cause: err },
      );
    }
    const first = result.images[0];
    if (!first) {
      throw ERRORS.INVALID_INPUT("图片生成失败：供应商未返回图片");
    }

    const asset = await this.deps.production.createAsset({
      projectId: input.projectId,
      type: "image",
      name: prompt.slice(0, 40) || "生成图片",
      url: first.url,
      mimeType: "image/png",
      metadata: first.b64Json ? { b64Json: first.b64Json } : undefined,
      generation: {
        providerId,
        modelId: config.model,
        prompt,
      },
    });
    return { asset, created: result.created };
  }

  // ================= 文生/图生视频（Phase 8：异步任务 + 轮询） =================

  /** 提交视频生成任务（立即返回 task，异步轮询结果） */
  async startVideoTask(input: {
    projectId: string;
    userId: string;
    prompt?: string;
    imageUrl?: string;
    modelName?: string;
    duration?: number;
    resolution?: string;
  }): Promise<ProductionTaskView> {
    const prompt = input.prompt?.trim() ?? "";
    if (prompt === "" && !input.imageUrl) {
      throw ERRORS.INVALID_INPUT("prompt 或 imageUrl 至少提供一个");
    }
    const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(
      input.modelName,
      input.userId,
      ["video"],
    );
    if (!config.model) {
      throw ERRORS.INVALID_INPUT("未配置可用的视频模型，请在 Settings 中启用视频模型");
    }

    const provider = this.resolveVideoProvider(config, providerId);
    let taskHandle;
    try {
      taskHandle = await provider.createTask({
        model: config.model,
        prompt: prompt || undefined,
        imageUrl: input.imageUrl,
        duration: input.duration,
        resolution: input.resolution,
      });
    } catch (err) {
      // 上游任务创建失败 → 502 + 原始信息（此时尚未落库任务，直接反馈即可）
      throw new ServerError(
        "VIDEO_PROVIDER_ERROR",
        `视频任务创建失败：${(err as Error).message}（请检查 DashScope API Key 与模型可用性）`,
        502,
        { cause: err },
      );
    }
    const { providerTaskId } = taskHandle;

    const taskId = randomId("ptk");
    const now = new Date();
    this.deps.db
      .insert(tasksTable)
      .values({
        id: taskId,
        projectId: input.projectId,
        userId: input.userId,
        kind: "video",
        providerId,
        providerTaskId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const controller = new AbortController();
    this.taskControllers.set(taskId, controller);
    void this.pollVideoTask(taskId, provider, providerTaskId, controller, {
      model: config.model,
      prompt: prompt || undefined,
    });
    return this.getTask(taskId);
  }

  /** 查询任务（轮询结果存在 DB，读取无需额外请求） */
  getTask(id: string): ProductionTaskView {
    const row = this.deps.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    if (!row) {
      throw new ServerError("NOT_FOUND", "任务不存在", 404);
    }
    return toTaskView(row);
  }

  /** 取消任务：标记取消 + 通知供应商 + 停止轮询 */
  async cancelTask(id: string): Promise<void> {
    const row = this.deps.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    if (!row) {
      throw new ServerError("NOT_FOUND", "任务不存在", 404);
    }
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      throw new ServerError("CONFLICT", `任务已处于终态（${row.status}），无法取消`, 409);
    }
    this.taskControllers.get(id)?.abort();
    if (row.providerTaskId && row.providerId) {
      try {
        const provider = this.resolveVideoProvider(
          { providerId: "", model: "", baseUrl: "", apiKey: "" },
          row.providerId,
        );
        await provider.cancelTask(row.providerTaskId);
      } catch {
        // 供应商取消失败不阻塞本地状态更新
      }
    }
    this.deps.db
      .update(tasksTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(tasksTable.id, id))
      .run();
  }

  // ================= 内部实现 =================

  private resolveVideoProvider(modelConfig: ModelConfig, providerId: string): VideoProvider {
    if (this.deps.videoAdapterFactory) {
      return this.deps.videoAdapterFactory({ modelConfig, providerId });
    }
    if (providerId !== "dashscope") {
      throw ERRORS.INVALID_INPUT("当前版本视频生成仅支持百炼（DashScope）模型");
    }
    return new DashScopeVideoProvider({ apiKey: modelConfig.apiKey });
  }

  private async pollVideoTask(
    taskId: string,
    provider: VideoProvider,
    providerTaskId: string,
    controller: AbortController,
    generation: { model: string; prompt?: string },
  ): Promise<void> {
    try {
      const task = await pollVideoTask(provider, providerTaskId, {
        intervalMs: this.deps.pollIntervalMs ?? 5000,
        signal: controller.signal,
        onProgress: (t) =>
          this.updateTask(taskId, { status: t.status, progress: t.progress, error: t.error }),
      });
      this.updateTask(taskId, {
        status: task.status,
        progress: task.status === "completed" ? 100 : undefined,
        outputUrl: task.outputUrl,
        error: task.error,
      });
      if (task.status === "completed" && task.outputUrl) {
        const row = this.deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
        if (row) {
          await this.deps.production.createAsset({
            projectId: row.projectId,
            type: "video",
            name: generation.prompt?.slice(0, 40) || "生成视频",
            url: task.outputUrl,
            mimeType: "video/mp4",
            generation: {
              providerId: row.providerId ?? "",
              modelId: generation.model,
              prompt: generation.prompt,
              taskId,
            },
          });
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.updateTask(taskId, { status: "failed", error: (err as Error).message });
      }
    } finally {
      this.taskControllers.delete(taskId);
    }
  }

  private updateTask(
    id: string,
    patch: { status?: string; progress?: number | null; outputUrl?: string | null; error?: string | null },
  ): void {
    this.deps.db
      .update(tasksTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tasksTable.id, id))
      .run();
  }
}

function toTaskView(row: {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  progress: number | null;
  outputUrl: string | null;
  error: string | null;
  providerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ProductionTaskView {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    outputUrl: row.outputUrl,
    error: row.error,
    providerId: row.providerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
