/**
 * 任务处理器（spec §4.2/§4.3）：payload → Provider → 资产落库 → 终态。
 * 所有异常内吞并落 task 终态——worker 主循环永不因单任务崩溃。
 *
 * 回写纪律（Task 5 评审 C1/I1）：
 * - running 推进一律走带守卫的 updateRunning（行非 running 即拒，取消不被复活）；
 * - 每次 await provider 往返后、写终态前都做「归属自查」：
 *   行仍 running 且 claimed_by 未被接管才允许写，否则静默让位不覆写。
 */
import type { SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import {
  createImageProvider,
  createVideoProvider,
  type ImageProvider,
  type ModelConfig,
  type VideoProvider,
  type VideoTask,
} from "@svh/providers";
import { finishTask, getTaskClaim, updateRunning, type ClaimedTask, type TaskPayload } from "./queue";

export interface HandlerDeps {
  pollIntervalMs: number;
  /** 供应商工厂（测试注入假实现；缺省走 providers 包路由工厂） */
  imageProviderFactory?: (p: TaskPayload) => ImageProvider;
  videoProviderFactory?: (p: TaskPayload) => VideoProvider;
  /** 定时器（测试注入 0ms） */
  sleep?: (ms: number) => Promise<void>;
  /** 视频任务最长等待（缺省 15 分钟） */
  maxWaitMs?: number;
  /** 观测日志（守卫拒绝覆写等让位场景），缺省 console */
  log?: (msg: string) => void;
}

/** getTask 连续瞬态异常容忍阈值（达到即 failed） */
const MAX_GET_ERRORS = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toConfig(p: TaskPayload): ModelConfig {
  return { providerId: p.providerId, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey };
}

export function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}

/**
 * payload 防御（Task 4 评审承传）：queue.parsePayload 校验较弱，
 * 执行前再核对必要字段，缺失即快速失败，绝不带残缺参数发网络请求。
 * 视频允许无 prompt（图生视频）；assetName 直接进资产表，必须非空。
 */
function payloadIncomplete(kind: ClaimedTask["kind"], p: TaskPayload): boolean {
  const s = (v: unknown): boolean => typeof v === "string" && v !== "";
  if (!s(p.providerId) || !s(p.model) || !s(p.apiKey) || !s(p.assetName)) return true;
  return kind === "image" && !s(p.prompt);
}

/**
 * 归属自查：行仍为 running 且 claimed_by 未被接管才允许继续推进/写终态。
 * 基准统一取 `task.claimedBy`（认领时 claim 写入的本 worker id；生产链路与
 * config.workerId 恒等，取自行数据可免去 deps 透传）。
 */
function stillOwnsRow(db: SVHDatabase, task: ClaimedTask): boolean {
  const claim = getTaskClaim(db, task.id);
  return claim !== null && claim.status === "running" && claim.claimedBy === task.claimedBy;
}

/** 写终态；被守卫拒绝（server 已取消/已被接管）时记日志说明让位（评审 Minor14） */
function finishLogged(
  db: SVHDatabase,
  task: ClaimedTask,
  patch: Parameters<typeof finishTask>[2],
  log: (msg: string) => void,
): void {
  if (!finishTask(db, task.id, patch)) {
    log(`任务 ${task.id} 写终态 ${patch.status} 被守卫拒绝：行已取消或被接管，让位不覆写`);
  }
}

/** 分发入口：主循环唯一调用点 */
export async function runTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(`[worker] ${m}`));
  try {
    if (task.kind !== "image" && task.kind !== "video") {
      finishLogged(db, task, { status: "failed", error: `暂不支持的任务类型：${task.kind}` }, log);
      return;
    }
    if (payloadIncomplete(task.kind, task.payload)) {
      finishLogged(db, task, { status: "failed", error: "任务参数不完整" }, log);
      return;
    }
    if (task.kind === "image") return await runImageTask(db, production, task, deps, log);
    return await runVideoTask(db, production, task, deps, log);
  } catch (err) {
    // 异常兜底同样受归属自查约束：已被接管则让位，不覆写新认领者的行
    if (!stillOwnsRow(db, task)) {
      log(`任务 ${task.id} 异常收尾时已失去归属，让位不写终态：${errMessage(err)}`);
      return;
    }
    finishLogged(db, task, { status: "failed", error: errMessage(err) }, log);
  }
}

async function runImageTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const p = task.payload;
  if (!stillOwnsRow(db, task)) return; // 认领后立即被取消/接管
  const provider =
    deps.imageProviderFactory?.(p) ?? createImageProvider({ providerId: p.providerId, config: toConfig(p) });
  const result = await provider.generate({ model: p.model, prompt: p.prompt ?? "", size: p.size });
  const first = result.images[0];
  if (!first || (!first.url && !first.b64Json)) {
    finishLogged(db, task, { status: "failed", error: "供应商未返回图片" }, log);
    return;
  }
  await production.createAsset({
    projectId: task.projectId,
    type: "image",
    name: p.assetName,
    url: first.url,
    mimeType: "image/png",
    metadata: first.b64Json ? { b64Json: first.b64Json } : undefined,
    generation: { providerId: p.providerId, modelId: p.model, prompt: p.prompt, taskId: task.id },
  });
  // 写终态前归属自查（评审 C1/I1）：生成往返期间被取消/接管 → 让位（资产已真实生成，保留）
  if (!stillOwnsRow(db, task)) {
    log(`图片任务 ${task.id} 资产已落库但失去归属（取消/接管），让位不写终态`);
    return;
  }
  finishLogged(db, task, { status: "completed", outputUrl: first.url ?? null, progress: 100 }, log);
}

