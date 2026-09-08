/**
 * 生成节点执行器核心（Task 2）。
 *
 * 职责：让 image.generate / video.generate 节点把分镜批量交给生产队列、等全部
 * 终态、自动绑定资产（spec §3-§7）。
 *
 * 端口化设计：所有外部副作用（读分镜/镜头/资产、入队、查任务、取消、写节点 output）
 * 经 `GenerationNodeDeps` 注入。执行器不依赖 Fastify / 真库 / worker 运行时，
 * 可用假 deps 做单测；真实装配由 `createRealGenerationDeps` 提供（供 app.ts 与
 * 集成测试共用）。worker 保持领域无关，不认识 storyboard；绑定闭环在 server 层完成。
 *
 * 关键语义（严格对齐 spec §4/§5/§6/§7）：
 * 1. 候选分镜（storyboardIds 限定或全项目）→ 逐个规划：跳过 / 收养 / 入队。
 * 2. 幂等权威 = 任务表 (workflowId,nodeId) 查询结果；非 failed/cancelled 即收养、
 *    绝不重复入队；completed 收养即补绑（历史欠账）。
 * 3. 等待循环：每 pollMs 轮询未终态任务；观测到 completed 立即绑定（updateShot），
 *    失败/取消项即时记录；每观测到终态即增量 writeNodeOutput。
 * 4. 任一 failed/cancelled → 节点抛错（成功项绑定不回滚）；abort → 对未终态任务
 *    批量 cancelTask（吞 409/404）并抛「取消」；总预算 maxWaitMs 超时 → 同路径
 *    批量 cancel + 抛「超时」。
 */
import { and, eq, sql } from "drizzle-orm";
import { productionAssets, workflowNodes, type SVHDatabase } from "@svh/database";
import type { WorkflowNode } from "@svh/core";
import type { ProductionAsset, ProductionService } from "@svh/production";
import type { GenerationService } from "./generation-service";
import { ServerError } from "../../lib/errors";

// ================= 端口与类型 =================

export interface GenerationNodeContext {
  projectId: string;
  workflowId: string;
  userId: string;
}

/** 终态状态（spec §3.6 输出 items.status 取值；不含等待期的 running） */
export type GenStatus = "completed" | "failed" | "cancelled" | "timeout" | "skipped";

export interface GenItem {
  taskId: string | null;
  assetId: string | null;
  /** 终态（GenStatus）或等待期的 running；执行中增量写 output 允许 running，终态同形 */
  status: GenStatus | "running";
  /** failed / timeout / skipped 的人读原因 */
  reason?: string;
  boundShotIds: string[];
}

export interface GenerationNodeOutput {
  items: Record<string, GenItem>;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timeout: number;
    skipped: number;
  };
}

/**
 * 生成节点执行器的依赖端口（注入面，供单测 / 真实装配共用）。
 * 形状刻意与外部服务字面量对齐，但只声明执行器实际消费的子集。
 */
export interface GenerationNodeDeps {
  pollMs: number;
  maxWaitMs: number;
  listStoryboards(
    projectId: string,
  ): Promise<
    Array<{
      id: string;
      imagePrompt?: string | null;
      videoPrompt?: string | null;
      status: string;
      duration: number;
      order: number;
      sceneId: string;
      description: string;
    }>
  >;
  listShotsByStoryboard(
    storyboardId: string,
  ): Promise<
    Array<{
      id: string;
      imageAssetId?: string | null;
      videoAssetId?: string | null;
      status: string;
    }>
  >;
  getAsset(id: string): Promise<ProductionAsset>;
  /** 按任务 id 反查产物资产（spec §6：json_extract(generation,'$.taskId')）；找不到返回 null */
  findAssetByTask(taskId: string): Promise<ProductionAsset | null>;
  updateShot(id: string, patch: { imageAssetId?: string; videoAssetId?: string }): Promise<unknown>;
  listAssets(projectId: string, type?: "image" | "video"): Promise<ProductionAsset[]>;
  enqueueImage(input: {
    projectId: string;
    userId: string;
    prompt: string;
    modelName?: string;
    size?: string;
    workflowId?: string;
    nodeId?: string;
    storyboardId?: string;
    assetName?: string;
  }): Promise<{ id: string }>;
  enqueueVideo(input: {
    projectId: string;
    userId: string;
    prompt?: string;
    imageUrl?: string;
    modelName?: string;
    duration?: number;
    resolution?: string;
    workflowId?: string;
    nodeId?: string;
    storyboardId?: string;
    assetName?: string;
  }): Promise<{ id: string }>;
  getTask(id: string): Promise<{ id: string; status: string }>;
  cancelTask(id: string): Promise<void>;
  listTasksByNode(
    workflowId: string,
    nodeId: string,
  ): Array<{ id: string; status: string; storyboardId?: string }>;
  writeNodeOutput(workflowId: string, nodeId: string, output: GenerationNodeOutput): Promise<void>;
}

