/**
 * 文本类技能：text.generate / requirement.analyze / script.generate
 *
 * 这三个技能都通过 `deps.models.invoke()` 调用模型，**不直接接触任何 Provider**
 * （技术文档原则 4：模型调用统一经过 Model Router）。
 *
 * 结构化输出的做法：
 * - 使用 Model Router 的 `responseSchema`（JSON Schema）约束模型输出
 * - 拿到 `result.data` 后**再做一次应用层校验**，而不盲信模型
 *   （审计结论：不能只依赖 response_format，需要真正的 Schema 校验）
 */
import {
  contentMetadataSchema,
  CONTENT_TYPES,
  ModelBadOutputError,
  ValidationError,
  type ContentType,
} from '@svh/domain';

import type { SkillExecutionContext } from '../runtime/ports.js';
import type { SkillExecutionOutput, SkillImplementation } from '../runtime/registry.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(input: Record<string, unknown>, key: string, skillId: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${skillId} 需要非空的 ${key} 参数`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* text.generate                                                              */
/* -------------------------------------------------------------------------- */

interface TextGenerateInput {
  prompt: string;
  system?: string;
  responseSchema?: Record<string, unknown>;
  /** 结构化输出的用途标记，用于日志与结果卡片标题 */
  label?: string;
}

export const textGenerateSkill: SkillImplementation<TextGenerateInput> = {
  id: 'text.generate',

  normalizeInput(input) {
    return {
      prompt: requireString(input, 'prompt', 'text.generate'),
      ...(typeof input.system === 'string' ? { system: input.system } : {}),
      ...(isPlainObject(input.responseSchema) ? { responseSchema: input.responseSchema } : {}),
      ...(typeof input.label === 'string' ? { label: input.label } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '正在生成文本');
    await ctx.step('编译提示词', { promptLength: input.prompt.length });

    const prompt = input.system !== undefined ? `${input.system}\n\n${input.prompt}` : input.prompt;

    await ctx.reportProgress(30, '正在调用模型');
    const result = await ctx.deps.models.invoke({
      capability: 'text',
      prompt,
      params: {},
      referenceImages: [],
      ...(input.responseSchema !== undefined ? { responseSchema: input.responseSchema } : {}),
    });

    await ctx.step('模型返回', {
      modelId: result.modelId,
      latencyMs: result.latencyMs,
      fallbackUsed: result.fallbackUsed,
    });
    await ctx.reportProgress(90, '正在整理结果');

    // 结构化输出时校验模型确实给了数据，避免上层拿到 undefined 后静默出错
    if (input.responseSchema !== undefined && result.data === undefined) {
      throw new ModelBadOutputError('模型未按约定的结构返回数据', {
        context: { skillId: 'text.generate', modelId: result.modelId },
      });
    }

    const text = result.text ?? '';
    await ctx.reportProgress(100, '文本已生成');

    return {
      output: {
        text,
        ...(result.data !== undefined ? { data: result.data as Record<string, unknown> } : {}),
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        ...(result.fallbackNote !== undefined ? { fallbackNote: result.fallbackNote } : {}),
      },
      summary: input.label !== undefined ? `${input.label}已完成。` : '文本已生成。',
    };
  },
};

/* -------------------------------------------------------------------------- */
/* requirement.analyze                                                        */
/* -------------------------------------------------------------------------- */

/** 需求解析的结构化输出契约 */
const REQUIREMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    content_type: {
      type: 'string',
      enum: [...CONTENT_TYPES],
      description: '识别出的内容类型',
    },
    duration: { type: 'number', description: '目标时长（秒）' },
    aspectRatio: { type: 'string', description: '画幅比例，如 9:16' },
    platform: { type: 'string', description: '目标平台标识' },
    audience: { type: 'string', description: '目标受众' },
    style: { type: 'array', items: { type: 'string' }, description: '风格关键词' },
    subject: { type: 'string', description: '主题对象，如产品名' },
    goal: { type: 'string', description: '创作目标' },
    episodes: { type: 'number', description: '剧集数（短剧适用）' },
    genre: { type: 'string', description: '题材（短剧适用）' },
    sellingPoints: { type: 'array', items: { type: 'string' }, description: '产品卖点' },
  },
  required: ['content_type', 'goal'],
};

