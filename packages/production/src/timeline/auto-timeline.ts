/**
 * Auto Timeline 领域规则（V0.3 文档 Phase 5：自动时间轴）。
 *
 * 把项目镜头自动编排为成片时间轴，三步全为纯函数（无 I/O）：
 * 1. 排序：scene.order → storyboard.order → shot.order（确定性的层级序，禁止随机）；
 * 2. 素材裁决：优先 shot.videoAssetId（用户/审核选中），否则取该镜头最新完成的
 *    视频生成记录（version 最大）；无效素材（不存在/类型不符/跨项目）不采用，
 *    并回退到次优候选（「否则」语义：第一个候选失效时继续查生成记录）；
 * 3. 成轨计划：单一 video 轨，剪辑按序累计 startTime，duration = 镜头时长，
 *    sourceStartTime = 0 / sourceDuration = 镜头时长（整段源素材语义）。
 *
 * 数据由调用方（Service / 工具）加载后传入：本项目所有 video 资产的 id 集合
 * 构成可用性判定（usableAssetIds，已保证「存在且同项目且类型 = video」）。
 */
import type { GenerationRecord } from "../generation/generation-record-types";
import type { ProductionScene } from "../scene/scene-types";
import type { ProductionShot } from "../shot/shot-types";
import type { Storyboard } from "../storyboard/storyboard-types";

// ---- 素材裁决 ----

/** 素材来源：镜头选中资产 / 最新完成的生成记录 / 无可选 */
export type ShotVideoAssetSource = "shot-selected" | "latest-ready" | "none";

export interface ShotVideoAssetSelection {
  shotId: string;
  /** 选定的视频资产 id（未选中时为 undefined） */
  assetId?: string;
  source: ShotVideoAssetSource;
  /** 未选中时的原因说明（source = none 时给出） */
  reason?: string;
}

/**
 * 素材选择策略（文档 Phase 5：优先 shot.videoAssetId，否则最新 ready）。
 *
 * 候选回退链（确定性，禁止随机）：
 * 1. shot.videoAssetId 存在且可用 → shot-selected；
 * 2. 该镜头 "video" 类生成记录中 status = completed 且 outputAssetId 可用者，
 *    取 version 最大的一条 → latest-ready；
 * 3. 均不可用 → none（附原因）。
 *
 * @param shot 镜头（只需 id / videoAssetId）
 * @param records 该镜头的生成记录（全部 history，函数内自行过滤）
 * @param isUsable 资产可用性判定（缺省视为全部可用）
 */
export function selectShotVideoAsset(
  shot: Pick<ProductionShot, "id" | "videoAssetId">,
  records: ReadonlyArray<
    Pick<GenerationRecord, "id" | "version" | "status" | "kind" | "outputAssetId">
  >,
  isUsable: (assetId: string) => boolean = () => true,
): ShotVideoAssetSelection {
  // 1. 用户/审核选中的镜头资产
  if (shot.videoAssetId) {
    if (isUsable(shot.videoAssetId)) {
      return { shotId: shot.id, assetId: shot.videoAssetId, source: "shot-selected" };
    }
    // 选中资产失效 → 回退生成记录（「否则」语义）
  }
  // 2. 最新完成的视频生成记录（version 最大；同 version 按 id 字典序稳定）
  const candidates = records
    .filter((r) => r.kind === "video" && r.status === "completed" && !!r.outputAssetId && isUsable(r.outputAssetId))
    .sort((a, b) => (a.version !== b.version ? b.version - a.version : a.id.localeCompare(b.id)));
  const latest = candidates[0];
  if (latest?.outputAssetId) {
    return { shotId: shot.id, assetId: latest.outputAssetId, source: "latest-ready" };
  }
  // 3. 无可用素材
  const reason = shot.videoAssetId
    ? "所选视频资产不可用，且没有已就绪的生成记录"
    : "没有已就绪的视频素材（选中或完成生成的视频记录）";
  return { shotId: shot.id, source: "none", reason };
}

// ---- 排序 ----

/**
 * 项目镜头确定性排序：scene.order → storyboard.order → shot.order，
 * 三个层级均升序；任一父级缺失时排到该组之后（保持非空字段的确定序），
 * 最后以 shot.id 字典序兜底，保证任何输入顺序下输出恒一致。
 */
