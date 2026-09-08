/**
 * Prompt Composition 类型（V0.3 Phase 2）。
 *
 * Prompt Composer 的输入/输出契约，纯领域、无 HTTP / 无生产实体依赖。
 * 目的是统一所有 Image/Video 生成的 Prompt 组合，禁止在
 * GenerationService / Worker / Agent / Provider 里各自拼字符串
 * （实施文档 §13.2 / §18）。
 */

/** Prompt 段按键（决定组合顺序） */
export type PromptPartKey =
  | "style"
  | "scene"
  | "characters"
  | "shot"
  | "camera"
  | "action"
  | "raw";

/** 角色 Prompt 片段（后续 Phase 3 会填 anchor/visualPrompt） */
export interface CharacterPromptSnippet {
  name: string;
  /** 角色 Prompt Anchor（稳定描述段，用于一致性） */
  anchor?: string;
  /** 角色视觉 Prompt */
  visualPrompt?: string;
  /** 角色描述（用于零 Anchor 时的兜底） */
  description?: string;
}

/** 场景 Prompt 片段 */
export interface ScenePromptSnippet {
  description?: string;
  location?: string;
  time?: string;
  visualPrompt?: string;
}

/** 镜头 Prompt 片段 */
export interface ShotPromptSnippet {
  description?: string;
  action?: string;
  framing?: string;
  cameraMovement?: string;
  dialogue?: string;
}

/** 图像生成组合输入 */
export interface ImagePromptContext {
  /** 用户/Agent 提供的原始描述（可选；如给了结构化 shot then 以结构为主） */
  rawPrompt?: string;
  /** 项目视觉风格（settings.style 或 VisualStyleProfile.visualPrompt） */
  projectStyle?: string;
  scene?: ScenePromptSnippet;
  characters?: CharacterPromptSnippet[];
  shot?: ShotPromptSnippet;
  /** 额外 negative（来自调用方/角色/风格） */
  negativePrompt?: string;
  /** 元数据回填（供 replay / review / debug） */
  projectId?: string;
  shotId?: string;
  sceneId?: string;
  characterIds?: string[];
  providerId?: string;
}

/** 视频生成组合输入（在 Image 基础上扩充动作/相机） */
export interface VideoPromptContext extends ImagePromptContext {
  /** 动作/运动描述 */
  actionPrompt?: string;
  /** 参考图地址（图生视频首帧） */
  imageUrl?: string;
}

/** 组合结果元数据（记录来源，便于审查/重放/调试） */
export interface PromptMetadata {
  templateId: string;
  projectId?: string;
  shotId?: string;
  sceneId?: string;
  characterIds?: string[];
  providerId?: string;
}

/** 组合结果 */
export interface ComposedPrompt {
  prompt: string;
  negativePrompt?: string;
  metadata: PromptMetadata;
}
