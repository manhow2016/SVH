/**
 * Production Scene 类型（文档 §6.4）。
 */
import type { VisualStyleOverride } from "../style/visual-style-types";

export interface ProductionScene {
  id: string;
  projectId: string;
  /** V0.3 多集：所属集（production_episodes.id；缺省归入项目第 1 集） */
  episodeId?: string;
  /** 关联剧本（production_scripts.id，可选） */
  scriptId?: string;
  /** 出场顺序（0 起，同一项目内唯一排序键） */
  order: number;
  name: string;
  description: string;
  location?: string;
  time?: string;
  /** 出场角色（存角色 id 列表，引用 production_characters.id） */
  characters: string[];
  /** V0.3 Phase 4：场景级视觉风格覆盖（覆盖项目风格的部分字段） */
  visualStyle?: VisualStyleOverride;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入 */
export interface CreateSceneInput {
  projectId: string;
  /** 所属集（缺省归入项目第 1 集） */
  episodeId?: string;
  name: string;
  description: string;
  scriptId?: string;
  order?: number;
  location?: string;
  time?: string;
  characters?: string[];
  visualStyle?: VisualStyleOverride;
}

/** 更新输入 */
export type UpdateSceneInput = Partial<
  Pick<
    ProductionScene,
    "name" | "description" | "scriptId" | "order" | "location" | "time" | "characters" | "visualStyle"
  >
>;
