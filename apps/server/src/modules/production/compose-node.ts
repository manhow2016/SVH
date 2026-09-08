/**
 * 成片组装节点执行器（video.compose）：把审过的镜头画面合成一段成片 mp4。
 *
 * 语义（v1，仅画面）：按分镜/镜头顺序，视频段直接复用、图片段转 loop 段，
 * concat 重编码（libx264/yuv420p）输出到工作区 `media/<assetId>.mp4`，更新资产
 * workspacePath + localization ready（与 localize 契约同构）；配音/字幕作为独立
 * 资产交付（音轨对齐 / 字幕烧录留组装升级轮）。
 * 无可用画面段 → 空输出（不抛错）。ffmpeg 经 deps.runFfmpeg 注入（测试 mock/真实 spawn）。
 */
import { stat, writeFile } from "node:fs/promises";
import type { WorkflowNode } from "@svh/core";

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
  ): Promise<Array<{ order: number; duration: number; imageAssetId?: string | null; videoAssetId?: string | null }>>;
  /** 资产本地绝对路径（localization ready 才在盘；远程/缺失返回 null → 该镜头跳过） */
  localAssetPath(assetId: string): Promise<string | null>;
  /** 先建资产行（type video），记录待填充的 workspacePath 关系 */
  createComposedAsset(input: { projectId: string; name: string }): Promise<{ id: string; workspaceId: string }>;
  /** 组最终输出路径（ffmpeg 直接写入）；返回绝对路径与工作区相对路径 */
  prepareOutput(assetId: string): Promise<{ abs: string; workspacePath: string }>;
  /** ffmpeg 输出完成后标记资产 ready（workspacePath + metadata.localization + mimeType） */
  markOutputReady(assetId: string, workspacePath: string, bytes: number): Promise<void>;
  /** 执行 ffmpeg（真实 = spawn 二进制；测试 = mock 记录参数） */
  runFfmpeg(args: string[], cwd?: string): Promise<void>;
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

/** 拼接所有段：concat demuxer + 重编码 → 成片 */
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
    "-movflags", "+faststart",
    outPath,
  ];
}

/** concat 列表内容（单引号转义：' → '\''） */
function concatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}

export async function runComposeNode(opts: {
  ctx: ComposeNodeContext;
  node: WorkflowNode;
  input: unknown;
  deps: ComposeNodeDeps;
}): Promise<ComposeNodeOutput> {
  const { ctx, deps } = opts;

  // 1) 收集画面段（按分镜、镜头顺序；视频段优先，其次图片）
  const segments: Array<{ order: number; duration: number; localPath: string; kind: "image" | "video" }> = [];
  const storyboards = await deps.listStoryboards(ctx.projectId);
  for (const sb of storyboards) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    for (const shot of shots) {
      const assetId = shot.videoAssetId ?? shot.imageAssetId;
      if (!assetId) continue;
      const localPath = await deps.localAssetPath(assetId);
      if (!localPath) continue;
      segments.push({
        order: sb.order * 1000 + shot.order,
        duration: Math.max(0.5, shot.duration),
        localPath,
        kind: shot.videoAssetId === assetId ? "video" : "image",
      });
    }
  }
  if (segments.length === 0) {
    return { assetId: null, segments: 0, reason: "无可用画面资产（需先本地转存 ready）" };
  }
  segments.sort((a, b) => a.order - b.order);

  // 2) 建资产行 + 临时目录
  const asset = await deps.createComposedAsset({ projectId: ctx.projectId, name: "成片·全片" });
  const tempDir = await deps.createTempDir();
  try {
    // 3) 图片段先转为 loop mp4
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

    // 4) concat 列表 + 合成输出（先写列表再执行）
    const listPath = `${tempDir}/list.txt`;
    const { abs: outPath, workspacePath } = await deps.prepareOutput(asset.id);
    await writeFile(listPath, concatListContent(segmentFiles), "utf8");
    await deps.runFfmpeg(buildConcatArgs(listPath, outPath), tempDir);

    // 5) 标记 ready（与 localize 契约同构：workspacePath + metadata.localization + mimeType）
    const st = await stat(outPath);
    await deps.markOutputReady(asset.id, workspacePath, st.size);
    return { assetId: asset.id, segments: segments.length, workspacePath };
  } finally {
    await deps.removeDir(tempDir);
  }
}
