/**
 * Mock Model Provider
 *
 * 用途：在没有真实模型 API 的情况下跑通「Agent → Skill → Task → Worker →
 * 资产产出」的全链路。技术选型阶段已确认采用 Mock 优先策略：
 * 不让外部 API 阻塞架构验证与自动化测试。
 *
 * 三条硬性要求：
 * 1. **确定性**：相同 prompt + model 必须产出相同结果（便于断言与快照）
 * 2. **可注入故障**：能按需让第 N 次调用失败，用于验证重试与降级链路
 * 3. **JSON Schema 填充**：结构化输出要真的符合契约，否则校验逻辑测不出来
 */
import {
  ModelBadOutputError,
  ProviderUnavailableError,
  type ModelCapability,
} from '@svh/domain';

import type { ProviderAdapter, ProviderInvokeParams, ProviderRawResult } from './ports.js';

/** 故障注入规则 */
export interface MockFailureRule {
  /** 命中该 modelKey 时生效；不填表示匹配所有 */
  modelKey?: string;
  /** 匹配的能力 */
  capability?: ModelCapability;
  /** 前 N 次调用失败（从 1 开始计数） */
  failFirstN?: number;
  /** 抛出的错误码 */
  code?: 'PROVIDER_UNAVAILABLE' | 'MODEL_RATE_LIMITED' | 'MODEL_TIMEOUT' | 'MODEL_BAD_OUTPUT';
  /** 固定失败（不消耗计数） */
  alwaysFail?: boolean;
  /** 模拟耗时（毫秒） */
  latencyMs?: number;
}

export interface MockProviderOptions {
  /** 模拟耗时（毫秒），默认 5ms */
  latencyMs?: number;
  /** 故障注入规则 */
  failures?: MockFailureRule[];
  /**
   * Mock 输出的资产 URL 前缀。
   * 图片返回 1x1 的 data URL，视频/音频返回可识别的占位 URL —— 
   * 不写真实文件，避免测试污染磁盘。
   */
  assetBaseUrl?: string;
}

/** 31 字节的 1×1 透明 PNG，用于让前端拿到一个真实可渲染的图片 */
const ONE_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * 确定性哈希（FNV-1a 32 位）。
 * 不用 crypto 是为了保持同步与零依赖，且仅用于生成假数据的种子。
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 由种子生成可复现的伪随机序列 */
function makeRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** 中文风格词表，让 Mock 文本看起来像真实产出（便于人工检查链路） */
const STYLE_WORDS = ['电影感', '冷调', '高级', '自然光', '质感', '留白', '低饱和'];
const SHOT_MOVES = ['缓推', '横移', '手持跟拍', '固定机位', '升降'];

/**
 * 按 JSON Schema 生成符合契约的假数据。
 *
 * 支持 type / properties / required / items / enum / oneOf / const 等
 * 生成式输出最常用的关键字。遇到不支持的关键字时给出宽松值而不是抛错，
 * 保证 Mock 不会因为 Schema 复杂化而失效。
 */
export function synthesizeFromSchema(
  schema: Record<string, unknown>,
  random: () => number,
  depth = 0,
): unknown {
  if (depth > 6) return null;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const index = Math.floor(random() * schema.enum.length);
    return schema.enum[index];
  }
  if ('const' in schema) return schema.const;

  // 显式标注为 unknown[] 再取值：`schema` 是 Record<string, unknown>，
  // 直接下标访问会得到 any，进而触发 no-unsafe-assignment。
  const oneOf = schema.oneOf as unknown[] | undefined;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const index = Math.floor(random() * oneOf.length);
    const branch: unknown = oneOf[index];
    return branch !== null && typeof branch === 'object'
      ? synthesizeFromSchema(branch as Record<string, unknown>, random, depth + 1)
      : null;
  }
  const anyOf = schema.anyOf as unknown[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const branch: unknown = anyOf[0];
    return branch !== null && typeof branch === 'object'
      ? synthesizeFromSchema(branch as Record<string, unknown>, random, depth + 1)
      : null;
  }

  const type = typeof schema.type === 'string' ? schema.type : inferType(schema);

  switch (type) {
    case 'string': {
      const format = schema.format;
      if (format === 'date-time') return new Date(1700000000000).toISOString();
      const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
      const base = `示例文本-${Math.floor(random() * 1000)}`;
      return base.length >= minLength ? base : base.padEnd(minLength, '文');
    }
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 1;
      const max = typeof schema.maximum === 'number' ? schema.maximum : min + 100;
      return Math.round((min + random() * (max - min)) * 100) / 100;
    }
    case 'integer': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 1;
      const max = typeof schema.maximum === 'number' ? schema.maximum : min + 10;
      return Math.floor(min + random() * (max - min + 1));
    }
    case 'boolean':
      return random() > 0.5;
    case 'array': {
      const itemSchema =
        schema.items !== null && typeof schema.items === 'object'
          ? (schema.items as Record<string, unknown>)
          : { type: 'string' };
      const count = Math.min(3, Math.max(1, typeof schema.minItems === 'number' ? schema.minItems : 2));
      return Array.from({ length: count }, () => synthesizeFromSchema(itemSchema, random, depth + 1));
    }
    case 'object':
    case 'record': {
      const properties =
        schema.properties !== null && typeof schema.properties === 'object'
          ? (schema.properties as Record<string, Record<string, unknown>>)
          : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const result: Record<string, unknown> = {};
      for (const [key, subSchema] of Object.entries(properties)) {
        // 非必填字段也生成，便于下游拿到完整结构
        result[key] = synthesizeFromSchema(subSchema, random, depth + 1);
      }
      // 补齐 required 中缺失的字段
      for (const key of required) {
        if (!(key in result)) result[key] = `必填值-${key}`;
      }
      return result;
    }
    default:
      return null;
  }
}

