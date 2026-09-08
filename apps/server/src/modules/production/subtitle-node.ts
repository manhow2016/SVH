/**
 * 字幕节点执行器（subtitle.generate）：本地生成分镜切片字幕（SRT），无模型依赖。
 *
 * 时间轴：同一分镜下按镜头顺序累计（start=前序镜头时长和，end=start+本镜头时长）；
 * 对白为本镜头 dialogue；产物落 `subtitle` 资产（metadata.srt，URL 缺省——组装轮读取）。
 * 重复执行幂等：同名资产会重复创建（后续轮可升级为 upsert；V1 接受）。
 */
import type { WorkflowNode } from "@svh/core";

export interface SubtitleNodeContext {
  projectId: string;
  workflowId: string;
  userId: string;
}

export interface SubtitleNodeDeps {
  listStoryboards(
    projectId: string,
  ): Promise<Array<{ id: string; order: number }>>;
  listShotsByStoryboard(
    storyboardId: string,
  ): Promise<Array<{ order: number; dialogue?: string | null; duration: number }>>;
  createSubtitleAsset(input: { projectId: string; name: string; srt: string }): Promise<{ id: string }>;
}

export interface SubtitleNodeOutput {
  /** 生成的字幕资产 id */
  assetIds: string[];
  /** 带对白镜头数 */
  shots: number;
}

/** 秒 → SRT 时间码（HH:MM:SS,mmm） */
function toSrtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

export async function runSubtitleNode(opts: {
  ctx: SubtitleNodeContext;
  node: WorkflowNode;
  input: unknown;
  deps: SubtitleNodeDeps;
}): Promise<SubtitleNodeOutput> {
  const { ctx, deps } = opts;
  const storyboards = await deps.listStoryboards(ctx.projectId);
  const assetIds: string[] = [];
  let shotCount = 0;

  for (const sb of storyboards) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    const cues = shots
      .filter((s) => s.dialogue?.trim())
      .map((s) => ({ ...s, dialogue: s.dialogue!.trim() }));
    if (cues.length === 0) continue;

    // 累计时间轴：start = 前序镜头时长和
    const cueLines: string[] = [];
    let cursor = 0;
    let index = 1;
    for (const shot of shots) {
      if (!shot.dialogue?.trim()) {
        cursor += shot.duration;
        continue;
      }
      const start = cursor;
      const end = cursor + shot.duration;
      cursor = end;
      cueLines.push(`${index}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${shot.dialogue.trim()}\n`);
      index += 1;
    }
    if (cueLines.length === 0) continue;
    const srt = cueLines.join("\n");
    const asset = await deps.createSubtitleAsset({
      projectId: ctx.projectId,
      name: `分镜${sb.order + 1}·字幕`,
      srt,
    });
    assetIds.push(asset.id);
    shotCount += cues.length;
  }

  return { assetIds, shots: shotCount };
}
