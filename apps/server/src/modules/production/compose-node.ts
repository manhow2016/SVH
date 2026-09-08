/**
 * 成片组装节点执行器（video.compose）：画面合成 + 音轨对齐 + 字幕烧录。
 *
 * 流程（v2）：
 *  1. 按分镜/镜头顺序收集画面段（视频段直用、图片段转 loop mp4）→ concat 重编码 visual.mp4；
 *  2. 音频轨：按镜头顺序 concat 各镜头配音（本地在盘 audio 资产）→ audio.m4a（无配音跳过）；
 *  3. mux：visual + audio（-map/-shortest，画面为准；无音轨则直通）；
 *  4. 字幕烧录：全局 SRT（按画面时间轴重建）写临时文件，libass subtitles 滤镜烧录；
 *     滤镜不可用则跳过烧录（reason 注明，字幕仍以独立资产交付）；
 *  5. 输出 `media/<assetId>.mp4` 并标记 ready（与 localize 契约同构）。
 * ffmpeg 经 deps.runFfmpeg 注入；无可用画面段 → 空输出（不抛错）。
 */
import { stat, writeFile } from "node:fs/promises";
import type { WorkflowNode } from "@svh/core";
import { toSrtTime } from "./subtitle-node";

export interface ComposeNodeContext {
  projectId: string;
  workflowId: string;
  userId: string;
}

export interface ComposeNodeDeps {
  listStoryboards(
    projectId: string,
  ): Promise<Array<{ id: string; order: number }>>;
  listShotsByStoryboard(
    storyboardId: string,
  ): Promise<
    Array<{
      order: number;
      duration: number;
      dialogue?: string | null;
      imageAssetId?: string | null;
      videoAssetId?: string | null;
      audioAssetId?: string | null;
    }>
  >;
  /** 资产本地绝对路径（localization ready 才在盘；远程/缺失返回 null） */
  localAssetPath(assetId: string): Promise<string | null>;
  /** 先建资产行（type video），记录待填充的 workspacePath 关系 */
  createComposedAsset(input: { projectId: string; name: string }): Promise<{ id: string; workspaceId: string }>;
  /** 组最终输出路径（ffmpeg 直接写入）；返回绝对路径与工作区相对路径 */
  prepareOutput(assetId: string): Promise<{ abs: string; workspacePath: string }>;
  /** ffmpeg 输出完成后标记资产 ready（workspacePath + metadata.localization + mimeType） */
  markOutputReady(assetId: string, workspacePath: string, bytes: number): Promise<void>;
  /** 执行 ffmpeg（真实 = spawn 二进制；测试 = mock 记录参数） */
  runFfmpeg(args: string[], cwd?: string): Promise<void>;
  /** 是否支持 subtitles 滤镜（libass；一次性探测缓存） */
  hasSubtitles(): Promise<boolean>;
  createTempDir(): Promise<string>;
  removeDir(dir: string): Promise<void>;
}

export interface ComposeNodeOutput {
  /** 成片资产 id（无可用段时为 null） */
  assetId: string | null;
  /** 参与合成的画面段数（图片段按 loop 计数 1） */
  segments: number;
  /** 输出相对工作区路径（ready 后在盘） */
  workspacePath?: string;
  /** 音轨段数（0 = 无配音合成） */
  audioSegments: number;
  /** 字幕是否烧录 */
  burned: boolean;
  reason?: string;
}

/** 组装图像 loop 段：ffmpeg 参数（-loop 1 input → 定长 mp4） */
function buildImageSegmentArgs(imagePath: string, duration: number, outPath: string): string[] {
  return [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-t", String(Math.max(0.5, duration)),
    "-r", "30",
    "-vf", "scale='min(1080,iw)':-2,format=yuv420p",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-an",
    outPath,
  ];
}

/** 拼接所有段：concat demuxer + 重编码 → visual.mp4（未加音轨） */
function buildConcatArgs(listPath: string, outPath: string): string[] {
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ];
}

/** 音轨 concat：各镜头配音 mp3 → aac m4a */
function buildAudioConcatArgs(listPath: string, outPath: string): string[] {
  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ];
}

/** mux：视觉 + 音频（画面为准 shortest；无音频不调用） */
function buildMuxArgs(visualPath: string, audioPath: string, outPath: string): string[] {
  return [
    "-y",
    "-i", visualPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    outPath,
  ];
}

