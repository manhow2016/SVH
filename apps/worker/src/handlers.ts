/**
 * 任务处理器（spec §4.2/§4.3）：payload → Provider → 资产落库 → 终态。
 * 所有异常内吞并落 task 终态——worker 主循环永不因单任务崩溃。
 */
import type { SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import {
  createImageProvider,
  createVideoProvider,
  type ImageProvider,
  type ModelConfig,
  type VideoProvider,
} from "@svh/providers";
import { finishTask, getTaskStatus, setTaskRunning, type ClaimedTask, type TaskPayload } from "./queue";

export interface HandlerDeps {
  pollIntervalMs: number;
  /** 供应商工厂（测试注入假实现；缺省走 providers 包路由工厂） */
  imageProviderFactory?: (p: TaskPayload) => ImageProvider;
  videoProviderFactory?: (p: TaskPayload) => VideoProvider;
  /** 定时器（测试注入 0ms） */
  sleep?: (ms: number) => Promise<void>;
  /** 视频任务最长等待（缺省 15 分钟） */
  maxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toConfig(p: TaskPayload): ModelConfig {
  return { providerId: p.providerId, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey };
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}

/**
 * payload 防御（Task 4 评审承传）：queue.parsePayload 校验较弱，
 * 执行前再核对必要字段，缺失即快速失败，绝不带残缺参数发网络请求。
 * 视频允许无 prompt（图生视频），图片必须有 prompt。
 */
function payloadIncomplete(kind: ClaimedTask["kind"], p: TaskPayload): boolean {
  const s = (v: unknown): boolean => typeof v === "string" && v !== "";
  if (!s(p.providerId) || !s(p.model) || !s(p.apiKey)) return true;
  return kind === "image" && !s(p.prompt);
}

/** 分发入口：主循环唯一调用点 */
export async function runTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  try {
    if (task.kind !== "image" && task.kind !== "video") {
      finishTask(db, task.id, { status: "failed", error: `暂不支持的任务类型：${task.kind}` });
      return;
    }
    if (payloadIncomplete(task.kind, task.payload)) {
      finishTask(db, task.id, { status: "failed", error: "任务参数不完整" });
      return;
    }
    if (task.kind === "image") return await runImageTask(db, production, task, deps);
    return await runVideoTask(db, production, task, deps);
  } catch (err) {
    finishTask(db, task.id, { status: "failed", error: errMessage(err) });
  }
}

async function runImageTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  const p = task.payload;
  if ((await getTaskStatus(db, task.id)) === "cancelled") return; // 认领后立即被取消
  const provider =
    deps.imageProviderFactory?.(p) ?? createImageProvider({ providerId: p.providerId, config: toConfig(p) });
  const result = await provider.generate({ model: p.model, prompt: p.prompt ?? "", size: p.size });
  const first = result.images[0];
  if (!first || (!first.url && !first.b64Json)) {
    finishTask(db, task.id, { status: "failed", error: "供应商未返回图片" });
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
  // 写终态前认领者自查（评审承传#2）：行已非 running（被接管/取消）则静默让位，
  // finishTask 守卫同样会拒绝覆写，这里提前收口避免竞态窗口内误判。
  if (getTaskStatus(db, task.id) !== "running") return;
  // 返回 false = server 已标记取消：资产虽落库但状态保持 cancelled（与旧 server 行为一致）
  finishTask(db, task.id, { status: "completed", outputUrl: first.url ?? null, progress: 100 });
}

async function runVideoTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  const p = task.payload;
  if ((await getTaskStatus(db, task.id)) === "cancelled") return; // 认领后立即被取消
  const provider =
    deps.videoProviderFactory?.(p) ?? createVideoProvider({ providerId: p.providerId, config: toConfig(p) });
  const sleep = deps.sleep ?? defaultSleep;

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
    setTaskRunning(db, task.id, { providerTaskId });
  }

  const started = Date.now();
  for (;;) {
    await sleep(deps.pollIntervalMs);
    const status = getTaskStatus(db, task.id);
    if (status === "cancelled") {
      try {
        await provider.cancelTask(providerTaskId);
      } catch {
        /* best-effort（spec §4.3） */
      }
      return;
    }
    // 认领者自查（评审承传#2）：行被接管者改写或其他终态 → 立即静默退出，不覆写
    if (status !== "running") return;
    const t = await provider.getTask(providerTaskId);
    if (t.status === "completed" && t.outputUrl) {
      await production.createAsset({
        projectId: task.projectId,
        type: "video",
        name: p.assetName,
        url: t.outputUrl,
        mimeType: "video/mp4",
        generation: { providerId: p.providerId, modelId: p.model, prompt: p.prompt, taskId: task.id },
      });
      if (getTaskStatus(db, task.id) !== "running") return; // 写终态前再自查一次
      finishTask(db, task.id, { status: "completed", outputUrl: t.outputUrl, progress: 100 });
      return;
    }
    if (t.status === "failed") {
      finishTask(db, task.id, { status: "failed", error: t.error ?? "供应商任务失败" });
      return;
    }
    if (t.status === "cancelled") {
      finishTask(db, task.id, { status: "cancelled", error: "任务已在供应商侧取消" });
      return;
    }
    setTaskRunning(db, task.id, { progress: t.progress ?? null }); // queued/running：推进心跳外的可见状态
    if (Date.now() - started > (deps.maxWaitMs ?? 15 * 60_000)) {
      finishTask(db, task.id, { status: "failed", error: "视频任务等待超时（>15 分钟）" });
      return;
    }
  }
}
