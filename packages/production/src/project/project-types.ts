/**
 * Production Project 类型（文档 §6.1）。
 *
 * Project 是短剧生产项目的根聚合：一个 Workspace 可有多个 Project，
 * 每个 Project 下挂 Script / Characters / Scenes / Storyboards / Shots / Assets。
 */
export type ProjectType = "short_video" | "short_drama" | "animation" | "advertisement";

export type ProjectStatus = "draft" | "planning" | "producing" | "completed" | "archived";

/** 项目生产设置（目标时长 / 风格 / 生成配置等，域内只存数据不做消费） */
export interface ProductionProjectSettings {
  /** 目标时长（秒） */
  duration?: number;
  /** 视觉/叙事风格，如 "chinese_fantasy" */
  style?: string;
  /** AI 生成相关配置（模型、供应商等信息由 server 侧生成服务解析） */
  generation?: Record<string, unknown>;
}

export interface ProductionProject {
  id: string;
  workspaceId: string;
  /** 冗余归属用户（写入时从 workspace 行取值，便于隔离查询与未来团队协作） */
  userId: string;
  name: string;
  description?: string;
  type: ProjectType;
  status: ProjectStatus;
  settings: ProductionProjectSettings;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入（userId 由 Service 依据 workspace 归属推导） */
export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  type?: ProjectType;
  description?: string;
  settings?: ProductionProjectSettings;
}

/** 更新输入（仅领域可变更字段） */
export type UpdateProjectInput = Partial<
  Pick<ProductionProject, "name" | "description" | "type" | "status" | "settings">
>;
