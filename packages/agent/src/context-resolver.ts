/**
 * Context Resolver —— 上下文解析器
 *
 * 技术文档第 51 条的核心约束：
 *
 * > 每次 Agent 执行任务**只加载相关上下文**。
 * > 例如生成 Shot 03 时加载：项目风格 + 角色 + 场景 + Shot 03 + 相关历史版本。
 * > **不要加载整个项目全部聊天记录。**
 *
 * 本模块把这些取舍写成代码，并且**记录取舍理由**（`notes`）——
 * 这样用户能理解 Agent 为什么这么改，开发者也能定位上下文缺失的问题。
 *
 * ── token 预算 ──
 * 上下文不是越多越好：塞满会推高成本、拖慢响应，还容易让模型忽略关键指令。
 * 因此这里按优先级分配预算，超出时**从低优先级开始裁剪**，
 * 并把裁剪动作记进 notes（而不是静默丢弃）。
 */
import { isCreativeAsset, isMediaAsset, type ResolvedContext } from '@svh/domain';

import type { AgentDeps, AssetSummary } from './ports.js';

/** 解析请求 */
export interface ResolveContextRequest {
  projectId: string;
  sessionId?: string | null;
  contentId?: string | null;
  /** 用户原始消息（用于提取 @引用 与关键词） */
  message: string;
  /** 显式传入的 @引用资产 id（来自前端解析，优先级高于文本解析） */
  referencedAssetIds?: string[];
}

/** 解析选项 */
export interface ContextResolverOptions {
  /** token 预算上限（估算值） */
  tokenBudget?: number;
  /** 最近对话取多少条 */
  recentMessageLimit?: number;
  /** 资产摘要最多列多少个 */
  assetSummaryLimit?: number;
}

const DEFAULT_OPTIONS: Required<ContextResolverOptions> = {
  // 约等于 8000 个中文字符；对规划类任务足够，且不会挤占输出空间
  tokenBudget: 6000,
  // 只取最近 6 条：更早的对话对当前操作几乎没有帮助，却会占用大量预算
  recentMessageLimit: 6,
  assetSummaryLimit: 30,
};

/**
 * 估算文本的 token 数。
 *
 * 用「中文按 1 字 1 token、英文按 4 字符 1 token」的粗略估算，
 * 目的是**控制量级**而不是精确计费。真正的计费以 Provider 返回的
 * usage 为准（已在 model_tasks 中记录）。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    // 中日韩字符按 1 token 计，其余按 4 字符 1 token
    tokens += /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 从文本中解析 `@引用`。
 *
 * 供前端未提供明确引用时使用（例如用户手打的消息）。
 */
