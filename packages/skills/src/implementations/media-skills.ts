/**
 * 媒体与输出类技能：edit.video / edit.brand_overlay / output.publish
 *
 * 这三个技能**不依赖任何模型**（目录中 capabilities 为空数组），
 * 属于本地计算类。Model Router 必须明确跳过它们 —— 这就是
 * `capabilities` 允许为空数组的原因（见 @svh/domain/skill.ts 的说明）。
 *
 * ── Phase 2 的边界说明 ──
 * 真正的视频合成需要 FFmpeg（音视频解码、拼接、混音、烧字幕）。
 * 本阶段**不引入 FFmpeg**，理由是：它是一个重量级系统依赖，
 * 而当前阶段要验证的是「任务链路能否跑通」，而不是编码性能。
 *
 * 因此这三个技能产出的是**真实可用的剪辑决策数据**：
 *   - `edit.video` → 生成 Edit Decision List（EDL：每个片段的入出点、时长、音轨、字幕轨）
 *   - `output.publish` → 按平台规格登记输出物，并生成交付清单
 *
 * EDL 是真实产物而非占位：Timeline（技术文档第 37 条）直接消费它，
 * 后续接入 FFmpeg 时只需把 EDL 喂给渲染器，不必重做数据结构。
 */
import { ValidationError, type CardAction, type ResultCardPayload } from '@svh/domain';

import type { SkillExecutionContext } from '../runtime/ports.js';
import type { SkillExecutionOutput, SkillImplementation } from '../runtime/registry.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从上游产出中提取资产 id：兼容 assetIds / assetId / 单对象 三种形态 */
function extractAssetIds(value: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 4 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isPlainObject(node)) return;
    const assetId = node.assetId;
    if (typeof assetId === 'string') ids.push(assetId);
    const assetIds = node.assetIds;
    if (Array.isArray(assetIds)) {
      ids.push(...assetIds.filter((v): v is string => typeof v === 'string'));
    }
    const files = node.files;
    if (Array.isArray(files)) walk(files, depth + 1);
  };
  walk(value);
  return [...new Set(ids)];
}

/* -------------------------------------------------------------------------- */
/* edit.video                                                                 */
/* -------------------------------------------------------------------------- */

/** EDL 中的一个剪辑片段 */
export interface EditClip {
  index: number;
  assetId?: string;
  /** 素材内的入点（秒） */
  inPoint: number;
  /** 素材内的出点（秒） */
  outPoint: number;
  /** 在成片时间轴上的起点（秒） */
  timelineStart: number;
  duration: number;
  /** 转场到下一片段的方式 */
  transition: 'cut' | 'fade' | 'dissolve' | 'wipe';
}

/** 字幕轨条目 */
export interface SubtitleCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** Edit Decision List：成片的完整剪辑决策 */
export interface EditDecisionList {
  version: 1;
  clips: EditClip[];
  audioTrack: { assetId?: string; volume: number; startAt: number } | null;
  subtitleTrack: SubtitleCue[];
  musicTrack: { assetId?: string; volume: number } | null;
  totalDuration: number;
  aspectRatio: string;
  /** 渲染状态：Phase 2 只产出剪辑决策，实际编码待接入渲染器 */
  renderStatus: 'pending_renderer' | 'single_source';
}

interface EditVideoInput {
  /** 上游产出：镜头 / 视频资产集合（结构自由，尽力提取） */
  video?: unknown;
  voice?: unknown;
  subtitle?: unknown;
  music?: string;
  aspectRatio?: string;
}