async function runVideoTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const p = task.payload;
  const provider =
    deps.videoProviderFactory?.(p) ?? createVideoProvider({ providerId: p.providerId, config: toConfig(p) });
  const sleep = deps.sleep ?? defaultSleep;

  /** 行失去归属的统一收口：server 取消则尽力取消供应商任务（防孤儿扣费），否则静默让位 */
  const abandon = async (providerTaskId: string, why: string): Promise<void> => {
    log(`视频任务 ${task.id} ${why}，让位退出`);
    if (getTaskClaim(db, task.id)?.status === "cancelled") {
      try {
        await provider.cancelTask(providerTaskId);
      } catch {
        /* best-effort（spec §4.3） */
      }
    }
  };

  // 入口自查（评审 Minor6）：行已 cancelled 且带 providerTaskId → 尽力取消；被接管/非 running → 静默让位
  const entry = getTaskClaim(db, task.id);
  if (!entry || entry.status !== "running" || entry.claimedBy !== task.claimedBy) {
    if (entry?.status === "cancelled" && task.providerTaskId) {
      await abandon(task.providerTaskId, "入口自查发现已取消");
    }
    return;
  }

  let providerTaskId = task.providerTaskId; // stale 回收接管时已有：续轮询，不重复扣费
  if (!providerTaskId) {
    const handle = await provider.createTask({
      model: p.model,
      prompt: p.prompt || undefined,
      imageUrl: p.imageUrl,
      duration: p.duration,
      resolution: p.resolution,
    });
    providerTaskId = handle.providerTaskId;
    // 守卫回写（探针A）：createTask 往返窗口内被取消/接管 → 拒绝覆写，并尽力取消刚提交的任务（防孤儿扣费）
    if (!updateRunning(db, task.id, { providerTaskId })) {
      await abandon(providerTaskId, "providerTaskId 回写被拒（往返窗口内取消/接管）");
      return;
    }
  }

  const started = Date.now();
  let getErrors = 0; // getTask 连续瞬态异常计数（成功一轮即清零）
  for (;;) {
    await sleep(deps.pollIntervalMs);
    const claim = getTaskClaim(db, task.id);
    if (!claim) return; // 行已不存在：无事可做
    if (claim.status === "cancelled") {
      try {
        await provider.cancelTask(providerTaskId);
      } catch {
        /* best-effort（spec §4.3） */
      }
      return;
    }
    // 认领者自查（评审 I1）：非 running（被写终态）或 claimed_by 被接管 → 静默让位
    if (claim.status !== "running" || claim.claimedBy !== task.claimedBy) return;

    let t: VideoTask;
    try {
      t = await provider.getTask(providerTaskId);
      getErrors = 0;
    } catch (err) {
      // 单轮网络异常容忍（评审 Minor8）：<3 连续下轮重试，≥3 判失败
      getErrors += 1;
      if (getErrors >= MAX_GET_ERRORS) {
        finishLogged(
          db,
          task,
          { status: "failed", error: `供应商轮询连续 ${MAX_GET_ERRORS} 次异常：${errMessage(err)}` },
          log,
        );
        return;
      }
      continue;
    }
    if (t.status === "completed") {
      if (!t.outputUrl) {
        // 评审 Minor7：completed 无输出地址不可能成功，立即失败，不空转到超时
        finishLogged(db, task, { status: "failed", error: "供应商返回完成但无输出地址" }, log);
        return;
      }
      await production.createAsset({
        projectId: task.projectId,
        type: "video",
        name: p.assetName,
        url: t.outputUrl,
        mimeType: "video/mp4",
        generation: { providerId: p.providerId, modelId: p.model, prompt: p.prompt, taskId: task.id },
      });
      if (!stillOwnsRow(db, task)) {
        log(`视频任务 ${task.id} 资产已落库但失去归属（取消/接管），让位不写终态`);
        return;
      }
      finishLogged(db, task, { status: "completed", outputUrl: t.outputUrl, progress: 100 }, log);
      return;
    }
    if (t.status === "failed") {
      finishLogged(db, task, { status: "failed", error: t.error ?? "供应商任务失败" }, log);
      return;
    }
    if (t.status === "cancelled") {
      finishLogged(db, task, { status: "cancelled", error: "任务已在供应商侧取消" }, log);
      return;
    }
    // queued/running：守卫推进心跳外的可见状态；往返窗口内行失活 → 让位（探针B）
    if (!updateRunning(db, task.id, { progress: t.progress ?? null })) {
      await abandon(providerTaskId, "progress 回写被拒（往返窗口内取消/接管）");
      return;
    }
    if (Date.now() - started > (deps.maxWaitMs ?? 15 * 60_000)) {
      finishLogged(db, task, { status: "failed", error: "视频任务等待超时（>15 分钟）" }, log);
      return;
    }
  }
}
