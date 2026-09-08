/**
 * 任务处理器（spec §4.2/§4.3）：payload → Provider → 资产落库 → 自动转存 → 终态。
 * 所有异常内吞并落 task 终态——worker 主循环永不因单任务崩溃。
 *
 * 转存纪律（资产本地化 spec §4）：资产先落库（远程 URL）→ 立即转存到工作区 → 宽落库
 * （转存失败只写 metadata.localization.failed，不改任务终态、不重复生成扣费）。
 *
 * 回写纪律（Task 5 评审 C1/I1）：
 * - running 推进一律走带守卫的 updateRunning（行非 running 即拒，取消不被复活）；
 * - 每次 await provider 往返后、写终态前都做「归属自查」：
 *   行仍 running 且 claimed_by 未被接管才允许写，否则静默让位不覆写。
 */
import { join } from "node:path";
import type { SVHDatabase } from "@svh/database";
import {
  LOCALIZE_DIR_PREFIX,
  LOCALIZE_METADATA_KEY,
  extFromContentType,
  localizeToFile,
  type AssetFieldsPatch,
  type LocalizeMetadata,
  type ProductionAsset,
  type ProductionService,
} from "@svh/production";
import {
  createImageProvider,
  createTTSService,
  createVideoProvider,
  type ImageGenerationInput,
  type ImageGenerationResult,
  type ImageProvider,
  type ModelConfig,
  type TTSService,
  type TTSSynthesisResult,
  type VideoProvider,
  type VideoTask,
} from "@svh/providers";
import type { TimelineService } from "@svh/production";
import { finishTask, getTaskClaim, updateRunning, type ClaimedTask, type TaskPayload } from "./queue";
import { runRenderTimelineTask } from "./render-timeline";

export interface HandlerDeps {
  pollIntervalMs: number;
  /** 供应商工厂（测试注入假实现；缺省走 providers 包路由工厂） */
  imageProviderFactory?: (p: TaskPayload) => ImageProvider;
  videoProviderFactory?: (p: TaskPayload) => VideoProvider;
  /** TTS 供应商工厂（测试注入假实现；缺省 openai-compatible /v1/audio/speech） */
  ttsProviderFactory?: (p: TaskPayload) => TTSService;
  /** 定时器（测试注入 0ms） */
  sleep?: (ms: number) => Promise<void>;
  /** 视频任务最长等待（缺省 15 分钟） */
  maxWaitMs?: number;
  /** 观测日志（守卫拒绝覆写等让位场景），缺省 console */
  log?: (msg: string) => void;
  /**
   * 工作区根（绝对路径，config.workspaceRoot 透传）。
   * 缺省 = 未配置 → 整体跳过转存（开发环境容错，资产保持远程模式，DB 不写 localization 键）。
   */
  workspaceRoot?: string;
  /** 单文件字节上限 / 单次尝试超时；缺省用 localizer 内置默认（500MB / 60s） */
  localizeConfig?: { maxBytes: number; timeoutMs: number };
  /** 网络注入面（转存下载用；测试注入假 fetch，生产缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** V0.3 Phase 8：时间轴状态回写（rendering → completed/failed）；未注入则跳过 */
  timeline?: TimelineService;
  /** V0.3 Phase 8：ffmpeg 执行（缺省 spawn 二进制；测试注入 mock 记录参数） */
  runFfmpeg?: (args: string[], cwd?: string) => Promise<void>;
  /** V0.3 Phase 8：字幕滤镜（libass）能力探测（缺省 -filters 一次探测） */
  hasSubtitles?: () => Promise<boolean>;
}

/** getTask 连续瞬态异常容忍阈值（达到即 failed） */
const MAX_GET_ERRORS = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toConfig(p: TaskPayload): ModelConfig {
  return { providerId: p.providerId, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey };
}

