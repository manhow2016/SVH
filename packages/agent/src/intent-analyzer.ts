/**
 * Intent Analyzer —— 意图分析器
 *
 * 对应技术文档第 8、9 条：Agent 从用户自然语言中识别意图与内容类型，
 * 用户**无需主动选择**内容类型。
 *
 * ── 为什么用「规则 + 模型」混合，而不是纯模型 ──
 * 纯模型方案有两个实际问题：
 *   1. 「继续」「开始制作」这类指令语义极简单，走一次模型既慢又可能误判
 *   2. 「第三个镜头改成夜景」这种**局部修改**要求精确的序号与目标定位，
 *      模型经常给不出稳定的结构化结果
 *
 * 因此这里先用规则匹配高置信度的明确模式，命中即返回；
 * 未命中或语义模糊时才交给模型。规则与模型都拿不到高置信度时，
 * Agent 应当**追问**而不是猜测（技术文档第 47 条的精神：宁可多问一句）。
 */
import {
  INTENT_CONFIDENCE_THRESHOLD,
  contentMetadataSchema,
  type ContentType,
  type IntentAnalysis,
  type ModificationTarget,
} from '@svh/domain';
import { CONTENT_TYPES } from '@svh/domain';

import { parseMentions } from './context-resolver.js';
import type { AgentDeps, AgentLogger } from './ports.js';

/** 分析请求 */
export interface AnalyzeIntentRequest {
  projectId: string;
  sessionId?: string | null;
  contentId?: string | null;
  message: string;
  /** 前端已解析出的 @引用资产 id */
  referencedAssetIds?: string[];
}

/** 意图分析的结构化输出契约 */
const INTENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'create_content',
        'modify_content',
        'create_asset',
        'modify_asset',
        'query',
        'advise',
        'continue',
        'other',
      ],
      description: '用户意图分类',
    },
    contentType: {
      type: 'string',
      enum: [...CONTENT_TYPES],
      description: '要创作的内容类型（仅创建内容时填写）',
    },
    confidence: { type: 'number', description: '判断置信度 0~1' },
    duration: { type: 'number', description: '目标时长（秒）' },
    platform: { type: 'string', description: '目标平台，如 douyin / xiaohongshu' },
    audience: { type: 'string', description: '目标受众' },
    style: { type: 'array', items: { type: 'string' }, description: '风格关键词' },
    subject: { type: 'string', description: '主题对象（产品名 / 剧名）' },
    episodes: { type: 'number', description: '集数（短剧）' },
    genre: { type: 'string', description: '题材（短剧）' },
    modification: { type: 'string', description: '修改要求的一句话描述' },
    targetIndex: { type: 'number', description: '被修改目标的序号，如「第三个镜头」填 3' },
    targetKind: {
      type: 'string',
      enum: ['content', 'asset', 'shot', 'scene', 'character', 'output'],
      description: '被修改目标的类型',
    },
    rationale: { type: 'string', description: '判断依据，一句话' },
  },
  required: ['intent', 'confidence'],
};

/* -------------------------------------------------------------------------- */
/* 规则匹配：处理高置信度的明确模式                                            */
/* -------------------------------------------------------------------------- */

/** 内容类型的关键词映射（用于规则识别） */
const CONTENT_TYPE_KEYWORDS: Array<{ type: ContentType; patterns: RegExp[] }> = [
  {
    type: 'short_drama',
    patterns: [/短剧/, /剧集/, /连续剧/, /第[一二三四五六七八九十\d]+集/, /复仇/, /古装.*(故事|剧)/],
  },
  {
    type: 'digital_human',
    patterns: [/数字人/, /虚拟主播/, /AI主播/, /口播/, /主播.*介绍/, /数字分身/],
  },
  {
    type: 'advertisement',
    patterns: [/广告/, /宣传.*产品/, /带货/, /种草/],
  },
  {
    type: 'promo',
    patterns: [/宣传片/, /企业.*片/, /品牌.*片/, /形象片/],
  },
  {
    type: 'visual_content',
    patterns: [/海报/, /banner/i, /封面/, /配图/, /商品图/, /主图/, /视觉/],
  },
  {
    type: 'short_video',
    patterns: [/短视频/, /抖音/, /小红书/, /快手/, /视频号/, /reels/i, /shorts/i, /tiktok/i],
  },
];

