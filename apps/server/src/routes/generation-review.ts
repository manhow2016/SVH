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