export interface RequirementAnalysis {
  content_type: ContentType;
  goal: string;
  duration?: number;
  aspectRatio?: string;
  platform?: string;
  audience?: string;
  style?: string[];
  subject?: string;
  episodes?: number;
  genre?: string;
  sellingPoints?: string[];
}

interface RequirementAnalyzeInput {
  brief: string;
  productSlugs?: string[];
  audience?: string;
  platform?: string;
  duration?: number;
  style?: string[];
}

export const requirementAnalyzeSkill: SkillImplementation<RequirementAnalyzeInput> = {
  id: 'requirement.analyze',

  normalizeInput(input) {
    return {
      brief: requireString(input, 'brief', 'requirement.analyze'),
      ...(Array.isArray(input.productSlugs)
        ? { productSlugs: input.productSlugs.filter((s): s is string => typeof s === 'string') }
        : {}),
      ...(typeof input.audience === 'string' ? { audience: input.audience } : {}),
      ...(typeof input.platform === 'string' ? { platform: input.platform } : {}),
      ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
      ...(Array.isArray(input.style)
        ? { style: input.style.filter((s): s is string => typeof s === 'string') }
        : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(15, '正在理解你的需求');
    await ctx.step('装配上下文', {
      productSlugs: input.productSlugs ?? [],
      hasAudienceHint: input.audience !== undefined,
    });

    // 把项目记忆里的品牌 / 视觉规范作为约束一并给模型，
    // 这样识别结果天然符合项目调性（技术文档第 50 条 Project Memory）
    const memory = await ctx.deps.projects.getMemory(ctx.projectId);
    const styleHint = extractStyleHints(memory);

    const prompt = [
      '请分析以下创作需求，识别内容类型并提取创作参数。',
      '',
      `需求原文：${input.brief}`,
      input.audience !== undefined ? `用户已说明受众：${input.audience}` : '',
      input.platform !== undefined ? `用户已说明平台：${input.platform}` : '',
      input.duration !== undefined ? `用户已说明时长：${input.duration} 秒` : '',
      input.style !== undefined && input.style.length > 0
        ? `用户已说明风格：${input.style.join('、')}`
        : '',
      styleHint.length > 0 ? `项目既有风格约束：${styleHint.join('、')}` : '',
      '',
      '要求：duration 单位为秒；aspectRatio 使用 9:16 / 16:9 / 1:1 这类写法；',
      '若需求中未提及某字段则不要臆造，留空即可。',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    await ctx.reportProgress(40, '正在调用模型识别需求');
    const result = await ctx.deps.models.invoke({
      capability: 'text',
      prompt,
      responseSchema: REQUIREMENT_SCHEMA,
      params: { temperature: 0.2 },
      referenceImages: [],
    });

    await ctx.step('模型返回', { modelId: result.modelId, fallbackUsed: result.fallbackUsed });
    await ctx.reportProgress(80, '正在校验识别结果');

    // 应用层二次校验：不盲信模型输出
    const analysis = validateRequirement(result.data, input);

    await ctx.reportProgress(100, '需求已解析');
    await ctx.step('解析结果', { content_type: analysis.content_type });

    return {
      output: analysis as unknown as Record<string, unknown>,
      summary: `已识别为「${contentTypeLabel(analysis.content_type)}」。`,
      card: {
        type: 'result_card',
        title: '需求已解析',
        category: 'info',
        subtitle: contentTypeLabel(analysis.content_type),
        attributes: buildAnalysisAttributes(analysis),
        media: [],
        actions: [],
      } as unknown as Record<string, unknown>,
    };
  },
};

/** 从项目记忆中提取风格线索 */
function extractStyleHints(memory: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const visual = memory.visual;
  if (isPlainObject(visual)) {
    if (typeof visual.style === 'string') hints.push(visual.style);
    const keywords = visual.styleKeywords;
    if (Array.isArray(keywords)) {
      hints.push(...keywords.filter((k): k is string => typeof k === 'string'));
    }
  }
  const brand = memory.brand;
  if (isPlainObject(brand) && typeof brand.tone === 'string') hints.push(brand.tone);
  return hints;
}

/**
 * 校验并收敛需求解析结果。
 *
 * 处理两类问题：
 * 1. 模型给出非法 content_type → 按关键词回退推断，而不是直接失败
 * 2. 用户明确说了参数 → 以用户为准（模型可能忽略提示）
 */
export function validateRequirement(
  raw: unknown,
  fallback: { audience?: string; platform?: string; duration?: number; style?: string[] },
): RequirementAnalysis {
  if (!isPlainObject(raw)) {
    throw new ModelBadOutputError('需求解析结果不是对象', { context: { skillId: 'requirement.analyze' } });
  }

  const rawType = raw.content_type;
  const contentType: ContentType =
    typeof rawType === 'string' && (CONTENT_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ContentType)
      : 'advertisement';

  const goal = typeof raw.goal === 'string' && raw.goal.length > 0 ? raw.goal : '创作内容';

  const analysis: RequirementAnalysis = { content_type: contentType, goal };

  // 用户显式提供的值优先于模型推断
  const duration = fallback.duration ?? (typeof raw.duration === 'number' ? raw.duration : undefined);
  if (duration !== undefined && duration > 0) analysis.duration = duration;

  const audience = fallback.audience ?? (typeof raw.audience === 'string' ? raw.audience : undefined);
  if (audience !== undefined && audience.length > 0) analysis.audience = audience;

  const platform = fallback.platform ?? (typeof raw.platform === 'string' ? raw.platform : undefined);
  if (platform !== undefined && platform.length > 0) analysis.platform = platform;

  const style = fallback.style ?? asStringArray(raw.style);
  if (style !== undefined && style.length > 0) analysis.style = style;

  if (typeof raw.aspectRatio === 'string' && raw.aspectRatio.length > 0) {
    analysis.aspectRatio = raw.aspectRatio;
  }
  if (typeof raw.subject === 'string' && raw.subject.length > 0) analysis.subject = raw.subject;
  const sellingPoints = asStringArray(raw.sellingPoints);
  if (sellingPoints !== undefined && sellingPoints.length > 0) {
    analysis.sellingPoints = sellingPoints;
  }

  // ── 类型约束归一化 ──
  // 模型（尤其是 Mock 与较小的真实模型）会给所有字段都填上值，
  // 于是短视频也会被塞进「66 集」这种无意义数据。
  // 这里按内容类型剔除不适用的字段，保证下游拿到的数据是自洽的。
  applyContentTypeConstraints(analysis);

  return analysis;
}

/**
 * 按内容类型剔除不适用的字段。
 *
 * 规则来自技术文档第 2 节对各内容类型的定义：
 * - 只有短剧有「集数」概念
 * - 「题材」主要对短剧 / 宣传片有意义
 * - 「产品卖点」只在涉及产品的场景（广告 / 短视频 / 数字人）出现
 */
export function applyContentTypeConstraints(analysis: RequirementAnalysis): void {
  const type = analysis.content_type;

  if (type !== 'short_drama') {
    // 短剧以外的类型都是一条独立内容：
    // - 没有「分集」概念（短视频 / 广告 / 数字人 / 宣传片都是单条）
    // - 没有「题材」概念（题材是剧集语境下的分类）
    delete analysis.episodes;
    delete analysis.genre;
  }

  if (type === 'visual_content' || type === 'promo') {
    // 纯视觉与宣传片不涉及产品卖点清单
    delete analysis.sellingPoints;
  }

  if (type === 'short_drama') {
    // 短剧的时长是「单集时长」，不带卖点
    delete analysis.sellingPoints;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function contentTypeLabel(type: ContentType): string {
  const labels: Record<ContentType, string> = {
    short_video: '短视频',
    advertisement: '广告',
    short_drama: '短剧',
    digital_human: '数字人',
    promo: '宣传片',
    visual_content: '视觉内容',
  };
  return labels[type];
}

function buildAnalysisAttributes(analysis: RequirementAnalysis): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (analysis.duration !== undefined) rows.push(['时长', `${analysis.duration} 秒`]);
  if (analysis.aspectRatio !== undefined) rows.push(['画幅', analysis.aspectRatio]);
  if (analysis.platform !== undefined) rows.push(['平台', analysis.platform]);
  if (analysis.audience !== undefined) rows.push(['受众', analysis.audience]);
  if (analysis.style !== undefined) rows.push(['风格', analysis.style.join('、')]);
  if (analysis.episodes !== undefined) rows.push(['集数', `${analysis.episodes} 集`]);
  if (analysis.genre !== undefined) rows.push(['题材', analysis.genre]);
  return rows.slice(0, 6);
}

/* -------------------------------------------------------------------------- */
/* script.generate                                                            */
/* -------------------------------------------------------------------------- */

/** 脚本的结构化输出契约：镜头列表 + 解说词 */
const SCRIPT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    logline: { type: 'string' },
    narration: { type: 'string', description: '整条内容的解说词 / 旁白' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          duration: { type: 'number' },
          shotSize: { type: 'string', description: '景别，如 特写 / 中景 / 全景' },
          cameraMove: { type: 'string', description: '运镜，如 缓推 / 横移' },
          description: { type: 'string', description: '画面内容描述' },
          imagePrompt: { type: 'string', description: '用于出图的画面提示词' },
          narration: { type: 'string', description: '该镜头的解说词' },
        },
        required: ['index', 'description'],
      },
    },
  },
  required: ['shots'],
};

