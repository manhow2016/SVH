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
import { and, asc, eq, notInArray } from "drizzle-orm";
import { randomId } from "@svh/shared";
import { productionTasks as tasksTable, type SVHDatabase } from "@svh/database";
import type { ComposedPrompt, PromptComposer, ProductionService } from "@svh/production";
import { resolveVisualStyle, visualStyleToPrompt } from "@svh/production";
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
  /** Task 1：所属分镜（storyboard）id，透传给 worker 作执行上下文参考 */
  storyboardId?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  assetName: string;
  /** V0.3 Phase 6：备用供应商配置（primary 失败后回退；无则不回退） */
  fallback?: { providerId: string; model: string; baseUrl: string; apiKey: string };
  /** Phase B：参考图 URL（角色一致性）；worker 仅在适配器声明支持时透传 */
  referenceImageUrls?: string[];
  /** Phase C：TTS 音色名（角色 voice；缺省供应商默认） */
  voice?: string;
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

  /** 解析备用供应商配置（用于 Provider fallback；失败静默忽略，不阻断入队） */
  private async resolveFallbackConfig(
    modelName: string | undefined,
    userId: string,
    kinds: Array<"image" | "video">,
  ): Promise<{ providerId: string; model: string; baseUrl: string; apiKey: string } | undefined> {
    if (!modelName) return undefined;
    try {
      const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(modelName, userId, kinds);
      if (config.model && config.apiKey) {
        return { providerId, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey };
      }
    } catch {
      /* 备用模型不可用：忽略 */
    }
    return undefined;
  }

  /**
   * Phase B：解析分镜出场角色的参考资产 URL（角色一致性）。
   * 分镜 → 场景 → 出场角色 → referenceAssetId → 资产 URL；
   * 任何一环缺失/失败 → 空数组（降级 prompt-only，不阻断生成，与生产上下文降级同源取舍）。
   */
  private async resolveReferenceImages(projectId: string, storyboardId?: string): Promise<string[]> {
    if (!storyboardId) return [];
    try {
      const storyboard = await this.deps.production.getStoryboard(storyboardId);
      const scene = await this.deps.production.getScene(storyboard.sceneId);
      const characters = await Promise.all(
        (scene.characters ?? []).map((id) => this.deps.production.getCharacter(id).catch(() => null)),
      );
      const refIds = characters
        .map((c) => c?.referenceAssetId)
        .filter((v): v is string => Boolean(v));
      if (refIds.length === 0) return [];
      const assets = await Promise.all(
        refIds.map((id) => this.deps.production.getAsset(id).catch(() => null)),
      );
      return assets
        .filter((a) => Boolean(a?.url))
        .map((a) => a!.url!);
    } catch {
      return [];
    }
  }

  // ================= 文生图（入队） =================

  /** 图片任务入队（校验与模型解析即时反馈；Provider 调用移入 worker） */
  async enqueueImage(input: {
    projectId: string;
    userId: string;
    prompt: string;
    modelName?: string;
    size?: string;
    /** Task 1：工作流/节点/分镜透传（写 workflowId/nodeId 列，storyboardId 进 payload） */
    workflowId?: string;
    nodeId?: string;
    storyboardId?: string;
    /** Task 1：覆盖默认资产名（未传则取 prompt 前 40 字，空则回退默认文案） */
    assetName?: string;
    /** V0.3 Phase 6：备用模型名（同类型不同供应商；解析后写入 payload.fallback） */
    fallbackModelName?: string;
    /** V0.3 后续：已由上层（如批量 per-shot 编排）组合好的完整 Prompt，直通不重复组合 */
    precomposed?: ComposedPrompt;
    /** Phase B：参考图 URL（角色一致性）；缺省时按分镜出场角色的参考资产解析 */
    referenceImageUrls?: string[];
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
    // V0.3 Phase 4：项目风格用 StyleResolver 解析出的有效视觉风格（结构化 visualStyle 优先，
    // 无则回退 settings.style 字符串），negative 合并。
    // 若传入 precomposed（per-shot 编排已带场景/角色上下文），则直通，不做二次组合。
    const project = await this.deps.production.getProject(input.projectId);
    const composed = input.precomposed ?? (() => {
      const style = resolveVisualStyle({ project });
      return this.deps.promptComposer.composeImage({
        rawPrompt: prompt,
        projectStyle: visualStyleToPrompt(style),
        negativePrompt: style.negativePrompt,
        projectId: input.projectId,
        providerId,
      });
    })();
    // Phase B：参考图（角色一致性）——显式传入优先，缺省按分镜出场角色的参考资产解析
    const referenceImageUrls =
      input.referenceImageUrls ?? (await this.resolveReferenceImages(input.projectId, input.storyboardId));
    const payload: TaskPayload = {
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
      assetName: input.assetName ?? (prompt.slice(0, 40) || "生成图片"),
      referenceImageUrls: referenceImageUrls.length > 0 ? referenceImageUrls : undefined,
    };
    const fallback = await this.resolveFallbackConfig(input.fallbackModelName, input.userId, ["image"]);
    if (fallback) payload.fallback = fallback;
    if (input.storyboardId) {
      payload.storyboardId = input.storyboardId;
    }
    return this.enqueue({
      projectId: input.projectId,
      userId: input.userId,
      kind: "image",
      payload,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
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
    /** 视频生成方案（economy 最省钱 / balanced 均衡 / quality 高质量）：由系统按档位选模型 */
    plan?: string;
    duration?: number;
    resolution?: string;
    /** Task 1：工作流/节点/分镜透传（写 workflowId/nodeId 列，storyboardId 进 payload） */
    workflowId?: string;
    nodeId?: string;
    storyboardId?: string;
    /** Task 1：覆盖默认资产名（未传则取 prompt 前 40 字，空则回退默认文案） */
    assetName?: string;
    /** V0.3 Phase 6：备用模型名（同类型不同供应商；解析后写入 payload.fallback） */
    fallbackModelName?: string;
    /** V0.3 后续：已由上层（如批量 per-shot 编排）组合好的完整 Prompt，直通不重复组合 */
    precomposed?: ComposedPrompt;
  }): Promise<ProductionTaskView> {
    const prompt = input.prompt?.trim() ?? "";
    if (prompt === "" && !input.imageUrl) {
      throw ERRORS.INVALID_INPUT("prompt 或 imageUrl 至少提供一个");
    }
    // V0.3：生成方案（plan）优先——由系统按档位自动选模型；未指定才走显式 modelName（兼容旧调用）
    const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(
      input.plan ? undefined : input.modelName,
      input.userId,
      ["video"],
      input.plan,
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
    const composed = input.precomposed ?? (() => {
      const style = resolveVisualStyle({ project });
      return this.deps.promptComposer.composeVideo({
        rawPrompt: prompt || undefined,
        imageUrl: input.imageUrl,
        projectStyle: visualStyleToPrompt(style),
        negativePrompt: style.negativePrompt,
        projectId: input.projectId,
        providerId,
      });
    })();
    const payload: TaskPayload = {
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
      assetName: input.assetName ?? (prompt.slice(0, 40) || "生成视频"),
    };
    const fallback = await this.resolveFallbackConfig(input.fallbackModelName, input.userId, ["video"]);
    if (fallback) payload.fallback = fallback;
    if (input.storyboardId) {
      payload.storyboardId = input.storyboardId;
    }
    return this.enqueue({
      projectId: input.projectId,
      userId: input.userId,
      kind: "video",
      payload,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
    });
  }

  // ================= 配音（TTS，Phase C） =================

  /** 配音任务入队（文本校验与模型解析即时反馈；合成在 worker，产物为 audio 资产） */
  async enqueueAudio(input: {
    projectId: string;
    userId: string;
    /** 对白/旁白文本 */
    prompt: string;
    /** 音色名（TTS 模型 voice；缺省供应商默认） */
    voice?: string;
    modelName?: string;
    storyboardId?: string;
    workflowId?: string;
    nodeId?: string;
    assetName?: string;
  }): Promise<ProductionTaskView> {
    const prompt = input.prompt.trim();
    if (prompt === "") {
      throw ERRORS.INVALID_INPUT("prompt 必须提供（对白/旁白文本）");
    }
    const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(
      input.modelName,
      input.userId,
      ["audio"],
    );
    if (!config.model) {
      throw ERRORS.INVALID_INPUT("未配置可用的语音合成模型，请在 Settings 中启用音频模型");
    }
    if (!config.apiKey) {
      throw ERRORS.INVALID_INPUT(`${providerId} 未配置 API Key，请在 Settings 中填写`);
    }
    const payload: TaskPayload = {
      v: 1,
      prompt,
      // 配音不走 Prompt Composer（无画面约束）：组合文本即最终文本
      composedPrompt: prompt,
      voice: input.voice,
      providerId,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      assetName: input.assetName ?? (prompt.slice(0, 40) || "配音"),
    };
    if (input.storyboardId) {
      payload.storyboardId = input.storyboardId;
    }
    return this.enqueue({
      projectId: input.projectId,
      userId: input.userId,
      kind: "audio",
      payload,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
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

  /**
   * Task 1：查询某工作流节点下入队的任务（按创建时间升序）。
   * 返回白名单字段；storyboardId 从 payload JSON 解析（可能缺失）。
   */
  listTasksByNode(
    workflowId: string,
    nodeId: string,
  ): Array<{ id: string; status: string; storyboardId?: string; createdAt: Date }> {
    const rows = this.deps.db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.workflowId, workflowId), eq(tasksTable.nodeId, nodeId)))
      .orderBy(asc(tasksTable.createdAt))
      .all();
    return rows.map((r) => {
      let storyboardId: string | undefined;
      if (r.payload) {
        try {
          storyboardId = (JSON.parse(r.payload) as { storyboardId?: string }).storyboardId;
        } catch {
          storyboardId = undefined;
        }
      }
      return { id: r.id, status: r.status, storyboardId, createdAt: r.createdAt };
    });
  }

  // ================= 内部实现 =================

  /** 落库一条 queued 任务并回读视图（providerId 冗余列供视图展示，与 payload 同源） */
  private async enqueue(input: {
    projectId: string;
    userId: string;
    kind: "image" | "video" | "audio";
    payload: TaskPayload;
    /** Task 1：可选的工作流/节点归属（写预留列） */
    workflowId?: string;
    nodeId?: string;
  }): Promise<ProductionTaskView> {
    const taskId = randomId("ptk");
    const now = new Date();
    this.deps.db
      .insert(tasksTable)
      .values({
        id: taskId,
        projectId: input.projectId,
        userId: input.userId,
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        kind: input.kind,
        providerId: input.payload.providerId,
        status: "queued",
        payload: JSON.stringify(input.payload),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // 工作流生成路径：自动登记生成记录（审核账本）——制作中心按记录审核，
    // 审核节点（review.generation）按任务反查记录裁定是否等待/放行。手工/批量路径不入此。
    if (input.workflowId && input.nodeId) {
      const payload = input.payload;
      await this.deps.production.createGenerationRecord({
        projectId: input.projectId,
        storyboardId: payload.storyboardId,
        kind: input.kind,
        prompt: payload.composedPrompt ?? payload.prompt ?? "",
        negativePrompt: payload.composedNegative,
        promptMetadata: payload.promptMetadata,
        inputRef: payload.imageUrl ? { imageUrl: payload.imageUrl } : undefined,
        taskId,
      });
    }
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