/** 平台关键词 */
const PLATFORM_KEYWORDS: Array<{ platform: string; patterns: RegExp[] }> = [
  { platform: 'douyin', patterns: [/抖音/] },
  { platform: 'xiaohongshu', patterns: [/小红书/] },
  { platform: 'kuaishou', patterns: [/快手/] },
  { platform: 'wechat_channels', patterns: [/视频号/] },
  { platform: 'bilibili', patterns: [/B站/, /哔哩哔哩/] },
  { platform: 'youtube', patterns: [/youtube/i] },
  { platform: 'tiktok', patterns: [/tiktok/i] },
  { platform: 'instagram', patterns: [/instagram/i, /ins\b/i] },
];

/** 单个中文数字 */
const CHINESE_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 两: 2,
};

/**
 * 解析中文数字（支持「三」「十二」「二十」「二十三」）。
 *
 * 简单的单字符映射只能处理个位数，而「第十二集」这类表述很常见，
 * 因此需要按十位与个位组合解析。
 */
export function parseChineseNumber(text: string): number | undefined {
  if (text.length === 0) return undefined;

  // 纯个位数
  if (text.length === 1) {
    if (text === '十') return 10;
    return CHINESE_DIGITS[text];
  }

  // 含「十」的两位数
  const tenIndex = text.indexOf('十');
  if (tenIndex >= 0) {
    const tensPart = text.slice(0, tenIndex);
    const onesPart = text.slice(tenIndex + 1);
    const tens = tensPart.length === 0 ? 1 : (CHINESE_DIGITS[tensPart] ?? 0);
    const ones = onesPart.length === 0 ? 0 : (CHINESE_DIGITS[onesPart] ?? 0);
    const value = tens * 10 + ones;
    return value > 0 ? value : undefined;
  }

  return undefined;
}

/** 从文本中提取序号（"第三个镜头" → 3） */
export function extractIndex(text: string): number | undefined {
  // 阿拉伯数字
  const arabic = /第\s*(\d+)\s*(?:个|条|张|集|镜|镜号|幕|场)?/u.exec(text);
  if (arabic?.[1] !== undefined) {
    const value = Number.parseInt(arabic[1], 10);
    if (value > 0) return value;
  }
  // 中文数字（支持十二、二十三这类多位写法）
  const chinese = /第\s*([一二三四五六七八九十两]{1,3})\s*(?:个|条|张|集|镜|幕|场)?/u.exec(text);
  if (chinese?.[1] !== undefined) {
    const value = parseChineseNumber(chinese[1]);
    if (value !== undefined) return value;
  }
  // "最后一个" / "最后一个镜头"
  if (/最后(?:一)?(?:个|条|张|集|镜|幕|场)/u.test(text)) return -1;
  return undefined;
}

/** 从文本中提取时长（秒） */
export function extractDuration(text: string): number | undefined {
  // "30秒" / "30 秒"
  const seconds = /(\d+(?:\.\d+)?)\s*秒/u.exec(text);
  if (seconds?.[1] !== undefined) {
    const value = Number.parseFloat(seconds[1]);
    if (value > 0 && value <= 3600) return value;
  }
  // "1分钟" / "2 分钟"
  const minutes = /(\d+(?:\.\d+)?)\s*分钟/u.exec(text);
  if (minutes?.[1] !== undefined) {
    const value = Number.parseFloat(minutes[1]) * 60;
    if (value > 0 && value <= 3600) return value;
  }
  return undefined;
}

/** 从文本中提取集数 */
export function extractEpisodes(text: string): number | undefined {
  const match = /([一二三四五六七八九十两\d]{1,3})\s*集/u.exec(text);
  if (match?.[1] === undefined) return undefined;
  const raw = match[1];

  // 纯阿拉伯数字
  const arabic = Number.parseInt(raw, 10);
  if (Number.isFinite(arabic) && arabic > 0) return arabic;

  // 中文数字（含十二、二十三这类多位写法）
  return parseChineseNumber(raw);
}

/** 从文本中提取风格关键词 */
export function extractStyle(text: string): string[] {
  const style: string[] = [];
  const candidates = [
    '高级', '有质感', '电影感', '科技感', '年轻', '时尚', '复古', '清新',
    '治愈', '搞笑', '悬疑', '温情', '专业', '简约', '奢华', '暗黑',
    '清新自然', '怀旧', '文艺', '活力',
  ];
  for (const word of candidates) {
    if (text.includes(word)) style.push(word);
  }
  return style;
}

