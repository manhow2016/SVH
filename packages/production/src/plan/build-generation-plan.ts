/**
 * 生成计划构建（V0.3 Phase 6）。
 *
 * 把给定镜头集合转为 GenerationPlan：每镜头一张 image 项；
 * 若镜头已有 imageAssetId（图生视频首帧）则追加一个依赖该 image 的 video 项。
 * 计划是纯描述（不触达 Provider / 队列），执行由 server 编排器入队。
 */
import type { ProductionShot } from "../shot/shot-types";
import type { GenerationPlan, GenerationPlanItem, GenerationPlanScope } from "./plan-types";
import { planItemId } from "./plan-types";

export interface BuildGenerationPlanOptions {
  /** 是否在镜头已有首帧图时生成 video 项（默认 true） */
  includeVideo?: boolean;
}

export function buildGenerationPlan(
  projectId: string,
  shots: ProductionShot[],
  scope: GenerationPlanScope = {},
  options: BuildGenerationPlanOptions = {},
): GenerationPlan {
  const sorted = [...shots].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const items: GenerationPlanItem[] = [];

  for (const shot of sorted) {
    const imageId = planItemId(shot.id, "image");
    items.push({
      id: imageId,
      shotId: shot.id,
      storyboardId: shot.storyboardId,
      type: "image",
      priority: shot.order,
      dependencies: [],
      status: "pending",
    });
    // 图生视频：已有首帧图 → 追加 video 项（依赖该镜头的 image 项）
    if (options.includeVideo !== false && shot.imageAssetId) {
      items.push({
        id: planItemId(shot.id, "video"),
        shotId: shot.id,
        storyboardId: shot.storyboardId,
        type: "video",
        priority: shot.order,
        dependencies: [imageId],
        status: "pending",
      });
    }
  }

  return { projectId, scope, items };
}
