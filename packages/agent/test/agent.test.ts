/**
 * Creative Agent 单元测试
 *
 * 用**假端口**驱动，不依赖数据库 —— 这正是端口/适配器隔离的价值：
 * 意图规则、上下文预算、流程规划、决策归一化都是纯逻辑，
 * 可以在毫秒级完成验证，且失败时能精确定位。
 */
import { describe, expect, it, vi } from 'vitest';

import type { IntentAnalysis } from '@svh/domain';

import {
  AgentRuntime,
  buildAgentTools,
  ContextResolver,
  estimateTokens,
  extractDuration,
  extractEpisodes,
  extractIndex,
  extractStyle,
  matchByRules,
  normalizeDecision,
  normalizeModelAnalysis,
  parseMentions,
  PromptCompiler,
  WorkflowPlanner,
} from '../src/index.js';
import { NOOP_AGENT_LOGGER, type AgentDeps, type AssetSummary } from '../src/ports.js';

/* -------------------------------------------------------------------------- */
/* 测试用假端口                                                                */
/* -------------------------------------------------------------------------- */

function makeAsset(slug: string, type: string, summary = ''): AssetSummary {
  return { id: `id_${slug}`, slug, name: slug, type, summary };
}

function makeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
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

/* -------------------------------------------------------------------------- */
/* 文本解析工具                                                                */
/* -------------------------------------------------------------------------- */

