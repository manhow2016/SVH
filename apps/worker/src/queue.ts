/**
 * 队列核心（spec §4.1）：SQLite 任务表即队列。
 * claim 用单条 `UPDATE … WHERE id IN (SELECT … LIMIT ?) RETURNING` 原子认领，
 * 多 worker 并发安全靠写锁串行化；心跳超时回收僵尸任务。
 */
import { and, eq } from "drizzle-orm";
import { productionTasks, type SVHDatabase } from "@svh/database";

/**
 * 入队时由 server 解析写入的执行参数（v1；含明文 Key，禁止经任务视图外泄）。
 * 与 server 端 `apps/server/src/modules/production/generation-service.ts` 的
 * TaskPayload 手写字面量同形——刻意不跨包 import（经 JSON 契约解耦），改动需双侧同步。
 */
export interface TaskPayload {
  v: number;
  prompt?: string;
  /** V0.3 Phase 2：由 Prompt Composer 组合后的最终提示词（worker 优先使用） */
  composedPrompt?: string;
  composedNegative?: string;
  promptMetadata?: Record<string, unknown>;
  imageUrl?: string;
  size?: string;
  duration?: number;
  resolution?: string;
  /** Task 1：所属分镜（storyboard）id，与 server 端 TaskPayload 同步（纯类型，零逻辑） */
  storyboardId?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  assetName: string;
  /** V0.3 Phase 6：备用供应商配置（primary 失败后回退；无则不回退） */
  fallback?: { providerId: string; model: string; baseUrl: string; apiKey: string };
  /** Phase B：参考图 URL（角色一致性）；仅在适配器声明支持时透传，否则降级 prompt-only */
  referenceImageUrls?: string[];
  /** Phase C：TTS 音色名（角色 voice；缺省供应商默认） */
  voice?: string;
  /**
   * 角色面板方案打标（server 端填）：合并进资产 metadata
   *（svhRole=character_scheme / characterId / batchId / seq）。
   * 与 server 端 generations-service.ts 的 transferMeta 手写字面量同形——经 JSON 契约解耦，改动需双侧同步。
   */
  transferMeta?: Record<string, unknown>;
}

export interface ClaimedTask {
  id: string;
  kind: "image" | "video" | "audio" | "timeline_render";
  projectId: string;
  userId: string;
  providerTaskId: string | null;
  /** 认领时写入的 workerId；handler 每轮自查行 claimed_by 是否仍是它（被 stale 回收接管则让位） */
  claimedBy: string;
  payload: TaskPayload;
}

/**
 * V0.3 Phase 8：时间轴渲染任务载荷（与 server `RenderTaskService` 的
 * TimelineRenderTaskPayload 手写字面量同形——经 JSON 契约解耦，改动需双侧同步）。
 * 含剪辑静态快照：worker 按此渲染，不读当前时间轴（编辑与渲染解耦）。
 */
export interface TimelineRenderTaskPayload {
  v: number;
  timelineId: string;
  projectId: string;
  version: number;
  fps: number;
  width: number;
  height: number;
  clips: Array<{
    clipId: string;
    trackId: string;
    trackType: "video" | "audio" | "subtitle" | "overlay";
    assetId?: string;
    shotId?: string;
    startTime: number;
    duration: number;
    sourceStartTime?: number;
    sourceDuration?: number;
  }>;
}

/** worker 认领的任务类型白名单（Phase 8：timeline_render 成片渲染） */
export const CLAIMABLE_KINDS = ["image", "video", "audio", "timeline_render"] as const;