export interface GenEnqueueMeta {
  workflowId: string;
  nodeId: string;
  storyboardId: string;
  assetName: string;
}

// ================= 内部工具 =================

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 任务的终态判定（worker 回写的 status；queued/running 为在途） */
const TERMINAL_TASK_STATUS = new Set(["completed", "failed", "cancelled"]);

interface PendingItem {
  storyboardId: string;
  taskId: string;
  order: number;
  duration: number;
  sceneId: string;
  description: string;
  imagePrompt: string | null;
  videoPrompt: string | null;
  /** 该 storyboard 全部 shot id（completed 时的绑定目标与 boundShotIds） */
  shotIds: string[];
}

/** 汇总：按终态计数（running 不计入），total = 各终态之和（spec §3.6 同形） */
function summarize(items: Record<string, GenItem>): GenerationNodeOutput {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let timeout = 0;
  let skipped = 0;
  for (const it of Object.values(items)) {
    if (it.status === "completed") succeeded++;
    else if (it.status === "failed") failed++;
    else if (it.status === "cancelled") cancelled++;
    else if (it.status === "timeout") timeout++;
    else if (it.status === "skipped") skipped++;
    // "running"：等待期瞬态，不计入任何计数
  }
  return {
    items,
    summary: {
      total: succeeded + failed + cancelled + timeout + skipped,
      succeeded,
      failed,
      cancelled,
      timeout,
      skipped,
    },
  };
}

/**
 * 观测到任务 completed：反查资产并绑定该 storyboard 全部 shot，记录 boundShotIds。
 * 反查不到资产 → 该条记 failed（reason 人读），不炸整节点（spec §6）。
 */
async function bindAndMarkCompleted(
  deps: GenerationNodeDeps,
  kind: "image" | "video",
  storyboardId: string,
  taskId: string,
  shotIds: string[],
  items: Record<string, GenItem>,
): Promise<void> {
  const asset = await deps.findAssetByTask(taskId);
  if (!asset) {
    items[storyboardId] = {
      taskId,
      assetId: null,
      status: "failed",
      reason: "任务完成但未找到产物资产",
      boundShotIds: [],
    };
    return;
  }
  const patch = kind === "image" ? { imageAssetId: asset.id } : { videoAssetId: asset.id };
  for (const shotId of shotIds) {
    await deps.updateShot(shotId, patch);
  }
  items[storyboardId] = { taskId, assetId: asset.id, status: "completed", boundShotIds: shotIds };
}

/** 处理一条任务终态：completed（绑定）/ failed / cancelled */
async function processTerminal(
  deps: GenerationNodeDeps,
  kind: "image" | "video",
  pendingItem: PendingItem,
  taskStatus: string,
  items: Record<string, GenItem>,
): Promise<void> {
  if (taskStatus === "completed") {
    await bindAndMarkCompleted(
      deps,
      kind,
      pendingItem.storyboardId,
      pendingItem.taskId,
      pendingItem.shotIds,
      items,
    );
    return;
  }
  if (taskStatus === "failed") {
    items[pendingItem.storyboardId] = {
      taskId: pendingItem.taskId,
      assetId: null,
      status: "failed",
      reason: "任务失败（worker 报告错误）",
      boundShotIds: [],
    };
    return;
  }
  if (taskStatus === "cancelled") {
    items[pendingItem.storyboardId] = {
      taskId: pendingItem.taskId,
      assetId: null,
      status: "cancelled",
      reason: "任务已取消",
      boundShotIds: [],
    };
  }
}

/** 取消/超时：对仍为 running 的未终态任务批量 cancelTask，并把条目标记为 cancelled/timeout */
async function settleInFlight(
  deps: GenerationNodeDeps,
  pending: PendingItem[],
  items: Record<string, GenItem>,
  settleKind: "cancelled" | "timeout",
  reason: string,
): Promise<void> {
  for (const p of pending) {
    const it = items[p.storyboardId];
    if (!it || it.status !== "running") continue;
    // createRealGenerationDeps 已吞掉与 worker 竞态的 409/404，这里直接调用
    await deps.cancelTask(p.taskId);
    it.status = settleKind;
    it.reason = reason;
  }
}

// ================= 执行入口 =================

