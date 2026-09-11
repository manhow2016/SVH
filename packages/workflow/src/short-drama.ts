/**
 * 短剧制作流程
 *
 * 对应技术文档第 26 条：
 *   创意 → 故事 → 世界观 → 角色 → 场景 → 分集 → 剧本 → 分镜
 *   → 图片 → 视频 → 配音 → 剪辑 → 成片
 *
 * 并行设计（技术文档第 45 条明确要求）：
 *   角色 与 场景 都只依赖「世界观」，可并行；
 *   剧本 → 分镜 → 视频 必须串行。
 *
 * 多集处理：本定义描述**单集的完整生产链路**。
 * Agent 在为「三集短剧」规划时，会基于该模板为每一集实例化一个
 * WorkflowRun（共享前置的 story / worldview / characters / scenes 节点），
 * 而不是把集数写死进流程结构里。
 */
import { defineWorkflow } from './define.js';

export const shortDramaWorkflow = defineWorkflow({
  type: 'short_drama',
  name: '短剧制作',
  description:
    '从创意与故事出发，构建世界观、角色与场景，拆解分集与剧本，完成分镜、画面、视频、配音与剪辑，输出成片。',
  metadata: {
    defaultAspectRatio: '9:16',
    // 单集时长（秒），总时长 = 集数 × 单集时长
    defaultEpisodeDurationSeconds: 120,
    supportsPlatforms: ['douyin', 'kuaishou', 'wechat_channels', 'bilibili', 'youtube', 'tiktok'],
  },
  nodes: [
    {
      key: 'idea',
      title: '创意构思',
      skill: 'drama.idea',
      estimatedSeconds: 20,
      input: {
        brief: '{{input.brief}}',
        genre: '{{input.genre}}',
        episodes: '{{input.episodes}}',
      },
    },
    {
      key: 'story',
      title: '故事大纲',
      skill: 'drama.story',
      dependsOn: ['idea'],
      estimatedSeconds: 40,
      input: { idea: '{{idea.output}}', episodes: '{{input.episodes}}' },
    },
    {
      key: 'worldview',
      title: '世界观设定',
      skill: 'drama.worldview',
      dependsOn: ['story'],
      estimatedSeconds: 30,
      input: { story: '{{story.output}}' },
    },
    {
      key: 'characters',
      title: '角色设定',
      skill: 'drama.character',
      dependsOn: ['worldview'],
      estimatedSeconds: 50,
      input: { worldview: '{{worldview.output}}', story: '{{story.output}}' },
    },
    {
      key: 'scenes',
      title: '场景设定',
      skill: 'drama.scene',
      dependsOn: ['worldview'],
      estimatedSeconds: 40,
      input: { worldview: '{{worldview.output}}' },
    },
    {
      key: 'episodes',
      title: '分集拆解',
      skill: 'drama.episode',
      dependsOn: ['story', 'characters'],
      estimatedSeconds: 40,
      input: { story: '{{story.output}}', characters: '{{characters.output}}' },
    },
    {
      key: 'script',
      title: '剧本',
      skill: 'drama.script',
      dependsOn: ['episodes', 'characters', 'scenes'],
      estimatedSeconds: 90,
      input: {
        episodes: '{{episodes.output}}',
        characters: '{{characters.output}}',
        scenes: '{{scenes.output}}',
      },
    },
    {
      key: 'storyboard',
      title: '分镜',
      skill: 'drama.storyboard',
      dependsOn: ['script'],
      estimatedSeconds: 60,
      input: { script: '{{script.output}}', scenes: '{{scenes.output}}' },
    },
    {
      key: 'character_visual',
      title: '角色形象图',
      skill: 'drama.character_visual',
      dependsOn: ['characters'],
      estimatedSeconds: 150,
      highCost: true,
      input: { characters: '{{characters.output}}' },
    },
    {
      key: 'scene_visual',
      title: '场景概念图',
      skill: 'drama.scene_visual',
      dependsOn: ['scenes'],
      estimatedSeconds: 120,
      highCost: true,
      input: { scenes: '{{scenes.output}}' },
    },
    {
      key: 'images',
      title: '生成分镜画面',
      skill: 'image.generate',
      dependsOn: ['storyboard', 'character_visual', 'scene_visual'],
      estimatedSeconds: 600,
      input: {
        storyboard: '{{storyboard.output}}',
        characterVisual: '{{character_visual.output}}',
        sceneVisual: '{{scene_visual.output}}',
      },
    },
    {
      key: 'video',
      title: '生成视频片段',
      skill: 'video.generate',
      dependsOn: ['images'],
      estimatedSeconds: 1200,
      highCost: true,
      input: { images: '{{images.output}}' },
    },
    {
      key: 'voice',
      title: '生成配音',
      skill: 'voice.generate',
      dependsOn: ['script', 'characters'],
      estimatedSeconds: 150,
      input: { script: '{{script.output}}', characters: '{{characters.output}}' },
    },
    {
      key: 'subtitle',
      title: '生成字幕',
      skill: 'subtitle.generate',
      dependsOn: ['script', 'voice'],
      estimatedSeconds: 30,
      input: { script: '{{script.output}}', voice: '{{voice.output}}' },
    },
    {
      key: 'edit',
      title: '剪辑合成',
      skill: 'edit.video',
      dependsOn: ['video', 'voice', 'subtitle'],
      estimatedSeconds: 300,
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
      estimatedSeconds: 20,
      input: { edit: '{{edit.output}}', platform: '{{input.platform}}' },
    },
  ],
});
