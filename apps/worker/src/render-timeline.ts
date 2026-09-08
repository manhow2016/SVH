/**
 * 时间轴渲染任务执行器（V0.3 文档 Phase 8：FFmpeg Renderer，worker 侧）。
 *
 * 输入：kind = timeline_render 的 ClaimedTask（payload = Phase 7 入队时刻的
 * 剪辑静态快照 TimelineRenderTaskPayload，worker 按快照渲染，不读当前时间轴）。
 *
 * 流程：
 *  1. 按轨道拆 split：video（画面轴）、audio（混音轨）、subtitle（字幕烧录）；
 *     overlay 轨第一阶段忽略（文档允许）；
 *  2. 素材定位：本地化优先（<workspaceRoot>/<workspaceId>/<workspacePath>），
 *     远程 URL 兜底下载到临时目录（fetchImpl 注入面）；任一素材不可用 → 整任务失败；
 *  3. 画面轴：video 剪辑按 startTime 升序逐段 trim + 规格化（scale/pad 到目标
 *     尺寸、fps、yuv420p），剪辑间 gap 补黑段（color=black）→ concat demuxer
 *     无缝拼接 visual.mp4（总长 = max clip end）；
 *  4. 音频轴：audio 剪辑 atrim + asetpts + adelay（对齐各自 startTime）→
 *     amix 混音（duration=longest, normalize=0）→ audio.m4a；无音频段则直通；
 *  5. 字幕：subtitle 剪辑关联资产 metadata.srt 文本（subtitle.generate 产物），
 *     各 cue 时间 + clip.startTime 偏移 → 全局 SRT；libass subtitles 滤镜烧录；
 *     滤镜不可用或无字幕文本 → 跳过烧录（reason 注明，不阻断）；
 *  6. 产物：新 video 资产落 media/<assetId>.mp4（与 localize 契约同构：
 *     workspacePath + metadata.localization.ready）→ 任务 completed；
 *     时间轴 rendering → completed；失败路径写入 failed（状态机合法转换）。
 *
 * ffmpeg 经 deps.runFfmpeg 注入（真实 = spawn 二进制，测试 = mock 记录参数）；
 * 取消/接管：段间自查 getTaskClaim，失去归属即让位并清理临时目录。
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SVHDatabase } from "@svh/database";
import {
  LOCALIZE_METADATA_KEY,
  type LocalizeMetadata,
  type ProductionService,
  type TimelineService,
} from "@svh/production";
import {
  finishTask,
  getTaskClaim,
  updateRunning,
  type ClaimedTask,
  type TimelineRenderTaskPayload,
} from "./queue";

export interface TimelineRenderDeps {
  production: ProductionService;
  /** 时间轴状态回写（rendering → completed/failed）；未注入则跳过并记日志 */
  timeline?: TimelineService;
  /** 工作区根（与 server 同语义；未配置时按“未本地化”降级走远程 URL） */
  workspaceRoot?: string;
  /** ffmpeg 执行（缺省 spawn 二进制：SVH_FFMPEG_PATH → @ffmpeg-installer） */
  runFfmpeg?: (args: string[], cwd?: string) => Promise<void>;
  /** 字幕滤镜（libass）能力探测（缺省 -filters 一次探测） */
  hasSubtitles?: () => Promise<boolean>;
  /** 素材远程 URL 下载注入面（测试假 fetch；缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

// ================= ffmpeg 二进制 =================

/** 解析 ffmpeg 可执行路径：SVH_FFMPEG_PATH 优先，其次 @ffmpeg-installer 本地静态二进制 */
export function resolveFfmpegPath(): string {
  const envPath = process.env.SVH_FFMPEG_PATH;
  if (envPath) return envPath;
  try {
    return (createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg") as { path: string }).path;
  } catch {
    throw new Error("未找到 ffmpeg：请 apt install ffmpeg（或设置 SVH_FFMPEG_PATH）后重试时间轴渲染");
  }
}

/** 真实 ffmpeg 执行：spawn 二进制，非零退出带 stderr 尾部抛错 */
export async function spawnFfmpeg(args: string[], cwd?: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 失败（exit ${code}）：${stderr.slice(-500)}`));
    });
    child.on("error", reject);
  });
}

let ffmpegSubtitlesSupport: boolean | undefined;

/** 探测 ffmpeg 是否支持 subtitles 滤镜（libass；一次缓存） */
export async function probeFfmpegSubtitles(): Promise<boolean> {
  if (ffmpegSubtitlesSupport !== undefined) return ffmpegSubtitlesSupport;
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ["-hide_banner", "-filters"], {});
    let buf = "";
    child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error("ffmpeg -filters 失败"))));
    child.on("error", reject);
  });
  ffmpegSubtitlesSupport = /\bsubtitles\b/.test(out);
  return ffmpegSubtitlesSupport;
}

// ================= ffmpeg 参数组装 =================

/** 视频剪辑段：-i 后置 -ss/-t（输出级精确定位）→ scale/pad 目标尺寸 + fps + yuv420p */
export function buildTrimSegmentArgs(
  inputPath: string,
  sourceStart: number,
  duration: number,
  fps: number,
  width: number,
  height: number,
  outPath: string,
): string[] {
  return [
    "-y",
    "-i", inputPath,
    "-ss", String(Math.max(0, sourceStart)),
    "-t", String(Math.max(0.1, duration)),
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-an",
    "-avoid_negative_ts", "make_zero",
    outPath,
  ];
}

/** gap 补黑段（与原段同规格，保证 concat 无缝） */
export function buildBlackSegmentArgs(
  duration: number,
  fps: number,
  width: number,
  height: number,
  outPath: string,
): string[] {
  return [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
    "-t", String(Math.max(0.1, duration)),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ];
}

/** 画面轴拼接：concat demuxer（各段同规格 → 流拷贝）+ faststart */
export function buildConcatVisualArgs(listPath: string, outPath: string): string[] {
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * 音频轴混音：逐剪辑 atrim + asetpts + adelay（对齐各自 startTime）→ amix。
 * duration=longest（画面外延部分交给 -shortest 截断，画面为准）。
 */
export function buildAudioMuxArgs(
  clips: Array<{ inputPath: string; sourceStart: number; startTime: number; duration: number }>,
  outPath: string,
): string[] {
  const inputs = clips.flatMap((c) => ["-i", c.inputPath]);
  const filters = clips.map((c, i) => {
    const ms = Math.round(c.startTime * 1000);
    // adelay 单参数形式：兼容含旧构建（ffmpeg 4.x）；mono/多声道均按同一延迟偏移
    return `[${i}:a]atrim=start=${Math.max(0, c.sourceStart)}:duration=${Math.max(0.1, c.duration)},asetpts=PTS-STARTPTS,adelay=${ms}[a${i}]`;
  });
  const mixLabels = clips.map((_, i) => `[a${i}]`).join("");
  // amix 不带 normalize（该选项 ffmpeg 5.0+ 才有；旧构建兼容，缺省归一化对单路无影响）
  filters.push(`${mixLabels}amix=inputs=${clips.length}:duration=longest[mix]`);
  return [
    "-y",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[mix]",
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ];
}

/** 最终封装：画面（+音轨 copy/aac 前已编码）+ 可选字幕烧录（cwd=临时目录引用 srt 文件名） */
export function buildFinalMuxArgs(
  visualPath: string,
  audioPath: string | null,
  srtFileName: string | null,
  outPath: string,
): string[] {
  const args = ["-y", "-i", visualPath];
  if (audioPath) args.push("-i", audioPath);
  if (srtFileName) {
    args.push("-vf", `subtitles=${srtFileName}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  } else {
    args.push("-c:v", "copy");
  }
  if (audioPath) {
    args.push("-map", "0:v", "-map", "1:a", "-c:a", "copy", "-shortest");
  } else {
    args.push("-map", "0:v", "-an");
  }
  args.push("-movflags", "+faststart", outPath);
  return args;
}

