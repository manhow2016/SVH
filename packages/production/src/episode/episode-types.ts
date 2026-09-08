/**
 * Production Episode 领域类型（短剧多集，V0.3）。
 *
 * 项目 Project → Episode(1..n)：每集拥有独立的剧本/场景/分镜/镜头/成片时间轴；
 * 角色与媒体资产跨集共享（挂在 Project 上）。
 * 历史兼容：episode_id 允许为空（未挂集数据），新代码一律写入具体集。
 */

export interface ProductionEpisode {
  id: string;
  projectId: string;
  /** 集号（1 起，升序）；集名缺省「第 N 集」 */
  order: number;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建输入（name 缺省由 Service 依集号生成） */
export interface CreateEpisodeInput {
  projectId: string;
  name?: string;
  description?: string;
  /** 集号（缺省 = 当前最大 + 1，从 1 起） */
  order?: number;
}

/** 更新输入 */
export type UpdateEpisodeInput = Partial<Pick<ProductionEpisode, "name" | "description" | "order">>;