export function orderProjectShots(
  scenes: ReadonlyArray<Pick<ProductionScene, "id" | "order">>,
  storyboards: ReadonlyArray<Pick<Storyboard, "id" | "sceneId" | "order">>,
  shots: ReadonlyArray<ProductionShot>,
): ProductionShot[] {
  const sceneOrder = new Map(scenes.map((s) => [s.id, s.order] as const));
  const storyboardOrder = new Map(storyboards.map((s) => [s.id, s.order] as const));
  const storyboardScene = new Map(storyboards.map((s) => [s.id, s.sceneId] as const));
  const max = Number.MAX_SAFE_INTEGER;
  return [...shots].sort((a, b) => {
    const sa = sceneOrder.get(storyboardScene.get(a.storyboardId) ?? "") ?? max;
    const sb = sceneOrder.get(storyboardScene.get(b.storyboardId) ?? "") ?? max;
    if (sa !== sb) return sa - sb;
    const saO = storyboardOrder.get(a.storyboardId) ?? max;
    const sbO = storyboardOrder.get(b.storyboardId) ?? max;
    if (saO !== sbO) return saO - sbO;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });
}

// ---- 自动时间轴计划 ----

/** 计划内单个剪辑（单条 video 轨、顺序累计） */
export interface AutoTimelineClipPlan {
  shotId: string;
  assetId: string;
  /** 时间轴起点（秒，按序累计） */
  startTime: number;
  /** 持续时间（秒）＝镜头时长 */
  duration: number;
  /** 源素材内截取区间（整段语义：从 0 到镜头时长） */
  sourceStartTime: number;
  sourceDuration: number;
  /** 轨道内顺序（0 起） */
  order: number;
}

/** 无法入轨的镜头（素材缺失/时长非法） */
export interface AutoTimelineSkippedShot {
  shotId: string;
  /** 面向用户的中文原因 */
  reason: string;
}

/** 自动时间轴计划（纯数据，未落库） */
export interface AutoTimelinePlan {
  clips: AutoTimelineClipPlan[];
  skipped: AutoTimelineSkippedShot[];
  /** 计划总时长（秒，= 末条剪辑终点） */
  duration: number;
}

export interface AutoTimelinePlanInput {
  scenes: ReadonlyArray<Pick<ProductionScene, "id" | "order">>;
  storyboards: ReadonlyArray<Pick<Storyboard, "id" | "sceneId" | "order">>;
  shots: ReadonlyArray<ProductionShot>;
  /** shotId → 该镜头的视频生成记录（缺省时仅按 shot.videoAssetId 裁决） */
  recordsByShot?: ReadonlyMap<string, ReadonlyArray<GenerationRecord>>;
  /**
   * 可用视频资产 id 集合（调用方保证：存在、类型 video、同一项目）。
   * 缺省视为全部候选可用（纯裁决场景）。
   */
  usableAssetIds?: ReadonlySet<string>;
}

/**
 * 构建自动时间轴计划：排序 → 逐镜头裁决素材 → 累计 startTime 生成剪辑。
 * 无素材/时长非法的镜头跳过并记录（不阻断整体生成，保证信息可回查）。
 */
export function buildAutoTimelinePlan(input: AutoTimelinePlanInput): AutoTimelinePlan {
  const ordered = orderProjectShots(input.scenes, input.storyboards, input.shots);
  const clips: AutoTimelineClipPlan[] = [];
  const skipped: AutoTimelineSkippedShot[] = [];
  let cursor = 0;
  const isUsable = (assetId: string) => input.usableAssetIds === undefined || input.usableAssetIds.has(assetId);

  for (const shot of ordered) {
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) {
      skipped.push({ shotId: shot.id, reason: "镜头时长非法，无法入轨" });
      continue;
    }
    const records = input.recordsByShot?.get(shot.id) ?? [];
    const selection = selectShotVideoAsset(shot, records, isUsable);
    if (!selection.assetId) {
      skipped.push({ shotId: shot.id, reason: selection.reason ?? "没有已就绪的视频素材" });
      continue;
    }
    clips.push({
      shotId: shot.id,
      assetId: selection.assetId,
      startTime: cursor,
      duration: shot.duration,
      sourceStartTime: 0,
      sourceDuration: shot.duration,
      order: clips.length,
    });
    cursor += shot.duration;
  }
  return { clips, skipped, duration: cursor };
}