export const editVideoSkill: SkillImplementation<EditVideoInput> = {
  id: 'edit.video',

  normalizeInput(input) {
    return {
      ...(input.video !== undefined ? { video: input.video } : {}),
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
      ...(typeof input.music === 'string' ? { music: input.music } : {}),
      ...(typeof input.aspectRatio === 'string' ? { aspectRatio: input.aspectRatio } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '正在收集镜头素材');

    const videoAssetIds = extractAssetIds(input.video);
    const voiceAssetIds = extractAssetIds(input.voice);
    const subtitleAssetIds = extractAssetIds(input.subtitle);

    await ctx.step('素材清点', {
      videoAssets: videoAssetIds.length,
      voiceAssets: voiceAssetIds.length,
      subtitleAssets: subtitleAssetIds.length,
    });

    if (videoAssetIds.length === 0) {
      throw new ValidationError('剪辑缺少视频素材，请先完成视频生成', {
        userMessage: '还没有可剪辑的视频片段，请先生成视频。',
        suggestions: ['先执行视频生成', '检查上游镜头是否生成成功'],
        context: { skillId: 'edit.video' },
      });
    }

    await ctx.reportProgress(40, '正在排布时间轴');

    const aspectRatio = input.aspectRatio ?? (await readAspectRatio(ctx));
    // 单片段直接引用原素材（可跳过编码），多片段才需要真正的合成
    const singleSource = videoAssetIds.length === 1;

    // 镜头默认时长：从项目制作规则读取，缺失时用 5 秒（行业常见短镜头时长）
    const defaultDuration = await readDefaultShotDuration(ctx);

    let cursor = 0;
    const clips: EditClip[] = videoAssetIds.map((assetId, i) => {
      const clip: EditClip = {
        index: i + 1,
        assetId,
        inPoint: 0,
        outPoint: defaultDuration,
        timelineStart: Math.round(cursor * 1000) / 1000,
        duration: defaultDuration,
        // 首尾用淡入淡出，中间用硬切：这是短内容的通用节奏
        transition: i === 0 || i === videoAssetIds.length - 1 ? 'fade' : 'cut',
      };
      cursor += defaultDuration;
      return clip;
    });

    const totalDuration = Math.round(cursor * 1000) / 1000;

    await ctx.reportProgress(70, '正在对齐字幕轨');
    const subtitleTrack = await buildSubtitleTrack(ctx, subtitleAssetIds, totalDuration);

    const edl: EditDecisionList = {
      version: 1,
      clips,
      audioTrack:
        voiceAssetIds[0] !== undefined
          ? { assetId: voiceAssetIds[0], volume: 1, startAt: 0 }
          : null,
      subtitleTrack,
      musicTrack: input.music !== undefined ? { assetId: input.music, volume: 0.25 } : null,
      totalDuration,
      aspectRatio,
      renderStatus: singleSource ? 'single_source' : 'pending_renderer',
    };

    await ctx.reportProgress(90, '正在登记剪辑结果');
    await ctx.step('生成剪辑决策', {
      clips: clips.length,
      totalDuration,
      subtitleCues: subtitleTrack.length,
    });

    // 把 EDL 作为内容产出物登记，供 Timeline 与后续渲染器消费
    const { outputId } = await ctx.deps.contents.addOutput({
      contentId: ctx.contentId ?? '',
      projectId: ctx.projectId,
      name: '剪辑决策（EDL）',
      type: 'project',
      storage: null,
      metadata: edl as unknown as Record<string, unknown>,
    });

    await ctx.reportProgress(100, '剪辑准备完成');

    const card: ResultCardPayload = {
      type: 'result_card',
      title: singleSource ? '剪辑已就绪' : '剪辑方案已生成',
      category: 'video',
      subtitle: `${clips.length} 个片段 / 约 ${Math.round(totalDuration)} 秒`,
      attributes: [
        ['片段数', String(clips.length)],
        ['总时长', `${Math.round(totalDuration)} 秒`],
        ['画幅', aspectRatio],
        ['字幕', subtitleTrack.length > 0 ? `${subtitleTrack.length} 条` : '无'],
        ...(singleSource
          ? ([['成片', '可直接使用原素材']] as Array<[string, string]>)
          : ([['成片', '待渲染合成']] as Array<[string, string]>)),
      ],
      media: [],
      contentId: ctx.contentId ?? undefined,
      actions: [
        { id: 'next', label: '继续输出成片', kind: 'primary', message: '输出成片' },
        { id: 'timeline', label: '查看时间线', kind: 'secondary' },
        { id: 'adjust', label: '调整节奏', kind: 'secondary', message: '节奏再快一点' },
      ] satisfies CardAction[],
    };

    return {
      output: {
        edl: edl as unknown as Record<string, unknown>,
        outputId,
        clipCount: clips.length,
        totalDuration,
      },
      summary: singleSource
        ? '剪辑已就绪，可直接使用原素材。'
        : `已生成 ${clips.length} 个片段的剪辑方案（合计约 ${Math.round(totalDuration)} 秒）。`,
      card: card as unknown as Record<string, unknown>,
    };
  },
};

/** 从项目记忆读取默认画幅 */
async function readAspectRatio(ctx: SkillExecutionContext): Promise<string> {
  const memory = await ctx.deps.projects.getMemory(ctx.projectId);
  const visual = memory.visual;
  if (isPlainObject(visual) && typeof visual.defaultAspectRatio === 'string') {
    return visual.defaultAspectRatio;
  }
  return '9:16';
}

/** 从项目记忆读取默认镜头时长 */
async function readDefaultShotDuration(ctx: SkillExecutionContext): Promise<number> {
  const memory = await ctx.deps.projects.getMemory(ctx.projectId);
  const production = memory.production;
  if (isPlainObject(production) && typeof production.defaultShotDuration === 'number') {
    const value = production.defaultShotDuration;
    if (value > 0 && value <= 60) return value;
  }
  return 5;
}

/** 读取字幕资产并转成字幕轨；读取失败时降级为空轨而不是让剪辑整体失败 */
async function buildSubtitleTrack(
  ctx: SkillExecutionContext,
  subtitleAssetIds: string[],
  totalDuration: number,
): Promise<SubtitleCue[]> {
  const assetId = subtitleAssetIds[0];
  if (assetId === undefined) return [];

  const assets = await ctx.deps.assets.listByProject(ctx.projectId, { limit: 200 });
  const asset = assets.find((a) => a.id === assetId);
  if (!asset || !isPlainObject(asset.metadata)) return [];

  const cues = asset.metadata.cues;
  if (!Array.isArray(cues)) return [];

  const parsed: SubtitleCue[] = [];
  cues.forEach((cue, position) => {
    if (!isPlainObject(cue)) return;
    const text = cue.text;
    if (typeof text !== 'string') return;
    const start = typeof cue.start === 'number' ? cue.start : position * 2.5;
    const end = typeof cue.end === 'number' ? cue.end : start + 2.4;
    // 超出成片长度的字幕直接丢弃，避免时间轴错位
    if (start >= totalDuration) return;
    parsed.push({ index: parsed.length + 1, start, end: Math.min(end, totalDuration), text });
  });

  return parsed;
}

/* -------------------------------------------------------------------------- */
/* edit.brand_overlay                                                         */
/* -------------------------------------------------------------------------- */

interface BrandOverlayInput {
  video?: unknown;
  subtitle?: unknown;
  brandSlug?: string;
  logoAssetSlug?: string;
}

/** 叠加层描述 */
export interface OverlaySpec {
  kind: 'logo' | 'color_bar' | 'lower_third' | 'watermark';
  assetId?: string;
  position: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right' | 'center';
  /** 出现时间段（秒） */
  startAt: number;
  endAt: number;
  opacity: number;
  color?: string;
}

export const brandOverlaySkill: SkillImplementation<BrandOverlayInput> = {
  id: 'edit.brand_overlay',

  normalizeInput(input) {
    return {
      ...(input.video !== undefined ? { video: input.video } : {}),
      ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
      ...(typeof input.brandSlug === 'string' ? { brandSlug: input.brandSlug } : {}),
      ...(typeof input.logoAssetSlug === 'string' ? { logoAssetSlug: input.logoAssetSlug } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在读取品牌规范');

    // 品牌资产可能通过 brandSlug 或 logoAssetSlug 任一方式给出
    const brandSlug = input.brandSlug ?? input.logoAssetSlug;
    let overlays: OverlaySpec[] = [];
    let brandName: string | undefined;

    if (brandSlug !== undefined) {
      const brand = await ctx.deps.assets.findBySlug(ctx.projectId, brandSlug);
      if (brand !== null) {
        brandName = brand.name;
        overlays = buildOverlaysFromBrand(brand);
      }
    }

    await ctx.step('生成叠加层', { count: overlays.length, brandName: brandName ?? '(未指定)' });
    await ctx.reportProgress(70, '正在登记叠加方案');

    const { outputId } = await ctx.deps.contents.addOutput({
      contentId: ctx.contentId ?? '',
      projectId: ctx.projectId,
      name: '品牌叠加方案',
      type: 'project',
      storage: null,
      metadata: { overlays: overlays as unknown as Record<string, unknown>[] },
    });

    await ctx.reportProgress(100, '品牌元素已就绪');

    // 该节点在数字人流程中标记了 continueOnError，
    // 因此没有品牌时不应报错，而是明确说明「无事可做」
    const summary =
      overlays.length > 0
        ? `已生成 ${overlays.length} 处品牌元素叠加方案。`
        : '未找到品牌资产，跳过品牌元素叠加。';

    return {
      output: {
        overlays: overlays as unknown as Record<string, unknown>[],
        outputId,
        brandName: brandName ?? null,
        skipped: overlays.length === 0,
      },
      summary,
      card: {
        type: 'result_card',
        title: overlays.length > 0 ? '品牌元素已就绪' : '已跳过品牌叠加',
        category: 'brand',
        subtitle: brandName,
        attributes:
          overlays.length > 0
            ? ([
                ['叠加层', String(overlays.length)],
                ['位置', overlays.map((o) => o.position).join('、')],
              ] as Array<[string, string]>)
            : ([['原因', '项目中没有品牌资产']] as Array<[string, string]>),
        media: [],
        actions: [],
      } as unknown as Record<string, unknown>,
    };
  },
};

/** 按品牌规范生成叠加层：Logo 角标 + 品牌色条 */
function buildOverlaysFromBrand(brand: {
  id: string;
  metadata: unknown;
}): OverlaySpec[] {
  const overlays: OverlaySpec[] = [];
  const metadata = isPlainObject(brand.metadata) ? brand.metadata : {};
  const colors = Array.isArray(metadata.colors)
    ? metadata.colors.filter((c): c is string => typeof c === 'string')
    : [];

  // Logo：作为图片资产时用 assetId，否则以文字水印形式表达
  const logoAssetId = metadata.logoAssetId;
  if (typeof logoAssetId === 'string') {
    overlays.push({
      kind: 'logo',
      assetId: logoAssetId,
      position: 'top_right',
      startAt: 0,
      endAt: Number.POSITIVE_INFINITY,
      opacity: 1,
    });
  }

  // 片尾品牌色条：用品牌主色，强化结尾记忆点
  const primaryColor = colors[0];
  if (primaryColor !== undefined) {
    overlays.push({
      kind: 'color_bar',
      position: 'bottom_left',
      startAt: 0,
      endAt: Number.POSITIVE_INFINITY,
      opacity: 0.9,
      color: primaryColor,
    });
  }

  return overlays;
}

/* -------------------------------------------------------------------------- */
/* output.publish                                                             */
/* -------------------------------------------------------------------------- */

/** 各平台规格：画幅、时长偏好、字幕要求（技术文档第 62 条） */
export const PLATFORM_SPECS: Record<
  string,
  { label: string; aspectRatio: string; maxDurationSeconds: number; needSubtitle: boolean; needCover: boolean }
> = {
  douyin: { label: '抖音', aspectRatio: '9:16', maxDurationSeconds: 180, needSubtitle: true, needCover: true },
  xiaohongshu: { label: '小红书', aspectRatio: '3:4', maxDurationSeconds: 300, needSubtitle: true, needCover: true },
  kuaishou: { label: '快手', aspectRatio: '9:16', maxDurationSeconds: 180, needSubtitle: true, needCover: true },
  wechat_channels: { label: '视频号', aspectRatio: '9:16', maxDurationSeconds: 300, needSubtitle: true, needCover: true },
  youtube: { label: 'YouTube', aspectRatio: '16:9', maxDurationSeconds: 3600, needSubtitle: false, needCover: true },
  youtube_shorts: { label: 'YouTube Shorts', aspectRatio: '9:16', maxDurationSeconds: 60, needSubtitle: true, needCover: true },
  instagram: { label: 'Instagram', aspectRatio: '4:5', maxDurationSeconds: 90, needSubtitle: true, needCover: true },
  tiktok: { label: 'TikTok', aspectRatio: '9:16', maxDurationSeconds: 180, needSubtitle: true, needCover: true },
  bilibili: { label: '哔哩哔哩', aspectRatio: '16:9', maxDurationSeconds: 3600, needSubtitle: false, needCover: true },
  generic: { label: '通用', aspectRatio: '9:16', maxDurationSeconds: 600, needSubtitle: false, needCover: false },
};

interface OutputPublishInput {
  edit?: unknown;
  platform?: string;
  aspectRatio?: string;
  title?: string;
}

export const outputPublishSkill: SkillImplementation<OutputPublishInput> = {
  id: 'output.publish',

  normalizeInput(input) {
    return {
      ...(input.edit !== undefined ? { edit: input.edit } : {}),
      ...(typeof input.platform === 'string' ? { platform: input.platform } : {}),
      ...(typeof input.aspectRatio === 'string' ? { aspectRatio: input.aspectRatio } : {}),
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在读取输出规格');

    const platform = input.platform ?? (await readPlatform(ctx));
    const spec = PLATFORM_SPECS[platform] ?? PLATFORM_SPECS.generic ?? {
      label: '通用',
      aspectRatio: '9:16',
      maxDurationSeconds: 600,
      needSubtitle: false,
      needCover: false,
    };

    const edl = extractEdl(input.edit);
    const sourceAssetIds = extractAssetIds(input.edit);

    await ctx.step('确定输出规格', {
      platform,
      aspectRatio: input.aspectRatio ?? spec.aspectRatio,
      totalDuration: edl?.totalDuration ?? null,
    });

    await ctx.reportProgress(50, '正在校验平台要求');

    // 逐项检查平台约束，把「不达标」明确告诉用户，而不是静默输出
    const warnings: string[] = [];
    if (edl !== null && edl.totalDuration > spec.maxDurationSeconds) {
      warnings.push(
        `成片约 ${Math.round(edl.totalDuration)} 秒，超出${spec.label}建议的 ${spec.maxDurationSeconds} 秒上限`,
      );
    }
    if (spec.needSubtitle && (edl?.subtitleTrack.length ?? 0) === 0) {
      warnings.push(`${spec.label}建议带字幕，当前成片没有字幕轨`);
    }
    if (edl !== null && edl.aspectRatio !== spec.aspectRatio) {
      warnings.push(`成片画幅为 ${edl.aspectRatio}，${spec.label}建议 ${spec.aspectRatio}`);
    }

    await ctx.reportProgress(80, '正在登记输出物');

    // 输出物类型由是否有视频源决定；纯 EDL 时登记为 project
    const outputType: 'video' | 'project' = sourceAssetIds.length > 0 ? 'video' : 'project';
    const { outputId } = await ctx.deps.contents.addOutput({
      contentId: ctx.contentId ?? '',
      projectId: ctx.projectId,
      name: input.title ?? `${spec.label}成片`,
      type: outputType,
      assetId: sourceAssetIds[0] ?? null,
      storage: null,
      metadata: {
        platform,
        platformLabel: spec.label,
        aspectRatio: input.aspectRatio ?? spec.aspectRatio,
        totalDuration: edl?.totalDuration ?? null,
        requirements: {
          needSubtitle: spec.needSubtitle,
          needCover: spec.needCover,
          maxDurationSeconds: spec.maxDurationSeconds,
        },
        warnings,
      },
    });

    await ctx.reportProgress(100, '输出已完成');
    await ctx.step('输出登记完成', { outputId, warnings: warnings.length });

    // 内容状态推进到 review：等待用户确认（技术文档第 40 条状态机）
    if (ctx.contentId != null) {
      await ctx.deps.contents.update({
        contentId: ctx.contentId,
        patch: { status: 'review' },
        changelog: `输出${spec.label}成片`,
      });
    }

    const card: ResultCardPayload = {
      type: 'result_card',
      title: warnings.length > 0 ? '成片已输出（有注意事项）' : '成片已输出',
      category: 'output',
      subtitle: input.title ?? `${spec.label}成片`,
      attributes: [
        ['平台', spec.label],
        ['画幅', input.aspectRatio ?? spec.aspectRatio],
        ...(edl !== null
          ? ([['时长', `${Math.round(edl.totalDuration)} 秒`]] as Array<[string, string]>)
          : []),
        ...(warnings.length > 0
          ? ([['注意', warnings[0] ?? '']] as Array<[string, string]>)
          : []),
      ],
      media: [],
      contentId: ctx.contentId ?? undefined,
      actions: [
        { id: 'adopt', label: '采用', kind: 'primary', message: '采用这个成片' },
        { id: 'adjust', label: '继续调整', kind: 'secondary', message: '我想调整成片' },
      ] satisfies CardAction[],
    };

    return {
      output: {
        outputId,
        platform,
        aspectRatio: input.aspectRatio ?? spec.aspectRatio,
        warnings: warnings as unknown as Record<string, unknown>[],
        totalDuration: edl?.totalDuration ?? null,
      },
      summary:
        warnings.length > 0
          ? `已输出${spec.label}成片，但有 ${warnings.length} 项需要注意。`
          : `已输出${spec.label}成片。`,
      card: card as unknown as Record<string, unknown>,
    };
  },
};

/** 从上游产出中提取 EDL */
function extractEdl(value: unknown): EditDecisionList | null {
  if (!isPlainObject(value)) return null;
  const edl = value.edl;
  if (!isPlainObject(edl)) return null;
  if (!Array.isArray(edl.clips)) return null;
  return edl as unknown as EditDecisionList;
}

/** 从项目记忆读取默认平台 */
async function readPlatform(ctx: SkillExecutionContext): Promise<string> {
  const memory = await ctx.deps.projects.getMemory(ctx.projectId);
  const goals = memory.goals;
  if (isPlainObject(goals)) {
    const platforms = goals.platforms;
    if (Array.isArray(platforms)) {
      const first = platforms.find((p): p is string => typeof p === 'string');
      if (first !== undefined) return first;
    }
  }
  return 'generic';
}
