/**
 * 生成审核 / 版本路由（V0.3 Phase 5）。
 *
 * 供 UI/客户端对「一次生成」进行审核与版本查看：
 * - 创建生成记录（登记一次生成意图；生成执行仍走既有入队链路）
 * - 按项目 / 镜头列出生成记录与版本
 * - approve / reject / replace（审核动作；approve 会把该镜头选中资产指向产出）
 *
 * 与并行「工作流生成节点」扇出/绑定互补：本表是生成历史 + 审核账本。
 */
import type { FastifyInstance } from "fastify";
import {
  buildGenerationPlan,
  DefaultPromptComposer,
  resolveVisualStyle,
  toCharacterPromptSnippets,
  visualStyleToPrompt,
  type ComposedPrompt,
  type ProductionShot,
} from "@svh/production";
import type { ProductionService } from "@svh/production";
import type { GenerationService } from "../modules/production/generation-service";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface GenerationReviewRouteDeps {
  production: ProductionService;
  generationService: GenerationService;
  workspaceService: WorkspaceService;
}

export function registerGenerationReviewRoutes(app: FastifyInstance, deps: GenerationReviewRouteDeps): void {
  const assertProjectOwned = async (projectId: string, userId: string): Promise<void> => {
    const project = await deps.production.getProject(projectId);
    await deps.workspaceService.getOwned(project.workspaceId, userId);
  };

  // 创建生成记录（登记一次生成意图）
  app.post<{
    Params: { projectId: string };
    Body: {
      shotId?: string;
      storyboardId?: string;
      kind?: string;
      prompt?: string;
      negativePrompt?: string;
      promptMetadata?: Record<string, unknown>;
      inputRef?: { imageUrl?: string };
    };
  }>("/api/projects/:projectId/generations", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    const kind = req.body?.kind;
    if (kind !== "image" && kind !== "video") {
      throw ERRORS.INVALID_INPUT("kind 必须为 image 或 video");
    }
    const prompt = req.body?.prompt?.trim() ?? "";
    if (prompt === "") {
      throw ERRORS.INVALID_INPUT("prompt 必须提供");
    }
    return deps.production.createGenerationRecord({
      projectId: req.params.projectId,
      shotId: req.body?.shotId,
      storyboardId: req.body?.storyboardId,
      kind,
      prompt,
      negativePrompt: req.body?.negativePrompt,
      promptMetadata: req.body?.promptMetadata,
      inputRef: req.body?.inputRef,
    });
  });

  // 列出项目的生成记录（可按 shot/storyboard/kind/reviewStatus 过滤）
  app.get<{
    Params: { projectId: string };
    Querystring: { shotId?: string; storyboardId?: string; kind?: string; reviewStatus?: string };
  }>("/api/projects/:projectId/generations", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    const reviewStatus = req.query.reviewStatus as "pending" | "generating" | "generated" | "reviewing" | "approved" | "rejected" | "replaced" | undefined;
    return deps.production.listGenerationRecords(req.params.projectId, {
      shotId: req.query.shotId,
      storyboardId: req.query.storyboardId,
      kind: req.query.kind as "image" | "video" | undefined,
      reviewStatus,
    });
  });

  // 列出某镜头的生成版本（v1/v2/v3…）
  app.get<{ Params: { id: string } }>("/api/shots/:id/generations", async (req) => {
    const shot = await deps.production.getShot(req.params.id);
    await assertProjectOwned(shot.projectId, req.user!.userId);
    return deps.production.listGenerationsByShot(req.params.id);
  });

  // ================= 批量生成（V0.3 Phase 6：计划 → 入队） =================

  /**
   * 解析给定 scope 的镜头集合：shotIds > storyboardId > sceneId > 全项目。
   * 返回按 order 排序的镜头。
   */
  const resolveShotsForScope = async (projectId: string, scope: {
    shotIds?: string[];
    storyboardId?: string;
    sceneId?: string;
  }): Promise<{ shots: ProductionShot[]; scopeKey: "shotIds" | "storyboardId" | "sceneId" | "project" }> => {
    if (scope.shotIds && scope.shotIds.length > 0) {
      const shots = await Promise.all(scope.shotIds.map((id) => deps.production.getShot(id)));
      return { shots, scopeKey: "shotIds" };
    }
    if (scope.storyboardId) {
      const shots = await deps.production.listShotsByStoryboard(scope.storyboardId);
      return { shots, scopeKey: "storyboardId" };
    }
    if (scope.sceneId) {
      const storyboards = await deps.production.listStoryboardsByScene(scope.sceneId);
      const shots = (
        await Promise.all(storyboards.map((sb) => deps.production.listShotsByStoryboard(sb.id)))
      ).flat();
      return { shots, scopeKey: "sceneId" };
    }
    const shots = await deps.production.listShots(projectId);
    return { shots, scopeKey: "project" };
  };

  /**
   * 批量生成：按 scope 构建 GenerationPlan，并逐项经 GenerationService 入队，
   * 同时登记 generation_record（审核账本）。返回计划（含 item 对应的 taskId）。
   */
  app.post<{
    Params: { projectId: string };
    Body: { scope?: { shotIds?: string[]; storyboardId?: string; sceneId?: string }; includeVideo?: boolean };
  }>("/api/projects/:projectId/generations/batch", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    const scope = req.body?.scope ?? {};
    const { shots, scopeKey } = await resolveShotsForScope(req.params.projectId, scope);
    if (shots.length === 0) {
      throw ERRORS.INVALID_INPUT("该范围内没有待生成的镜头");
    }
    const plan = buildGenerationPlan(req.params.projectId, shots, scope, {
      includeVideo: req.body?.includeVideo,
    });

    const tasks: Array<{ id: string; kind: string; taskId?: string }> = [];
    // per-shot 上下文组合（V0.3 后续）：把镜头/场景/角色 Anchor + 风格完整传入 Composer
    const composer = new DefaultPromptComposer();
    const composeShotPrompt = async (
      kind: "image" | "video",
      shot: ProductionShot,
    ): Promise<ComposedPrompt> => {
      const project = await deps.production.getProject(req.params.projectId);
      const storyboard = await deps.production.getStoryboard(shot.storyboardId);
      let scene;
      if (storyboard.sceneId) {
        scene = await deps.production.getScene(storyboard.sceneId);
      }
      const sceneSnippet = scene
        ? { description: scene.description, location: scene.location, time: scene.time, visualPrompt: scene.visualStyle?.visualPrompt }
        : undefined;
      const charIds = scene?.characters ?? [];
      const characters = (
        await Promise.all(charIds.map((id) => deps.production.getCharacter(id).catch(() => null)))
      ).filter((c): c is NonNullable<typeof c> => Boolean(c));
      const charSnippets = toCharacterPromptSnippets(characters);
      const style = resolveVisualStyle({ project, scene: scene ?? undefined, shot });
      const shotSnippet = {
        description: [shot.action, shot.framing].filter(Boolean).join(", ").trim() || undefined,
        action: shot.action,
        framing: shot.framing,
        cameraMovement: shot.cameraMovement,
        dialogue: shot.dialogue,
      };
      const base = {
        projectStyle: visualStyleToPrompt(style),
        negativePrompt: style.negativePrompt,
        scene: sceneSnippet,
        characters: charSnippets,
        shot: shotSnippet,
        projectId: req.params.projectId,
        shotId: shot.id,
        sceneId: storyboard.sceneId,
        characterIds: charIds,
      };
      if (kind === "image") {
        const rawPrompt = [shot.action, shot.framing, shot.dialogue].filter(Boolean).join(", ").trim();
        return composer.composeImage({ ...base, rawPrompt: rawPrompt || `镜头${shot.order + 1}画面` });
      }
      const assetUrl = shot.imageAssetId
        ? (await deps.production.getAsset(shot.imageAssetId).catch(() => null))?.url
        : undefined;
      const rawPrompt = [shot.action, shot.cameraMovement].filter(Boolean).join(", ").trim();
      return composer.composeVideo({
        ...base,
        imageUrl: assetUrl,
        rawPrompt: rawPrompt || undefined,
        actionPrompt: shot.action,
      });
    };

    for (const item of plan.items) {
      const shot = shots.find((s) => s.id === item.shotId)!;
      if (item.type === "image") {
        const composed = await composeShotPrompt("image", shot);
        const task = await deps.generationService.enqueueImage({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt: composed.prompt || `镜头${shot.order + 1}画面`,
          storyboardId: item.storyboardId,
          precomposed: composed,
        });
        await deps.production.createGenerationRecord({
          projectId: req.params.projectId,
          shotId: item.shotId,
          storyboardId: item.storyboardId,
          kind: "image",
          prompt: composed.prompt,
          negativePrompt: composed.negativePrompt,
          promptMetadata: composed.metadata as unknown as Record<string, unknown>,
          providerId: task.providerId ?? undefined,
          taskId: task.id,
        });
        tasks.push({ id: item.id, kind: "image", taskId: task.id });
      } else {
        const composed = await composeShotPrompt("video", shot);
        const task = await deps.generationService.enqueueVideo({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          imageUrl: shot.imageAssetId ? (await deps.production.getAsset(shot.imageAssetId).catch(() => null))?.url : undefined,
          prompt: composed.prompt || undefined,
          storyboardId: item.storyboardId,
          precomposed: composed,
        });
        await deps.production.createGenerationRecord({
          projectId: req.params.projectId,
          shotId: item.shotId,
          storyboardId: item.storyboardId,
          kind: "video",
          prompt: composed.prompt || "图生视频",
          negativePrompt: composed.negativePrompt,
          promptMetadata: composed.metadata as unknown as Record<string, unknown>,
          providerId: task.providerId ?? undefined,
          taskId: task.id,
        });
        tasks.push({ id: item.id, kind: "video", taskId: task.id });
      }
    }
    return { projectId: req.params.projectId, scopeKey, plan, items: tasks };
  });

  // ================= 审核动作 =================

  app.post<{ Params: { id: string } }>("/api/generations/:id/approve", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    return deps.production.approveGeneration(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/generations/:id/reject", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    return deps.production.rejectGeneration(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { assetId?: string } }>("/api/generations/:id/replace", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    const assetId = req.body?.assetId;
    if (!assetId) {
      throw ERRORS.INVALID_INPUT("assetId 必须提供");
    }
    return deps.production.replaceGeneration(req.params.id, assetId);
  });

  /**
   * 重新生成（V0.3 Phase 5 + 后续）：基于既有生成记录创建 v+1 版本并入队。
   * 可用 body.prompt/negativePrompt 覆盖最终 Prompt（否则沿用原记录）。
   */
  app.post<{ Params: { id: string }; Body: { prompt?: string; negativePrompt?: string } }>(
    "/api/generations/:id/regenerate",
    async (req) => {
      const record = await deps.production.getGenerationRecord(req.params.id);
      await assertProjectOwned(record.projectId, req.user!.userId);
      const newPrompt = req.body?.prompt?.trim() ?? record.prompt;
      if (newPrompt === "") {
        throw ERRORS.INVALID_INPUT("prompt 不能为空");
      }
      const composed: ComposedPrompt = {
        prompt: newPrompt,
        negativePrompt: req.body?.negativePrompt?.trim() ?? record.negativePrompt,
        metadata: (record.promptMetadata ?? { templateId: "default" }) as unknown as ComposedPrompt["metadata"],
      };
      const userId = req.user!.userId;
      const task =
        record.kind === "image"
          ? await deps.generationService.enqueueImage({
              projectId: record.projectId,
              userId,
              prompt: newPrompt,
              storyboardId: record.storyboardId,
              precomposed: composed,
            })
          : await deps.generationService.enqueueVideo({
              projectId: record.projectId,
              userId,
              prompt: newPrompt,
              imageUrl: record.inputRef?.imageUrl,
              storyboardId: record.storyboardId,
              precomposed: composed,
            });
      const regen = await deps.production.createGenerationRecord({
        projectId: record.projectId,
        shotId: record.shotId,
        storyboardId: record.storyboardId,
        kind: record.kind,
        prompt: newPrompt,
        negativePrompt: composed.negativePrompt,
        promptMetadata: composed.metadata as unknown as Record<string, unknown>,
        inputRef: record.inputRef,
        providerId: task.providerId ?? undefined,
        taskId: task.id,
      });
      return { record: regen, task };
    },
  );
}
