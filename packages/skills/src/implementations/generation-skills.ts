/**
 * 生成类技能：image.generate / image.edit / video.generate / video.extend /
 *             voice.generate / audio.generate / subtitle.generate
 *
 * 这些技能都通过 Model Router 调用模型，并把产出**登记为项目资产**。
 *
 * 关键设计：**产出必须落成资产并支持版本**（技术文档原则 6）。
 * 因此每次生成都会：
 *   1. 调用模型拿到文件
 *   2. 创建资产（image / video / audio 类型），首版 v1
 *   3. 把生成所用的模型与提示词写进 metadata.generation，便于复现与再生成
 *
 * Phase 2 说明：Mock Provider 返回的是占位文件（1×1 PNG / mock:// URL），
 * 但**资产记录、版本、引用关系、元数据都是真实的**。
 * Phase 3 接入真实 Provider 后，同一套技能无需改动即可产出真实文件。
 */
import { ValidationError, type CardAction, type ResultCardPayload } from '@svh/domain';

import type { SkillExecutionContext } from '../runtime/ports.js';
import type { SkillExecutionOutput, SkillImplementation } from '../runtime/registry.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** 把模型返回的文件转成资产的 files 字段结构（storageRef 数组） */
function filesToStorageRefs(
  files: Array<{ url?: string; storageKey?: string; mimeType?: string; width?: number; height?: number; duration?: number }> | undefined,
): Array<Record<string, unknown>> {
  if (files === undefined) return [];
  return files.map((file, index) => ({
    driver: file.url?.startsWith('mock://') === true ? 'mock' : 'remote',
    key: file.storageKey ?? file.url ?? `unnamed-${index}`,
    ...(file.url !== undefined ? { url: file.url } : {}),
    ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
  }));
}

/** 从项目记忆与内容 metadata 中提炼全局视觉约束 */
async function collectVisualContext(ctx: SkillExecutionContext): Promise<{
  styleKeywords: string[];
  negativePrompt?: string;
  styleReferenceUrls: string[];
}> {
  const memory = await ctx.deps.projects.getMemory(ctx.projectId);
  const visual = memory.visual;
  if (!isPlainObject(visual)) return { styleKeywords: [], styleReferenceUrls: [] };

  const styleKeywords = asStringArray(visual.styleKeywords);
  if (typeof visual.style === 'string' && visual.style.length > 0) {
    styleKeywords.unshift(visual.style);
  }

  const styleReferenceUrls = Array.isArray(visual.styleReferences)
    ? visual.styleReferences
        .map((ref) => (isPlainObject(ref) && typeof ref.url === 'string' ? ref.url : null))
        .filter((url): url is string => url !== null)
    : [];

  return {
    styleKeywords,
    ...(typeof visual.negativePrompt === 'string'
      ? { negativePrompt: visual.negativePrompt }
      : {}),
    styleReferenceUrls,
  };
}

/* -------------------------------------------------------------------------- */
/* image.generate                                                             */
/* -------------------------------------------------------------------------- */

interface ImageGenerateInput {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  referenceImages?: string[];
  count?: number;
  /** 资产名称，不填则由提示词推导 */
  name?: string;
}

