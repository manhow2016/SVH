import { ERRORS } from "../../lib/errors";
import type { ModelType } from "../settings/model-catalog";

export type SkillParamType = "text" | "textarea" | "number" | "select";

/** 技能输入参数定义 */
export interface SkillParamDef {
  key: string;                         // 参数键（{{key}} 占位 / 校验用）
  label: string;                       // 中文标签
  type: SkillParamType;
  /** 主文本参数：输入栏直接输入（type 须为 text/textarea） */
  primary?: boolean;
  required?: boolean;
  placeholder?: string;
  /** select 专用选项 */
  options?: Array<{ label: string; value: string }>;
  default?: string | number;
}

/** 技能结果展示类型（V1 全 text，媒体为 V2 预留） */
export type SkillResultKind = "text" | "image" | "video" | "audio";

/** 完整技能定义（仅服务端内部使用，模板不下发前端） */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  /** 允许调用的模型类型（服务端严格校验） */
  modelTypes: ModelType[];
  params: SkillParamDef[];
  systemPrompt?: string;
  /** 用户消息模板，{{key}} 占位 */
  promptTemplate: string;
  resultKind: SkillResultKind;
}

/** 前端可见的技能视图（不含提示词模板） */
export interface SkillPublicView {
  id: string;
  name: string;
  description: string;
  modelTypes: ModelType[];
  params: SkillParamDef[];
  resultKind: SkillResultKind;
}

/** V1 内置技能注册表（无管理界面，代码维护） */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "script-breakdown",
    name: "剧本拆解",
    description: "将一段文字拆解为短剧剧本",
    modelTypes: ["text"],
    resultKind: "text",
    params: [
      { key: "source_text", label: "原始文本", type: "textarea", primary: true, required: true, placeholder: "粘贴要拆解的原始文本…" },
      { key: "episodes", label: "集数", type: "number", default: 5 },
      {
        key: "format",
        label: "输出格式",
        type: "select",
        default: "script",
        options: [
          { label: "短剧剧本", value: "script" },
          { label: "分镜大纲", value: "outline" },
        ],
      },
    ],
    systemPrompt: "你是资深短剧编剧，擅长将长篇内容拆解为结构清晰、节奏紧凑的短剧剧本。",
    promptTemplate: [
      "请将以下原始文本拆解为短剧剧本：",
      "",
      "{{source_text}}",
      "",
      "要求：",
      "1. 拆分为 {{episodes}} 集，每集有清晰的开端、冲突、转折与结尾。",
      "2. 保留原文核心剧情与人物关系，可适当增补对话。",
      "3. 输出格式：{{format}}。",
    ].join("\n"),
  },
  {
    id: "storyboard",
    name: "分镜脚本",
    description: "将剧本文本拆解为分镜脚本",
    modelTypes: ["text"],
    resultKind: "text",
    params: [
      { key: "script_text", label: "剧本文本", type: "textarea", primary: true, required: true, placeholder: "粘贴剧本文本…" },
      { key: "shots", label: "镜头数量", type: "number", default: 8 },
    ],
    systemPrompt: "你是影视分镜师，负责将剧本转化为可拍摄的分镜脚本。",
    promptTemplate: [
      "请将以下剧本文本拆解为分镜脚本：",
      "",
      "{{script_text}}",
      "",
      "要求：",
      "1. 输出约 {{shots}} 个镜头。",
      "2. 每个镜头包含：镜号、景别、画面内容、台词、时长。",
      "3. 使用表格形式输出。",
    ].join("\n"),
  },
];

export function getSkillById(id: string): SkillDefinition | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}

export function listSkillPublicViews(): SkillPublicView[] {
  return BUILTIN_SKILLS.map(({ id, name, description, modelTypes, params, resultKind }) => ({
    id, name, description, modelTypes, params, resultKind,
  }));
}

/**
 * 校验并规范化技能参数：
 * - 未知键拒绝；必填缺失拒绝；number 转数值；select 必须命中枚举。
 */
export function validateSkillParams(
  skill: SkillDefinition,
  raw: Record<string, unknown>,
): Record<string, string | number> {
  const known = new Map(skill.params.map((p) => [p.key, p]));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」未知参数：${key}`);
    }
  }

  const out: Record<string, string | number> = {};
  for (const def of skill.params) {
    const rawValue = raw[def.key];
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      if (def.primary || def.required) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」缺少必填参数：${def.label}`);
      }
      if (def.default !== undefined) {
        out[def.key] = def.default;
      }
      continue;
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数类型不合法：${def.label}`);
    }
    if (def.type === "number") {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数应为数字：${def.label}`);
      }
      out[def.key] = num;
    } else if (def.type === "select") {
      const option = def.options?.find((o) => o.value === String(rawValue));
      if (!option) {
        throw ERRORS.INVALID_INPUT(`技能「${skill.name}」参数值不合法：${def.label}`);
      }
      out[def.key] = option.value;
    } else {
      out[def.key] = String(rawValue);
    }
  }
  return out;
}

/** 渲染用户消息模板（占位符替换；模板中未提供的占位符视为定义错误，直接抛错） */
export function renderSkillPrompt(
  skill: SkillDefinition,
  params: Record<string, string | number>,
): string {
  let rendered = skill.promptTemplate;
  const matches = rendered.matchAll(/\{\{(\w+)\}\}/g);
  for (const m of matches) {
    const key = m[1]!;
    if (!(key in params)) {
      throw ERRORS.INVALID_INPUT(`技能「${skill.name}」模板缺少参数：${key}`);
    }
    rendered = rendered.replaceAll(`{{${key}}}`, String(params[key]));
  }
  return rendered;
}
