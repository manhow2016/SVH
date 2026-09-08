/**
 * Production Context 类型（V0.3 Phase 1）。
 *
 * Production Context 是「面向 Agent 的上下文投影」，不是 Database Entity。
 * 只承载 Agent 完成任务所需的最小生产信息，避免把整个 Production Project
 * 序列化塞进 LLM Context（实施文档 §5 / §45：按 Agent、按任务加载）。
 *
 * 字段以当前 Production Domain 真实实体为准（实施文档 §6 要求：禁止复制数据模型，
 * 这里是面向 Agent 的投影）。后续 Phase 3/4 会在此扩展 Character Visual Profile
 * / Visual Style Profile，本阶段只提供基础投影与渲染。
 */
import type { Character } from "../character/character-types";
import { deriveCharacterPromptAnchor } from "../character/character-anchor";
import type { ProductionAsset } from "../asset/asset-types";
import type { ProductionProject } from "../project/project-types";
import type { ProductionScene } from "../scene/scene-types";
import type { ProductionScript } from "../script/script-types";
import type { ProductionShot } from "../shot/shot-types";
import type { Storyboard } from "../storyboard/storyboard-types";

/** 当前支持注入生产上下文的 Agent 角色（决定加载范围） */
export type ProductionContextRole = "director" | "script" | "storyboard";

/** 项目上下文投影 */
export interface ProjectContext {
  projectId: string;
  name: string;
  type: string;
  status: string;
  description?: string;
  /** 目标时长（秒，来自 settings.duration，可能缺失） */
  targetDuration?: number;
  /** 视觉/叙事风格（来自 settings.style，可能缺失） */
  visualStyle?: string;
}

/** 剧本上下文投影（一次只带一个版本：优先已审核，否则最新） */
export interface ScriptContext {
  scriptId: string;
  title: string;
  version: number;
  status: string;
  /** 正文（渲染时按上限截断，防爆 Context token） */
  content: string;
  /** 摘要（本阶段置空，预留后续 Script Summary） */
  summary?: string;
}

/** 角色上下文投影（Phase 1 只映射现有字段；Phase 3 增加 Visual Profile/Anchor） */
export interface CharacterContext {
  characterId: string;
  name: string;
  description?: string;
  personality?: string;
  appearance?: {
    gender?: string;
    age?: string;
    hairstyle?: string;
    clothing?: string;
    facialFeatures?: string;
    style?: string;
  };
  /** V0.3 Phase 3：稳定 Prompt Anchor（保证跨镜头一致） */
  anchor?: string;
  /** 外观视觉 Prompt（visualProfile.appearancePrompt） */
  visualPrompt?: string;
  /** 参考图资产 id 列表（visualProfile.referenceAssetIds） */
  referenceAssetIds?: string[];
}

/** 场景上下文投影 */
export interface SceneContext {
  sceneId: string;
  order: number;
  name: string;
  description: string;
  location?: string;
  time?: string;
  /** 出场角色名（渲染时由角色名解析） */
  characters: string[];
}

/** 分镜上下文投影（本阶段只带现有分镜，不加载全部分镜） */
export interface StoryboardContext {
  storyboardId: string;
  sceneId: string;
  order: number;
  description: string;
  shotType: string;
  duration: number;
  cameraMovement?: string;
}

/** 镜头上下文投影（Phase 6 编排会用到，Phase 1 预留） */
export interface ShotContext {
  shotId: string;
  storyboardId: string;
  order: number;
  duration: number;
  framing?: string;
  cameraMovement?: string;
  action?: string;
  dialogue?: string;
  status: string;
}

/** Reference Asset 投影（Phase 3 会扩展为 ReferenceResolver 输入） */
export interface AssetReferenceContext {
  assetId: string;
  type: string;
  name: string;
}

/**
 * Production Context（面向 Agent 的投影聚合）。
 * 只包含 resolver 按角色加载的有意义部分；空集合用缺省空数组。
 */
export interface ProductionContext {
  project: ProjectContext;
  script?: ScriptContext;
  characters: CharacterContext[];
  scenes: SceneContext[];
  storyboards: StoryboardContext[];
  shots: ShotContext[];
}

// ================= 映射（实体 → 投影） =================

export function mapProjectContext(project: ProductionProject): ProjectContext {
  return {
    projectId: project.id,
    name: project.name,
    type: project.type,
    status: project.status,
    description: project.description,
    targetDuration: project.settings?.duration,
    visualStyle: project.settings?.style,
  };
}

export function mapScriptContext(script: ProductionScript): ScriptContext {
  return {
    scriptId: script.id,
    title: script.title,
    version: script.version,
    status: script.status,
    content: script.content,
  };
}

export function mapCharacterContext(character: Character): CharacterContext {
  const ctx: CharacterContext = {
    characterId: character.id,
    name: character.name,
    description: character.description !== "" ? character.description : undefined,
    personality: character.personality,
    // V0.3 Phase 3：直接派生稳定 Prompt Anchor（保证跨镜头一致）
    anchor: deriveCharacterPromptAnchor(character) || undefined,
    visualPrompt: character.visualProfile?.appearancePrompt,
    referenceAssetIds: character.visualProfile?.referenceAssetIds,
  };
  if (
    character.appearance &&
    Object.keys(character.appearance).some((k) => character.appearance[k as keyof typeof character.appearance])
  ) {
    ctx.appearance = { ...character.appearance };
  }
  return ctx;
}

export function mapSceneContext(scene: ProductionScene, characterNames: Map<string, string>): SceneContext {
  return {
    sceneId: scene.id,
    order: scene.order,
    name: scene.name,
    description: scene.description,
    location: scene.location,
    time: scene.time,
    characters: scene.characters.map((id) => characterNames.get(id) ?? id),
  };
}

export function mapStoryboardContext(storyboard: Storyboard): StoryboardContext {
  return {
    storyboardId: storyboard.id,
    sceneId: storyboard.sceneId,
    order: storyboard.order,
    description: storyboard.description,
    shotType: storyboard.shotType,
    duration: storyboard.duration,
    cameraMovement: storyboard.cameraMovement,
  };
}

export function mapShotContext(shot: ProductionShot): ShotContext {
  return {
    shotId: shot.id,
    storyboardId: shot.storyboardId,
    order: shot.order,
    duration: shot.duration,
    framing: shot.framing,
    cameraMovement: shot.cameraMovement,
    action: shot.action,
    dialogue: shot.dialogue,
    status: shot.status,
  };
}

export function mapAssetReferenceContext(asset: ProductionAsset): AssetReferenceContext {
  return { assetId: asset.id, type: asset.type, name: asset.name };
}

/** 抽取角色 id → 名称映射（供场景投影解析出场角色名） */
export function buildCharacterNameMap(characters: Character[]): Map<string, string> {
  return new Map(characters.map((c) => [c.id, c.name]));
}