/** 字幕烧录：subtitles 滤镜（libass），cwd=临时目录以相对路径引用 srt */
function buildBurnArgs(videoPath: string, srtName: string, outPath: string): string[] {
  return [
    "-y",
    "-i", videoPath,
    "-vf", `subtitles=${srtName}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
}

/** concat 列表内容（单引号转义：' → '\''） */
function concatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}

/** 全局字幕：按画面段时间轴（前序段时长累计）重建 cue */
function buildGlobalSrt(segments: Array<{ duration: number; dialogue?: string | null }>): string {
  const cues: string[] = [];
  let cursor = 0;
  let index = 1;
  for (const seg of segments) {
    const start = cursor;
    const end = cursor + seg.duration;
    cursor = end;
    const text = seg.dialogue?.trim();
    if (!text) continue;
    cues.push(`${index}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}\n`);
    index += 1;
  }
  return cues.join("\n");
}

export async function runComposeNode(opts: {
  ctx: ComposeNodeContext;
  node: WorkflowNode;
  input: unknown;
  deps: ComposeNodeDeps;
}): Promise<ComposeNodeOutput> {
  const { ctx, deps } = opts;

  // 1) 收集画面段（按分镜、镜头顺序；视频段优先，其次图片）
  const segments: Array<{
    order: number;
    duration: number;
    localPath: string;
    kind: "image" | "video";
    dialogue?: string | null;
  }> = [];
  const audioSegments: Array<{ order: number; localPath: string }> = [];
  const storyboards = await deps.listStoryboards(ctx.projectId);
  for (const sb of storyboards) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    for (const shot of shots) {
      const order = sb.order * 1000 + shot.order;
      const assetId = shot.videoAssetId ?? shot.imageAssetId;
      if (assetId) {
        const localPath = await deps.localAssetPath(assetId);
        if (localPath) {
          segments.push({
            order,
            duration: Math.max(0.5, shot.duration),
            localPath,
            kind: shot.videoAssetId === assetId ? "video" : "image",
            dialogue: shot.dialogue,
          });
        }
      }
      // 配音段：仅在画面段包含该镜头且音频在盘时收录（与画面同一时间轴）
      if (shot.audioAssetId && segments.some((s) => s.order === order)) {
        const audioPath = await deps.localAssetPath(shot.audioAssetId);
        if (audioPath) audioSegments.push({ order, localPath: audioPath });
      }
    }
  }
  if (segments.length === 0) {
    return { assetId: null, segments: 0, audioSegments: 0, burned: false, reason: "无可用画面资产（需先本地转存 ready）" };
  }
  segments.sort((a, b) => a.order - b.order);
  audioSegments.sort((a, b) => a.order - b.order);

  // 2) 建资产行 + 临时目录
  const asset = await deps.createComposedAsset({ projectId: ctx.projectId, name: "成片·全片" });
  const tempDir = await deps.createTempDir();
  try {
    // 3) 图片段转 loop mp4 → 画面 concat
    const segmentFiles: string[] = [];
    for (const [index, seg] of segments.entries()) {
      if (seg.kind === "image") {
        const segOut = `${tempDir}/seg_${index}.mp4`;
        await deps.runFfmpeg(buildImageSegmentArgs(seg.localPath, seg.duration, segOut), tempDir);
        segmentFiles.push(segOut);
      } else {
        segmentFiles.push(seg.localPath);
      }
    }
    const visualPath = `${tempDir}/visual.mp4`;
    const visualList = `${tempDir}/visual_list.txt`;
    await writeFile(visualList, concatListContent(segmentFiles), "utf8");
    await deps.runFfmpeg(buildConcatArgs(visualList, visualPath), tempDir);

    // 4) 音轨（有配音段时）：音频 concat → mux（画面为准）
    let muxedPath = visualPath;
    if (audioSegments.length > 0) {
      const audioPath = `${tempDir}/audio.m4a`;
      const audioList = `${tempDir}/audio_list.txt`;
      await writeFile(audioList, concatListContent(audioSegments.map((a) => a.localPath)), "utf8");
      await deps.runFfmpeg(buildAudioConcatArgs(audioList, audioPath), tempDir);
      muxedPath = `${tempDir}/muxed.mp4`;
      await deps.runFfmpeg(buildMuxArgs(visualPath, audioPath, muxedPath), tempDir);
    }

    // 5) 字幕烧录（有对白且滤镜可用）；否则直通
    const srt = buildGlobalSrt(segments);
    const { abs: outPath, workspacePath } = await deps.prepareOutput(asset.id);
    let burned = false;
    if (srt.trim() !== "" && (await deps.hasSubtitles())) {
      await writeFile(`${tempDir}/captions.srt`, srt, "utf8");
      await deps.runFfmpeg(buildBurnArgs(muxedPath, "captions.srt", outPath), tempDir);
      burned = true;
    } else {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(muxedPath, outPath);
    }

    // 6) 标记 ready（与 localize 契约同构）
    const st = await stat(outPath);
    await deps.markOutputReady(asset.id, workspacePath, st.size);
    return {
      assetId: asset.id,
      segments: segments.length,
      workspacePath,
      audioSegments: audioSegments.length,
      burned,
      reason: !burned && srt.trim() !== "" ? "字幕滤镜不可用（libass），字幕以独立资产交付" : undefined,
    };
  } finally {
    await deps.removeDir(tempDir);
  }
}