/** 构造「备用供应商」视角的 payload（providerId/model/key 换成 fallback 的），供工厂分支识别 */
function fallbackPayload(p: TaskPayload): TaskPayload | null {
  if (!p.fallback) return null;
  return {
    ...p,
    providerId: p.fallback.providerId,
    model: p.fallback.model,
    baseUrl: p.fallback.baseUrl,
    apiKey: p.fallback.apiKey,
  };
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
  if (kind === "image") return !s(p.prompt);
  if (kind === "audio") {
    // 配音文本取 composedPrompt ?? prompt；两者皆空 → 不完整
    return !(s(p.composedPrompt) || s(p.prompt));
  }
  return false;
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

/**
 * 任务完成 → 回写生成记录（审核账本：status=completed + 产出资产）。
 * 宽落库同源取舍：失败只记日志，不影响任务终态与资产落库；
 * 但回写失败会让制作中心审核永久不可用，故带 1 次短延迟重试（对账兜底见路由 reconcile）。
 */
async function markRecordCompleted(
  production: ProductionService,
  taskId: string,
  outputAssetId: string,
  log: (msg: string) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await production.markGenerationRecordsCompletedByTask(taskId, outputAssetId);
      return;
    } catch (err) {
      if (attempt === 2) {
        log(`生成记录回写失败 task=${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

/** kind → 落盘文件名兜底扩展名与默认 MIME（Content-Type 只在下载成功后才可得，故扩展名先行按 kind 定） */
const KIND_MEDIA: Record<"image" | "video" | "audio", { ext: string; mime: string }> = {
  image: { ext: "png", mime: "image/png" },
  video: { ext: "mp4", mime: "video/mp4" },
  audio: { ext: "mp3", mime: "audio/mpeg" },
};

/**
 * 生成成功后把远程资产转存到本地工作区（spec §4：宽落库）。
 *
 * 落库语义（Task 3/4/5 依赖的接口约定，见 task-2 报告）：
 * - `workspacePath` 存**工作区相对路径** `media/<assetId>.<ext>`（spec §3 + Task 4 前缀判据；
 *   目录字面量与判据同取 @svh/production `LOCALIZE_DIR_PREFIX` 单一事实源，终审 M①），
 *   绝对路径由消费方用 `<workspaceRoot>/<asset.workspaceId>/<workspacePath>` 组；
 * - 扩展名先行按 kind 兜底（image→png / video→mp4），**不二次改名**；真实媒体类型靠 `mimeType` 承载：
 *   Content-Type 命中 localizer 白名单且与 kind 默认 mime 不符时（如 image/jpeg 存成 .png）兜正 DB mimeType；
 *   octet-stream 等未知类型 extFromContentType 返回 null → 不污染 DB；
 * - `metadata.localization`：ready 必有 workspacePath；failed 不写 workspacePath（保持 null）且 error 在案；
 *   整步跳过（未配 workspaceRoot / 无远程 url）→ 完全不写 localization 键（= 从未尝试的远程模式）。
 *
 * 路径安全：dest 三要素全部可信——`asset.id`/`asset.workspaceId` 是 randomId 生成的服务端串，
 * `ext` 取白名单常量，root 来自 config（`SVH_WORKSPACE_ROOT` 或仓库根默认）；
 * 用户输入（资产名、prompt、供应商返回体）一概不进路径，故无路径注入面。
 *
 * 异常纪律：localizeToFile 本身永不抛；此处再包一层双保险，任何异常都收敛为 failed 落库，
 * 绝不冒到任务处理外层（转存失败不得影响任务终态与资产落库）。
 */
async function localizeAsset(
  production: ProductionService,
  asset: ProductionAsset,
  kind: "image" | "video" | "audio",
  deps: HandlerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const root = deps.workspaceRoot;
  // safeLog：注入的日志面自身可能抛（外置 sink/句柄失效）；日志失败不得改变
  // 转存的宽落库纪律（尤其 catch 内再抛会冒泡），统一吞掉。
  const safeLog = (msg: string): void => {
    try {
      log(msg);
    } catch {
      /* 日志失败静默 */
    }
  };
  if (!root) return; // 未配置工作区根：整体跳过（开发环境容错）
  if (!asset.url) {
    safeLog(`资产 ${asset.id} 无远程地址（供应商直出 b64），跳过转存`);
    return;
  }
  const fallback = KIND_MEDIA[kind];
  const baseMetadata = asset.metadata ?? {};
  const failedPatch = (error: string): AssetFieldsPatch => ({
    metadata: {
      ...baseMetadata,
      [LOCALIZE_METADATA_KEY]: { state: "failed", error, at: new Date().toISOString() } satisfies LocalizeMetadata,
    },
  });
  /** 窄更新自带兜底：连回写都失败只记日志，绝不影响任务收尾 */
  const write = async (fields: AssetFieldsPatch): Promise<void> => {
    try {
      await production.updateAssetFields(asset.id, fields);
    } catch (err) {
      safeLog(`资产 ${asset.id} 转存结果回写失败（不影响任务终态）：${errMessage(err)}`);
    }
  };

  try {
    // 路径组装也在双保险内：任何未预期形态（异常 id、未知 kind）都收敛成 failed，绝不冒泡
    const relativePath = `${LOCALIZE_DIR_PREFIX}${asset.id}.${fallback.ext}`;
    const destPath = join(root, asset.workspaceId, relativePath);
    const result = await localizeToFile({
      url: asset.url,
      destPath,
      maxBytes: deps.localizeConfig?.maxBytes,
      timeoutMs: deps.localizeConfig?.timeoutMs,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep, // 退避复用注入面：测试 0ms，生产缺省真实退避
    });
    if (!result.ok) {
      safeLog(`资产 ${asset.id} 转存失败（宽落库，任务不受影响）：${result.error}`);
      await write(failedPatch(result.error));
      return;
    }
    const fields: AssetFieldsPatch = {
      workspacePath: relativePath,
      metadata: {
        ...baseMetadata,
        [LOCALIZE_METADATA_KEY]: {
          state: "ready",
          bytes: result.bytes,
          at: new Date().toISOString(),
        } satisfies LocalizeMetadata,
      },
    };
    const realExt = extFromContentType(result.contentType);
    const realMime = result.contentType?.split(";")[0]?.trim().toLowerCase();
    // 只有白名单媒体类型（mp4/png/webp/jpeg）才可信；octet-stream 等未知类型 extFromContentType 返回 null，
    // 绝不让垃圾 Content-Type 倒灌 DB。扩展名与真实类型不符（image/jpeg 存成 .png）时兜正 mimeType。
    if (realExt && realMime && realMime !== fallback.mime) {
      fields.mimeType = realMime; // 真实媒体类型兜正（media 路由以 DB mimeType 给 Content-Type）
    }
    await write(fields);
  } catch (err) {
    // 双保险第二层：上面任何未预期异常（含回写本身）一律收敛成 failed 兜底
    safeLog(`资产 ${asset.id} 转存步骤异常（按失败兜底）：${errMessage(err)}`);
    await write(failedPatch(errMessage(err)));
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
    if (task.kind !== "image" && task.kind !== "video" && task.kind !== "audio" && task.kind !== "timeline_render") {
      finishLogged(db, task, { status: "failed", error: `暂不支持的任务类型：${task.kind}` }, log);
      return;
    }
    if (task.kind === "timeline_render") {
      return await runRenderTimelineTask(db, {
        production,
        timeline: deps.timeline,
        workspaceRoot: deps.workspaceRoot,
        runFfmpeg: deps.runFfmpeg,
        hasSubtitles: deps.hasSubtitles,
        fetchImpl: deps.fetchImpl,
      }, task, log);
    }
    if (payloadIncomplete(task.kind, task.payload)) {
      finishLogged(db, task, { status: "failed", error: "任务参数不完整" }, log);
      return;
    }
    if (task.kind === "image") return await runImageTask(db, production, task, deps, log);
    if (task.kind === "audio") return await runAudioTask(db, production, task, deps, log);
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
  // V0.3 Phase 2：使用 Prompt Composer 已组合的最终提示词（无则回退原始 prompt）
  const finalPrompt = p.composedPrompt ?? p.prompt ?? "";
  // V0.3 Phase 6：Provider fallback——primary 失败后回退 fback（无则单供应商）
  const providers: Array<{ provider: ImageProvider; model: string }> = [];
  const primaryProvider =
    deps.imageProviderFactory?.(p) ?? createImageProvider({ providerId: p.providerId, config: toConfig(p) });
  providers.push({ provider: primaryProvider, model: p.model });
  const fbPayload = fallbackPayload(p);
  if (fbPayload && p.fallback) {
    const fallbackProvider =
      deps.imageProviderFactory?.(fbPayload) ??
      createImageProvider({ providerId: p.fallback.providerId, config: p.fallback });
    providers.push({ provider: fallbackProvider, model: p.fallback.model });
  }
  let result: ImageGenerationResult | null = null;
  let lastError: Error | null = null;
  for (const { provider, model } of providers) {
    try {
      const genInput: ImageGenerationInput = { model, prompt: finalPrompt, size: p.size };
      // Phase B：参考图仅透传给声明支持的适配器（否则 prompt-only 降级，不报错）
      if (provider.referenceImageSupport && p.referenceImageUrls && p.referenceImageUrls.length > 0) {
        genInput.referenceImageUrls = p.referenceImageUrls;
      }
      const r = await provider.generate(genInput);
      const f = r.images[0];
      if (f && (f.url || f.b64Json)) {
        result = r;
        break;
      }
      lastError = new Error("供应商未返回图片");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (!result) {
    finishLogged(db, task, { status: "failed", error: lastError?.message ?? "供应商未返回图片" }, log);
    return;
  }
  const first = result.images[0]!;
  const asset = await production.createAsset({
    projectId: task.projectId,
    type: "image",
    name: p.assetName,
    url: first.url,
    mimeType: "image/png",
    metadata: first.b64Json ? { b64Json: first.b64Json } : undefined,
    generation: { providerId: p.providerId, modelId: p.model, prompt: finalPrompt, taskId: task.id },
  });
  // V0.3 审核账本：任务完成 → 回写生成记录（status=completed + 产出资产），制作中心方可审核
  await markRecordCompleted(production, task.id, asset.id, log);
  // 资产已落库→立即转存（宽落库：失败不影响任务终态；路径与 metadata 语义见 localizeAsset 注释）
  await localizeAsset(production, asset, "image", deps, log);
  // 写终态前归属自查（评审 C1/I1）：生成+转存往返期间被取消/接管 → 让位（资产已真实生成，保留）
  if (!stillOwnsRow(db, task)) {
    log(`图片任务 ${task.id} 资产已落库但失去归属（取消/接管），让位不写终态`);
    return;
  }
  finishLogged(db, task, { status: "completed", outputUrl: first.url ?? null, progress: 100 }, log);
}

/**
 * Phase C：TTS 配音任务——文本 → 供应商合成 → 资产落库（type audio）→ 回写记录。
 * 输出两态：JSON { url } → 存 url（远程）；二进制音频 → 转 base64 存 metadata.b64Json
 * （本地转存 audio 的 localizer 扩展在组装轮一并做；本轮保持远程/b64 展示）。
 */
async function runAudioTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const p = task.payload;
  if (!stillOwnsRow(db, task)) return; // 认领后立即被取消/接管
  const text = p.composedPrompt ?? p.prompt ?? "";
  const provider =
    deps.ttsProviderFactory?.(p) ?? createTTSService({ providerId: p.providerId, config: toConfig(p) });
  let result: TTSSynthesisResult;
  try {
    result = await provider.synthesize({ model: p.model, input: text, voice: p.voice });
  } catch (err) {
    finishLogged(db, task, { status: "failed", error: errMessage(err) }, log);
    return;
  }
  const asset = await production.createAsset({
    projectId: task.projectId,
    type: "audio",
    name: p.assetName,
    url: result.url,
    mimeType: result.contentType,
    metadata: result.b64Json ? { b64Json: result.b64Json } : undefined,
    generation: { providerId: p.providerId, modelId: p.model, prompt: text, taskId: task.id },
  });
  // 有远程地址则立即转存（宽落库与图/视频同源；b64 形态无 url 跳过）
  if (asset.url) {
    await localizeAsset(production, asset, "audio", deps, log);
  }
  await markRecordCompleted(production, task.id, asset.id, log);
  if (!stillOwnsRow(db, task)) {
    log(`音频任务 ${task.id} 资产已落库但失去归属（取消/接管），让位不写终态`);
    return;
  }
  finishLogged(db, task, { status: "completed", outputUrl: asset.url ?? null, progress: 100 }, log);
}

async function runVideoTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const p = task.payload;
  // V0.3 Phase 6：Provider fallback——primary createTask 失败后回退 fback
  const providers: Array<{ provider: VideoProvider; model: string }> = [];
  const primaryProvider =
    deps.videoProviderFactory?.(p) ?? createVideoProvider({ providerId: p.providerId, config: toConfig(p) });
  providers.push({ provider: primaryProvider, model: p.model });
  const fbPayload = fallbackPayload(p);
  if (fbPayload && p.fallback) {
    const fallbackProvider =
      deps.videoProviderFactory?.(fbPayload) ??
      createVideoProvider({ providerId: p.fallback.providerId, config: p.fallback });
    providers.push({ provider: fallbackProvider, model: p.fallback.model });
  }
  // 当前活跃供应商（createTask 成功者；abandon/poll 用它）
  let activeProvider: VideoProvider = primaryProvider;
  const sleep = deps.sleep ?? defaultSleep;

  /** 行失去归属的统一收口：server 取消则尽力取消供应商任务（防孤儿扣费），否则静默让位 */
  const abandon = async (providerTaskId: string, why: string): Promise<void> => {
    log(`视频任务 ${task.id} ${why}，让位退出`);
    if (getTaskClaim(db, task.id)?.status === "cancelled") {
      try {
        await activeProvider.cancelTask(providerTaskId);
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
  // V0.3 Phase 2：使用 Prompt Composer 已组合的最终提示词（无则回退原始 prompt；图生视频允许为空）
  const finalPrompt = p.composedPrompt ?? p.prompt ?? undefined;
  if (!providerTaskId) {
    // 依次尝试 primary → fallback（createTask 失败即切换；全部失败才 failed）
    let lastCreateError: Error | null = null;
    let created = false;
    for (const { provider, model } of providers) {
      try {
        const handle = await provider.createTask({
          model,
          prompt: finalPrompt,
          imageUrl: p.imageUrl,
          duration: p.duration,
          resolution: p.resolution,
        });
        providerTaskId = handle.providerTaskId;
        activeProvider = provider;
        created = true;
        break;
      } catch (err) {
        lastCreateError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!created || !providerTaskId) {
      finishLogged(db, task, { status: "failed", error: lastCreateError?.message ?? "供应商创建任务失败" }, log);
      return;
    }
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
        await activeProvider.cancelTask(providerTaskId);
      } catch {
        /* best-effort（spec §4.3） */
      }
      return;
    }
    // 认领者自查（评审 I1）：非 running（被写终态）或 claimed_by 被接管 → 静默让位
    if (claim.status !== "running" || claim.claimedBy !== task.claimedBy) return;

    let t: VideoTask;
    try {
      t = await activeProvider.getTask(providerTaskId);
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
      const asset = await production.createAsset({
        projectId: task.projectId,
        type: "video",
        name: p.assetName,
        url: t.outputUrl,
        mimeType: "video/mp4",
        generation: { providerId: p.providerId, modelId: p.model, prompt: finalPrompt ?? p.prompt, taskId: task.id },
      });
      // V0.3 审核账本：任务完成 → 回写生成记录（status=completed + 产出资产）
      await markRecordCompleted(production, task.id, asset.id, log);
      // 视频同样「先落库→立即转存」：远程链接 24h 过期，产物必须在本进程内抢救到磁盘
      await localizeAsset(production, asset, "video", deps, log);
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