export function parseMentions(text: string): string[] {
  const mentions: string[] = [];
  const pattern = /@([\w\u4e00-\u9fa5-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (name !== undefined && !mentions.includes(name)) mentions.push(name);
  }
  return mentions;
}

/** 把资产压缩为一行摘要，供模型快速理解 */
export function summarizeAsset(asset: AssetSummary): string {
  const parts: string[] = [`${asset.name}`];
  if (asset.summary.length > 0) parts.push(asset.summary);
  return parts.join('：');
}

export class ContextResolver {
  private readonly deps: AgentDeps;
  private readonly options: Required<ContextResolverOptions>;

  constructor(deps: AgentDeps, options: ContextResolverOptions = {}) {
    this.deps = deps;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 装配上下文。
   *
   * 加载顺序即优先级（从高到低）：
   *   1. @引用命中的资产 —— 用户明确指向的东西，必须带上
   *   2. 关联内容（若在具体内容上下文中对话）
   *   3. 项目记忆（品牌 / 视觉 / 制作规则）
   *   4. 最近对话
   *   5. 资产摘要清单（最容易被裁剪）
   */
  async resolve(request: ResolveContextRequest): Promise<ResolvedContext> {
    const notes: string[] = [];

    // ── ① 项目记忆：Agent 每次规划都要读的顶层约束 ──
    const projectMemory = await this.deps.projects.getMemory(request.projectId);
    const memoryKeys = Object.keys(projectMemory).filter(
      (key) => projectMemory[key] !== null && projectMemory[key] !== undefined,
    );
    notes.push(
      memoryKeys.length > 0
        ? `已加载项目记忆（${memoryKeys.join('、')}）`
        : '项目记忆为空，本次规划不应用项目级规范',
    );

    // ── ② @引用资产：用户明确指向，优先级最高 ──
    const mentionSlugs =
      request.referencedAssetIds !== undefined && request.referencedAssetIds.length > 0
        ? []
        : parseMentions(request.message);

    let referencedAssets: ResolvedContext['referencedAssets'] = [];

    if (request.referencedAssetIds !== undefined && request.referencedAssetIds.length > 0) {
      /*
       * 前端已经把 `@引用` 解析成资产 id（`POST /api/assets/resolve-mentions`），
       * 这里做的是「按 id 取摘要」。取不到的**必须留痕**：
       *
       * 摘要清单是有上限的（`limit: 200`），资产一多就会有 id 落在窗口之外；
       * 而这条路径上没有 `missing` 名单可依赖 —— 前端只上报命中的 id。
       * 早先的实现用 `filter(a => a !== undefined)` 把它们静静丢掉，
       * 用户在界面上看到的是「引用明明点了、回复里却没有它」，
       * 而 `Composer` 承诺的「Agent 会回答我没有找到 @X」在**这条路径上根本不成立**：
       * 模型拿不到任何「有引用没带上」的线索。
       *
       * 因此把未命中的 id 写进 notes —— 它会随 contextSnapshot 出现在前端
       * 任务面板的「上下文」区，用户与开发者都能看见这一步丢了什么。
       */
      const all = await this.deps.assets.listSummaries(request.projectId, { limit: 200 });
      const byId = new Map(all.map((a) => [a.id, a]));
      const missingIds: string[] = [];
      referencedAssets = [];
      for (const id of request.referencedAssetIds) {
        const asset = byId.get(id);
        if (asset === undefined) {
          missingIds.push(id);
          continue;
        }
        referencedAssets.push({
          id: asset.id,
          slug: asset.slug,
          name: asset.name,
          type: asset.type,
          summary: asset.summary,
        });
      }
      notes.push(
        missingIds.length > 0
          ? `已按前端解析结果加载 ${referencedAssets.length} 个引用资产；` +
            `未找到 ${missingIds.length} 个引用（${missingIds.join('、')}），` +
            `它们没有被带入上下文 —— 引用已归档、或不在本次摘要窗口（前 200 条）内`
          : `已按前端解析结果加载 ${referencedAssets.length} 个引用资产`,
      );
    } else if (mentionSlugs.length > 0) {
      const found = await this.deps.assets.findBySlugs(request.projectId, mentionSlugs);
      referencedAssets = found.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        type: a.type,
        summary: a.summary,
      }));

      const foundSlugs = new Set(found.map((a) => a.slug));
      const missing = mentionSlugs.filter((s) => !foundSlugs.has(s));
      notes.push(
        missing.length > 0
          ? `引用资产 ${found.length} 个已加载，未找到：${missing.join('、')}`
          : `已解析 @引用：${mentionSlugs.join('、')}`,
      );
    }

    // ── ③ 关联内容 ──
    let content: ResolvedContext['content'] = null;
    if (request.contentId !== null && request.contentId !== undefined && request.contentId.length > 0) {
      content = await this.deps.contents.get(request.contentId);
      notes.push(
        content !== null
          ? `已加载关联内容「${content.title}」`
          : `关联内容 ${request.contentId} 不存在`,
      );
    }

    // ── ④ 最近对话 ──
    let recentMessages: ResolvedContext['recentMessages'] = [];
    if (request.sessionId !== null && request.sessionId !== undefined && request.sessionId.length > 0) {
      const raw = await this.deps.sessions.recentMessages(
        request.sessionId,
        this.options.recentMessageLimit,
      );
      recentMessages = raw.map((m) => ({ role: m.role, content: m.content }));
      notes.push(`已加载最近 ${recentMessages.length} 条对话（不加载完整历史）`);
    }

    // ── ⑤ 资产摘要：最容易被裁剪的一项 ──
    const assetSummaries = await this.deps.assets.listSummaries(request.projectId, {
      limit: this.options.assetSummaryLimit,
    });
    notes.push(`资产清单：${assetSummaries.length} 个可用资产`);

    // ── 预算核算与裁剪 ──
    const draft: ResolvedContext = {
      projectMemory,
      assetSummaries: assetSummaries.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        type: a.type,
      })),
      referencedAssets,
      content,
      recentMessages,
      notes,
      estimatedTokens: 0,
    };

    return this.applyBudget(draft);
  }

  /**
   * 应用 token 预算：超预算时从低优先级开始裁剪。
   *
   * 裁剪顺序（先裁最不重要的）：
   *   1. 资产摘要清单（模型可以从工具按需查询）
   *   2. 最近对话（最早的先丢）
   *   3. 项目记忆中体积最大的片段
   *
   * **绝不裁剪**：@引用资产与关联内容 —— 它们是用户明确指向的，
   * 裁掉会让 Agent 答非所问。
   */
  private applyBudget(context: ResolvedContext): ResolvedContext {
    const result: ResolvedContext = { ...context, notes: [...context.notes] };
    const budget = this.options.tokenBudget;

    let tokens = this.measure(result);
    if (tokens <= budget) {
      result.estimatedTokens = tokens;
      return result;
    }

    // ① 先裁资产摘要
    const originalAssetCount = result.assetSummaries.length;
    while (this.measure(result) > budget && result.assetSummaries.length > 0) {
      // 一次裁掉一半，避免逐条裁剪的低效
      const keep = Math.floor(result.assetSummaries.length / 2);
      result.assetSummaries = result.assetSummaries.slice(0, keep);
    }
    if (result.assetSummaries.length < originalAssetCount) {
      result.notes.push(
        `上下文超出预算，资产清单从 ${originalAssetCount} 个裁剪到 ${result.assetSummaries.length} 个` +
          `（Agent 可用 asset.search 按需查询）`,
      );
    }

    // ② 再裁最早的对话
    const originalMessageCount = result.recentMessages.length;
    while (this.measure(result) > budget && result.recentMessages.length > 1) {
      result.recentMessages = result.recentMessages.slice(1);
    }
    if (result.recentMessages.length < originalMessageCount) {
      result.notes.push(
        `上下文超出预算，去掉最早的 ${originalMessageCount - result.recentMessages.length} 条对话`,
      );
    }

    // ③ 最后才精简项目记忆（保留键，去掉空值）
    if (this.measure(result) > budget) {
      const compact: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.projectMemory)) {
        const serialized = JSON.stringify(value);
        // 单项超过 2000 字符的记忆片段整体丢弃，避免一条挤爆预算
        if (serialized !== undefined && serialized.length <= 2000) {
          compact[key] = value;
        }
      }
      if (Object.keys(compact).length < Object.keys(result.projectMemory).length) {
        result.projectMemory = compact;
        result.notes.push('上下文超出预算，已精简项目记忆中体积过大的片段');
      }
    }

    tokens = this.measure(result);
    result.estimatedTokens = tokens;

    if (tokens > budget) {
      result.notes.push(
        `注意：裁剪后仍约 ${tokens} tokens，超出预算 ${budget}。建议开启新会话或缩小需求范围。`,
      );
    } else {
      result.notes.push(`裁剪后上下文约 ${tokens} tokens（预算 ${budget}）`);
    }

    return result;
  }

  /** 估算整份上下文的 token 数 */
  private measure(context: ResolvedContext): number {
    let total = 0;

    total += estimateTokens(JSON.stringify(context.projectMemory));

    for (const asset of context.assetSummaries) {
      total += estimateTokens(`${asset.slug}${asset.name}${asset.type}`);
    }
    for (const asset of context.referencedAssets) {
      total += estimateTokens(`${asset.slug}${asset.name}${asset.summary}`);
    }
    if (context.content !== null) {
      total += estimateTokens(
        `${context.content.title}${context.content.brief}${JSON.stringify(context.content.metadata)}`,
      );
    }
    for (const message of context.recentMessages) {
      total += estimateTokens(message.content);
    }

    return total;
  }
}