// ================= SRT 工具 =================

/** 秒 → SRT 时间戳（HH:MM:SS,mmm） */
export function toSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

/** SRT 时间戳 → 秒（无法解析返回 null） */
export function parseSrtTime(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const msPart = (m[4] ?? "0").padEnd(3, "0");
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(msPart) / 1000;
}

/**
 * 全局字幕：多段（subtitle 剪辑）SRT 各 cue 按 offset（= clip.startTime）平移，
 * 合并重编号、按时间排序（稳定：同起始时间保序）。
 */
export function buildGlobalSrt(segments: Array<{ offset: number; srt: string }>): string {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const seg of segments) {
    const blocks = seg.srt.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
      const arrow = lines.findIndex((l) => l.includes("-->"));
      if (arrow < 0) continue;
      const [startT, endT] = lines[arrow]!.split("-->");
      const start = parseSrtTime(startT ?? "");
      const end = parseSrtTime(endT ?? "");
      if (start === null || end === null) continue;
      const text = lines.slice(arrow + 1).join("\n").trim();
      if (!text) continue;
      cues.push({ start: seg.offset + start, end: seg.offset + end, text });
    }
  }
  cues.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  return cues.map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}\n`).join("\n");
}

// ================= 主执行 =================

interface ClipInput {
  clip: TimelineRenderTaskPayload["clips"][number];
  sourceStart: number;
  localPath: string;
}

/**
 * 渲染任务入口（runTask 分发到本函数；上报/回写纪律与生成类 handler 一致：
 * 所有异常内吞并落任务终态 + 时间轴终态，绝不冒泡击穿 worker 主循环）。
 */
export async function runRenderTimelineTask(
  db: SVHDatabase,
  deps: TimelineRenderDeps,
  task: ClaimedTask,
  log: (msg: string) => void,
): Promise<void> {
  const payload = task.payload as unknown as TimelineRenderTaskPayload;
  const fail = async (error: string): Promise<void> => {
    if (stillOwnsRow(db, task)) {
      finishTask(db, task.id, { status: "failed", error });
      await markTimelineStatus(deps, payload.timelineId, "failed", log);
    }
  };
  try {
    await runRenderTimeline(db, deps, task, payload, log);
    if (!stillOwnsRow(db, task)) {
      log(`渲染任务 ${task.id} 已失去归属，让位不写终态`);
      return;
    }
    finishTask(db, task.id, { status: "completed", progress: 100 });
    await markTimelineStatus(deps, payload.timelineId, "completed", log);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

async function runRenderTimeline(
  db: SVHDatabase,
  deps: TimelineRenderDeps,
  task: ClaimedTask,
  payload: TimelineRenderTaskPayload,
  log: (msg: string) => void,
): Promise<void> {
  const { production } = deps;
  const videoClips = payload.clips.filter((c) => c.trackType === "video").sort((a, b) => a.startTime - b.startTime);
  const audioClips = payload.clips.filter((c) => c.trackType === "audio").sort((a, b) => a.startTime - b.startTime);
  const subtitleClips = payload.clips.filter((c) => c.trackType === "subtitle").sort((a, b) => a.startTime - b.startTime);
  if (videoClips.length === 0) {
    throw new Error("时间轴没有视频轨剪辑，无法渲染成片");
  }
  if (!deps.workspaceRoot) {
    throw new Error("未配置工作区根（SVH_WORKSPACE_ROOT），无法落盘成片");
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "svh-render-"));
  try {
    // 1) 素材定位（本地化优先，远程 URL 兜底下载；同素材复用同一份）
    const pathCache = new Map<string, string>();
    const resolveInput = async (clip: TimelineRenderTaskPayload["clips"][number]): Promise<string> => {
      if (!clip.assetId) throw new Error(`剪辑 ${clip.clipId} 未绑定素材`);
      const cached = pathCache.get(clip.assetId);
      if (cached) return cached;
      const asset = await production.getAsset(clip.assetId);
      if (!asset) throw new Error(`剪辑 ${clip.clipId} 关联素材不存在（${clip.assetId}）`);
      if (asset.workspacePath && asset.workspaceId) {
        const local = join(deps.workspaceRoot!, asset.workspaceId, asset.workspacePath);
        try {
          await stat(local);
          pathCache.set(clip.assetId, local);
          return local;
        } catch {
          log(`素材 ${clip.assetId} 本地路径不可读（${local}），尝试远程下载`);
        }
      }
      if (!asset.url) throw new Error(`剪辑 ${clip.clipId} 素材无本地文件且无远程地址`);
      const ext = clip.trackType === "audio" ? ".mp3" : ".mp4";
      const target = join(tmpDir, `src_${clip.assetId}${ext}`);
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      const res = await fetchImpl(asset.url);
      if (!res.ok) throw new Error(`素材 ${clip.assetId} 下载失败：HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(target, buf);
      pathCache.set(clip.assetId, target);
      return target;
    };

    const videoInputs: ClipInput[] = [];
    for (const clip of videoClips) {
      videoInputs.push({
        clip,
        sourceStart: clip.sourceStartTime ?? 0,
        localPath: await resolveInput(clip),
      });
    }
    const audioInputs: ClipInput[] = [];
    for (const clip of audioClips) {
      audioInputs.push({
        clip,
        sourceStart: clip.sourceStartTime ?? 0,
        localPath: await resolveInput(clip),
      });
    }

    // 2) 画面轴：逐段 trim（gap 补黑）→ concat
    const runFfmpeg = deps.runFfmpeg ?? spawnFfmpeg;
    const segmentFiles: string[] = [];
    let cursor = 0;
    const E = 1e-6;
    for (let i = 0; i < videoInputs.length; i++) {
      if (!stillOwnsRow(db, task)) {
        throw new Error("任务已在渲染期间取消或被接管，让位退出");
      }
      const seg = videoInputs[i]!;
      const gap = seg.clip.startTime - cursor;
      if (gap > E) {
        const blackOut = join(tmpDir, `seg_black_${i}.mp4`);
        await runFfmpeg(
          buildBlackSegmentArgs(gap, payload.fps, payload.width, payload.height, blackOut),
          tmpDir,
        );
        segmentFiles.push(blackOut);
      }
      const segOut = join(tmpDir, `seg_v_${i}.mp4`);
      await runFfmpeg(
        buildTrimSegmentArgs(seg.localPath, seg.sourceStart, seg.clip.duration, payload.fps, payload.width, payload.height, segOut),
        tmpDir,
      );
      segmentFiles.push(segOut);
      cursor = seg.clip.startTime + seg.clip.duration;
      updateRunning(db, task.id, { progress: Math.min(80, Math.round((i / videoInputs.length) * 60) + 10) });
    }
    const visualPath = join(tmpDir, "visual.mp4");
    const visualList = join(tmpDir, "visual_list.txt");
    await writeFile(visualList, concatListContent(segmentFiles), "utf8");
    await runFfmpeg(buildConcatVisualArgs(visualList, visualPath), tmpDir);

    // 3) 音频轴（有音频段时）：atrim + adelay + amix
    let audioPath: string | null = null;
    if (audioInputs.length > 0) {
      audioPath = join(tmpDir, "audio.m4a");
      await runFfmpeg(
        buildAudioMuxArgs(
          audioInputs.map((a) => ({
            inputPath: a.localPath,
            sourceStart: a.sourceStart,
            startTime: a.clip.startTime,
            duration: a.clip.duration,
          })),
          audioPath,
        ),
        tmpDir,
      );
    }

    // 4) 字幕：subtitle 剪辑资产 metadata.srt 平移合并 → 全局 SRT（滤镜可用才烧录）
    let srtFileName: string | null = null;
    let hasSubtitles = false;
    try {
      hasSubtitles = await (deps.hasSubtitles ?? probeFfmpegSubtitles)();
    } catch {
      hasSubtitles = false;
    }
    const srtSegments: Array<{ offset: number; srt: string }> = [];
    for (const clip of subtitleClips) {
      if (!clip.assetId) continue;
      const asset = await production.getAsset(clip.assetId);
      const raw = asset?.metadata?.["srt"];
      if (typeof raw === "string" && raw.trim() !== "") {
        srtSegments.push({ offset: clip.startTime, srt: raw });
      }
    }
    const globalSrt = buildGlobalSrt(srtSegments);
    if (hasSubtitles && globalSrt.trim() !== "") {
      await writeFile(join(tmpDir, "captions.srt"), globalSrt, "utf8");
      srtFileName = "captions.srt";
    }

    // 5) 产物资产 + 输出路径（localize 契约同构：media/<assetId>.mp4）
    const asset = await production.createAsset({
      projectId: payload.projectId,
      type: "video",
      name: `成片·时间轴`,
      mimeType: "video/mp4",
    });
    const workspacePath = join("media", `${asset.id}.mp4`);
    const outAbs = join(deps.workspaceRoot, asset.workspaceId, workspacePath);
    await mkdir(dirname(outAbs), { recursive: true });
    updateRunning(db, task.id, { progress: 90 });
    await runFfmpeg(buildFinalMuxArgs(visualPath, audioPath, srtFileName, outAbs), tmpDir);

    // 6) 标记 ready（与 localize 契约同构）
    const st = await stat(outAbs);
    await production.updateAssetFields(asset.id, {
      workspacePath,
      mimeType: "video/mp4",
      metadata: {
        ...(asset.metadata ?? {}),
        [LOCALIZE_METADATA_KEY]: {
          state: "ready",
          bytes: st.size,
          at: new Date().toISOString(),
        } satisfies LocalizeMetadata,
      },
    });
    log(
      `渲染完成 task=${task.id} timeline=${payload.timelineId} asset=${asset.id} ` +
        `segments=${videoInputs.length} audio=${audioInputs.length} subtitles=${srtFileName !== null}`,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 归属自查（与生成类 handler 同基准：仍 running 且 claimed_by 未被接管） */
function stillOwnsRow(db: SVHDatabase, task: ClaimedTask): boolean {
  const claim = getTaskClaim(db, task.id);
  return claim !== null && claim.status === "running" && claim.claimedBy === task.claimedBy;
}

/** 时间轴状态回写（rendering → completed/failed）；未注入 TimelineService 时记日志跳过 */
async function markTimelineStatus(
  deps: TimelineRenderDeps,
  timelineId: string,
  status: "completed" | "failed",
  log: (msg: string) => void,
): Promise<void> {
  if (!deps.timeline) {
    log(`未注入 TimelineService，跳过时间轴 ${timelineId} 状态回写（${status}）`);
    return;
  }
  try {
    await deps.timeline.updateTimeline(timelineId, { status });
  } catch (err) {
    log(`时间轴 ${timelineId} 状态回写 ${status} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** concat 列表内容（单引号转义：' → '\''） */
function concatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}
