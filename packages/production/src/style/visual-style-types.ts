/**
 * Visual Style 类型与纯解析（V0.3 Phase 4，实施文档 §24/§25）。
 *
 * `VisualStyleProfile` 是项目级视觉风格；`resolveVisualStyle` 按
 * Shot Override > Scene Override > Project Style > Global Default 的优先级
 * 解析出「有效风格」，保证同一项目的多个 Scene / Shot 保持统一风格。
 */
import type { ProductionProject, ProductionScene, ProductionShot } from "..";
import { validationError } from "../errors";

/** 项目视觉风格档案 */
export interface VisualStyleProfile {
  /** 风格名称（如 "Chinese fantasy cinematic"） */
  styleName?: string;
  /** 核心视觉 Prompt（继承给所有 Scene / Shot） */
  visualPrompt?: string;
  lighting?: string;
  colorTone?: string;
  cameraStyle?: string;
  renderingStyle?: string;
  negativePrompt?: string;
}

/** 场景/镜头的风格覆盖（Partial，只覆盖出现的字段） */
export type VisualStyleOverride = Partial<VisualStyleProfile>;

/** 有效风格（解析后的最终结果） */
export interface EffectiveVisualStyle {
  styleName?: string;
  visualPrompt?: string;
  lighting?: string;
  colorTone?: string;
  cameraStyle?: string;
  renderingStyle?: string;
  negativePrompt?: string;
}

/** 把视觉风格档案渲染为注入 Prompt 的「风格 Prompt 字符串」 */
export function visualStyleToPrompt(style: EffectiveVisualStyle): string | undefined {
  const parts: string[] = [];
  if (style.visualPrompt) parts.push(style.visualPrompt.trim());
  if (style.lighting) parts.push(`${style.lighting.trim()} lighting`);
  if (style.colorTone) parts.push(`${style.colorTone.trim()} color tone`);
  if (style.cameraStyle) parts.push(style.cameraStyle.trim());
  if (style.renderingStyle) parts.push(style.renderingStyle.trim());
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** 判断风格档案是否「有意义」（存在任一字段） */
function hasContent(s: Partial<VisualStyleProfile> | undefined): s is Partial<VisualStyleProfile> {
  if (!s) return false;
  return (
    (s.styleName ?? "").trim() !== "" ||
    (s.visualPrompt ?? "").trim() !== "" ||
    (s.lighting ?? "").trim() !== "" ||
    (s.colorTone ?? "").trim() !== "" ||
    (s.cameraStyle ?? "").trim() !== "" ||
    (s.renderingStyle ?? "").trim() !== "" ||
    (s.negativePrompt ?? "").trim() !== ""
  );
}

const MAX_STYLE_TEXT = 1000;

const VISUAL_STYLE_TEXT_KEYS: readonly (keyof VisualStyleProfile)[] = [
  "styleName",
  "visualPrompt",
  "lighting",
  "colorTone",
  "cameraStyle",
  "renderingStyle",
  "negativePrompt",
];

/** 校验并规范化视觉风格档案（白名单字符串字段，空对象返回 undefined）；非法结构抛 VALIDATION */
export function normalizeVisualStyleProfile(input?: unknown): VisualStyleProfile | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("视觉风格必须为对象");
  }
  const raw = input as Partial<VisualStyleProfile>;
  const profile: VisualStyleProfile = {};
  for (const key of VISUAL_STYLE_TEXT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw validationError(`视觉风格字段 ${key} 必须为字符串`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      profile[key] = trimmed.slice(0, MAX_STYLE_TEXT);
    }
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

/**
 * 按优先级合并视觉风格：Shot Override > Scene Override > Project Style > Global Default。
 * 返回合并后的有效风格；优先级高的字段覆盖低的字段（缺省继承）。
 */
export function resolveVisualStyle(input: {
  project: ProductionProject;
  scene?: ProductionScene;
  shot?: ProductionShot;
  globalDefault?: Partial<VisualStyleProfile>;
}): EffectiveVisualStyle {
  const projectStyle = input.project.settings?.visualStyle;
  // 项目层：结构化 visualStyle 优先；无 visualPrompt 时回退到 legacy settings.style 字符串，
  // 保证旧数据（仅 style 字符串）继续生效。
  const projectLayer: Partial<VisualStyleProfile> = hasContent(projectStyle) ? { ...projectStyle } : {};
  if (!projectLayer.visualPrompt && input.project.settings?.style) {
    projectLayer.visualPrompt = input.project.settings.style;
  }
  // 各层按优先级从低到高合并（后写覆盖先写）：Global → Project → Scene → Shot
  const layers: Array<Partial<VisualStyleProfile> | undefined> = [
    input.globalDefault,
    hasContent(projectLayer) ? projectLayer : undefined,
    hasContent(input.scene?.visualStyle) ? input.scene?.visualStyle : undefined,
    hasContent(input.shot?.visualStyle) ? input.shot?.visualStyle : undefined,
  ];

  const effective: EffectiveVisualStyle = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.styleName !== undefined && layer.styleName.trim() !== "") effective.styleName = layer.styleName.trim();
    if (layer.visualPrompt !== undefined && layer.visualPrompt.trim() !== "") effective.visualPrompt = layer.visualPrompt.trim();
    if (layer.lighting !== undefined && layer.lighting.trim() !== "") effective.lighting = layer.lighting.trim();
    if (layer.colorTone !== undefined && layer.colorTone.trim() !== "") effective.colorTone = layer.colorTone.trim();
    if (layer.cameraStyle !== undefined && layer.cameraStyle.trim() !== "") effective.cameraStyle = layer.cameraStyle.trim();
    if (layer.renderingStyle !== undefined && layer.renderingStyle.trim() !== "") effective.renderingStyle = layer.renderingStyle.trim();
    if (layer.negativePrompt !== undefined && layer.negativePrompt.trim() !== "") effective.negativePrompt = layer.negativePrompt.trim();
  }
  return effective;
}
