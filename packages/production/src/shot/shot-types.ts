/**
 * Production Shot 类型（文档 §6.6）。
 *
 * Storyboard 与 Shot 允许分离：一个分镜可对应多个镜头（多机位/多段）。
 * 关系：Scene → Storyboard → Shot[*]。
 */
export type ShotStatus = "pending" | "generating" | "ready" | "failed";

export interface ProductionShot {
  id: string;
  projectId: string;
  storyboardId: string;
  order: number;
  /** 镜头时长（秒），同一分镜下各镜头时长之和不得超过分镜时长 */
  duration: number;
  framing?: string;
  cameraMovement?: string;
  action?: string;
  dialogue?: string;
  /** 图生视频用的参考图资产（production_assets.id） */
  imageAssetId?: string;
  /** 生成结果视频资产（production_assets.id） */
  videoAssetId?: string;
  status: ShotStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入 */
export interface CreateShotInput {
  projectId: string;
  storyboardId: string;
  duration: number;
  order?: number;
  framing?: string;
  cameraMovement?: string;
  action?: string;
  dialogue?: string;
}

/** 更新输入 */
export type UpdateShotInput = Partial<
  Pick<
    ProductionShot,
    | "duration"
    | "order"
    | "framing"
    | "cameraMovement"
    | "action"
    | "dialogue"
    | "imageAssetId"
    | "videoAssetId"
    | "status"
  >
>;
