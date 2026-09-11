/**
 * 短视频制作流程
 *
 * 对应技术文档第 25 条：
 *   需求 → 选题 → 脚本 → 素材 → 镜头 → 视频 → 配音 → 字幕 → 剪辑 → 输出
 *
 * 与广告流程的差异：短视频以「话题性」为核心驱动力，
 * 因此增加「选题」环节，且素材与镜头并行准备。
 */
import { defineWorkflow } from './define.js';

export const shortVideoWorkflow = defineWorkflow({
  type: 'short_video',
  name: '短视频制作',
  description:
    '围绕平台与受众做选题，产出脚本与镜头，生成素材与视频，完成配音、字幕与剪辑后输出。',
  metadata: {
    defaultDurationSeconds: 60,
    defaultAspectRatio: '9:16',
    supportsPlatforms: ['douyin', 'xiaohongshu', 'kuaishou', 'wechat_channels', 'tiktok', 'youtube_shorts', 'instagram'],
  },
  nodes: [
    {
      key: 'requirement_analysis',
      title: '分析需求',
      skill: 'requirement.analyze',
      estimatedSeconds: 8,
      input: {
        brief: '{{input.brief}}',
        platform: '{{input.platform}}',
        audience: '{{input.audience}}',
        duration: '{{input.duration}}',
      },
    },
    {
      key: 'topic',
      title: '确定选题',
      skill: 'short_video.topic',
      dependsOn: ['requirement_analysis'],
      estimatedSeconds: 20,
      input: { platform: '{{input.platform}}', audience: '{{requirement_analysis.audience}}' },
    },
    {
      key: 'script',
      title: '生成脚本',
      skill: 'short_video.script',
      dependsOn: ['topic'],
      estimatedSeconds: 25,
      input: { topic: '{{topic.output}}', duration: '{{input.duration}}' },
    },
    {
      key: 'assets',
      title: '准备素材',
      skill: 'asset.prepare',
      dependsOn: ['topic'],
      estimatedSeconds: 40,
      input: { topic: '{{topic.output}}', assetSlugs: '{{input.assetSlugs}}' },
    },
    {
      key: 'shots',
      title: '生成镜头',
      skill: 'short_video.storyboard',
      dependsOn: ['script', 'assets'],
      estimatedSeconds: 60,
      input: { script: '{{script.output}}', assets: '{{assets.output}}' },
    },
    {
      key: 'video',
      title: '生成视频',
      skill: 'video.generate',
      dependsOn: ['shots'],
      estimatedSeconds: 300,
      highCost: true,
      input: { shots: '{{shots.output}}' },
    },
    {
      key: 'voice',
      title: '生成配音',
      skill: 'voice.generate',
      dependsOn: ['script'],
      estimatedSeconds: 45,
      input: { script: '{{script.output}}' },
    },
    {
      key: 'subtitle',
      title: '生成字幕',
      skill: 'subtitle.generate',
      dependsOn: ['script', 'voice'],
      estimatedSeconds: 20,
      input: { script: '{{script.output}}', voice: '{{voice.output}}' },
    },
    {
      key: 'edit',
      title: '剪辑合成',
      skill: 'edit.video',
      dependsOn: ['video', 'voice', 'subtitle'],
      estimatedSeconds: 90,
      input: {
        video: '{{video.output}}',
        voice: '{{voice.output}}',
        subtitle: '{{subtitle.output}}',
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
