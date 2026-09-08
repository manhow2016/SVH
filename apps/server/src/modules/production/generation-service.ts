/**
 * 生成服务（V0.2 收尾：任务入队，执行在 apps/worker）。
 *
 * 职责：输入校验与模型配置解析（复用 settings 解析优先级，即时反馈 400）
 * → production_tasks 落 `queued` 行（payload = server 解析好的完整执行参数）
 * → 返回任务视图。不再调用 Provider、不再进程内轮询：生成执行、心跳与
 * 终态回写由 worker 经队列认领完成；Provider 错误进 task.error（worker 测试覆盖）。
 *
 * 注意：payload 含明文 API Key，只允许落库与 worker 内消费，严禁经视图/日志外泄。
 */
import { and, eq, notInArray } from "drizzle-orm";
import { randomId } from "@svh/shared";
import { productionTasks as tasksTable, type SVHDatabase } from "@svh/database";
import type { PromptComposer, ProductionService } from "@svh/production";
import type { SettingsService } from "../settings/service";
import { ERRORS, ServerError } from "../../lib/errors";

export interface GenerationServiceDeps {
  db: SVHDatabase;
  settings: SettingsService;
  /** 生产领域服务（读取项目风格/镜头/角色上下文，供 Prompt Composer 组合） */
  production: ProductionService;
  /** Prompt Composer（V0.3 Phase 2：统一所有 Image/Video 生成提示词组合） */
  promptComposer: PromptComposer;
}

/**
 * worker 执行参数（v1）。与 apps/worker `TaskPayload` 同形——刻意手写字面量、
 * 不跨包 import，保持 server ↔ worker 经 JSON 契约解耦（改动需双侧同步）。
 */
interface TaskPayload {
  v: number;
  prompt?: string;
  /** V0.3 Phase 2：由 Prompt Composer 组合后的最终提示词（worker 优先使用） */
  composedPrompt?: string;
  composedNegative?: string;
  /** V0.3 Phase 2：组合来源元数据（模板/项目/镜头/角色/供应商，供 replay/review/debug） */
  promptMetadata?: Record<string, unknown>;
  imageUrl?: string;
  size?: string;
  duration?: number;
  resolution?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  assetName: string;
}

/** 生产任务视图（对前端/测试）：白名单字段，不含 payload/claimedBy/heartbeatAt */
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
  constructor(private readonly deps: GenerationServiceDeps) {}

  // ================= 文生图（入队） =================

  /** 图片任务入队（校验与模型解析即时反馈；Provider 调用移入 worker） */
  async enqueueImage(input: {
    projectId: string;
    userId: string;
    prompt: string;
    modelName?: string;
    size?: string;
  }): Promise<ProductionTaskView> {
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
    // 修复轮 I2：空 Key 属配置错误，入队前即时 400（回归旧语义）——
    // 否则一路 queued、worker 一个 tick 后才 failed，用户拿不到可操作的即时提示。
    if (!config.apiKey) {
      throw ERRORS.INVALID_INPUT(`${providerId} 未配置 API Key，请在 Settings 中填写`);
    }
    // V0.3 Phase 2：所有图片生成经 Prompt Composer 统一组合（项目风格 + 用户描述）
    // 组合不阻塞入队（如项目读取失败则退化为仅用户描述，不阻断生成）。
    const project = await this.deps.production.getProject(input.projectId);
    const composed = this.deps.promptComposer.composeImage({
      rawPrompt: prompt,
      projectStyle: project.settings?.style,
      projectId: input.projectId,
      providerId,
    });
    return this.enqueue({
      projectId: input.projectId,
      userId: input.userId,
      kind: "image",
      payload: {
        v: 1,
        prompt,
        composedPrompt: composed.prompt || undefined,
        composedNegative: composed.negativePrompt,
        promptMetadata: composed.metadata as unknown as Record<string, unknown>,
        size: input.size,
        providerId,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        assetName: prompt.slice(0, 40) || "生成图片",
      },
    });
  }

  // ================= 文生/图生视频（入队） =================

  /** 视频任务入队（同 image：即时校验 + payload 透传时长/分辨率） */
  async enqueueVideo(input: {
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
    // 修复轮 I2：同图片——空 Key 即时 400，不入库
    if (!config.apiKey) {
      throw ERRORS.INVALID_INPUT(`${providerId} 未配置 API Key，请在 Settings 中填写`);
    }
    // V0.3 Phase 2：所有视频生成经 Prompt Composer 统一组合（项目风格 + 用户描述/动作）
    const project = await this.deps.production.getProject(input.projectId);
    const composed = this.deps.promptComposer.composeVideo({
      rawPrompt: prompt || undefined,
      imageUrl: input.imageUrl,
      projectStyle: project.settings?.style,
      projectId: input.projectId,
      providerId,
    });
    return this.enqueue({
      projectId: input.projectId,
      userId: input.userId,
      kind: "video",
      payload: {
        v: 1,
        prompt: prompt || undefined,
        composedPrompt: composed.prompt || undefined,
        composedNegative: composed.negativePrompt,
        promptMetadata: composed.metadata as unknown as Record<string, unknown>,
        imageUrl: input.imageUrl,
        duration: input.duration,
        resolution: input.resolution,
        providerId,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        assetName: prompt.slice(0, 40) || "生成视频",
      },
    });
  }

  // ================= 查询 / 取消 =================

  /** 查询任务（状态由 worker 回写，读取无需额外请求） */
  getTask(id: string): ProductionTaskView {
    const row = this.deps.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    if (!row) {
      throw new ServerError("NOT_FOUND", "任务不存在", 404);
    }
    return toTaskView(row);
  }

  /**
   * 取消任务：仅标记 `cancelled`（worker 下一轮归属自查/守卫回写观察收敛）。
   * server 不再通知供应商——供应商侧取消由 worker 的 best-effort 路径负责。
   */
  async cancelTask(id: string): Promise<void> {
    const row = this.deps.db.select().from(tasksTable).where(eq(tasksTable.id, id)).get();
    if (!row) {
      throw new ServerError("NOT_FOUND", "任务不存在", 404);
    }
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      throw new ServerError("CONFLICT", `任务已处于终态（${row.status}），无法取消`, 409);
    }
    // 修复轮 Minor2：与 finishTask 同型的终态守卫——读判与写入之间的窗口里
    // worker 可能恰好落终态；条件 UPDATE 零行命中即并发已终结，409 而非覆写。
    const changed = this.deps.db
      .update(tasksTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(tasksTable.id, id),
          notInArray(tasksTable.status, ["completed", "failed", "cancelled"]),
        ),
      )
      .returning({ id: tasksTable.id })
      .get();
    if (!changed) {
      throw new ServerError("CONFLICT", "任务已被并发终结，无法取消", 409);
    }
  }

  // ================= 内部实现 =================

  /** 落库一条 queued 任务并回读视图（providerId 冗余列供视图展示，与 payload 同源） */
  private enqueue(input: {
    projectId: string;
    userId: string;
    kind: "image" | "video";
    payload: TaskPayload;
  }): ProductionTaskView {
    const taskId = randomId("ptk");
    const now = new Date();
    this.deps.db
      .insert(tasksTable)
      .values({
        id: taskId,
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        providerId: input.payload.providerId,
        status: "queued",
        payload: JSON.stringify(input.payload),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getTask(taskId);
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