export interface GeneratedShot {
  index: number;
  description: string;
  duration?: number;
  shotSize?: string;
  cameraMove?: string;
  imagePrompt?: string;
  narration?: string;
}

interface ScriptGenerateInput {
  brief: string;
  duration?: number;
  platform?: string;
  style?: string[];
  /** 镜头数量提示；不填则由模型按时长推断 */
  shotCount?: number;
}

export const scriptGenerateSkill: SkillImplementation<ScriptGenerateInput> = {
  id: 'script.generate',

  normalizeInput(input) {
    return {
      brief: requireString(input, 'brief', 'script.generate'),
      ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
      ...(typeof input.platform === 'string' ? { platform: input.platform } : {}),
      ...(Array.isArray(input.style)
        ? { style: input.style.filter((s): s is string => typeof s === 'string') }
        : {}),
      ...(typeof input.shotCount === 'number' ? { shotCount: input.shotCount } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '正在准备脚本生成');
    const memory = await ctx.deps.projects.getMemory(ctx.projectId);
    const styleHints = extractStyleHints(memory);

    const duration = input.duration ?? 30;
    // 单镜头 3~6 秒是短视频 / 广告的常见节奏，据此给出镜头数建议
    const suggestedShots = input.shotCount ?? Math.max(3, Math.min(12, Math.round(duration / 4)));

    const prompt = [
      `请为以下需求生成一条 ${duration} 秒内容的脚本，拆分为约 ${suggestedShots} 个镜头。`,
      '',
      `需求：${input.brief}`,
      input.platform !== undefined ? `目标平台：${input.platform}` : '',
      input.style !== undefined && input.style.length > 0 ? `风格要求：${input.style.join('、')}` : '',
      styleHints.length > 0 ? `项目既有风格：${styleHints.join('、')}` : '',
      '',
      '要求：',
      `- 每个镜头的 duration 之和应接近 ${duration} 秒`,
      '- 每个镜头都必须给出可直接用于 AI 出图的 imagePrompt（只描述画面，不含镜头术语）',
      '- 第一个镜头需要有明确的钩子，最后一个镜头要有收束感',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    await ctx.reportProgress(35, '正在调用模型生成脚本');
    const result = await ctx.deps.models.invoke({
      capability: 'script',
      prompt,
      responseSchema: SCRIPT_SCHEMA,
      params: { temperature: 0.7 },
      referenceImages: [],
    });

    await ctx.step('模型返回', { modelId: result.modelId, latencyMs: result.latencyMs });
    await ctx.reportProgress(80, '正在校验脚本结构');

    const shots = validateShots(result.data);
    if (shots.length === 0) {
      throw new ModelBadOutputError('模型未产出任何镜头，无法继续', {
        context: { skillId: 'script.generate', modelId: result.modelId },
      });
    }

    const data = isPlainObject(result.data) ? result.data : {};
    const narration = typeof data.narration === 'string' ? data.narration : '';
    const totalDuration = shots.reduce((sum, s) => sum + (s.duration ?? 0), 0);

    await ctx.reportProgress(100, '脚本已生成');
    await ctx.step('脚本概况', { shotCount: shots.length, totalDuration });

    return {
      output: {
        title: typeof data.title === 'string' ? data.title : undefined,
        logline: typeof data.logline === 'string' ? data.logline : undefined,
        narration,
        shots: shots as unknown as Record<string, unknown>[],
        shotCount: shots.length,
        totalDuration,
        modelId: result.modelId,
        ...(result.fallbackNote !== undefined ? { fallbackNote: result.fallbackNote } : {}),
      },
      summary: `已生成 ${shots.length} 个镜头的脚本${totalDuration > 0 ? `（合计约 ${Math.round(totalDuration)} 秒）` : ''}。`,
      card: {
        type: 'result_card',
        title: '脚本已生成',
        category: 'script',
        subtitle: typeof data.title === 'string' ? data.title : `${shots.length} 个镜头`,
        attributes: [
          ['镜头数', String(shots.length)],
          ...(totalDuration > 0 ? ([['合计时长', `${Math.round(totalDuration)} 秒`]] as Array<[string, string]>) : []),
          ...(narration.length > 0 ? ([['解说词', `${narration.slice(0, 60)}${narration.length > 60 ? '…' : ''}`]] as Array<[string, string]>) : []),
        ],
        media: [],
        actions: [
          { id: 'next', label: '继续生成分镜', kind: 'primary', message: '继续生成分镜' },
          { id: 'edit', label: '修改脚本', kind: 'secondary', message: '我想修改脚本' },
          { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成脚本' },
        ],
      } as unknown as Record<string, unknown>,
    };
  },
};

/** 校验并规范化镜头列表，丢弃结构不合法的条目而不是整体失败 */
export function validateShots(raw: unknown): GeneratedShot[] {
  if (!isPlainObject(raw)) {
    throw new ModelBadOutputError('脚本结果不是对象', { context: { skillId: 'script.generate' } });
  }
  const list = raw.shots;
  if (!Array.isArray(list)) {
    throw new ModelBadOutputError('脚本结果缺少 shots 数组', {
      context: { skillId: 'script.generate' },
    });
  }

  const shots: GeneratedShot[] = [];
  list.forEach((item, position) => {
    if (!isPlainObject(item)) return;
    const description = item.description;
    if (typeof description !== 'string' || description.length === 0) return;

    const index = typeof item.index === 'number' && item.index > 0 ? Math.floor(item.index) : position + 1;
    shots.push({
      index,
      description,
      ...(typeof item.duration === 'number' && item.duration > 0 ? { duration: item.duration } : {}),
      ...(typeof item.shotSize === 'string' ? { shotSize: item.shotSize } : {}),
      ...(typeof item.cameraMove === 'string' ? { cameraMove: item.cameraMove } : {}),
      ...(typeof item.imagePrompt === 'string' ? { imagePrompt: item.imagePrompt } : {}),
      ...(typeof item.narration === 'string' ? { narration: item.narration } : {}),
    });
  });

  // 按 index 排序，并使用序号稳定的顺序，避免模型乱序导致后续步骤错位
  return shots.sort((a, b) => a.index - b.index);
}

/** 供其它模块复用：把需求解析结果转成内容 metadata */
export function analysisToContentMetadata(analysis: RequirementAnalysis): Record<string, unknown> {
  const parsed = contentMetadataSchema.safeParse({
    ...(analysis.duration !== undefined ? { duration: analysis.duration } : {}),
    ...(analysis.aspectRatio !== undefined ? { aspectRatio: analysis.aspectRatio } : {}),
    ...(analysis.platform !== undefined ? { platform: analysis.platform } : {}),
    ...(analysis.audience !== undefined ? { audience: analysis.audience } : {}),
    ...(analysis.style !== undefined ? { style: analysis.style } : {}),
    ...(analysis.episodes !== undefined ? { episodes: analysis.episodes } : {}),
    ...(analysis.genre !== undefined ? { genre: analysis.genre } : {}),
  });
  return parsed.success ? (parsed.data as Record<string, unknown>) : {};
}