export async function runGenerationNode(opts: {
  ctx: GenerationNodeContext;
  node: WorkflowNode;
  input: unknown;
  signal?: AbortSignal;
  deps: GenerationNodeDeps;
}): Promise<GenerationNodeOutput> {
  const { ctx, node, deps } = opts;
  const kind: "image" | "video" = node.type === "image.generate" ? "image" : "video";
  const input = (opts.input ?? {}) as {
    storyboardIds?: string[];
    regenerateAll?: boolean;
    modelName?: string;
    size?: string;
    duration?: number;
    resolution?: string;
  };

  const items: Record<string, GenItem> = {};
  const write = async (): Promise<void> => {
    await deps.writeNodeOutput(ctx.workflowId, node.id, summarize(items));
  };

  // 1) 候选分镜（storyboardIds 限定或全项目）
  const all = await deps.listStoryboards(ctx.projectId);
  let candidates = all;
  if (input.storyboardIds && input.storyboardIds.length > 0) {
    const ids = new Set(input.storyboardIds);
    candidates = all.filter((s) => ids.has(s.id));
  }

  // 2) 收养既有任务（幂等权威：任务表 (workflowId,nodeId)）
  const existing = new Map<string, { id: string; status: string }>();
  for (const t of deps.listTasksByNode(ctx.workflowId, node.id)) {
    if (t.storyboardId) existing.set(t.storyboardId, { id: t.id, status: t.status });
  }

  // 3) 逐个分镜规划：跳过 / 收养 / 入队
  const pending: PendingItem[] = [];
  for (const sb of candidates) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    const shotIds = shots.map((s) => s.id);
    const bound = shots.every((s) => (kind === "image" ? s.imageAssetId : s.videoAssetId));

    // 已绑对应资产且未开 regenerateAll → 跳过（spec §3.4）
    if (input.regenerateAll !== true && bound && shots.length > 0) {
      items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "已绑定", boundShotIds: [] };
      continue;
    }
    // image：imagePrompt 非空才有资格（spec §3.4）
    if (kind === "image" && !(sb.imagePrompt && sb.imagePrompt.trim())) {
      items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "无可用提示", boundShotIds: [] };
      continue;
    }
    // video：videoPrompt 非空 或 任一 shot 已绑 imageAssetId（图生视频）
    if (kind === "video") {
      const hasPrompt = sb.videoPrompt && sb.videoPrompt.trim();
      const hasImg = shots.some((s) => s.imageAssetId);
      if (!hasPrompt && !hasImg) {
        items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "无可用提示", boundShotIds: [] };
        continue;
      }
    }

    const adopted = existing.get(sb.id);
    if (adopted && adopted.status !== "failed" && adopted.status !== "cancelled") {
      // 收养：completed 立即补绑（不再等待），queued/running 进等待集合（spec §5）
      if (adopted.status === "completed") {
        await bindAndMarkCompleted(deps, kind, sb.id, adopted.id, shotIds, items);
        continue;
      }
      pending.push({
        storyboardId: sb.id,
        taskId: adopted.id,
        order: sb.order,
        duration: sb.duration,
        sceneId: sb.sceneId,
        description: sb.description,
        imagePrompt: sb.imagePrompt ?? null,
        videoPrompt: sb.videoPrompt ?? null,
        shotIds,
      });
      items[sb.id] = { taskId: adopted.id, assetId: null, status: "running", boundShotIds: [] };
      continue;
    }

    // 入队新任务
    const assetName = `${kind === "image" ? "分镜" + sb.order + "·画面" : "分镜" + sb.order + "·动态"}`;
    let taskId: string;
    if (kind === "image") {
      taskId = (
        await deps.enqueueImage({
          projectId: ctx.projectId,
          userId: ctx.userId,
          prompt: sb.imagePrompt!,
          modelName: input.modelName,
          size: input.size,
          workflowId: ctx.workflowId,
          nodeId: node.id,
          storyboardId: sb.id,
          assetName,
        })
      ).id;
    } else {
      const imgShot = shots.find((s) => s.imageAssetId);
      let imageUrl: string | undefined;
      if (imgShot?.imageAssetId) {
        const asset = await deps.getAsset(imgShot.imageAssetId);
        imageUrl = asset.url;
      }
      taskId = (
        await deps.enqueueVideo({
          projectId: ctx.projectId,
          userId: ctx.userId,
          prompt: sb.videoPrompt ?? undefined,
          imageUrl,
          modelName: input.modelName,
          duration: input.duration ?? sb.duration,
          resolution: input.resolution,
          workflowId: ctx.workflowId,
          nodeId: node.id,
          storyboardId: sb.id,
          assetName,
        })
      ).id;
    }
    items[sb.id] = { taskId, assetId: null, status: "running", boundShotIds: [] };
    pending.push({
      storyboardId: sb.id,
      taskId,
      order: sb.order,
      duration: sb.duration,
      sceneId: sb.sceneId,
      description: sb.description,
      imagePrompt: sb.imagePrompt ?? null,
      videoPrompt: sb.videoPrompt ?? null,
      shotIds,
    });
  }

  // 无任何待生成/待收养的可执行项（全部跳过或空）→ 0 扇出抛错（spec §4.2）
  const hasWork = Object.values(items).some((it) => it.status !== "skipped");
  if (!hasWork) {
    throw new Error("无合格分镜可生成（检查提示词/绑定/重跑范围）");
  }
  await write();

  // 4) 等待循环：轮询未终态任务；每观测到终态立即处理并增量 write
  const deadline = Date.now() + deps.maxWaitMs;
  let phase: "waiting" | "abort" | "timeout" = "waiting";
  for (;;) {
    if (opts.signal?.aborted) {
      phase = "abort";
      break;
    }
    const inflight = pending.filter((p) => items[p.storyboardId]?.status === "running");
    if (inflight.length === 0) {
      phase = "waiting";
      break;
    }
    if (Date.now() > deadline) {
      phase = "timeout";
      break;
    }
    await sleep(deps.pollMs);
    let changed = false;
    for (const p of inflight) {
      const t = await deps.getTask(p.taskId);
      if (!TERMINAL_TASK_STATUS.has(t.status)) continue;
      await processTerminal(deps, kind, p, t.status, items);
      changed = true;
    }
    if (changed) await write();
  }

  // 取消 / 超时：对未终态任务批量 cancel（吞 409/404），并抛错
  if (phase === "abort") {
    await settleInFlight(deps, pending, items, "cancelled", "节点取消");
    await write();
    throw new Error("生成节点已取消（abort）");
  }
  if (phase === "timeout") {
    await settleInFlight(deps, pending, items, "timeout", "节点超时");
    await write();
    throw new Error(`生成节点超时（等待全部任务终态超时，超过 ${deps.maxWaitMs}ms）`);
  }

  // 5) 收尾：全部终态。任何 failed/cancelled → 节点失败；成功项绑定不回滚（spec §4）
  const failures = Object.values(items).filter(
    (it) => it.status === "failed" || it.status === "cancelled",
  );
  if (failures.length > 0) {
    const failedCount = failures.filter((it) => it.status === "failed").length;
    const cancelledCount = failures.length - failedCount;
    throw new Error(
      `生成节点失败：${failedCount} 项失败，${cancelledCount} 项取消（成功项已绑定保留）`,
    );
  }
  return summarize(items);
}

