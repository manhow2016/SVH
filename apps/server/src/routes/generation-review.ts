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
  type GenerationRecord,
  type ProductionShot,
} from "@svh/production";
import type { ProductionService } from "@svh/production";
import type { GenerationService } from "../modules/production/generation-service";
import type { WorkflowService } from "../modules/production/workflow-service";
import type { WorkspaceService } from "../modules/workspace/service";
import { ERRORS } from "../lib/errors";

export interface GenerationReviewRouteDeps {
  production: ProductionService;
  generationService: GenerationService;
  workflowService: WorkflowService;
  workspaceService: WorkspaceService;
}

export function registerGenerationReviewRoutes(app: FastifyInstance, deps: GenerationReviewRouteDeps): void {
  const assertProjectOwned = async (projectId: string, userId: string): Promise<void> => {
    const project = await deps.production.getProject(projectId);
    await deps.workspaceService.getOwned(project.workspaceId, userId);
  };

  /**
   * 对账（建议 3）：记录 status=queued 但对应任务已终态 completed → 自动补写
   * status=completed + outputAssetId（按任务反查产物资产）。
   * 消除「worker 回写失败导致审核按钮永久不可用」的隐性故障。返回是否有变更。
   */
  const reconcileRecords = async (records: GenerationRecord[]): Promise<boolean> => {
    let changed = false;
    for (const record of records) {
      if (record.status !== "queued" || !record.taskId) continue;
      let task;
      try {
        task = deps.generationService.getTask(record.taskId);
      } catch {
        continue; // 任务不存在：跳过
      }
      if (task.status !== "completed") continue;
      const asset = await deps.production.findAssetByTask(record.taskId);
      if (!asset) continue;
      await deps.production.markGenerationRecordsCompletedByTask(record.taskId, asset.id);
      changed = true;
    }
    return changed;
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
    const filter = {
      shotId: req.query.shotId,
      storyboardId: req.query.storyboardId,
      kind: req.query.kind as "image" | "video" | undefined,
      reviewStatus,
    };
    const records = await deps.production.listGenerationRecords(req.params.projectId, filter);
    if (await reconcileRecords(records)) {
      return deps.production.listGenerationRecords(req.params.projectId, filter);
    }
    return records;
  });

  // 列出某镜头的生成版本（v1/v2/v3…）
  app.get<{ Params: { id: string } }>("/api/shots/:id/generations", async (req) => {
    const shot = await deps.production.getShot(req.params.id);
    await assertProjectOwned(shot.projectId, req.user!.userId);
    const records = await deps.production.listGenerationsByShot(req.params.id);
    if (await reconcileRecords(records)) {
      return deps.production.listGenerationsByShot(req.params.id);
    }
    return records;
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

  // ================= 批量审核（Phase D：按 scope 一键通过/拒绝） =================

  /**
   * 按 scope 批量审核：对每个镜头的「最新已完成且未裁定」记录执行 approve/reject。
   * scope 语义与批量生成一致（shotIds > storyboardId > sceneId > 全项目）；
   * 可能触发等待中工作流自动续跑（resumeWaiting）。
   */
  app.post<{
    Params: { projectId: string };
    Body: { scope?: { shotIds?: string[]; storyboardId?: string; sceneId?: string }; action?: string };
  }>("/api/projects/:projectId/generations/batch-review", async (req) => {
    await assertProjectOwned(req.params.projectId, req.user!.userId);
    const action = req.body?.action;
    if (action !== "approve" && action !== "reject") {
      throw ERRORS.INVALID_INPUT("action 必须为 approve 或 reject");
    }
    const { shots, scopeKey } = await resolveShotsForScope(req.params.projectId, req.body?.scope ?? {});
    if (shots.length === 0) {
      throw ERRORS.INVALID_INPUT("该范围内没有镜头");
    }
    let affected = 0;
    const results: Array<{ shotId: string; kind: string; reviewStatus: string }> = [];
    for (const shot of shots) {
      const records = await deps.production.listGenerationsByShot(shot.id);
      // 最新已完成且未裁定的记录（pending/generating/generated/reviewing）
      const candidate = records
        .filter(
          (r) =>
            r.status === "completed" &&
            r.reviewStatus !== "approved" &&
            r.reviewStatus !== "rejected" &&
            r.reviewStatus !== "replaced",
        )
        .sort((a, b) => b.version - a.version)[0];
      if (!candidate) continue;
      const updated =
        action === "approve"
          ? await deps.production.approveGeneration(candidate.id)
          : await deps.production.rejectGeneration(candidate.id);
      affected += 1;
      results.push({ shotId: shot.id, kind: candidate.kind, reviewStatus: updated.reviewStatus });
    }
    await resumeWaiting(req.params.projectId);
    return { projectId: req.params.projectId, scopeKey, action, affected, results };
  });

  // ================= 审核动作 =================

  /** 审核动作后尝试续跑该项目等待人工审核的工作流（幂等；未裁定完全会再次挂起） */
  const resumeWaiting = async (projectId: string): Promise<void> => {
    try {
      await deps.workflowService.resumeWaitingWorkflows(projectId);
    } catch (err) {
      // 续跑失败不改变审核结果，仅留痕
      app.log.warn({ projectId, error: (err as Error).message }, "审核后续跑等待工作流失败");
    }
  };

  app.post<{ Params: { id: string } }>("/api/generations/:id/approve", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    const updated = await deps.production.approveGeneration(req.params.id);
    await resumeWaiting(record.projectId);
    return updated;
  });

  app.post<{ Params: { id: string } }>("/api/generations/:id/reject", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    const updated = await deps.production.rejectGeneration(req.params.id);
    await resumeWaiting(record.projectId);
    return updated;
  });

  app.post<{ Params: { id: string }; Body: { assetId?: string } }>("/api/generations/:id/replace", async (req) => {
    const record = await deps.production.getGenerationRecord(req.params.id);
    await assertProjectOwned(record.projectId, req.user!.userId);
    const assetId = req.body?.assetId;
    if (!assetId) {
      throw ERRORS.INVALID_INPUT("assetId 必须提供");
    }
    const updated = await deps.production.replaceGeneration(req.params.id, assetId);
    await resumeWaiting(record.projectId);
    return updated;
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
      await resumeWaiting(record.projectId);
      return { record: regen, task };
    },
  );
}