export function claimTasks(
  db: SVHDatabase,
  workerId: string,
  opts: {
    limit: number;
    staleMs: number;
    now?: number;
    /** provider 并发预算（0 = 不限）：running 中同 provider 任务数达上限即不认领 */
    maxPerProvider?: number;
    /** project 并发预算（0 = 不限）：running 中同 project 任务数达上限即不认领 */
    maxPerProject?: number;
  },
): ClaimedTask[] {
  if (opts.limit <= 0) return [];
  const now = opts.now ?? Date.now();
  const placeholders = CLAIMABLE_KINDS.map(() => "?").join(", ");

  // 分级预算（Phase C 后规模化的公平约束）：子查询按「当前 running 计数」原子过滤，
  // 0 = 不过滤；provider_id 为 NULL 的行归一为空串分组（与老任务共存）。
  const budgetClauses: string[] = [];
  const budgetParams: Array<number> = [];
  if ((opts.maxPerProvider ?? 0) > 0) {
    budgetClauses.push(
      `( SELECT COUNT(*) FROM production_tasks r
           WHERE r.status = 'running'
             AND COALESCE(r.provider_id, '') = COALESCE(t.provider_id, '') ) < ?`,
    );
    budgetParams.push(opts.maxPerProvider!);
  }
  if ((opts.maxPerProject ?? 0) > 0) {
    budgetClauses.push(
      `( SELECT COUNT(*) FROM production_tasks r
           WHERE r.status = 'running' AND r.project_id = t.project_id ) < ?`,
    );
    budgetParams.push(opts.maxPerProject!);
  }

  const rows = db.$client
    .prepare(
      `UPDATE production_tasks
          SET status = 'running', claimed_by = ?, heartbeat_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM production_tasks t
           WHERE kind IN (${placeholders})
             AND payload IS NOT NULL
             AND (status = 'queued'
                  OR (status = 'running'
                      AND (heartbeat_at IS NULL OR heartbeat_at < ?)))
             ${budgetClauses.length > 0 ? `AND ${budgetClauses.join(" AND ")}` : ""}
           ORDER BY created_at
           LIMIT ?)
        RETURNING id, kind, project_id, user_id, provider_task_id, payload`,
    )
    .all(
      workerId, now, now,
      ...CLAIMABLE_KINDS,
      now - opts.staleMs,
      ...budgetParams,
      opts.limit,
    ) as Array<{
      id: string; kind: string; project_id: string; user_id: string;
      provider_task_id: string | null; payload: string | null;
    }>;

  const claimed: ClaimedTask[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload, row.kind);
    if (!payload) {
      // 损坏 payload 显式落终态，避免被反复回收
      finishTask(db, row.id, { status: "failed", error: "任务参数损坏（payload 无法解析）" });
      continue;
    }
    claimed.push({
      id: row.id,
      kind: row.kind as ClaimedTask["kind"],
      projectId: row.project_id,
      userId: row.user_id,
      providerTaskId: row.provider_task_id,
      claimedBy: workerId, // SET claimed_by = ? 即本次认领者
      payload,
    });
  }
  return claimed;
}

function parsePayload(raw: string | null, kind: string): TaskPayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as TaskPayload;
    // 版本守卫：非 v1 载荷按损坏处理（认领后判损坏置 failed，而非不认领）
    if (obj.v !== 1) return null;
    // V0.3 Phase 8：时间轴渲染载荷按 kind 单独校验（无 provider/model 字段）
    if (kind === "timeline_render") {
      return isTimelineRenderPayload(obj) ? obj : null;
    }
    return typeof obj.model === "string" && typeof obj.providerId === "string" ? obj : null;
  } catch {
    return null;
  }
}

/** timeline_render 载荷最小校验（快照必备字段） */
function isTimelineRenderPayload(obj: unknown): obj is TaskPayload {
  if (typeof obj !== "object" || obj === null) return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.timelineId === "string" &&
    typeof p.projectId === "string" &&
    typeof p.version === "number" &&
    typeof p.fps === "number" &&
    typeof p.width === "number" &&
    typeof p.height === "number" &&
    Array.isArray(p.clips)
  );
}

/** 本 worker 全部 running 任务刷心跳（tick 内调用） */
export function heartbeat(db: SVHDatabase, workerId: string, now?: number): void {
  db.$client
    .prepare(`UPDATE production_tasks SET heartbeat_at = ? WHERE claimed_by = ? AND status = 'running'`)
    .run(now ?? Date.now(), workerId);
}

/**
 * 带守卫的 running 推进回写（Task 5 评审 C1）：仅当行**当前仍为 running** 才推进
 * providerTaskId/progress/error——取消落在 provider 往返窗口时，无守卫回写会把
 * cancelled 复活成 running 并跑完落资产。返回 false = 行已失去（取消/接管），调用方立即让位。
 * 注：不校验 claimed_by，认领者归属由 handler 每轮 getTaskClaim 自查负责。
 */
export function updateRunning(
  db: SVHDatabase,
  id: string,
  patch: { progress?: number | null; providerTaskId?: string; error?: string | null },
): boolean {
  const res = db
    .update(productionTasks)
    .set({
      status: "running",
      ...(patch.providerTaskId !== undefined ? { providerTaskId: patch.providerTaskId } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(productionTasks.id, id), eq(productionTasks.status, "running")))
    .returning({ id: productionTasks.id })
    .get();
  return res != null;
}
/**
 * 终态写入：带 `status='running'` 守卫（spec §4.2）——
 * server 已标记 cancelled 时返回 false，调用方放弃覆写（取消竞态收敛点）。
 */
export function finishTask(
  db: SVHDatabase,
  id: string,
  patch: { status: "completed" | "failed" | "cancelled"; outputUrl?: string | null; error?: string | null; progress?: number | null },
): boolean {
  const res = db
    .update(productionTasks)
    .set({
      status: patch.status,
      outputUrl: patch.outputUrl ?? null,
      error: patch.error ?? null,
      progress: patch.progress ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(productionTasks.id, id), eq(productionTasks.status, "running")))
    .returning({ id: productionTasks.id })
    .get();
  return res != null;
}

/** 读状态 + 认领者（handler 每轮自查双要素：仍 running 且未被接管，评审 I1） */
export function getTaskClaim(
  db: SVHDatabase,
  id: string,
): { status: string; claimedBy: string | null } | null {
  const row = db
    .select({ status: productionTasks.status, claimedBy: productionTasks.claimedBy })
    .from(productionTasks)
    .where(eq(productionTasks.id, id))
    .get();
  return row ?? null;
}
