/**
 * 队列核心（spec §4.1）：SQLite 任务表即队列。
 * claim 用单条 `UPDATE … WHERE id IN (SELECT … LIMIT ?) RETURNING` 原子认领，
 * 多 worker 并发安全靠写锁串行化；心跳超时回收僵尸任务。
 */
import { and, eq } from "drizzle-orm";
import { productionTasks, type SVHDatabase } from "@svh/database";

/** 入队时由 server 解析写入的执行参数（v1；含明文 Key，禁止经任务视图外泄） */
export interface TaskPayload {
  v: number;
  prompt?: string;
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

export interface ClaimedTask {
  id: string;
  kind: "image" | "video";
  projectId: string;
  userId: string;
  providerTaskId: string | null;
  /** 认领时写入的 workerId；handler 每轮自查行 claimed_by 是否仍是它（被 stale 回收接管则让位） */
  claimedBy: string;
  payload: TaskPayload;
}

/** worker 认领的任务类型白名单（未来 audio 等注册 handler 后放开） */
export const CLAIMABLE_KINDS = ["image", "video"] as const;

export function claimTasks(
  db: SVHDatabase,
  workerId: string,
  opts: { limit: number; staleMs: number; now?: number },
): ClaimedTask[] {
  if (opts.limit <= 0) return [];
  const now = opts.now ?? Date.now();
  const placeholders = CLAIMABLE_KINDS.map(() => "?").join(", ");
  const rows = db.$client
    .prepare(
      `UPDATE production_tasks
          SET status = 'running', claimed_by = ?, heartbeat_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM production_tasks
           WHERE kind IN (${placeholders})
             AND payload IS NOT NULL
             AND (status = 'queued'
                  OR (status = 'running'
                      AND (heartbeat_at IS NULL OR heartbeat_at < ?)))
           ORDER BY created_at
           LIMIT ?)
        RETURNING id, kind, project_id, user_id, provider_task_id, payload`,
    )
    .all(
      workerId, now, now,
      ...CLAIMABLE_KINDS,
      now - opts.staleMs,
      opts.limit,
    ) as Array<{
      id: string; kind: string; project_id: string; user_id: string;
      provider_task_id: string | null; payload: string | null;
    }>;

  const claimed: ClaimedTask[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
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

function parsePayload(raw: string | null): TaskPayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as TaskPayload;
    return typeof obj.model === "string" && typeof obj.providerId === "string" ? obj : null;
  } catch {
    return null;
  }
}

/** 本 worker 全部 running 任务刷心跳（tick 内调用） */
export function heartbeat(db: SVHDatabase, workerId: string, now?: number): void {
  db.$client
    .prepare(`UPDATE production_tasks SET heartbeat_at = ? WHERE claimed_by = ? AND status = 'running'`)
    .run(now ?? Date.now(), workerId);
}

/** running 期间回写（仅状态推进：providerTaskId / progress / error 暂存） */
export function setTaskRunning(
  db: SVHDatabase,
  id: string,
  patch: {
    progress?: number | null;
    error?: string | null;
    providerTaskId?: string | null;
    /** 接口签名兼容项：本函数语义即置 running，无需显式传 */
    status?: "running";
  },
): void {
  db.update(productionTasks)
    .set({
      status: "running",
      ...(patch.providerTaskId !== undefined ? { providerTaskId: patch.providerTaskId } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(productionTasks.id, id))
    .run();
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

/** 读当前状态（video handler 每轮检测 server 侧取消） */
export function getTaskStatus(db: SVHDatabase, id: string): string | null {
  const row = db
    .select({ status: productionTasks.status })
    .from(productionTasks)
    .where(eq(productionTasks.id, id))
    .get();
  return row?.status ?? null;
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