describe('文本解析工具', () => {
  it('parseMentions 提取中文与英文引用名', () => {
    expect(parseMentions('让 @苏晚 在 @长安城 里，用 @product-A')).toEqual([
      '苏晚',
      '长安城',
      'product-A',
    ]);
  });

  it('parseMentions 去重且忽略空引用', () => {
    expect(parseMentions('@苏晚 和 @苏晚，还有 @')).toEqual(['苏晚']);
  });

  it('extractIndex 支持阿拉伯数字与中文数字', () => {
    expect(extractIndex('把第3个镜头改成夜景')).toBe(3);
    expect(extractIndex('把第三个镜头改成夜景')).toBe(3);
    expect(extractIndex('第十二集')).toBe(12);
    expect(extractIndex('最后一个镜头')).toBe(-1);
    expect(extractIndex('没有序号')).toBeUndefined();
  });

  it('extractDuration 支持秒与分钟', () => {
    expect(extractDuration('做一个30秒的广告')).toBe(30);
    expect(extractDuration('做2分钟的片子')).toBe(120);
    expect(extractDuration('没有时长')).toBeUndefined();
  });

  it('extractEpisodes 支持中文与阿拉伯数字', () => {
    expect(extractEpisodes('三集古装复仇短剧')).toBe(3);
    expect(extractEpisodes('共 12 集')).toBe(12);
  });

  it('extractStyle 提取风格关键词', () => {
    expect(extractStyle('高级、有质感，最好有电影感')).toEqual(['高级', '有质感', '电影感']);
  });

  it('estimateTokens 对中文与英文给出合理量级', () => {
    // 中文按 1 字 1 token
    expect(estimateTokens('你好世界')).toBe(4);
    // 英文按 4 字符 1 token
    expect(estimateTokens('hello world')).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 规则意图匹配                                                                */
/* -------------------------------------------------------------------------- */

describe('规则意图匹配（高置信度模式走规则，不消耗模型调用）', () => {
  it('「继续」类指令被识别为 continue', () => {
    for (const text of ['继续', '开始制作', '确认', '好的', 'OK']) {
      const result = matchByRules(text, { hasContent: false });
      expect(result?.intent).toBe('continue');
      expect(result?.confidence).toBeGreaterThan(0.9);
    }
  });

  it('「取消」被识别为 other', () => {
    expect(matchByRules('取消', { hasContent: false })?.intent).toBe('other');
    expect(matchByRules('算了', { hasContent: false })?.intent).toBe('other');
  });

  it('「第三个镜头改成夜景」被精确定位到镜头 3 的修改', () => {
    const result = matchByRules('把第三个镜头改成夜景', { hasContent: true });

    expect(result?.intent).toBe('modify_content');
    expect(result?.targets).toHaveLength(1);
    expect(result?.targets[0]?.kind).toBe('shot');
    // 精确定位到序号是关键：它决定了只重新生成 Shot 03 而不是整个项目
    expect(result?.targets[0]?.index).toBe(3);
    expect(result?.targets[0]?.label).toContain('第 3 个');
  });

  it('引用资产的修改被识别为 modify_asset', () => {
    const result = matchByRules('把 @苏晚 换成黑色长发', { hasContent: false });

    expect(result?.intent).toBe('modify_asset');
    expect(result?.targets[0]?.slug).toBe('苏晚');
    expect(result?.mentions).toEqual(['苏晚']);
  });

  it('创作需求被识别出内容类型与参数', () => {
    const result = matchByRules('帮我做一个30秒的护肤品广告，面向年轻女性，高级有质感', {
      hasContent: false,
    });

    expect(result?.intent).toBe('create_content');
    expect(result?.contentType).toBe('advertisement');
    expect(result?.parameters.duration).toBe(30);
    expect(result?.parameters.audience).toBe('年轻女性');
    expect(result?.parameters.style).toContain('高级');
  });

  it('识别小红书为短视频类型并提取平台', () => {
    const result = matchByRules('帮我做一个小红书风格的15秒产品视频', { hasContent: false });
    expect(result?.contentType).toBe('short_video');
    expect(result?.parameters.platform).toBe('xiaohongshu');
    expect(result?.parameters.duration).toBe(15);
  });

  it('识别三集古装复仇为短剧并提取集数与题材', () => {
    const result = matchByRules('帮我做一个三集古装复仇故事', { hasContent: false });
    expect(result?.contentType).toBe('short_drama');
    expect(result?.parameters.episodes).toBe(3);
  });

  it('识别数字人需求', () => {
    const result = matchByRules('让一个年轻女主播介绍我的产品', { hasContent: false });
    expect(result?.contentType).toBe('digital_human');
  });

  it('语义模糊时不返回结果，交由模型处理', () => {
    expect(matchByRules('这个东西能不能弄得更好一些', { hasContent: false })).toBeNull();
  });

  it('没有内容上下文时的修改指令不武断归类', () => {
    // 「换个风格」在无上下文时无法定位目标，应由模型结合上下文判断
    expect(matchByRules('换个风格', { hasContent: false })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 模型结果归一化                                                              */
/* -------------------------------------------------------------------------- */

describe('normalizeModelAnalysis —— 不盲信模型输出', () => {
  it('非法 intent 回退为 other', () => {
    const result = normalizeModelAnalysis({ intent: 'not_real', confidence: 0.9 }, [], 'x');
    expect(result.intent).toBe('other');
  });

  it('非法 content_type 被剔除', () => {
    const result = normalizeModelAnalysis(
      { intent: 'create_content', contentType: 'bogus', confidence: 0.9 },
      [],
      'x',
    );
    expect(result.contentType).toBeUndefined();
  });

  it('置信度被收敛到 0~1', () => {
    expect(normalizeModelAnalysis({ intent: 'query', confidence: 5 }, [], 'x').confidence).toBe(1);
    expect(normalizeModelAnalysis({ intent: 'query', confidence: -1 }, [], 'x').confidence).toBe(0);
    expect(normalizeModelAnalysis({ intent: 'query' }, [], 'x').confidence).toBe(0.5);
  });

  it('短视频被剔除集数与题材（类型约束）', () => {
    const result = normalizeModelAnalysis(
      {
        intent: 'create_content',
        contentType: 'short_video',
        episodes: 12,
        genre: '古装',
        confidence: 0.8,
      },
      [],
      'x',
    );
    // 短视频没有分集概念，模型臆造的字段必须被清掉
    expect(result.parameters.episodes).toBeUndefined();
    expect(result.parameters.genre).toBeUndefined();
  });

  it('短剧保留集数与题材', () => {
    const result = normalizeModelAnalysis(
      { intent: 'create_content', contentType: 'short_drama', episodes: 3, genre: '古装', confidence: 0.8 },
      [],
      'x',
    );
    expect(result.parameters.episodes).toBe(3);
    expect(result.parameters.genre).toBe('古装');
  });

  it('模型漏掉序号时由规则补齐（第三个镜头 → 3）', () => {
    const result = normalizeModelAnalysis(
      { intent: 'modify_content', targetKind: 'shot', confidence: 0.8 },
      [],
      '把第三个镜头改成夜景',
    );
    expect(result.targets[0]?.index).toBe(3);
  });

  it('非对象输入不崩溃', () => {
    const result = normalizeModelAnalysis(null, ['苏晚'], '测试');
    expect(result.intent).toBe('other');
    expect(result.mentions).toEqual(['苏晚']);
  });
});

/* -------------------------------------------------------------------------- */
/* 上下文解析与预算                                                            */
/* -------------------------------------------------------------------------- */

describe('ContextResolver —— 只加载相关上下文（技术文档第 51 条）', () => {
  it('加载项目记忆、@引用资产与关联内容', async () => {
    const resolver = new ContextResolver(makeDeps());
    const context = await resolver.resolve({
      projectId: 'p1',
      contentId: 'c1',
      message: '让 @苏晚 在 @长安城 里走路',
    });

    expect(Object.keys(context.projectMemory).length).toBeGreaterThan(0);
    expect(context.referencedAssets.map((a) => a.slug)).toEqual(['苏晚', '长安城']);
    expect(context.content?.title).toBe('测试广告');
    // 装配理由被记录，便于解释与排障
    expect(context.notes.join(' ')).toContain('@引用');
  });

  it('未找到的引用被明确记录，而不是静默忽略', async () => {
    const resolver = new ContextResolver(makeDeps());
    const context = await resolver.resolve({
      projectId: 'p1',
      message: '让 @不存在的角色 出场',
    });

    expect(context.referencedAssets).toHaveLength(0);
    expect(context.notes.join(' ')).toContain('未找到');
    expect(context.notes.join(' ')).toContain('不存在的角色');
  });

  it('不加载完整历史：只取最近若干条对话', async () => {
    const recentMessages = vi.fn(async () => [
      { role: 'user', content: '最近一条', kind: 'text', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const deps = makeDeps({
      sessions: {
        recentMessages,
        appendMessage: async () => undefined,
        updateState: async () => undefined,
        ensureSession: async () => ({ id: 's1', created: false }),
      },
    });

    const resolver = new ContextResolver(deps, { recentMessageLimit: 4 });
    await resolver.resolve({ projectId: 'p1', sessionId: 's1', message: '继续' });

    // 必须把 limit 传给端口，而不是取回全部再在内存里截断
    expect(recentMessages).toHaveBeenCalledWith('s1', 4);
  });

  it('超预算时裁剪资产清单，并保留 @引用资产', async () => {
    const manyAssets: AssetSummary[] = Array.from({ length: 200 }, (_, i) =>
      makeAsset(`资产${i}`, 'image', '这是一个用于占位的资产描述'.repeat(5)),
    );
    const deps = makeDeps({
      assets: {
        findBySlugs: async (_p, slugs) => [makeAsset(slugs[0] ?? '苏晚', 'character', '重要角色')],
        listSummaries: async () => manyAssets,
        search: async () => [],
      },
    });

    const resolver = new ContextResolver(deps, { tokenBudget: 500 });
    const context = await resolver.resolve({
      projectId: 'p1',
      message: '让 @苏晚 出场',
    });

    // 资产清单被裁剪
    expect(context.assetSummaries.length).toBeLessThan(200);
    expect(context.notes.join(' ')).toContain('裁剪');
    // 但用户明确引用的资产必须保留 —— 裁掉它会让 Agent 答非所问
    expect(context.referencedAssets).toHaveLength(1);
    expect(context.referencedAssets[0]?.slug).toBe('苏晚');
  });

  it('预算充足时不裁剪', async () => {
    const resolver = new ContextResolver(makeDeps(), { tokenBudget: 100_000 });
    const context = await resolver.resolve({ projectId: 'p1', message: '你好' });
    expect(context.notes.join(' ')).not.toContain('裁剪');
    expect(context.assetSummaries).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 流程规划                                                                    */
/* -------------------------------------------------------------------------- */

describe('WorkflowPlanner —— 基于模板动态规划', () => {
  const baseAnalysis: IntentAnalysis = {
    intent: 'create_content',
    contentType: 'advertisement',
    confidence: 0.9,
    parameters: { duration: 30 },
    targets: [],
    mentions: [],
  };

  it('广告需求复用内置模板', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    const plan = await planner.plan({ projectId: 'p1', analysis: baseAnalysis });

    expect(plan.origin).toBe('builtin');
    expect(plan.definition.type).toBe('advertisement');
    expect(plan.steps.length).toBeGreaterThan(5);
    expect(plan.totalLayers).toBeGreaterThan(3);
    // 每一步都带上可读的预估，让用户知道要等多久
    expect(plan.steps.some((s) => s.estimate !== undefined)).toBe(true);
  });

  it('极短内容省略字幕节点（时长过短来不及阅读）', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    const plan = await planner.plan({
      projectId: 'p1',
      analysis: { ...baseAnalysis, parameters: { duration: 8 } },
    });

    expect(plan.origin).toBe('adjusted');
    expect(plan.steps.some((s) => s.key === 'subtitle')).toBe(false);
    expect(plan.adjustments.join(' ')).toContain('字幕');
  });

  it('删除节点后下游依赖被重新连接，不留悬空依赖', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    const plan = await planner.plan({
      projectId: 'p1',
      analysis: { ...baseAnalysis, parameters: { duration: 8 } },
    });

    const keys = new Set(plan.definition.nodes.map((n) => n.key));
    for (const node of plan.definition.nodes) {
      for (const dep of node.dependsOn) {
        expect(keys.has(dep), `节点 ${node.key} 依赖了已被删除的 ${dep}`).toBe(true);
      }
    }
    // edges 必须与 dependsOn 保持一致
    const fromEdges = plan.definition.edges.map((e) => `${e.from}->${e.to}`).sort();
    const fromDeps = plan.definition.nodes
      .flatMap((n) => n.dependsOn.map((d) => `${d}->${n.key}`))
      .sort();
    expect(fromEdges).toEqual(fromDeps);
  });

  it('没有内置模板的内容类型生成轻量流程', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    const plan = await planner.plan({
      projectId: 'p1',
      analysis: { ...baseAnalysis, contentType: 'visual_content' },
    });

    expect(plan.origin).toBe('generated');
    // 刻意保持极简：不硬凑多阶段流程
    expect(plan.steps.length).toBeLessThanOrEqual(4);
    expect(plan.rationale).toContain('视觉');
  });

  it('高成本节点较多时要求用户先确认整体方案', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    const plan = await planner.plan({
      projectId: 'p1',
      analysis: { ...baseAnalysis, contentType: 'short_drama' },
    });

    // 短剧流程有角色形象、场景概念、分镜画面、视频等多个高成本节点
    expect(plan.steps.filter((s) => s.highCost).length).toBeGreaterThanOrEqual(3);
    expect(plan.requiresApproval).toBe(true);
  });

  it('缺少内容类型时明确报错，不猜测', async () => {
    const planner = new WorkflowPlanner(makeDeps(), NOOP_AGENT_LOGGER);
    await expect(
      planner.plan({
        projectId: 'p1',
        analysis: { ...baseAnalysis, contentType: undefined },
      }),
    ).rejects.toThrow(/内容类型/);
  });
});

/* -------------------------------------------------------------------------- */
/* Prompt Compiler                                                             */
/* -------------------------------------------------------------------------- */

describe('PromptCompiler —— 分层编译而非拼接', () => {
  it('把项目规范与上下文注入系统提示词', async () => {
    const resolver = new ContextResolver(makeDeps());
    const context = await resolver.resolve({ projectId: 'p1', message: '你好' });

    const compiler = new PromptCompiler();
    const compiled = compiler.compile({
      message: '帮我做个广告',
      analysis: {
        intent: 'create_content',
        contentType: 'advertisement',
        confidence: 0.9,
        parameters: {},
        targets: [],
        mentions: [],
      },
      context,
    });

    expect(compiled.system).toContain('电影感');
    expect(compiled.system).toContain('克制、专业');
    // 用户原始消息必须原样保留
    expect(compiled.user).toBe('帮我做个广告');
  });

  it('局部修改编译出「改什么」与「保持什么」', async () => {
    const resolver = new ContextResolver(makeDeps());
    const context = await resolver.resolve({ projectId: 'p1', message: '把苏晚的服装改成红色' });

    const compiler = new PromptCompiler();
    const compiled = compiler.compile({
      message: '把苏晚的服装改成红色',
      analysis: {
        intent: 'modify_asset',
        confidence: 0.9,
        parameters: {},
        targets: [{ kind: 'asset', slug: '苏晚', label: '@苏晚' }],
        mentions: ['苏晚'],
        modification: '服装改成红色',
      },
      context,
    });

    expect(compiled.system).toContain('局部修改');
    expect(compiled.system).toContain('服装改成红色');
    // 这是角色一致性的关键：明确列出不能改的部分
    expect(compiled.system).toContain('保持不变');
    expect(compiled.notes.join(' ')).toContain('局部修改');
  });

  it('非修改类意图不注入修改块', async () => {
    const resolver = new ContextResolver(makeDeps());
    const context = await resolver.resolve({ projectId: 'p1', message: '你好' });

    const compiled = new PromptCompiler().compile({
      message: '你好',
      analysis: {
        intent: 'query',
        confidence: 0.9,
        parameters: {},
        targets: [],
        mentions: [],
      },
      context,
    });

    expect(compiled.system).not.toContain('局部修改');
  });

  it('系统提示词要求不暴露技术细节', () => {
    const compiler = new PromptCompiler();
    const compiled = compiler.compile({
      message: 'x',
      analysis: { intent: 'other', confidence: 0.5, parameters: {}, targets: [], mentions: [] },
      context: {
        projectMemory: {},
        assetSummaries: [],
        referencedAssets: [],
        content: null,
        recentMessages: [],
        notes: [],
        estimatedTokens: 0,
      },
    });

    expect(compiled.system).toContain('不要暴露技术细节');
    expect(compiled.system).toContain('简体中文');
  });
});

/* -------------------------------------------------------------------------- */
/* Agent 决策归一化                                                            */
/* -------------------------------------------------------------------------- */

describe('normalizeDecision —— 半个工具调用不如不调用', () => {
  it('解析正常的工具调用决策', () => {
    const decision = normalizeDecision({
      thought: '先找角色',
      toolCalls: [{ name: 'asset.search', arguments: { query: '苏晚' } }],
    });

    expect(decision.toolCalls).toHaveLength(1);
    expect(decision.toolCalls[0]?.name).toBe('asset.search');
    expect(decision.toolCalls[0]?.arguments).toEqual({ query: '苏晚' });
  });

  it('缺少 name 的工具调用被丢弃', () => {
    const decision = normalizeDecision({
      thought: 'x',
      toolCalls: [{ arguments: { a: 1 } }, { name: 'ok.tool' }],
    });
    expect(decision.toolCalls).toHaveLength(1);
    expect(decision.toolCalls[0]?.name).toBe('ok.tool');
  });

  it('arguments 非对象时退化为空对象而不是崩溃', () => {
    const decision = normalizeDecision({
      thought: 'x',
      toolCalls: [{ name: 't', arguments: 'not-an-object' }, { name: 't2', arguments: [1, 2] }],
    });
    expect(decision.toolCalls[0]?.arguments).toEqual({});
    expect(decision.toolCalls[1]?.arguments).toEqual({});
  });

  it('thought 缺失时给出兜底文案', () => {
    expect(normalizeDecision({}).thought).toBe('继续处理你的请求');
  });

  it('解析计划结构', () => {
    const decision = normalizeDecision({
      thought: '规划好了',
      reply: '我准备这样做',
      plan: {
        goal: '制作 30 秒广告',
        tasks: [
          { id: 't1', title: '分析需求' },
          { title: '生成画面', skill: 'image.generate' },
        ],
      },
    });

    expect(decision.plan?.goal).toBe('制作 30 秒广告');
    expect(decision.plan?.tasks).toHaveLength(2);
    // 缺少 id 的任务自动补上，避免下游用 undefined 做键
    expect(decision.plan?.tasks[1]?.id).toBe('task_2');
    expect(decision.plan?.tasks[1]?.skill).toBe('image.generate');
  });

  it('无有效任务时不产出计划', () => {
    const decision = normalizeDecision({ thought: 'x', plan: { goal: 'g', tasks: [] } });
    expect(decision.plan).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Agent 运行时（用假端口驱动完整轮次）                                        */
/* -------------------------------------------------------------------------- */

describe('AgentRuntime —— 完整轮次编排', () => {
  /** 构造一个「模型总是返回固定决策」的依赖 */
  function makeRuntimeDeps(decision: Record<string, unknown>, overrides: Partial<AgentDeps> = {}): AgentDeps {
    return makeDeps({
      models: {
        generateText: async () => ({
          text: JSON.stringify(decision),
          data: decision,
          modelId: 'mock-text',
        }),
      },
      ...overrides,
    });
  }

  it('创作需求产出计划载荷，并真实创建内容', async () => {
    const created: Array<{ type: string; title: string }> = [];
    const deps = makeRuntimeDeps(
      { thought: 'x' },
      {
        contents: {
          get: async () => null,
          list: async () => [],
          create: async (input) => {
            created.push({ type: input.type, title: input.title });
            return { id: 'c1', type: input.type, title: input.title };
          },
        },
      },
    );

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '帮我做一个30秒的护肤品广告，面向年轻女性',
      signal: new AbortController().signal,
    });

    expect(result.analysis.intent).toBe('create_content');
    expect(result.analysis.contentType).toBe('advertisement');
    expect(result.payload?.type).toBe('plan');
    // 内容被真实创建：用户确认后才有明确的挂载对象
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('advertisement');
    expect(result.state).toBe('completed');
  });

  it('低置信度时追问，且**不创建**任何内容', async () => {
    const createSpy = vi.fn(async (input: { type: string; title: string }) => ({
      id: 'c1',
      type: input.type,
      title: input.title,
    }));
    const deps = makeRuntimeDeps(
      { thought: 'x', confidence: 0.2, intent: 'other' },
      {
        contents: { get: async () => null, list: async () => [], create: createSpy },
      },
    );

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '这个东西能不能弄得更好一些',
      signal: new AbortController().signal,
    });

    expect(result.state).toBe('waiting_user');
    expect(result.message.length).toBeGreaterThan(0);
    // 信息不足时绝不能动手修改项目
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('引用不存在的资产时明确告知，而不是泛泛追问', async () => {
    const deps = makeRuntimeDeps({ thought: 'x', confidence: 0.2, intent: 'other' });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '让 @不存在的角色 出场',
      signal: new AbortController().signal,
    });

    expect(result.state).toBe('waiting_user');
    // 「找不到 @某某」比「我没理解」具体得多
    expect(result.message).toContain('不存在的角色');
    expect(result.message).toContain('没有找到');
  });

  it('找到引用时在追问里点明，帮助用户确认', async () => {
    const deps = makeRuntimeDeps({ thought: 'x', confidence: 0.2, intent: 'other' });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '让 @苏晚 做点什么',
      signal: new AbortController().signal,
    });

    expect(result.state).toBe('waiting_user');
    expect(result.message).toContain('@苏晚');
  });

  it('模型不可用时保留已算出的意图（不误报为听不懂）', async () => {
    const deps = makeDeps({
      models: {
        generateText: async () => {
          throw new Error('模型服务不可用');
        },
      },
    });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '现在项目里都有什么',
      signal: new AbortController().signal,
    });

    expect(result.state).toBe('failed');
    // 关键：已算出的意图不应因为后续失败就丢掉（此处规则未命中，
    // 因此意图为 other，但要保留 mentions 等已解析信息）
    expect(result.analysis).toBeDefined();
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('工具调用循环：模型要求调用工具后拿到结果再回复', async () => {
    let callCount = 0;
    const deps = makeDeps({
      models: {
        generateText: async () => {
          callCount += 1;
          // 第一轮要求搜资产，第二轮给出最终回复
          if (callCount === 1) {
            return {
              text: '',
              data: {
                thought: '先看看有哪些角色',
                toolCalls: [{ name: 'asset.search', arguments: { query: '苏晚' } }],
              },
              modelId: 'mock-text',
            };
          }
          return {
            text: '',
            data: { thought: '找到了', toolCalls: [], reply: '我找到了角色苏晚。' },
            modelId: 'mock-text',
          };
        },
      },
    });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      // 用一个不触发创作规则的消息，确保走到工具循环而非计划分支
      message: '现在项目里都有什么',
      signal: new AbortController().signal,
    });

    expect(result.message).toBe('我找到了角色苏晚。');
    // 两轮：一次工具调用 + 一次最终回复
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('asset.search');
    expect(result.toolCalls[0]?.status).toBe('success');
  });

  it('未知工具被记录为失败，且不中断整轮对话', async () => {
    const deps = makeDeps({
      models: {
        generateText: async () => ({
          text: '',
          data: {
            thought: 'x',
            toolCalls: [{ name: 'not.a.real.tool', arguments: {} }],
          },
          modelId: 'mock-text',
        }),
      },
    });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '现在项目里都有什么',
      signal: new AbortController().signal,
    });

    const failed = result.toolCalls.find((c) => c.name === 'not.a.real.tool');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('不存在');
    // 达到迭代上限后正常收尾，而不是崩溃
    expect(result.state).toBe('completed');
  });

  it('高成本技能在保守策略下转为确认请求，不入队执行', async () => {
    const enqueueSpy = vi.fn(async () => ({
      taskId: 't1',
      status: 'pending',
      deduplicated: false,
    }));

    const deps = makeDeps({
      tasks: { enqueue: enqueueSpy },
      models: {
        generateText: async () => ({
          text: '',
          data: {
            thought: 'x',
            toolCalls: [{ name: 'skill.execute', arguments: { skillId: 'video.generate' } }],
          },
          modelId: 'mock-text',
        }),
      },
    });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '现在项目里都有什么',
      signal: new AbortController().signal,
      confirmationPolicy: 'reject',
    });

    expect(result.state).toBe('waiting_user');
    expect(result.payload?.type).toBe('confirmation_request');
    // 关键：未确认前绝不入队 —— 高成本操作不能默默消耗额度
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('授权策略下高成本技能正常入队', async () => {
    const enqueueSpy = vi.fn(async () => ({
      taskId: 't1',
      status: 'pending',
      deduplicated: false,
    }));

    // 用计数器区分轮次：提示词里始终包含工具说明，
    // 因此不能靠「提示词是否含某字样」判断第几轮
    let round = 0;
    const deps = makeDeps({
      tasks: { enqueue: enqueueSpy },
      models: {
        generateText: async () => {
          round += 1;
          if (round === 1) {
            return {
              text: '',
              data: {
                thought: 'x',
                toolCalls: [{ name: 'skill.execute', arguments: { skillId: 'video.generate' } }],
              },
              modelId: 'mock-text',
            };
          }
          return {
            text: '',
            data: { thought: 'x', toolCalls: [], reply: '已开始生成视频。' },
            modelId: 'mock-text',
          };
        },
      },
    });

    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '现在项目里都有什么',
      signal: new AbortController().signal,
      confirmationPolicy: 'allow',
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0]?.status).toBe('success');
  });

  it('取消信号会中断执行', async () => {
    const controller = new AbortController();
    controller.abort();

    const deps = makeDeps();
    const runtime = new AgentRuntime({ deps, tools: buildAgentTools({ deps }) });
    const result = await runtime.runTurn({
      projectId: 'p1',
      message: '现在项目里都有什么',
      signal: controller.signal,
    });

    expect(result.message).toContain('取消');
  });
});