/**
 * 把上下文渲染为提示词片段。
 *
 * 刻意用**结构化文本**而不是 JSON：模型对「标题 + 列表」的理解
 * 通常好于嵌套 JSON，且更省 token。
 */
export function renderContext(context: ResolvedContext): string {
  const sections: string[] = [];

  // 项目规范
  const memory = context.projectMemory;
  if (Object.keys(memory).length > 0) {
    const lines: string[] = ['## 项目规范'];
    const goals = memory.goals as Record<string, unknown> | undefined;
    if (goals !== undefined && typeof goals.objective === 'string') {
      lines.push(`- 项目目标：${goals.objective}`);
    }
    const brand = memory.brand as Record<string, unknown> | undefined;
    if (brand !== undefined) {
      if (typeof brand.tone === 'string') lines.push(`- 品牌调性：${brand.tone}`);
      if (Array.isArray(brand.must) && brand.must.length > 0) {
        lines.push(`- 必须遵守：${brand.must.join('、')}`);
      }
      if (Array.isArray(brand.forbidden) && brand.forbidden.length > 0) {
        lines.push(`- 禁止出现：${brand.forbidden.join('、')}`);
      }
    }
    const visual = memory.visual as Record<string, unknown> | undefined;
    if (visual !== undefined) {
      if (typeof visual.style === 'string') lines.push(`- 视觉风格：${visual.style}`);
      if (Array.isArray(visual.styleKeywords) && visual.styleKeywords.length > 0) {
        lines.push(`- 风格关键词：${visual.styleKeywords.join('、')}`);
      }
      if (typeof visual.negativePrompt === 'string') {
        lines.push(`- 全局负面提示：${visual.negativePrompt}`);
      }
    }
    const production = memory.production as Record<string, unknown> | undefined;
    if (production !== undefined) {
      if (typeof production.defaultShotDuration === 'number') {
        lines.push(`- 默认镜头时长：${production.defaultShotDuration} 秒`);
      }
      if (typeof production.defaultContentDuration === 'number') {
        lines.push(`- 默认内容时长：${production.defaultContentDuration} 秒`);
      }
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  // 关联内容
  if (context.content !== null) {
    const content = context.content;
    const lines = [`## 当前内容`, `- 标题：${content.title}`];
    if (content.brief.length > 0) lines.push(`- 需求：${content.brief}`);
    lines.push(`- 类型：${content.type}｜状态：${content.status}`);

    const meta = content.metadata;
    const metaParts: string[] = [];
    if (typeof meta.duration === 'number') metaParts.push(`时长 ${meta.duration} 秒`);
    if (typeof meta.platform === 'string') metaParts.push(`平台 ${meta.platform}`);
    if (typeof meta.audience === 'string') metaParts.push(`受众 ${meta.audience}`);
    if (Array.isArray(meta.style)) metaParts.push(`风格 ${meta.style.join('、')}`);
    if (metaParts.length > 0) lines.push(`- 创作参数：${metaParts.join('｜')}`);

    sections.push(lines.join('\n'));
  }

  // @引用资产
  if (context.referencedAssets.length > 0) {
    const lines = ['## 用户引用的资产'];
    for (const asset of context.referencedAssets) {
      lines.push(`- @${asset.slug}（${asset.type}）：${asset.summary}`);
    }
    sections.push(lines.join('\n'));
  }

  // 可用资产清单
  if (context.assetSummaries.length > 0) {
    const byType = new Map<string, string[]>();
    for (const asset of context.assetSummaries) {
      const list = byType.get(asset.type) ?? [];
      list.push(`@${asset.slug}`);
      byType.set(asset.type, list);
    }
    const lines = ['## 项目可用资产'];
    for (const [type, slugs] of byType) {
      lines.push(`- ${type}：${slugs.join('、')}`);
    }
    sections.push(lines.join('\n'));
  }

  // 最近对话
  if (context.recentMessages.length > 0) {
    const lines = ['## 最近对话'];
    for (const message of context.recentMessages) {
      const role = message.role === 'user' ? '用户' : message.role === 'agent' ? 'Agent' : message.role;
      // 单条截断，避免一条长消息挤占全部预算
      lines.push(`- ${role}：${message.content.slice(0, 300)}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/** 供工具与 Planner 复用的资产分类判断 */
export { isCreativeAsset, isMediaAsset };