// ================= 真实装配（app.ts 与集成测试共用） =================

export function createRealGenerationDeps(opts: {
  db: SVHDatabase;
  production: ProductionService;
  generationService: GenerationService;
  pollMs: number;
  maxWaitMs: number;
}): GenerationNodeDeps {
  const { db, production, generationService } = opts;
  return {
    pollMs: opts.pollMs,
    maxWaitMs: opts.maxWaitMs,
    listStoryboards: (projectId) => production.listStoryboards(projectId),
    listShotsByStoryboard: (sid) => production.listShotsByStoryboard(sid),
    getAsset: (id) => production.getAsset(id),
    findAssetByTask: (taskId) => {
      const row = db
        .select()
        .from(productionAssets)
        .where(sql`json_extract(${productionAssets.generation}, '$.taskId') = ${taskId}`)
        .get();
      if (!row) return Promise.resolve(null);
      // 行 → 领域实体（null → undefined，与 DrizzleProductionRepository.toAsset 同口径）
      return Promise.resolve({
        ...row,
        type: row.type as ProductionAsset["type"],
        url: row.url ?? undefined,
        workspacePath: row.workspacePath ?? undefined,
        mimeType: row.mimeType ?? undefined,
        metadata: row.metadata ?? undefined,
        generation: row.generation ?? undefined,
      });
    },
    updateShot: (id, patch) => production.updateShot(id, patch),
    listAssets: (projectId, type) => production.listAssets(projectId, type),
    enqueueImage: (i) => generationService.enqueueImage(i),
    enqueueVideo: (i) => generationService.enqueueVideo(i),
    getTask: (id) => Promise.resolve(generationService.getTask(id)),
    // 与 worker 竞态：终态/并发已终结时抛 409/404 —— 吞掉视为已收敛（spec §7）
    cancelTask: async (id) => {
      try {
        await generationService.cancelTask(id);
      } catch (e) {
        if (!(e instanceof ServerError && (e.status === 409 || e.status === 404))) throw e;
      }
    },
    listTasksByNode: (wf, node) => generationService.listTasksByNode(wf, node),
    writeNodeOutput: async (wf, node, output) => {
      db.update(workflowNodes)
        .set({ output, updatedAt: new Date() })
        .where(and(eq(workflowNodes.workflowId, wf), eq(workflowNodes.nodeId, node)))
        .run();
    },
  };
}