export const imageGenerateSkill: SkillImplementation<ImageGenerateInput> = {
  id: 'image.generate',

  /**
   * 动态高风险判定：成本随**张数**而非技能本身变化。
   *
   * 生成 1 张图属于常规操作，直接执行；一次生成多张（广告分镜常见 6~9 张）
   * 消耗显著，应先让用户确认（技术文档第 47 条：「批量生成」属于必须确认）。
   *
   * 这也是「按数量确认应放在技能实现内部，而不是节点静态标记」的落点。
   */
  isHighRisk(input) {
    return (input.count ?? 1) > 1;
  },

  normalizeInput(input) {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new ValidationError('image.generate 需要非空的 prompt 参数');
    }
    return {
      prompt,
      ...(typeof input.negativePrompt === 'string' ? { negativePrompt: input.negativePrompt } : {}),
      ...(typeof input.width === 'number' ? { width: input.width } : {}),
      ...(typeof input.height === 'number' ? { height: input.height } : {}),
      ...(Array.isArray(input.referenceImages)
        ? { referenceImages: asStringArray(input.referenceImages) }
        : {}),
      ...(typeof input.count === 'number' && input.count > 0
        ? { count: Math.min(Math.floor(input.count), 8) }
        : {}),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '正在准备画面提示词');

    const visual = await collectVisualContext(ctx);
    // 把项目风格拼进提示词：这是「同一个项目里所有画面风格一致」的实现方式
    const compiledPrompt = [input.prompt, ...visual.styleKeywords].join('，');
    const count = input.count ?? 1;

    await ctx.step('编译提示词', {
      styleKeywords: visual.styleKeywords.length,
      count,
    });

    await ctx.reportProgress(30, `正在生成第 1/${count} 张画面`);

    const assetIds: string[] = [];
    const coverUrls: string[] = [];

    for (let i = 0; i < count; i += 1) {
      if (ctx.signal.aborted) {
        throw new ValidationError('任务已取消');
      }

      const result = await ctx.deps.models.invoke({
        capability: 'image',
        prompt: compiledPrompt,
        params: {
          ...(input.width !== undefined ? { width: input.width } : {}),
          ...(input.height !== undefined ? { height: input.height } : {}),
        },
        referenceImages: input.referenceImages ?? [],
        ...(input.negativePrompt !== undefined || visual.negativePrompt !== undefined
          ? { negativePrompt: input.negativePrompt ?? visual.negativePrompt ?? '' }
          : {}),
      });

      const refs = filesToStorageRefs(result.files);
      const coverUrl = result.files?.[0]?.url;

      const created = await ctx.deps.assets.create({
        projectId: ctx.projectId,
        type: 'image',
        name: input.name !== undefined ? `${input.name}${count > 1 ? `-${i + 1}` : ''}` : `画面-${Date.now().toString(36)}-${i + 1}`,
        slug: input.name !== undefined ? `${input.name}${count > 1 ? `-${i + 1}` : ''}` : undefined,
        description: compiledPrompt.slice(0, 500),
        metadata: {
          width: input.width ?? result.files?.[0]?.width,
          height: input.height ?? result.files?.[0]?.height,
          format: 'png',
          generation: {
            modelId: result.modelId,
            prompt: compiledPrompt,
            ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
            ...(result.usage?.seed !== undefined ? { seed: result.usage.seed } : {}),
            skillId: 'image.generate',
            taskId: ctx.taskId,
          },
        },
        files: refs,
        ...(coverUrl !== undefined ? { coverUrl } : {}),
        ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
        changelog: '由 Agent 生成画面',
      });

      assetIds.push(created.id);
      if (coverUrl !== undefined) coverUrls.push(coverUrl);

      await ctx.reportProgress(30 + Math.round(((i + 1) / count) * 60), `正在生成第 ${i + 1}/${count} 张画面`);
    }

    await ctx.reportProgress(100, '画面已生成');
    await ctx.step('登记资产', { assetCount: assetIds.length });

    const card: ResultCardPayload = {
      type: 'result_card',
      title: count > 1 ? `已生成 ${count} 张画面` : '画面已生成',
      category: 'image',
      subtitle: input.prompt.slice(0, 60),
      attributes: [
        ['数量', String(assetIds.length)],
        ...(input.width !== undefined && input.height !== undefined
          ? ([['尺寸', `${input.width}×${input.height}`]] as Array<[string, string]>)
          : []),
        ...(visual.styleKeywords.length > 0
          ? ([['风格', visual.styleKeywords.slice(0, 3).join('、')]] as Array<[string, string]>)
          : []),
      ],
      media: coverUrls.slice(0, 4).map((url) => ({ kind: 'image' as const, url })),
      assetId: assetIds[0],
      contentId: ctx.contentId ?? undefined,
      actions: [
        { id: 'adopt', label: '采用', kind: 'primary', message: '采用这张画面' },
        { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成这张画面' },
        { id: 'edit', label: '修改', kind: 'secondary', message: '我想修改画面' },
      ] satisfies CardAction[],
    };

    return {
      // 产出的资产统一通过 assetIds 表达，由执行器汇总为 producedAssetIds。
      // 刻意不再额外输出一份 assetId —— 同一事实两处表达会让下游
      // 难以判断「总数是 1 个还是 2 个」（曾因此在测试里数出 5 个而实际是 4 个）。
      output: {
        assetIds: assetIds as unknown as Record<string, unknown>[],
        count: assetIds.length,
      },
      assetIds,
      summary: count > 1 ? `已生成 ${count} 张画面。` : '画面已生成。',
      card: card as unknown as Record<string, unknown>,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* image.edit                                                                 */
/* -------------------------------------------------------------------------- */

interface ImageEditInput {
  assetId: string;
  instruction: string;
  /** 保留项：编辑时不应改动的部分（角色一致性关键） */
  keep?: string[];
}

export const imageEditSkill: SkillImplementation<ImageEditInput> = {
  id: 'image.edit',

  normalizeInput(input) {
    const assetId = input.assetId;
    const instruction = input.instruction;
    if (typeof assetId !== 'string' || assetId.length === 0) {
      throw new ValidationError('image.edit 需要 assetId 参数');
    }
    if (typeof instruction !== 'string' || instruction.length === 0) {
      throw new ValidationError('image.edit 需要 instruction 参数');
    }
    return {
      assetId,
      instruction,
      ...(Array.isArray(input.keep) ? { keep: asStringArray(input.keep) } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(15, '正在读取原图');

    const assets = await ctx.deps.assets.listByProject(ctx.projectId, { type: 'image', limit: 200 });
    const source = assets.find((a) => a.id === input.assetId);
    if (!source) {
      throw new ValidationError(`原图 ${input.assetId} 不存在于当前项目`, {
        userMessage: '没有找到要修改的图片，可能已被删除。',
      });
    }

    // 局部修改的语义：明确「改什么」与「保留什么」。
    // 保留项来自视觉规范与用户指令，是角色一致性的实现基础（技术文档第 52 条）
    const keep = input.keep ?? ['脸部', '发型', '年龄', '身材', '画风'];
    await ctx.step('编译修改指令', { instruction: input.instruction, keep });

    const prompt = `在保持${keep.join('、')}不变的前提下，${input.instruction}`;

    await ctx.reportProgress(45, '正在按你的要求修改画面');
    const result = await ctx.deps.models.invoke({
      capability: 'image_edit',
      prompt,
      params: {},
      referenceImages: extractReferenceUrls(source.metadata),
    });

    const refs = filesToStorageRefs(result.files);
    const metadata = isPlainObject(source.metadata) ? source.metadata : {};

    // 生成**新版本**而不是覆盖原资产：这是「局部修改」与「可恢复」的基础
    const updated = await ctx.deps.assets.update({
      assetId: input.assetId,
      patch: {
        metadata: {
          ...metadata,
          generation: {
            modelId: result.modelId,
            prompt,
            skillId: 'image.edit',
            taskId: ctx.taskId,
            editedFrom: input.assetId,
          },
        },
        ...(result.files?.[0]?.url !== undefined ? { coverUrl: result.files[0].url } : {}),
        ...(refs.length > 0 ? { files: refs } : {}),
      },
      changelog: input.instruction,
    });

    await ctx.reportProgress(100, '修改完成');

    return {
      output: { assetId: updated.id, version: updated.version, instruction: input.instruction },
      assetIds: [updated.id],
      summary: `已按要求修改画面（v${updated.version}）：${input.instruction}`,
      card: {
        type: 'result_card',
        title: '画面已修改',
        category: 'image',
        subtitle: `v${updated.version}`,
        attributes: [
          ['修改', input.instruction],
          ['保留', keep.slice(0, 3).join('、')],
        ] as Array<[string, string]>,
        media: result.files?.[0]?.url !== undefined ? [{ kind: 'image' as const, url: result.files[0].url }] : [],
        assetId: updated.id,
        actions: [
          { id: 'adopt', label: '采用', kind: 'primary', message: '采用这次修改' },
          { id: 'restore', label: '恢复上一版', kind: 'secondary' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};

/** 从资产 metadata 中提取参考图 URL（用于图生图） */
function extractReferenceUrls(metadata: unknown): string[] {
  if (!isPlainObject(metadata)) return [];
  const generation = metadata.generation;
  if (isPlainObject(generation) && typeof generation.coverUrl === 'string') {
    return [generation.coverUrl];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* video.generate                                                             */
/* -------------------------------------------------------------------------- */

interface VideoGenerateInput {
  /** 上游分镜或画面集合 */
  shots?: unknown;
  prompt?: string;
  firstFrameAssetId?: string;
  duration?: number;
  aspectRatio?: string;
  name?: string;
}

export const videoGenerateSkill: SkillImplementation<VideoGenerateInput> = {
  id: 'video.generate',

  normalizeInput(input) {
    return {
      ...(input.shots !== undefined ? { shots: input.shots } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
      ...(typeof input.firstFrameAssetId === 'string'
        ? { firstFrameAssetId: input.firstFrameAssetId }
        : {}),
      ...(typeof input.duration === 'number' && input.duration > 0 ? { duration: input.duration } : {}),
      ...(typeof input.aspectRatio === 'string' ? { aspectRatio: input.aspectRatio } : {}),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(10, '正在整理镜头素材');

    // 从上游取出镜头清单：兼容 shots 数组与 {shots:[...]} 两种形态
    const shots = extractShotList(input.shots);
    const duration = input.duration ?? sumShotDurations(shots) ?? 5;
    const visual = await collectVisualContext(ctx);

    await ctx.step('镜头清点', { shotCount: shots.length, duration });

    await ctx.reportProgress(25, '正在生成视频片段');

    const result = await ctx.deps.models.invoke({
      capability: 'video',
      prompt: input.prompt ?? buildVideoPrompt(shots, visual.styleKeywords),
      params: {
        duration,
        ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
      },
      referenceImages: [],
    });

    const refs = filesToStorageRefs(result.files);
    const created = await ctx.deps.assets.create({
      projectId: ctx.projectId,
      type: 'video',
      name: input.name ?? `视频片段-${Date.now().toString(36)}`,
      ...(input.name !== undefined ? { slug: input.name } : {}),
      description: `由 ${shots.length > 0 ? `${shots.length} 个镜头` : '提示词'}生成的视频片段`,
      metadata: {
        duration,
        aspectRatio: input.aspectRatio,
        generation: {
          modelId: result.modelId,
          prompt: input.prompt ?? buildVideoPrompt(shots, visual.styleKeywords),
          skillId: 'video.generate',
          taskId: ctx.taskId,
          ...(result.usage?.seed !== undefined ? { seed: result.usage.seed } : {}),
        },
        shotCount: shots.length,
      },
      files: refs,
      ...(result.files?.[0]?.url !== undefined ? { coverUrl: result.files[0].url } : {}),
      ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
      changelog: '由 Agent 生成视频片段',
    });

    await ctx.reportProgress(100, '视频片段已生成');
    await ctx.step('登记资产', { assetId: created.id });

    const card: ResultCardPayload = {
      type: 'result_card',
      title: '视频片段已生成',
      category: 'video',
      subtitle: `${shots.length > 0 ? `${shots.length} 个镜头 / ` : ''}${Math.round(duration)} 秒`,
      attributes: [
        ['时长', `${Math.round(duration)} 秒`],
        ...(input.aspectRatio !== undefined
          ? ([['画幅', input.aspectRatio]] as Array<[string, string]>)
          : []),
        ...(result.fallbackNote !== undefined
          ? ([['提示', result.fallbackNote]] as Array<[string, string]>)
          : []),
      ],
      media: result.files?.[0]?.url !== undefined ? [{ kind: 'video' as const, url: result.files[0].url }] : [],
      assetId: created.id,
      contentId: ctx.contentId ?? undefined,
      actions: [
        { id: 'adopt', label: '采用', kind: 'primary', message: '采用这个片段' },
        { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成这个片段' },
        { id: 'extend', label: '延长', kind: 'secondary', message: '把这个片段延长一些' },
      ] satisfies CardAction[],
    };

    return {
      output: {
        assetIds: [created.id] as unknown as Record<string, unknown>[],
        assetId: created.id,
        shotCount: shots.length,
        duration,
      },
      assetIds: [created.id],
      summary: `已生成 ${Math.round(duration)} 秒视频片段。`,
      card: card as unknown as Record<string, unknown>,
    };
  },
};

/** 从上游产出中尽力提取镜头列表 */
function extractShotList(value: unknown): Array<{ description?: string; imagePrompt?: string; duration?: number }> {
  const shots: Array<{ description?: string; imagePrompt?: string; duration?: number }> = [];
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 4 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.shots)) {
      for (const shot of node.shots) {
        if (!isPlainObject(shot)) continue;
        shots.push({
          ...(typeof shot.description === 'string' ? { description: shot.description } : {}),
          ...(typeof shot.imagePrompt === 'string' ? { imagePrompt: shot.imagePrompt } : {}),
          ...(typeof shot.duration === 'number' ? { duration: shot.duration } : {}),
        });
      }
      return;
    }
    for (const key of ['images', 'assets', 'output']) {
      if (node[key] !== undefined) visit(node[key], depth + 1);
    }
  };
  visit(value);
  return shots;
}

function sumShotDurations(shots: Array<{ duration?: number }>): number | null {
  const total = shots.reduce((sum, shot) => sum + (shot.duration ?? 0), 0);
  return total > 0 ? total : null;
}

function buildVideoPrompt(
  shots: Array<{ description?: string; imagePrompt?: string }>,
  styleKeywords: string[],
): string {
  const parts = shots
    .map((shot) => shot.imagePrompt ?? shot.description)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
  return [...parts, ...styleKeywords].join('，') || '生成一段视频';
}

/* -------------------------------------------------------------------------- */
/* video.extend                                                               */
/* -------------------------------------------------------------------------- */

interface VideoExtendInput {
  assetId: string;
  extraSeconds: number;
  prompt?: string;
}

export const videoExtendSkill: SkillImplementation<VideoExtendInput> = {
  id: 'video.extend',

  normalizeInput(input) {
    const assetId = input.assetId;
    if (typeof assetId !== 'string' || assetId.length === 0) {
      throw new ValidationError('video.extend 需要 assetId 参数');
    }
    const extraSeconds = input.extraSeconds;
    if (typeof extraSeconds !== 'number' || extraSeconds <= 0) {
      throw new ValidationError('video.extend 需要正的 extraSeconds 参数');
    }
    return {
      assetId,
      extraSeconds: Math.min(extraSeconds, 60),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在读取原视频');

    const assets = await ctx.deps.assets.listByProject(ctx.projectId, { type: 'video', limit: 200 });
    const source = assets.find((a) => a.id === input.assetId);
    if (!source) {
      throw new ValidationError(`视频 ${input.assetId} 不存在于当前项目`, {
        userMessage: '没有找到要延长的视频，可能已被删除。',
      });
    }

    const sourceMeta = isPlainObject(source.metadata) ? source.metadata : {};
    const originalDuration = typeof sourceMeta.duration === 'number' ? sourceMeta.duration : 5;

    await ctx.reportProgress(50, `正在延长 ${input.extraSeconds} 秒`);
    const result = await ctx.deps.models.invoke({
      capability: 'video_extend',
      prompt: input.prompt ?? '延长画面，保持原有风格与运动连续性',
      params: { extraSeconds: input.extraSeconds, duration: input.extraSeconds },
      referenceImages: [],
    });

    const newDuration = originalDuration + input.extraSeconds;

    // 延长同样产生新版本：用户可回退到延长前
    const updated = await ctx.deps.assets.update({
      assetId: input.assetId,
      patch: {
        metadata: {
          ...sourceMeta,
          duration: newDuration,
          generation: {
            modelId: result.modelId,
            skillId: 'video.extend',
            taskId: ctx.taskId,
            extendedFrom: input.assetId,
            extraSeconds: input.extraSeconds,
          },
        },
        ...(result.files?.[0]?.url !== undefined ? { coverUrl: result.files[0].url } : {}),
        ...(filesToStorageRefs(result.files).length > 0
          ? { files: filesToStorageRefs(result.files) }
          : {}),
      },
      changelog: `延长 ${input.extraSeconds} 秒`,
    });

    await ctx.reportProgress(100, '视频已延长');

    return {
      output: {
        assetId: updated.id,
        version: updated.version,
        originalDuration,
        newDuration,
      },
      assetIds: [updated.id],
      summary: `视频已从 ${Math.round(originalDuration)} 秒延长到 ${Math.round(newDuration)} 秒。`,
      card: {
        type: 'result_card',
        title: '视频已延长',
        category: 'video',
        subtitle: `${Math.round(originalDuration)} 秒 → ${Math.round(newDuration)} 秒`,
        attributes: [['新增时长', `${input.extraSeconds} 秒`]] as Array<[string, string]>,
        media: [],
        assetId: updated.id,
        actions: [
          { id: 'adopt', label: '采用', kind: 'primary', message: '采用这个视频' },
          { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成这个视频' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* voice.generate                                                             */
/* -------------------------------------------------------------------------- */

interface VoiceGenerateInput {
  text: string;
  voiceAssetId?: string;
  speed?: number;
  emotion?: string;
  name?: string;
}

export const voiceGenerateSkill: SkillImplementation<VoiceGenerateInput> = {
  id: 'voice.generate',

  normalizeInput(input) {
    const text = input.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new ValidationError('voice.generate 需要非空的 text 参数');
    }
    return {
      text,
      ...(typeof input.voiceAssetId === 'string' ? { voiceAssetId: input.voiceAssetId } : {}),
      ...(typeof input.speed === 'number' ? { speed: input.speed } : {}),
      ...(typeof input.emotion === 'string' ? { emotion: input.emotion } : {}),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在准备配音');

    // 未指定音色时回落到项目默认音色（来自 Project Memory 的制作规则）
    const voiceAssetId = input.voiceAssetId ?? (await readDefaultVoiceAssetId(ctx));

    await ctx.step('确定音色', { voiceAssetId: voiceAssetId ?? '(使用默认音色)' });

    await ctx.reportProgress(45, '正在合成语音');
    const result = await ctx.deps.models.invoke({
      capability: 'voice',
      prompt: input.text,
      params: {
        ...(voiceAssetId !== undefined ? { voiceAssetId } : {}),
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
        ...(input.emotion !== undefined ? { emotion: input.emotion } : {}),
      },
      referenceImages: [],
    });

    const created = await ctx.deps.assets.create({
      projectId: ctx.projectId,
      type: 'audio',
      name: input.name ?? `配音-${Date.now().toString(36)}`,
      ...(input.name !== undefined ? { slug: input.name } : {}),
      description: input.text.slice(0, 200),
      metadata: {
        duration: result.files?.[0]?.duration,
        language: 'zh-CN',
        transcript: input.text,
        voiceTraits: {
          ...(input.emotion !== undefined ? { style: input.emotion } : {}),
        },
        generation: {
          modelId: result.modelId,
          prompt: input.text.slice(0, 500),
          skillId: 'voice.generate',
          taskId: ctx.taskId,
          ...(voiceAssetId !== undefined ? { voiceAssetId } : {}),
        },
      },
      files: filesToStorageRefs(result.files),
      ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
      changelog: '由 Agent 生成配音',
    });

    await ctx.reportProgress(100, '配音已生成');

    return {
      output: {
        assetId: created.id,
        duration: result.files?.[0]?.duration ?? null,
        textLength: input.text.length,
      },
      assetIds: [created.id],
      summary: '配音已生成。',
      card: {
        type: 'result_card',
        title: '配音已生成',
        category: 'audio',
        subtitle: `${input.text.length} 字`,
        attributes: [
          ['字数', String(input.text.length)],
          ...(input.emotion !== undefined ? ([['情绪', input.emotion]] as Array<[string, string]>) : []),
        ],
        media: [],
        assetId: created.id,
        actions: [
          { id: 'adopt', label: '采用', kind: 'primary', message: '采用这段配音' },
          { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成配音' },
          { id: 'changeVoice', label: '换个音色', kind: 'secondary', message: '换一个更年轻的女声' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};

/** 读取项目默认音色 */
async function readDefaultVoiceAssetId(ctx: SkillExecutionContext): Promise<string | undefined> {
  const memory = await ctx.deps.projects.getMemory(ctx.projectId);
  const production = memory.production;
  if (isPlainObject(production) && typeof production.defaultVoiceAssetId === 'string') {
    return production.defaultVoiceAssetId;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* audio.generate                                                             */
/* -------------------------------------------------------------------------- */

interface AudioGenerateInput {
  prompt: string;
  duration?: number;
  mood?: string;
  name?: string;
}

export const audioGenerateSkill: SkillImplementation<AudioGenerateInput> = {
  id: 'audio.generate',

  normalizeInput(input) {
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new ValidationError('audio.generate 需要非空的 prompt 参数');
    }
    return {
      prompt,
      ...(typeof input.duration === 'number' ? { duration: input.duration } : {}),
      ...(typeof input.mood === 'string' ? { mood: input.mood } : {}),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(30, '正在生成音频');

    const result = await ctx.deps.models.invoke({
      capability: 'music',
      prompt: input.prompt,
      params: {
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.mood !== undefined ? { mood: input.mood } : {}),
      },
      referenceImages: [],
    });

    const created = await ctx.deps.assets.create({
      projectId: ctx.projectId,
      type: 'music',
      name: input.name ?? `音频-${Date.now().toString(36)}`,
      ...(input.name !== undefined ? { slug: input.name } : {}),
      description: input.prompt.slice(0, 300),
      metadata: {
        duration: result.files?.[0]?.duration,
        format: 'mp3',
        generation: {
          modelId: result.modelId,
          prompt: input.prompt,
          skillId: 'audio.generate',
          taskId: ctx.taskId,
        },
      },
      files: filesToStorageRefs(result.files),
      ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
      changelog: '由 Agent 生成音频',
    });

    await ctx.reportProgress(100, '音频已生成');

    return {
      output: { assetId: created.id, duration: result.files?.[0]?.duration ?? null },
      assetIds: [created.id],
      summary: '音频已生成。',
      card: {
        type: 'result_card',
        title: '音频已生成',
        category: 'audio',
        subtitle: input.prompt.slice(0, 50),
        attributes: [
          ...(input.duration !== undefined ? ([['时长', `${input.duration} 秒`]] as Array<[string, string]>) : []),
          ...(input.mood !== undefined ? ([['情绪', input.mood]] as Array<[string, string]>) : []),
        ],
        media: [],
        assetId: created.id,
        actions: [
          { id: 'adopt', label: '采用', kind: 'primary', message: '采用这段音频' },
          { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成音频' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* subtitle.generate                                                          */
/* -------------------------------------------------------------------------- */

interface SubtitleGenerateInput {
  script?: string;
  audioAssetId?: string;
  language?: string;
  style?: string;
  name?: string;
}

export const subtitleGenerateSkill: SkillImplementation<SubtitleGenerateInput> = {
  id: 'subtitle.generate',

  normalizeInput(input) {
    return {
      ...(typeof input.script === 'string' ? { script: input.script } : {}),
      ...(typeof input.audioAssetId === 'string' ? { audioAssetId: input.audioAssetId } : {}),
      ...(typeof input.language === 'string' ? { language: input.language } : {}),
      ...(typeof input.style === 'string' ? { style: input.style } : {}),
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
    };
  },

  async execute(input, ctx: SkillExecutionContext): Promise<SkillExecutionOutput> {
    await ctx.reportProgress(20, '正在准备字幕文本');

    // 优先用脚本；没有脚本时尝试从配音资产的 transcript 取
    let text = input.script ?? '';
    if (text.length === 0 && input.audioAssetId !== undefined) {
      const assets = await ctx.deps.assets.listByProject(ctx.projectId, { type: 'audio', limit: 200 });
      const audio = assets.find((a) => a.id === input.audioAssetId);
      const metadata = isPlainObject(audio?.metadata) ? audio.metadata : {};
      if (typeof metadata.transcript === 'string') text = metadata.transcript;
    }

    if (text.length === 0) {
      throw new ValidationError('字幕生成需要脚本或带文本的配音资产', {
        userMessage: '没有可用的文本，无法生成字幕。请先完成脚本或配音。',
        suggestions: ['先生成脚本', '先生成配音'],
      });
    }

    /** 字幕结构化输出契约 */
    const subtitleSchema: Record<string, unknown> = {
      type: 'object',
      properties: {
        cues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              start: { type: 'number' },
              end: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['text'],
          },
        },
        language: { type: 'string' },
      },
      required: ['cues'],
    };

    await ctx.reportProgress(50, '正在生成字幕时间轴');
    const result = await ctx.deps.models.invoke({
      capability: 'subtitle',
      prompt: text,
      responseSchema: subtitleSchema,
      params: {
        language: input.language ?? 'zh-CN',
        ...(input.style !== undefined ? { style: input.style } : {}),
      },
      referenceImages: [],
    });

    const cues = extractSubtitleCues(result.data);
    if (cues.length === 0) {
      throw new ValidationError('模型未产出可用的字幕条目', {
        userMessage: '字幕生成失败，请重试。',
      });
    }

    const created = await ctx.deps.assets.create({
      projectId: ctx.projectId,
      type: 'audio',
      name: input.name ?? `字幕-${Date.now().toString(36)}`,
      ...(input.name !== undefined ? { slug: input.name } : {}),
      description: `共 ${cues.length} 条字幕`,
      metadata: {
        language: input.language ?? 'zh-CN',
        transcript: text,
        cues: cues as unknown as Record<string, unknown>,
        generation: {
          modelId: result.modelId,
          skillId: 'subtitle.generate',
          taskId: ctx.taskId,
        },
      },
      files: [],
      ...(ctx.contentId != null ? { sourceContentId: ctx.contentId } : {}),
      changelog: '由 Agent 生成字幕',
    });

    await ctx.reportProgress(100, '字幕已生成');
    await ctx.step('字幕统计', { cueCount: cues.length });

    const totalDuration = cues.length > 0 ? (cues[cues.length - 1]?.end ?? 0) : 0;

    return {
      output: {
        assetId: created.id,
        cueCount: cues.length,
        totalDuration,
        cues: cues as unknown as Record<string, unknown>[],
      },
      assetIds: [created.id],
      summary: `已生成 ${cues.length} 条字幕。`,
      card: {
        type: 'result_card',
        title: '字幕已生成',
        category: 'subtitle',
        subtitle: `${cues.length} 条`,
        attributes: [
          ['条目数', String(cues.length)],
          ...(totalDuration > 0 ? ([['时长', `${Math.round(totalDuration)} 秒`]] as Array<[string, string]>) : []),
        ],
        media: [],
        assetId: created.id,
        actions: [
          { id: 'adopt', label: '采用', kind: 'primary', message: '采用这份字幕' },
          { id: 'regenerate', label: '重新生成', kind: 'secondary', message: '重新生成字幕' },
        ] satisfies CardAction[],
      } as unknown as Record<string, unknown>,
    };
  },
};

function extractSubtitleCues(data: unknown): Array<{ index: number; start: number; end: number; text: string }> {
  if (!isPlainObject(data)) return [];
  const raw = data.cues;
  if (!Array.isArray(raw)) return [];

  const cues: Array<{ index: number; start: number; end: number; text: string }> = [];
  raw.forEach((cue, position) => {
    if (!isPlainObject(cue)) return;
    const text = cue.text;
    if (typeof text !== 'string' || text.length === 0) return;
    const start = typeof cue.start === 'number' ? cue.start : position * 2.5;
    const end = typeof cue.end === 'number' ? cue.end : start + 2.4;
    cues.push({ index: cues.length + 1, start, end, text });
  });
  return cues;
}
