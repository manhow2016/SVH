/**
 * Storyboard 类型（文档 §6.5）。
 */
export type StoryboardStatus = "draft" | "approved";

export interface Storyboard {
  id: string;
  projectId: string;
  sceneId: string;
  order: number;
  description: string;
  /** 分镜时长（秒） */
  duration: number;
  /** 景别/运镜类型，如 "medium_shot"、"slow_push_in" */
  shotType: string;
  cameraMovement?: string;
  /** 文生图提示词（SceneGen 阶段产出） */
  imagePrompt?: string;
  /** 文生视频提示词 */
  videoPrompt?: string;
  status: StoryboardStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入 */
export interface CreateStoryboardInput {
  projectId: string;
  sceneId: string;
  description: string;
  duration: number;
  shotType: string;
  order?: number;
  cameraMovement?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  status?: StoryboardStatus;
}

/** 更新输入 */
export type UpdateStoryboardInput = Partial<
  Pick<
    Storyboard,
    | "description"
    | "duration"
    | "shotType"
    | "cameraMovement"
    | "imagePrompt"
    | "videoPrompt"
    | "order"
    | "status"
  >
>;
