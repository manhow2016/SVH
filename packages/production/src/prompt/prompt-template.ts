/**
 * Prompt Template（V0.3 Phase 2，实施文档 §17）。
 *
 * 定义 Image/Video 的 Prompt 段组合顺序、连接符与全局 Negative。
 * 支持 Global / Project / Style / Provider 模板叠加的抽象基础：
 * 目前提供一套默认模板（Global），后续可针对项目/风格/供应商扩展模板 id。
 */
import type { PromptPartKey } from "./prompt-types";

export const DEFAULT_IMAGE_ORDER: PromptPartKey[] = [
  "style",
  "scene",
  "characters",
  "shot",
  "camera",
  "action",
  "raw",
];

/** 视频以动作/相机为主，但基础顺序一致（可由调用方覆盖） */
export const DEFAULT_VIDEO_ORDER: PromptPartKey[] = [
  "style",
  "scene",
  "characters",
  "shot",
  "camera",
  "action",
  "raw",
];

/** 通用负面词（质量/形变/文字等常见瑕疵） */
export const DEFAULT_GLOBAL_NEGATIVE = [
  "blurry",
  "low quality",
  "deformed",
  "bad anatomy",
  "extra fingers",
  "extra limbs",
  "watermark",
  "text",
  "logo",
  "oversaturated",
  "jpeg artifacts",
  "out of frame",
];

/** Prompt 模板：决定段顺序、连接符与全局 negative */
export interface PromptTemplate {
  id: string;
  imageOrder: PromptPartKey[];
  videoOrder: PromptPartKey[];
  /** 段间连接符（默认 ", "） */
  separator: string;
  /** 全局负面词（与风格/角色/调用方负面词叠加去重） */
  globalNegative: string[];
}

/** 默认模板 */
export const DEFAULT_PROMPT_TEMPLATE: PromptTemplate = {
  id: "default",
  imageOrder: DEFAULT_IMAGE_ORDER,
  videoOrder: DEFAULT_VIDEO_ORDER,
  separator: ", ",
  globalNegative: DEFAULT_GLOBAL_NEGATIVE,
};
