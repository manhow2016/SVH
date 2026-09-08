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
import { buildGenerationPlan, type ProductionShot } from "@svh/production";
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
    for (const item of plan.items) {
      const shot = shots.find((s) => s.id === item.shotId)!;
      if (item.type === "image") {
        const prompt = [shot.action, shot.framing, shot.dialogue].filter(Boolean).join(", ").trim();
        const task = await deps.generationService.enqueueImage({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          prompt: prompt || `镜头${shot.order + 1}画面`,
          storyboardId: item.storyboardId,
        });
        await deps.production.createGenerationRecord({
          projectId: req.params.projectId,
          shotId: item.shotId,
          storyboardId: item.storyboardId,
          kind: "image",
          prompt: prompt || `镜头${shot.order + 1}画面`,
          providerId: task.providerId ?? undefined,
          taskId: task.id,
        });
        tasks.push({ id: item.id, kind: "image", taskId: task.id });
      } else {
        // video（图生视频：首帧来自镜头 imageAssetId）
        const asset = shot.imageAssetId ? await deps.production.getAsset(shot.imageAssetId) : null;
        const prompt = [shot.action, shot.cameraMovement].filter(Boolean).join(", ").trim();
        const task = await deps.generationService.enqueueVideo({
          projectId: req.params.projectId,
          userId: req.user!.userId,
          imageUrl: asset?.url,
          prompt: prompt || undefined,
          storyboardId: item.storyboardId,
        });
        await deps.production.createGenerationRecord({
          projectId: req.params.projectId,
          shotId: item.shotId,
          storyboardId: item.storyboardId,
          kind: "video",
          prompt: prompt || "图生视频",
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
}
