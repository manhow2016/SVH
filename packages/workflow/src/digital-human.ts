/**
 * 数字人制作流程
 *
 * 对应技术文档第 27 条：
 *   需求 → 数字人 → 文案 → 声音 → 动作 → 背景 → 视频 → 字幕 → 输出
 *
 * 与其它流程的关键差异：数字人流程的「输入四方」——
 * 数字人形象、文案、声音、背景 —— 彼此独立，可完全并行准备，
 * 最后汇聚到「数字人视频」节点。
 */
import { defineWorkflow } from './define.js';

export const digitalHumanWorkflow = defineWorkflow({
  type: 'digital_human',
  name: '数字人口播制作',
  description:
    '基于数字人形象、文案、声音与背景，合成口播视频，叠加字幕与品牌元素后输出。',
  metadata: {
    defaultAspectRatio: '9:16',
    defaultDurationSeconds: 60,
    supportsPlatforms: ['douyin', 'xiaohongshu', 'wechat_channels', 'bilibili', 'generic'],
  },
  nodes: [
    {
      key: 'requirement_analysis',
      title: '分析需求',
      skill: 'requirement.analyze',
      estimatedSeconds: 8,
      input: {
        brief: '{{input.brief}}',
        productSlugs: '{{input.productSlugs}}',
        duration: '{{input.duration}}',
        audience: '{{input.audience}}',
      },
    },
    {
      key: 'digital_human',
      title: '准备数字人',
      skill: 'digital_human.prepare',
      dependsOn: ['requirement_analysis'],
      estimatedSeconds: 60,
      input: {
        digitalHumanSlug: '{{input.digitalHumanSlug}}',
        // 未指定数字人时由 Skill 按需求推荐或创建
        brief: '{{input.brief}}',
      },
    },
    {
      key: 'copywriting',
      title: '生成口播文案',
      skill: 'digital_human.script',
      dependsOn: ['requirement_analysis'],
      estimatedSeconds: 25,
      input: { brief: '{{input.brief}}', duration: '{{input.duration}}' },
    },
    {
      key: 'voice',
      title: '生成声音',
      skill: 'digital_human.voice',
      dependsOn: ['copywriting', 'digital_human'],
      estimatedSeconds: 60,
      input: {
        script: '{{copywriting.output}}',
        // 优先使用数字人自带音色
        voiceAssetId: '{{digital_human.voiceAssetId}}',
      },
    },
    {
      key: 'background',
      title: '准备背景',
      skill: 'image.generate',
      dependsOn: ['requirement_analysis'],
      estimatedSeconds: 40,
      input: {
        backgroundAssetSlug: '{{input.backgroundAssetSlug}}',
        style: '{{requirement_analysis.style}}',
      },
    },
    {
      key: 'motion',
      title: '配置动作',
      skill: 'digital_human.motion',
      dependsOn: ['digital_human', 'copywriting'],
      estimatedSeconds: 20,
      input: { digitalHuman: '{{digital_human.output}}', script: '{{copywriting.output}}' },
    },
    {
      key: 'video',
      title: '合成数字人视频',
      skill: 'digital_human.generate',
      dependsOn: ['digital_human', 'voice', 'background', 'motion'],
      estimatedSeconds: 420,
      highCost: true,
      input: {
        digitalHuman: '{{digital_human.output}}',
        voice: '{{voice.output}}',
        background: '{{background.output}}',
        motion: '{{motion.output}}',
      },
    },
    {
      key: 'subtitle',
      title: '生成字幕',
      skill: 'subtitle.generate',
      dependsOn: ['copywriting', 'voice'],
      estimatedSeconds: 20,
      input: { script: '{{copywriting.output}}', voice: '{{voice.output}}' },
    },
    {
      key: 'brand_overlay',
      title: '叠加品牌元素',
      skill: 'edit.brand_overlay',
      dependsOn: ['video', 'subtitle'],
      estimatedSeconds: 40,
      // 品牌元素叠加失败不应阻断整体产出
      continueOnError: true,
      input: {
        video: '{{video.output}}',
        subtitle: '{{subtitle.output}}',
        brandSlug: '{{input.brandSlug}}',
        logoAssetSlug: '{{input.logoAssetSlug}}',
      },
    },
    {
      key: 'output',
      title: '输出成片',
      skill: 'output.publish',
      dependsOn: ['brand_overlay'],
      estimatedSeconds: 15,
      input: { video: '{{brand_overlay.output}}', platform: '{{input.platform}}' },
    },
  ],
});