/** 从文本中提取受众 */
export function extractAudience(text: string): string | undefined {
  const patterns = [
    /面向\s*([^\s，。；,;]{2,20})/u,
    /目标(?:用户|受众|人群)[是为：:]*\s*([^\s，。；,;]{2,20})/u,
    /给\s*([^\s，。；,;]{2,20})\s*(?:看|用|做)/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined && match[1].length >= 2) return match[1];
  }
  return undefined;
}

/** 判断是否是在修改已有序号目标 */
function detectModificationTarget(text: string): ModificationTarget | null {
  const index = extractIndex(text);
  if (index === undefined) return null;

  // 目标类型关键词
  const kindPatterns: Array<{ kind: ModificationTarget['kind']; pattern: RegExp; label: string }> = [
    { kind: 'shot', pattern: /镜头|分镜|画面/u, label: '镜头' },
    { kind: 'scene', pattern: /场景|场次/u, label: '场景' },
    { kind: 'character', pattern: /角色|人物/u, label: '角色' },
    { kind: 'content', pattern: /内容|视频|广告/u, label: '内容' },
    { kind: 'output', pattern: /成片|输出/u, label: '成片' },
  ];

  for (const { kind, pattern, label } of kindPatterns) {
    if (pattern.test(text)) {
      return {
        kind,
        ...(index > 0 ? { index } : {}),
        label: index > 0 ? `第 ${index} 个${label}` : `最后${index === -1 ? '一' : ''}个${label}`,
      };
    }
  }
  return null;
}

/**
 * 修改意图的识别模式。
 *
 * 分三类，因为用户的表达方式差异很大：
 * 1. **显式动词**：改成 / 换成 / 修改
 * 2. **外观与服装类**：「穿红色衣服」「戴帽子」「留长发」——
 *    这类表达没有「改」字，但在创作语境下几乎总是修改诉求
 * 3. **程度调整**：「更高级一点」「放大一些」
 */
const MODIFY_PATTERNS = [
  // ① 显式动词
  /改成/, /换成/, /变为/, /调整为/, /修改/, /重新生成/, /再来一?[个次张条]/,
  /不要.*要/, /删掉/, /去掉/, /替换/,
  // ② 外观与服装类（口语化，无「改」字）
  /穿[上着]?[^，。；,;]{0,6}(衣服|裙子|外套|西装|衬衫|汉服|襦裙|礼服)/,
  /(衣服|裙子|外套|服装|造型|发型|发色|妆容)[^，。；,;]{0,8}(换|改|变)/,
  /(换|改|变)[^，。；,;]{0,8}(衣服|裙子|服装|造型|发型|发色|颜色|妆容)/,
  /(戴|留|蓄)[^，。；,;]{0,6}(帽子|眼镜|胡须|长发|短发|马尾)/,
  // ③ 程度与风格调整
  /更[^，。；,;]{0,6}(一点|一些|些)/,
  /再[^，。；,;]{0,6}(一点|一些|些)/,
  /放大|缩小|拉长|缩短|调亮|调暗/,
  /(换成|改成)[^，。；,;]{0,10}(风格|色调|氛围|感觉)/,
];

/**
 * 规则匹配。
 *
 * 命中时返回高置信度结果；未命中返回 null 交给模型。
 */
