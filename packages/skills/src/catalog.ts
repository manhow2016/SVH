/**
 * 内置 Skill 目录
 *
 * 对应技术文档第 20、21 条。本文件是 **Phase 1 的尽力克制版**：
 * 只交付「能力的声明式元数据」（Skill Definition），
 * **不含执行实现** —— 执行（Skill Registry + Worker + Model Router）
 * 属于 Phase 2 / Phase 3 的范围。
 *
 * 为什么现在就定义？
 * 因为 Workflow 节点通过 `skill` 字段引用 Skill id。若没有这份目录，
 * 四套内置工作流引用的 skill 就是悬空字符串，无法校验。
 * 有了它，`workflow-node-skills.test.ts` 可以保证**每个流程节点都指向真实技能**。
 *
 * 设计约束（技术文档第 19 条）：Skill 只声明「需要什么模型能力」，
 * 不绑定具体模型 —— 由 Model Router 决定用哪个模型执行。
 */
import { z } from 'zod';

import {
  skillDefinitionSchema,
  type SkillDefinition,
  type TaskQueueName,
} from '@svh/domain';

/** 目录条目 = 技能定义 + 执行所需的运行时信息 */
export interface SkillCatalogEntry {
  definition: SkillDefinition;
  /**
   * 执行该技能时任务应进入的资源池队列。
   * 分池的目的见 @svh/domain/task-runtime.ts（避免长任务饿死短任务）。
   */
  queue: TaskQueueName;
}

/**
 * 构造目录条目的辅助函数。
 *
 * 入参形状是「skillDefinitionSchema 的输入 + queue」，因此每个条目
 * 仍然享有完整的类型检查（不会因为省略模型能力等字段而报错，
 * 因为 capabilities 已允许为空数组）。
 */
function skill(
  definition: z.input<typeof skillDefinitionSchema>,
  queue: TaskQueueName,
): SkillCatalogEntry {
  return { definition: skillDefinitionSchema.parse(definition), queue };
}

/**
 * 内置技能目录。
 *
 * 命名规范：`<域>.<动作>`，如 `image.generate`、`advertisement.storyboard`。
 */