/** 当 schema 未显式声明 type 时，根据关键字推断 */
function inferType(schema: Record<string, unknown>): string {
  if ('properties' in schema || 'additionalProperties' in schema) return 'object';
  if ('items' in schema) return 'array';
  if ('minimum' in schema || 'maximum' in schema) return 'number';
  return 'string';
}

export class MockProviderAdapter implements ProviderAdapter {
  // 独立协议标识：避免与真实 openai_compatible 适配器争抢 kind 槽位
  readonly kind = 'mock' as const;

  private readonly options: MockProviderOptions;
  /** 每个 (modelKey|capability) 的调用计数，用于 failFirstN */
  private readonly callCounts = new Map<string, number>();

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
  }

  /** 重置调用计数（测试用例之间隔离） */
  reset(): void {
    this.callCounts.clear();
  }

  async invoke(params: ProviderInvokeParams): Promise<ProviderRawResult> {
    const key = `${params.modelKey}|${params.capability}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    const rule = this.matchFailureRule(params, count);
    const latency = rule?.latencyMs ?? this.options.latencyMs ?? 5;

    if (latency > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, latency);
      });
    }

    if (rule) {
      throw this.buildFailure(rule);
    }

    const seed = hashString(`${params.modelKey}|${params.capability}|${params.prompt}`);
    const random = makeRandom(seed);

    switch (params.capability) {
      case 'text':
      case 'script':
        return this.buildTextResult(params, random);
      case 'image':
      case 'image_edit':
        return this.buildImageResult(params, seed);
      case 'video':
      case 'video_extend':
        return this.buildVideoResult(params, seed);
      case 'audio':
      case 'music':
      case 'voice':
        return this.buildAudioResult(params, seed);
      case 'subtitle':
        return this.buildSubtitleResult(params, random);
      case 'digital_human':
        return this.buildDigitalHumanResult(params, seed);
      case 'embedding':
        return { data: Array.from({ length: 8 }, () => random()) };
      default:
        // 上面已穷举全部 ModelCapability，走到这里说明新增了能力但忘了补生成器。
        // 用 String() 包一层是因为此时 capability 被收窄为 never。
        return { text: `（Mock 输出，能力 ${String(params.capability)} 未实现专用生成器）` };
    }
  }

  private matchFailureRule(params: ProviderInvokeParams, count: number): MockFailureRule | null {
    for (const rule of this.options.failures ?? []) {
      if (rule.modelKey !== undefined && rule.modelKey !== params.modelKey) continue;
      if (rule.capability !== undefined && rule.capability !== params.capability) continue;
      if (rule.alwaysFail === true) return rule;
      if (rule.failFirstN !== undefined && count <= rule.failFirstN) return rule;
    }
    return null;
  }

  private buildFailure(rule: MockFailureRule): Error {
    const message = `Mock Provider 注入故障（${rule.code ?? 'PROVIDER_UNAVAILABLE'}）`;
    switch (rule.code) {
      case 'MODEL_BAD_OUTPUT':
        return new ModelBadOutputError(message);
      case 'MODEL_TIMEOUT':
        // 由 Model Router 依据 aborted 信号转换，这里直接抛不可用
        return new ProviderUnavailableError(message);
      case 'MODEL_RATE_LIMITED':
      case 'PROVIDER_UNAVAILABLE':
      default:
        return new ProviderUnavailableError(message);
    }
  }

  /** 文本类：有 responseSchema 时按契约生成结构化输出，否则给确定性文本 */
  private buildTextResult(params: ProviderInvokeParams, random: () => number): ProviderRawResult {
    if (params.responseSchema !== undefined) {
      const data = synthesizeFromSchema(params.responseSchema, random);
      return {
        data,
        // 同时给出文本形式，便于不解析 JSON 的调用方也能用
        text: JSON.stringify(data),
        usage: { inputTokens: params.prompt.length, outputTokens: 128, totalTokens: params.prompt.length + 128 },
      };
    }

    const style = STYLE_WORDS[Math.floor(random() * STYLE_WORDS.length)] ?? '电影感';
    const move = SHOT_MOVES[Math.floor(random() * SHOT_MOVES.length)] ?? '缓推';
    return {
      text: [
        `【Mock 生成】围绕需求「${params.prompt.slice(0, 60)}」产出内容。`,
        `整体风格：${style}。`,
        `镜头建议：${move}。`,
      ].join('\n'),
      usage: { inputTokens: params.prompt.length, outputTokens: 96, totalTokens: params.prompt.length + 96 },
    };
  }

  private buildImageResult(params: ProviderInvokeParams, seed: number): ProviderRawResult {
    const width = typeof params.params.width === 'number' ? params.params.width : 1024;
    const height = typeof params.params.height === 'number' ? params.params.height : 1024;
    return {
      files: [
        {
          url: ONE_PIXEL_PNG_DATA_URL,
          mimeType: 'image/png',
          width,
          height,
        },
      ],
      // 把种子放进 usage，便于测试断言「同输入同输出」
      usage: { units: 1, unitLabel: 'image', seed },
    };
  }

  private buildVideoResult(params: ProviderInvokeParams, seed: number): ProviderRawResult {
    const duration = typeof params.params.duration === 'number' ? params.params.duration : 5;
    const base = this.options.assetBaseUrl ?? 'mock://assets';
    return {
      files: [
        {
          // 用 mock:// 协议明确标识这是占位产物，避免被误当成真实视频
          url: `${base}/video/${seed}.mp4`,
          mimeType: 'video/mp4',
          duration,
        },
      ],
      usage: { units: duration, unitLabel: 'second', seed },
    };
  }

  private buildAudioResult(params: ProviderInvokeParams, seed: number): ProviderRawResult {
    const duration = typeof params.params.duration === 'number' ? params.params.duration : 10;
    const base = this.options.assetBaseUrl ?? 'mock://assets';
    return {
      files: [
        {
          url: `${base}/audio/${seed}.mp3`,
          mimeType: 'audio/mpeg',
          duration,
        },
      ],
      usage: { units: duration, unitLabel: 'second', seed },
    };
  }

  /** 字幕：产出带时间轴的 cue 列表（供 Timeline 直接消费） */
  private buildSubtitleResult(params: ProviderInvokeParams, random: () => number): ProviderRawResult {
    const lines = params.prompt.split('\n').filter((l) => l.trim().length > 0).slice(0, 8);
    const source = lines.length > 0 ? lines : ['示例字幕内容'];
    const cues = source.map((text, index) => ({
      index: index + 1,
      start: index * 2.5,
      end: index * 2.5 + 2.4,
      text: text.slice(0, 40),
    }));
    void random;
    return {
      data: { cues, language: params.params.language ?? 'zh-CN' },
      text: cues.map((c) => c.text).join('\n'),
    };
  }

  private buildDigitalHumanResult(params: ProviderInvokeParams, seed: number): ProviderRawResult {
    const duration = typeof params.params.duration === 'number' ? params.params.duration : 30;
    const base = this.options.assetBaseUrl ?? 'mock://assets';
    return {
      files: [
        {
          url: `${base}/digital-human/${seed}.mp4`,
          mimeType: 'video/mp4',
          duration,
        },
      ],
      usage: { units: duration, unitLabel: 'second', seed },
    };
  }
}

/**
 * 构造一个「已注册 Mock 模型」的描述，供 Model Router 的模型目录使用。
 * 让调用方无需手写繁复的 ModelDescriptor。
 */
export function buildMockModelDescriptor(input: {
  modelId: string;
  providerId: string;
  modelKey: string;
  displayName: string;
  capabilities: readonly ModelCapability[];
  priority?: number;
}): {
  modelId: string;
  providerId: string;
  modelKey: string;
  displayName: string;
  capabilities: readonly ModelCapability[];
  priority: number;
  supportsStreaming: boolean;
  supportsAsync: boolean;
  defaultParams: Record<string, unknown>;
  enabled: boolean;
  providerHealth: 'healthy';
  providerName: string;
  supportedSizes: string[];
  maxDurationSeconds: number;
} {
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    modelKey: input.modelKey,
    displayName: input.displayName,
    capabilities: input.capabilities,
    priority: input.priority ?? 100,
    supportsStreaming: false,
    supportsAsync: false,
    defaultParams: {},
    enabled: true,
    providerHealth: 'healthy',
    providerName: 'Mock Provider',
    supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
    maxDurationSeconds: 60,
  };
}