export function matchByRules(
  message: string,
  context: { hasContent: boolean },
): IntentAnalysis | null {
  const text = message.trim();
  const mentions = parseMentions(text);

  // ── 继续类指令：极短且语义明确，不需要模型 ──
  if (/^(继续|开始|开始制作|确定|确认|好的|可以|行|嗯|好|go|ok)[。！!]*$/iu.test(text)) {
    return {
      intent: 'continue',
      confidence: 0.95,
      parameters: {},
      targets: [],
      mentions,
      rationale: '识别为继续执行的确认指令',
    };
  }

  // ── 取消 / 否定 ──
  if (/^(取消|算了|不用了|停止)[。！!]*$/u.test(text)) {
    return {
      intent: 'other',
      confidence: 0.9,
      parameters: {},
      targets: [],
      mentions,
      rationale: '用户要求取消',
    };
  }

  // ── 局部修改：必须能定位到具体目标才算高置信度 ──
  const isModifyVerb = MODIFY_PATTERNS.some((p) => p.test(text));
  if (isModifyVerb) {
    const target = detectModificationTarget(text);
    if (target !== null) {
      return {
        intent: 'modify_content',
        confidence: 0.85,
        parameters: {},
        targets: [target],
        mentions,
        modification: text,
        rationale: `定位到${target.label}，按局部修改处理`,
      };
    }

    // 提到角色 / 资产名也算可定位
    if (mentions.length > 0) {
      return {
        intent: 'modify_asset',
        confidence: 0.8,
        parameters: {},
        targets: mentions.map((slug) => ({
          kind: 'asset' as const,
          slug,
          label: `@${slug}`,
        })),
        mentions,
        modification: text,
        rationale: '用户引用具体资产并提出修改',
      };
    }

    // 有内容上下文但没指明序号：归为内容级修改，交给模型细化
    if (context.hasContent) {
      return null;
    }
  }

  // ── 创建内容：必须能识别出内容类型 ──
  const createPatterns = [/帮我(?:做|制作|生成|写|创作)/, /做一?[个条支]/, /制作/, /生成一?[个条张]/];
  const isCreate = createPatterns.some((p) => p.test(text));

  if (isCreate) {
    let matchedType: ContentType | null = null;
    for (const { type, patterns } of CONTENT_TYPE_KEYWORDS) {
      if (patterns.some((p) => p.test(text))) {
        matchedType = type;
        break;
      }
    }

    if (matchedType !== null) {
      const parameters: Record<string, unknown> = {};
      const duration = extractDuration(text);
      if (duration !== undefined) parameters.duration = duration;

      const episodes = extractEpisodes(text);
      if (episodes !== undefined) parameters.episodes = episodes;

      const style = extractStyle(text);
      if (style.length > 0) parameters.style = style;

      const audience = extractAudience(text);
      if (audience !== undefined) parameters.audience = audience;

      for (const { platform, patterns } of PLATFORM_KEYWORDS) {
        if (patterns.some((p) => p.test(text))) {
          parameters.platform = platform;
          break;
        }
      }

      // 内容类型识别得很明确，但创作参数可能有缺失，因此置信度不到 1
      return {
        intent: 'create_content',
        contentType: matchedType,
        confidence: 0.85,
        parameters,
        targets: [],
        mentions,
        rationale: `关键词匹配到内容类型「${matchedType}」`,
      };
    }
  }

  // ── 数字人的口语化表达：没有「做/制作」字样也要能识别 ──
  // 「让一个年轻女主播介绍我的产品」是典型的数字人需求，
  // 但字面上没有「帮我做」这类动词，因此单独识别
  if (/(数字人|虚拟主播|AI\s*主播)/iu.test(text) || /(主播|播报|讲解|口播|介绍).{0,10}(产品|商品|内容)/u.test(text)) {
    return {
      intent: 'create_content',
      contentType: 'digital_human',
      confidence: 0.8,
      parameters: {
        ...(extractDuration(text) !== undefined ? { duration: extractDuration(text) } : {}),
      },
      targets: [],
      mentions,
      rationale: '识别为主播 / 口播类需求，归为数字人内容',
    };
  }

  // ── 创建资产 ──
  if (/(设计|创建|生成|做)一?[个位名]*(角色|人物|场景|产品|品牌|形象)/u.test(text)) {
    return {
      intent: 'create_asset',
      confidence: 0.8,
      parameters: {},
      targets: [],
      mentions,
      rationale: '识别为创建资产的请求',
    };
  }

  // ── 查询 ──
  if (/(有哪|有哪些|列出|查看|显示|现在有|都有什么)/u.test(text) && text.length < 60) {
    return {
      intent: 'query',
      confidence: 0.75,
      parameters: {},
      targets: [],
      mentions,
      rationale: '识别为信息查询',
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 模型分析（规则未命中时）                                                    */
/* -------------------------------------------------------------------------- */

export class IntentAnalyzer {
  private readonly deps: AgentDeps;
  private readonly logger: AgentLogger;

  constructor(deps: AgentDeps, logger: AgentLogger) {
    this.deps = deps;
    this.logger = logger;
  }

  /**
   * 分析用户意图。
   *
   * 顺序：规则 → 模型 → 兜底。任何一步得到足够置信度的结果就返回，
   * 避免不必要的模型调用（规则命中时零成本、零延迟）。
   */
  async analyze(request: AnalyzeIntentRequest): Promise<IntentAnalysis> {
    const mentions = parseMentions(request.message);
    const hasContent = request.contentId !== null && request.contentId !== undefined;

    // ① 规则优先
    const byRule = matchByRules(request.message, { hasContent });
    if (byRule !== null) {
      this.logger.debug('意图由规则判定', { intent: byRule.intent, confidence: byRule.confidence });
      return byRule;
    }

    // ② 交给模型
    try {
      const byModel = await this.analyzeByModel(request, mentions);
      if (byModel.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
        return byModel;
      }

      // 置信度不足：明确告诉调用方需要追问，而不是猜一个结果去执行
      return {
        ...byModel,
        clarifyingQuestion:
          byModel.clarifyingQuestion ??
          buildClarifyingQuestion(byModel, hasContent),
        rationale: `${byModel.rationale ?? ''}（置信度 ${byModel.confidence.toFixed(2)} 低于阈值，建议先确认）`.trim(),
      };
    } catch (err) {
      // 模型不可用不能让整个对话失败：退化为保守判断并向用户追问
      this.logger.warn('模型意图分析失败，退化为追问', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        intent: 'other',
        confidence: 0.2,
        parameters: {},
        targets: [],
        mentions,
        clarifyingQuestion: hasContent
          ? '我没太理解你的意思。你想修改这条内容的哪一部分？'
          : '我没太理解你的意思。你想创作什么类型的内容（广告 / 短视频 / 短剧 / 数字人）？',
        rationale: '模型意图分析不可用，需要用户补充说明',
      };
    }
  }

  /** 调用模型做意图分析 */
  private async analyzeByModel(
    request: AnalyzeIntentRequest,
    mentions: string[],
  ): Promise<IntentAnalysis> {
    // 只带轻量上下文：意图分析不需要完整项目记忆，省 token 也更快
    const project = await this.deps.projects.getProject(request.projectId);
    const availableSkills = this.deps.skills.listImplemented();

    const prompt = [
      '请分析下面这条用户消息的意图。',
      '',
      `用户消息：${request.message}`,
      project !== null ? `当前项目：${project.name}` : '',
      request.contentId !== null && request.contentId !== undefined
        ? '用户正在某条具体内容的上下文中对话'
        : '用户没有指定具体内容',
      mentions.length > 0 ? `消息中引用了资产：${mentions.join('、')}` : '',
      '',
      '可用的能力（供你判断意图是否可执行）：',
      ...availableSkills.slice(0, 20).map((s) => `- ${s.id}：${s.name}${s.userHint !== undefined ? `（${s.userHint}）` : ''}`),
      '',
      '判断要求：',
      '- 若用户想创作新内容，识别内容类型并提取时长 / 平台 / 受众 / 风格等参数',
      '- 若是修改，尽量定位到具体目标（targetKind + targetIndex）',
      '- confidence 请如实填写：不确定就给低分，不要为了显得确定而虚高',
      '- 参数无法从消息中推断时不要臆造',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    const result = await this.deps.models.generateText({
      prompt,
      responseSchema: INTENT_SCHEMA,
      temperature: 0.1,
      skillId: 'agent.intent_analyze',
    });

    return normalizeModelAnalysis(result.data, mentions, request.message);
  }
}

/**
 * 归一化模型返回的分析结果。
 *
 * 处理三类问题：
 * 1. 非法枚举值 → 回退为 other
 * 2. 参数不符合内容类型的约束 → 剔除（例如给短视频填集数）
 * 3. 置信度缺失或越界 → 收敛到合法区间
 */
export function normalizeModelAnalysis(
  raw: unknown,
  mentions: string[],
  originalMessage: string,
): IntentAnalysis {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const rawIntent = record.intent;
  const validIntents = [
    'create_content', 'modify_content', 'create_asset', 'modify_asset',
    'query', 'advise', 'continue', 'other',
  ];
  const intent =
    typeof rawIntent === 'string' && validIntents.includes(rawIntent)
      ? (rawIntent as IntentAnalysis['intent'])
      : 'other';

  const rawType = record.contentType;
  const contentType =
    typeof rawType === 'string' && (CONTENT_TYPES as readonly string[]).includes(rawType)
      ? (rawType as ContentType)
      : undefined;

  // 收集创作参数
  const parameters: Record<string, unknown> = {};
  if (typeof record.duration === 'number' && record.duration > 0) parameters.duration = record.duration;
  if (typeof record.platform === 'string') parameters.platform = record.platform;
  if (typeof record.audience === 'string') parameters.audience = record.audience;
  if (Array.isArray(record.style)) {
    const style = record.style.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (style.length > 0) parameters.style = style;
  }
  if (typeof record.subject === 'string') parameters.subject = record.subject;
  if (typeof record.genre === 'string') parameters.genre = record.genre;
  if (typeof record.episodes === 'number' && record.episodes > 0) {
    parameters.episodes = Math.floor(record.episodes);
  }

  // 用领域 Schema 过滤掉与内容类型不符的参数
  const validated = contentMetadataSchema.safeParse(parameters);
  const cleanParameters = validated.success
    ? (validated.data as Record<string, unknown>)
    : parameters;

  // 类型约束：只有短剧有集数与题材
  if (contentType !== undefined && contentType !== 'short_drama') {
    delete cleanParameters.episodes;
    delete cleanParameters.genre;
  }
  if (contentType === 'visual_content' || contentType === 'promo') {
    delete cleanParameters.sellingPoints;
  }

  // ── 目标定位 ──
  // 两条路径：模型给出 targetKind，或规则从原文识别出「第三个镜头」这类表述。
  // 关键点：只要模型**没有给出有效序号**，就必须再走一次规则补齐 ——
  // 模型经常能判断出「要改哪里」却漏掉「第几个」，导致定位不完整。
  const targets: ModificationTarget[] = [];
  const rawKind = record.targetKind;
  const validKinds = ['content', 'asset', 'shot', 'scene', 'character', 'output'];

  const modelIndex =
    typeof record.targetIndex === 'number' && Number.isFinite(record.targetIndex) && record.targetIndex !== 0
      ? Math.trunc(record.targetIndex)
      : undefined;

  if (typeof rawKind === 'string' && validKinds.includes(rawKind) && modelIndex !== undefined) {
    targets.push({
      kind: rawKind as ModificationTarget['kind'],
      index: modelIndex,
      label: modelIndex > 0 ? `第 ${modelIndex} 个${rawKind}` : `最后${modelIndex === -1 ? '一' : ''}个${rawKind}`,
    });
  } else if (typeof rawKind === 'string' && validKinds.includes(rawKind)) {
    // 有类型但无序号：先按原文补序号，补不到再退回不带序号的定位
    const detected = detectModificationTarget(originalMessage);
    if (detected !== null && detected.kind === rawKind) {
      targets.push(detected);
    } else if (detected !== null && detected.index !== undefined) {
      // 原文的序号更可信，但类型以模型的判断为准
      targets.push({ ...detected, kind: rawKind as ModificationTarget['kind'] });
    } else {
      targets.push({ kind: rawKind as ModificationTarget['kind'], label: rawKind });
    }
  } else {
    const detected = detectModificationTarget(originalMessage);
    if (detected !== null) targets.push(detected);
  }

  const rawConfidence = record.confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5;

  return {
    intent,
    ...(contentType !== undefined ? { contentType } : {}),
    confidence,
    parameters: cleanParameters,
    targets,
    mentions,
    ...(typeof record.modification === 'string' ? { modification: record.modification } : {}),
    ...(typeof record.rationale === 'string' ? { rationale: record.rationale } : {}),
  };
}

/** 根据分析结果生成追问 */
function buildClarifyingQuestion(analysis: IntentAnalysis, hasContent: boolean): string {
  switch (analysis.intent) {
    case 'create_content':
      return '你想创作哪种类型的内容？广告、短视频、短剧、还是数字人口播？';
    case 'modify_content':
    case 'modify_asset':
      return hasContent
        ? '你想修改这条内容的哪个部分？例如「第三个镜头」「角色服装」「背景音乐」。'
        : '你想修改哪个内容或资产？可以用 @ 引用它，或说明它的名字。';
    case 'create_asset':
      return '你想创建哪种资产？角色、场景、产品还是品牌？';
    default:
      return '能再具体说明一下你的需求吗？例如「做一个 30 秒的护肤品广告，面向年轻女性」。';
  }
}