export const SKILL_CATALOG: SkillCatalogEntry[] = [
  /* ── 基础 Skill（技术文档第 20 条） ───────────────────────────── */

  skill(
    {
      id: 'text.generate',
      name: '生成文本',
      description: '根据提示词生成文本内容，支持结构化输出约束',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '提示词' },
          system: { type: 'string', description: '系统指令' },
          responseSchema: { type: 'object', description: '结构化输出约束' },
        },
        required: ['prompt'],
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, data: { type: 'object' } },
      },
      risk: 'low',
      accessTier: 'free',
      estimatedSeconds: 10,
    },
    'ai_llm'),

  skill(
    {
      id: 'script.generate',
      name: '生成脚本',
      description: '生成带镜头划分与解说词的脚本',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          duration: { type: 'number' },
          platform: { type: 'string' },
          style: { type: 'array' },
        },
        required: ['brief'],
      },
      outputSchema: {
        type: 'object',
        properties: { shots: { type: 'array' }, narration: { type: 'string' } },
      },
      risk: 'low',
      estimatedSeconds: 25,
      aliases: ['写脚本', '生成脚本'],
      userHint: '根据你的需求生成可拍摄的脚本',
    },
    'ai_llm'),

  skill(
    {
      id: 'image.generate',
      name: '生成图片',
      description: '根据提示词生成图片',
      category: 'image',
      capabilities: ['image'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          negativePrompt: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          referenceImages: { type: 'array' },
          count: { type: 'number' },
        },
        required: ['prompt'],
      },
      outputSchema: {
        type: 'object',
        properties: { assetIds: { type: 'array' }, asset_id: { type: 'string' } },
      },
      risk: 'medium',
      accessTier: 'free',
      estimatedSeconds: 30,
      aliases: ['生成图片', '生图'],
      userHint: '生成符合项目风格的画面',
    },
    'ai_image'),

  skill(
    {
      id: 'image.edit',
      name: '编辑图片',
      description: '基于参考图做局部修改或风格迁移',
      category: 'image',
      capabilities: ['image_edit'],
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          instruction: { type: 'string' },
          mask: { type: 'string' },
        },
        required: ['assetId', 'instruction'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'medium',
      estimatedSeconds: 40,
    },
    'ai_image'),

  skill(
    {
      id: 'video.generate',
      name: '生成视频',
      description: '根据分镜画面生成视频片段',
      category: 'video',
      capabilities: ['video'],
      inputSchema: {
        type: 'object',
        properties: {
          shots: { type: 'array' },
          prompt: { type: 'string' },
          firstFrameAssetId: { type: 'string' },
          duration: { type: 'number' },
          aspectRatio: { type: 'string' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { assetIds: { type: 'array' } } },
      // 视频生成为高成本操作：执行前需要用户确认（技术文档第 47 条）
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 300,
      requiresConfirmation: true,
      aliases: ['生成视频'],
      userHint: '把分镜画面变成视频片段',
    },
    'ai_video'),

  skill(
    {
      id: 'video.extend',
      name: '延长视频',
      description: '在已有视频基础上延长时长',
      category: 'video',
      capabilities: ['video_extend'],
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          extraSeconds: { type: 'number' },
          prompt: { type: 'string' },
        },
        required: ['assetId', 'extraSeconds'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 180,
      requiresConfirmation: true,
    },
    'ai_video'),

  skill(
    {
      id: 'audio.generate',
      name: '生成音频',
      description: '生成音乐或环境音效',
      category: 'audio',
      capabilities: ['audio', 'music'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          duration: { type: 'number' },
          mood: { type: 'string' },
        },
        required: ['prompt'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'medium',
      estimatedSeconds: 60,
    },
    'ai_audio'),

  skill(
    {
      id: 'voice.generate',
      name: '生成配音',
      description: '把文本合成为指定音色的语音',
      category: 'voice',
      capabilities: ['voice'],
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          voiceAssetId: { type: 'string' },
          speed: { type: 'number' },
          emotion: { type: 'string' },
        },
        required: ['text'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'medium',
      estimatedSeconds: 45,
      aliases: ['生成配音', '配音'],
      userHint: '为脚本配上合适的声音',
    },
    'ai_audio'),

  skill(
    {
      id: 'digital_human.generate',
      name: '生成数字人视频',
      description: '驱动数字人形象与音色合成口播视频',
      category: 'digital_human',
      capabilities: ['digital_human'],
      inputSchema: {
        type: 'object',
        properties: {
          digitalHumanAssetId: { type: 'string' },
          audioAssetId: { type: 'string' },
          backgroundAssetId: { type: 'string' },
          motionTemplate: { type: 'string' },
        },
        required: ['digitalHumanAssetId', 'audioAssetId'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 420,
      requiresConfirmation: true,
      aliases: ['生成数字人', '做数字人'],
      userHint: '用数字人形象完成一条口播视频',
    },
    'ai_digital_human'),

  skill(
    {
      id: 'subtitle.generate',
      name: '生成字幕',
      description: '根据脚本或音轨生成带时间轴的字幕',
      category: 'subtitle',
      capabilities: ['subtitle', 'voice'],
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string' },
          audioAssetId: { type: 'string' },
          language: { type: 'string' },
          style: { type: 'string' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' }, cues: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 20,
      aliases: ['生成字幕'],
      userHint: '自动生成带时间轴的字幕',
    },
    'ai_render'),

  skill(
    {
      id: 'edit.video',
      name: '剪辑合成',
      description: '把视频片段、配音、字幕与音乐合成为成片',
      category: 'edit',
      capabilities: [],
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'object' },
          voice: { type: 'object' },
          subtitle: { type: 'object' },
          music: { type: 'string' },
          aspectRatio: { type: 'string' },
        },
        required: ['video'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' }, url: { type: 'string' } } },
      risk: 'medium',
      estimatedSeconds: 120,
      aliases: ['剪辑视频', '剪辑'],
      userHint: '把画面、配音与字幕合成为成片',
    },
    'ai_render'),

  skill(
    {
      id: 'edit.brand_overlay',
      name: '叠加品牌元素',
      description: '在成片上叠加 Logo、品牌色块与角标',
      category: 'edit',
      capabilities: [],
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'object' },
          subtitle: { type: 'object' },
          brandSlug: { type: 'string' },
          logoAssetSlug: { type: 'string' },
        },
        required: ['video'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'low',
      estimatedSeconds: 40,
    },
    'ai_render'),

  skill(
    {
      id: 'output.publish',
      name: '输出成片',
      description: '按目标平台规格导出并登记为内容输出物',
      category: 'asset',
      capabilities: [],
      inputSchema: {
        type: 'object',
        properties: {
          edit: { type: 'object' },
          platform: { type: 'string' },
          aspectRatio: { type: 'string' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { outputId: { type: 'string' }, url: { type: 'string' } } },
      risk: 'low',
      estimatedSeconds: 15,
    },
    'asset'),

  skill(
    {
      id: 'asset.create',
      name: '创建资产',
      description: '在项目中创建资产并写入首版快照',
      category: 'asset',
      capabilities: [],
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          name: { type: 'string' },
          slug: { type: 'string' },
          description: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['type', 'name'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' }, slug: { type: 'string' } } },
      risk: 'low',
      estimatedSeconds: 2,
    },
    'asset'),

  skill(
    {
      id: 'asset.update',
      name: '更新资产',
      description: '更新资产字段并记录新版本',
      category: 'asset',
      capabilities: [],
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          patch: { type: 'object' },
          changelog: { type: 'string' },
        },
        required: ['assetId', 'patch'],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' }, version: { type: 'number' } } },
      risk: 'low',
      estimatedSeconds: 2,
    },
    'asset'),

  skill(
    {
      id: 'asset.prepare',
      name: '准备素材',
      description: '按选题检索或生成所需素材并登记为资产',
      category: 'asset',
      capabilities: ['image', 'text'],
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'object' },
          assetSlugs: { type: 'array' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { assetIds: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 40,
    },
    'asset'),

  /* ── 需求与产品分析 ───────────────────────────────────────────── */

  skill(
    {
      id: 'requirement.analyze',
      name: '分析需求',
      description: '把用户的自然语言需求解析为结构化的创作参数',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          productSlugs: { type: 'array' },
          audience: { type: 'string' },
          platform: { type: 'string' },
          duration: { type: 'number' },
        },
        required: ['brief'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          content_type: { type: 'string' },
          duration: { type: 'number' },
          audience: { type: 'string' },
          style: { type: 'array' },
        },
      },
      risk: 'low',
      estimatedSeconds: 8,
    },
    'ai_llm'),

  skill(
    {
      id: 'product.analyze',
      name: '分析产品',
      description: '从产品资产与受众出发提炼卖点与沟通角度',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: {
          productSlugs: { type: 'array' },
          audience: { type: 'string' },
        },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: { sellingPoints: { type: 'array' }, angle: { type: 'string' } },
      },
      risk: 'low',
      estimatedSeconds: 12,
    },
    'ai_llm'),

  skill(
    {
      id: 'product.visual',
      name: '生成产品视觉',
      description: '生成符合品牌规范的产品主视觉与细节图',
      category: 'image',
      capabilities: ['image'],
      inputSchema: {
        type: 'object',
        properties: { productSlugs: { type: 'array' }, aspectRatio: { type: 'string' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { assetIds: { type: 'array' } } },
      risk: 'medium',
      estimatedSeconds: 40,
    },
    'ai_image'),

  /* ── 广告专业 Skill（技术文档第 21 条） ───────────────────────── */

  skill(
    {
      id: 'advertisement.objective',
      name: '确定广告目标',
      description: '明确广告要达成的核心目标与衡量方式',
      category: 'text',
      capabilities: ['text'],
      inputSchema: { type: 'object', properties: { analysis: { type: 'object' } }, required: [] },
      outputSchema: {
        type: 'object',
        properties: { objective: { type: 'string' }, kpi: { type: 'array' } },
      },
      risk: 'low',
      estimatedSeconds: 8,
    },
    'ai_llm'),

  skill(
    {
      id: 'advertisement.idea',
      name: '广告创意',
      description: '产出广告核心创意与叙事角度',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: { objective: { type: 'object' }, style: { type: 'array' } },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: { idea: { type: 'string' }, angle: { type: 'string' }, tone: { type: 'string' } },
      },
      risk: 'low',
      estimatedSeconds: 20,
      aliases: ['广告创意'],
      userHint: '为产品想一个有记忆点的广告创意',
    },
    'ai_llm'),

  skill(
    {
      id: 'advertisement.script',
      name: '广告脚本',
      description: '把创意落实为带时长分配的分镜脚本',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { idea: { type: 'object' }, duration: { type: 'number' } },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: { shots: { type: 'array' }, voiceover: { type: 'string' } },
      },
      risk: 'low',
      estimatedSeconds: 25,
      aliases: ['广告脚本'],
      userHint: '把创意写成可执行的广告脚本',
    },
    'ai_llm'),

  skill(
    {
      id: 'advertisement.storyboard',
      name: '广告分镜',
      description: '把脚本拆解为可执行的镜头清单（景别、运镜、画面提示）',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'object' },
          productVisual: { type: 'object' },
          duration: { type: 'number' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { shots: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 30,
      aliases: ['广告分镜'],
      userHint: '把脚本拆成逐个镜头',
    },
    'ai_llm'),

  skill(
    {
      id: 'advertisement.generate',
      name: '广告成片',
      description: '按广告流程串接生成完整成片',
      category: 'video',
      capabilities: ['video'],
      inputSchema: { type: 'object', properties: { contentId: { type: 'string' } }, required: [] },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 900,
      requiresConfirmation: true,
      aliases: ['创作广告', '做广告'],
      userHint: '从创意到成片，一次完成一支广告',
    },
    'ai_video'),

  /* ── 短视频专业 Skill ─────────────────────────────────────────── */

  skill(
    {
      id: 'short_video.topic',
      name: '短视频选题',
      description: '结合平台与受众确定选题与钩子',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: { platform: { type: 'string' }, audience: { type: 'string' } },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: { topic: { type: 'string' }, hook: { type: 'string' } },
      },
      risk: 'low',
      estimatedSeconds: 20,
      aliases: ['短视频选题'],
      userHint: '结合平台与受众找到合适的选题',
    },
    'ai_llm'),

  skill(
    {
      id: 'short_video.script',
      name: '短视频脚本',
      description: '生成适配平台节奏的短视频脚本',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { topic: { type: 'object' }, duration: { type: 'number' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { shots: { type: 'array' }, narration: { type: 'string' } } },
      risk: 'low',
      estimatedSeconds: 25,
    },
    'ai_llm'),

  skill(
    {
      id: 'short_video.storyboard',
      name: '短视频镜头',
      description: '把脚本拆为镜头并给出画面提示词',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'object' }, assets: { type: 'object' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { shots: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 30,
    },
    'ai_llm'),

  skill(
    {
      id: 'short_video.generate',
      name: '短视频成片',
      description: '按短视频流程串接生成完整成片',
      category: 'video',
      capabilities: ['video'],
      inputSchema: { type: 'object', properties: { contentId: { type: 'string' } }, required: [] },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 600,
      requiresConfirmation: true,
      aliases: ['创作短视频', '做短视频'],
      userHint: '按平台节奏制作一条短视频',
    },
    'ai_video'),

  /* ── 短剧专业 Skill ───────────────────────────────────────────── */

  skill(
    {
      id: 'drama.idea',
      name: '短剧创意',
      description: '产出短剧核心创意与冲突设定',
      category: 'text',
      capabilities: ['text'],
      inputSchema: {
        type: 'object',
        properties: { brief: { type: 'string' }, genre: { type: 'string' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { idea: { type: 'string' }, conflict: { type: 'string' } } },
      risk: 'low',
      estimatedSeconds: 20,
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.story',
      name: '故事大纲',
      description: '展开三幕结构与分集梗概',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { idea: { type: 'object' }, episodes: { type: 'number' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { logline: { type: 'string' }, outline: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 40,
      aliases: ['写故事'],
      userHint: '把创意展开成完整故事大纲',
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.worldview',
      name: '世界观设定',
      description: '构建时代、地域、规则与基调',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: { type: 'object', properties: { story: { type: 'object' } }, required: [] },
      outputSchema: {
        type: 'object',
        properties: { era: { type: 'string' }, setting: { type: 'string' }, rules: { type: 'array' } },
      },
      risk: 'low',
      estimatedSeconds: 30,
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.character',
      name: '角色设定',
      description: '生成角色档案并登记为角色资产',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { worldview: { type: 'object' }, story: { type: 'object' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { characters: { type: 'array' }, assetIds: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 50,
      aliases: ['创建角色'],
      userHint: '生成角色档案与外观设定',
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.scene',
      name: '场景设定',
      description: '生成场景档案并登记为场景资产',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: { type: 'object', properties: { worldview: { type: 'object' } }, required: [] },
      outputSchema: { type: 'object', properties: { scenes: { type: 'array' }, assetIds: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 40,
      aliases: ['创建场景'],
      userHint: '生成场景设定与氛围描述',
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.episode',
      name: '分集拆解',
      description: '把故事拆解为逐集梗概与钩子',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { story: { type: 'object' }, characters: { type: 'object' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { episodes: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 40,
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.script',
      name: '剧本',
      description: '生成含场次、对白与动作描述的完整剧本',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: {
          episodes: { type: 'object' },
          characters: { type: 'object' },
          scenes: { type: 'object' },
        },
        required: [],
      },
      outputSchema: { type: 'object', properties: { scenes: { type: 'array' }, dialogues: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 90,
      aliases: ['写剧本'],
      userHint: '生成含对白与场次的剧本',
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.storyboard',
      name: '短剧分镜',
      description: '把剧本拆解为镜头清单',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'object' }, scenes: { type: 'object' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { shots: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 60,
    },
    'ai_llm'),

  skill(
    {
      id: 'drama.character_visual',
      name: '角色形象图',
      description: '为每个角色生成定妆照，用于后续角色一致性',
      category: 'image',
      capabilities: ['image'],
      inputSchema: { type: 'object', properties: { characters: { type: 'object' } }, required: [] },
      outputSchema: { type: 'object', properties: { assetIds: { type: 'array' } } },
      risk: 'high',
      requiresConfirmation: true,
      accessTier: 'pro',
      estimatedSeconds: 150,
    },
    'ai_image'),

  skill(
    {
      id: 'drama.scene_visual',
      name: '场景概念图',
      description: '为每个场景生成概念图，作为镜头的视觉基准',
      category: 'image',
      capabilities: ['image'],
      inputSchema: { type: 'object', properties: { scenes: { type: 'object' } }, required: [] },
      outputSchema: { type: 'object', properties: { assetIds: { type: 'array' } } },
      risk: 'high',
      requiresConfirmation: true,
      accessTier: 'pro',
      estimatedSeconds: 120,
    },
    'ai_image'),

  /* ── 数字人专业 Skill（技术文档第 21 条） ─────────────────────── */

  skill(
    {
      id: 'digital_human.prepare',
      name: '准备数字人',
      description: '按需求选择或创建数字人形象资产',
      category: 'digital_human',
      capabilities: ['digital_human', 'image'],
      inputSchema: {
        type: 'object',
        properties: { digitalHumanSlug: { type: 'string' }, brief: { type: 'string' } },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: { digitalHumanAssetId: { type: 'string' }, voiceAssetId: { type: 'string' } },
      },
      risk: 'medium',
      estimatedSeconds: 60,
    },
    'ai_digital_human'),

  skill(
    {
      id: 'digital_human.script',
      name: '数字人文案',
      description: '生成适配口播节奏的文案',
      category: 'script',
      capabilities: ['script', 'text'],
      inputSchema: {
        type: 'object',
        properties: { brief: { type: 'string' }, duration: { type: 'number' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { text: { type: 'string' }, segments: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 25,
      aliases: ['数字人文案'],
      userHint: '生成适合口播的文案',
    },
    'ai_llm'),

  skill(
    {
      id: 'digital_human.voice',
      name: '数字人声音',
      description: '用数字人音色合成口播语音',
      category: 'voice',
      capabilities: ['voice'],
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'object' }, voiceAssetId: { type: 'string' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'medium',
      estimatedSeconds: 60,
    },
    'ai_audio'),

  skill(
    {
      id: 'digital_human.motion',
      name: '配置动作',
      description: '按文案分段配置手势与镜头切换',
      category: 'digital_human',
      capabilities: ['digital_human'],
      inputSchema: {
        type: 'object',
        properties: { digitalHuman: { type: 'object' }, script: { type: 'object' } },
        required: [],
      },
      outputSchema: { type: 'object', properties: { timeline: { type: 'array' } } },
      risk: 'low',
      estimatedSeconds: 20,
    },
    'ai_digital_human'),

  skill(
    {
      id: 'digital_human.video',
      name: '数字人成片',
      description: '按数字人流程串接生成完整口播视频',
      category: 'digital_human',
      capabilities: ['digital_human'],
      inputSchema: { type: 'object', properties: { contentId: { type: 'string' } }, required: [] },
      outputSchema: { type: 'object', properties: { assetId: { type: 'string' } } },
      risk: 'high',
      accessTier: 'pro',
      estimatedSeconds: 480,
      requiresConfirmation: true,
    },
    'ai_digital_human'),
];

/** 按 id 索引，便于 O(1) 查找 */
const SKILL_BY_ID = new Map(SKILL_CATALOG.map((entry) => [entry.definition.id, entry]));

/** 取单个技能条目 */
export function getSkill(id: string): SkillCatalogEntry | undefined {
  return SKILL_BY_ID.get(id);
}

/** 列出全部技能定义 */
export function listSkills(): SkillDefinition[] {
  return SKILL_CATALOG.map((entry) => entry.definition);
}

/** 全部技能 id（用于校验 Workflow 节点引用） */
export function listSkillIds(): string[] {
  return [...SKILL_BY_ID.keys()];
}

/**
 * 为某能力筛选可用技能。
 * Model Router 与 Agent 的 Skill Selection 都会用到。
 */
export function findSkillsByCapability(capability: string): SkillDefinition[] {
  return SKILL_CATALOG.filter((entry) =>
    (entry.definition.capabilities as readonly string[]).includes(capability),
  ).map((entry) => entry.definition);
}

/** 按中文别名查找技能（`/写脚本` 这类指令的解析） */
export function findSkillByAlias(alias: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((entry) => entry.definition.aliases.includes(alias))?.definition;
}
