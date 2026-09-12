/**
 * Agent 测试的假端口工厂
 *
 * 用**假端口**驱动，不依赖数据库 —— 这正是端口/适配器隔离的价值：
 * 意图规则、上下文预算、流程规划、决策归一化都是纯逻辑，
 * 可以在毫秒级完成验证，且失败时能精确定位。
 *
 * 这里从 `agent.test.ts` 中提取出来，供多个测试文件共用，
 * 避免每个测试各写一套 deps 构造代码。`overrides` 是**浅合并**，
 * 因此可以直接按需替换某个端口的实现，例如：
 *
 * ```ts
 * const deps = createTestDeps({ tasks: { enqueue } });
 * ```
 */
import type { AgentDeps, AssetSummary } from '../src/ports.js';

/** 构造一个资产摘要 */
export function makeAsset(slug: string, type: string, summary = ''): AssetSummary {
  return { id: `id_${slug}`, slug, name: slug, type, summary };
}

/** 构造一套完整的假端口；`overrides` 按端口整体替换（浅合并） */
export function createTestDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const assets: AssetSummary[] = [
    makeAsset('苏晚', 'character', '年轻女性，黑色长发'),
    makeAsset('长安城', 'scene', '夜雨中的古城街道'),
    makeAsset('产品A', 'product', '冷萃咖啡液'),
  ];

  return {
    projects: {
      getMemory: async () => ({
        brand: { tone: '克制、专业' },
        visual: { style: '电影感、冷调', styleKeywords: ['电影感', '冷调'] },
        production: { defaultShotDuration: 5 },
      }),
      getProject: async () => ({ id: 'p1', name: '测试项目', description: '用于测试' }),
      mergeMemory: async () => undefined,
    },
    assets: {
      findBySlugs: async (_projectId, slugs) => assets.filter((a) => slugs.includes(a.slug)),
      listSummaries: async () => assets,
      search: async (_projectId, query) => assets.filter((a) => a.slug.includes(query)),
    },
    contents: {
      get: async (contentId) => ({
        id: contentId,
        type: 'advertisement',
        title: '测试广告',
        brief: '一条 30 秒广告',
        status: 'draft',
        metadata: { duration: 30 },
      }),
      list: async () => [],
      create: async (input) => ({ id: 'c_new', type: input.type, title: input.title }),
    },
    sessions: {
      recentMessages: async () => [
        { role: 'user', content: '帮我做个广告', kind: 'text', createdAt: '2026-01-01T00:00:00Z' },
        { role: 'agent', content: '好的，我来规划', kind: 'text', createdAt: '2026-01-01T00:00:01Z' },
      ],
      appendMessage: async () => undefined,
      updateState: async () => undefined,
      ensureSession: async () => ({ id: 's1', created: false }),
    },
    skills: {
      listImplemented: () => [
        {
          id: 'image.generate',
          name: '生成图片',
          description: '根据提示词生成图片',
          category: 'image',
          risk: 'medium',
          accessTier: 'free',
          capabilities: ['image'],
          aliases: ['生成图片'],
        },
        {
          id: 'video.generate',
          name: '生成视频',
          description: '生成视频片段',
          category: 'video',
          risk: 'high',
          accessTier: 'pro',
          capabilities: ['video'],
          aliases: [],
        },
        {
          id: 'requirement.analyze',
          name: '分析需求',
          description: '解析需求',
          category: 'text',
          risk: 'low',
          accessTier: 'free',
          capabilities: ['text'],
          aliases: [],
        },
      ],
    },
    tasks: {
      enqueue: async () => ({ taskId: 't1', status: 'pending', deduplicated: false }),
    },
    models: {
      generateText: async () => ({ text: 'ok', modelId: 'mock-text' }),
    },
    ...overrides,
  };
}
