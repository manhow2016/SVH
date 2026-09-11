/**
 * 广告制作流程
 *
 * 对应技术文档第 24 条：
 *   用户需求 → 产品分析 → 广告目标 → 广告创意 → 广告脚本 → 分镜
 *   → 产品视觉 → 视频生成 → 配音 → 字幕 → 剪辑 → 成片
 *
 * 并行设计：广告创意与产品视觉都只依赖「产品分析」，
 * 因此可并行执行，缩短整体制作时间。
 */
import { defineWorkflow } from './define.js';

export const advertisementWorkflow = defineWorkflow({
  type: 'advertisement',
  name: '广告视频制作',
  description:
    '从产品与受众出发，产出创意、脚本、分镜、产品视觉，生成广告视频并完成配音字幕与剪辑，输出可投放的成片。',
  metadata: {
    defaultDurationSeconds: 30,
    defaultAspectRatio: '16:9',
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
        audience: '{{input.audience}}',
        platform: '{{input.platform}}',
        duration: '{{input.duration}}',
        style: '{{input.style}}',
      },
    },
    {
      key: 'product_analysis',
      title: '产品分析',
      skill: 'product.analyze',
      dependsOn: ['requirement_analysis'],
      estimatedSeconds: 12,
      input: {
        productSlugs: '{{input.productSlugs}}',
        audience: '{{requirement_analysis.audience}}',
      },
    },
    {
      key: 'ad_objective',
      title: '确定广告目标',
      skill: 'advertisement.objective',
      dependsOn: ['product_analysis'],
      estimatedSeconds: 8,
    },
    {
      key: 'ad_idea',
      title: '广告创意',
      skill: 'advertisement.idea',
      dependsOn: ['ad_objective'],
      estimatedSeconds: 20,
      input: { objective: '{{ad_objective.output}}' },
    },
    {
      key: 'ad_script',
      title: '广告脚本',
      skill: 'advertisement.script',
      dependsOn: ['ad_idea'],
      estimatedSeconds: 25,
      input: { idea: '{{ad_idea.output}}', duration: '{{input.duration}}' },
    },
    {
      key: 'product_visual',
      title: '产品视觉',
      skill: 'product.visual',
      dependsOn: ['product_analysis'],
      estimatedSeconds: 40,
      input: { productSlugs: '{{input.productSlugs}}' },
    },
    {
      key: 'storyboard',
      title: '生成分镜',
      skill: 'advertisement.storyboard',
      dependsOn: ['ad_script', 'product_visual'],
      estimatedSeconds: 30,
      input: {
        script: '{{ad_script.output}}',
        productVisual: '{{product_visual.output}}',
        duration: '{{input.duration}}',
      },
    },
    {
      key: 'shots',
      title: '生成镜头画面',
      skill: 'image.generate',
      dependsOn: ['storyboard'],
      estimatedSeconds: 180,
      input: { storyboard: '{{storyboard.output}}' },
    },
    {
      key: 'video',
      title: '生成视频',
      skill: 'video.generate',
      dependsOn: ['shots'],
      estimatedSeconds: 420,
      highCost: true,
      input: { shots: '{{shots.output}}' },
    },
    {
      key: 'voice',
      title: '生成配音',
      skill: 'voice.generate',
      dependsOn: ['ad_script'],
      estimatedSeconds: 60,
      input: { script: '{{ad_script.output}}' },
    },
    {
      key: 'subtitle',
      title: '生成字幕',
      skill: 'subtitle.generate',
      dependsOn: ['ad_script', 'voice'],
      estimatedSeconds: 20,
      input: { script: '{{ad_script.output}}', voice: '{{voice.output}}' },
    },
    {
      key: 'edit',
      title: '剪辑合成',
      skill: 'edit.video',
      dependsOn: ['video', 'voice', 'subtitle'],
      estimatedSeconds: 120,
      input: {
        video: '{{video.output}}',
        voice: '{{voice.output}}',
        subtitle: '{{subtitle.output}}',
        music: '{{input.musicAssetSlug}}',
      },
    },
    {
      key: 'output',
      title: '输出成片',
      skill: 'output.publish',
      dependsOn: ['edit'],
      estimatedSeconds: 15,
      input: { edit: '{{edit.output}}', platform: '{{input.platform}}' },
    },
  ],
});
