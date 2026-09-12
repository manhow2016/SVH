/**
 * Anthropic（Claude）协议适配器
 *
 * 与 OpenAI 兼容协议的四处关键差异（都必须显式处理，否则请求会被直接拒绝）：
 *
 * 1. **鉴权头**：用 `x-api-key` 而不是 `Authorization: Bearer`
 * 2. **版本头**：必须带 `anthropic-version`，缺失会返回 400
 * 3. **系统提示词**：是顶层的 `system` 字段，不能放进 messages 数组
 * 4. **结构化输出**：Anthropic **没有** `response_format`。
 *    官方推荐做法是 **Tool Calling** —— 定义一个入参为目标的工具并强制调用，
 *    模型就会按该 Schema 输出。这是与 OpenAI 最本质的差别。
 *
 * 媒体生成：Anthropic 不提供图片 / 视频 / 音频生成接口。
 * 因此这些能力会明确报「该协议不支持」，让 Model Router 去选别的模型，
 * 而不是发出一个必然 404 的请求。
 */
import type { ModelCapability } from '@svh/domain';
import { ModelBadOutputError } from '@svh/domain';

import type {
  ProviderAdapter,
  ProviderDescriptor,
  ProviderInvokeParams,
  ProviderRawResult,
} from '../ports.js';
import { ensureJsonObject, getPath, joinUrl, requestJson } from './http.js';

/** Anthropic 的 API 版本，缺失该头会返回 400 */
const ANTHROPIC_VERSION = '2023-06-01';

/** 该协议不支持的能力 */
const UNSUPPORTED_CAPABILITIES: readonly ModelCapability[] = [
  'image',
  'image_edit',
  'video',
  'video_extend',
  'audio',
  'voice',
  'music',
  'digital_human',
  'embedding',
];

/** 强制工具调用的工具名 */
const STRUCTURED_TOOL_NAME = 'svh_structured_output';

/**
 * 把未知值安全地转为可读文本。
 *
 * 为什么不用 `String(value)`：当值的类型被收窄为 `{}`（例如与字面量比较之后）
 * eslint 的 no-base-to-string 会报错 —— 因为对象会变成 `[object Object]`，
 * 这个提示是合理的。显式分支后既无告警，输出也更有意义。
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'unknown';
  return '（非文本值）';
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic_compatible' as const;

  async invoke(params: ProviderInvokeParams): Promise<ProviderRawResult> {
    const label = params.provider.name;

    if (UNSUPPORTED_CAPABILITIES.includes(params.capability)) {
      // 明确说明「是该协议不支持」，这样 Model Router 与用户都知道该换个模型，
      // 而不是误以为服务故障并反复重试
      throw new ModelBadOutputError(
        `${label}（Anthropic 协议）不提供「${params.capability}」能力，请为该能力配置其它协议的模型`,
        {
          retryable: false,
          userMessage: '当前模型不支持这项生成能力，请更换模型。',
          suggestions: ['在设置中为图片 / 视频等能力配置对应协议的模型'],
          context: { capability: params.capability, providerLabel: label },
        },
      );
    }

    return params.responseSchema !== undefined
      ? this.invokeWithTool(params, label)
      : this.invokePlain(params, label);
  }

  /** 普通文本请求 */
  private async invokePlain(params: ProviderInvokeParams, label: string): Promise<ProviderRawResult> {
    const json = await this.post(params, this.buildBody(params, label, undefined), label);
    return this.extractText(json, label, undefined);
  }

  /** 结构化输出：用 Tool Calling 强制模型按 Schema 输出 */
  private async invokeWithTool(params: ProviderInvokeParams, label: string): Promise<ProviderRawResult> {
    const schema = params.responseSchema ?? {};

    const body = this.buildBody(params, label, {
      name: STRUCTURED_TOOL_NAME,
      description: '按指定结构返回结果',
      input_schema: normalizeForAnthropicTool(schema),
    });

    // 强制调用该工具：不设置的话模型可能选择直接文本回复
    body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME };

    const json = await this.post(params, body, label);

    // 从 content 数组里找 tool_use 块，其 input 就是结构化结果
    const content = json.content;
    if (!Array.isArray(content)) {
      throw new ModelBadOutputError(`${label} 的响应缺少 content 数组`, {
        context: { providerLabel: label },
      });
    }

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use' && record.name === STRUCTURED_TOOL_NAME) {
        const usage = extractUsage(json);
        return {
          data: record.input,
          text: JSON.stringify(record.input),
          ...(usage !== undefined ? { usage } : {}),
        };
      }
    }

    // 模型没有调用工具（少数情况）：退化为解析文本里的 JSON
    const textResult = this.extractText(json, label, undefined);
    const parsed = parseJsonFromText(textResult.text);
    if (parsed === null) {
      throw new ModelBadOutputError(`${label} 未按约定的结构返回结果（既没有 tool_use，文本也不是 JSON）`, {
        context: { providerLabel: label, preview: (textResult.text ?? '').slice(0, 200) },
      });
    }
    return { ...textResult, data: parsed };
  }

  /** 构造 messages 请求体 */
  private buildBody(
    params: ProviderInvokeParams,
    label: string,
    tool: { name: string; description: string; input_schema: Record<string, unknown> } | undefined,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.modelKey,
      max_tokens: asNumber(params.params.maxTokens) ?? 4096,
      // 系统提示词必须是顶层字段，不能放进 messages
      system: buildSystemPrompt(params, label),
      messages: [{ role: 'user', content: params.prompt }],
    };

    if (params.params.temperature !== undefined) body.temperature = params.params.temperature;
    if (params.params.topP !== undefined) body.top_p = params.params.topP;
    if (params.params.stopSequences !== undefined) body.stop_sequences = params.params.stopSequences;

    if (tool !== undefined) body.tools = [tool];

    return body;
  }

  /** 发起请求并解析 JSON */
  private async post(
    params: ProviderInvokeParams,
    body: Record<string, unknown>,
    label: string,
  ): Promise<Record<string, unknown>> {
    const result = await requestJson({
      // Anthropic 的路径固定为 /v1/messages
      url: joinUrl(params.provider.baseUrl, '/messages'),
      method: 'POST',
      headers: {
        ...(params.provider.headers ?? {}),
        'x-api-key': params.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    return ensureJsonObject(result, label);
  }

  /** 从 content 块数组里取出文本 */
  private extractText(
    json: Record<string, unknown>,
    label: string,
    _schema: Record<string, unknown> | undefined,
  ): ProviderRawResult {
    const content = json.content;
    if (!Array.isArray(content)) {
      throw new ModelBadOutputError(`${label} 的响应缺少 content 数组`, {
        context: { providerLabel: label },
      });
    }

    const texts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        texts.push(record.text);
      }
    }

    if (texts.length === 0) {
      // 被安全策略拦截时会返回 stop_reason=refusal 且没有 text 块
      const stopReason = getPath(json, 'stop_reason');
      if (stopReason === 'refusal') {
        throw new ModelBadOutputError(`${label} 拒绝了该内容（refusal）`, {
          retryable: false,
          userMessage: '内容未通过模型的安全校验，请调整描述后重试。',
          suggestions: ['调整描述用词后重试'],
          context: { providerLabel: label },
        });
      }
      throw new ModelBadOutputError(`${label} 的响应中没有文本内容`, {
        context: { providerLabel: label, stopReason: describeValue(stopReason) },
      });
    }

    const usage = extractUsage(json);
    return { text: texts.join('\n'), ...(usage !== undefined ? { usage } : {}) };
  }

  /**
   * 连通性检查。
   *
   * Anthropic 没有 `/models` 列表端点，因此发送一个最小的 messages 请求：
   * - 200 → 凭据与网络都好
   * - 401/403 → 凭据问题
   * - 其它 → 网络可达但服务异常
   */
  async checkHealth(provider: ProviderDescriptor, apiKey: string | null): Promise<'healthy' | 'degraded' | 'down'> {
    if (apiKey === null || apiKey.length === 0) return 'down';

    try {
      const result = await requestJson({
        url: joinUrl(provider.baseUrl, '/messages'),
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        json: {
          model: 'claude-3-5-haiku-latest',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        timeoutMs: 10_000,
        providerLabel: provider.name,
      });

      if (result.status >= 200 && result.status < 300) return 'healthy';
      if (result.status === 401 || result.status === 403) return 'down';
      // 404（模型名不存在）说明凭据有效且网络可达
      return result.status === 404 ? 'healthy' : 'degraded';
    } catch {
      return 'down';
    }
  }
}

/**
 * 把 JSON Schema 规范化为 Anthropic Tool 的 input_schema。
 *
 * 与 OpenAI strict 的差异：Anthropic 不要求 required 覆盖全部字段，
 * 也不要求 additionalProperties=false。但数组项的 `items` 必须是单个对象
 * （不支持 tuple 形式），这里做一次收敛避免 400。
 */
export function normalizeForAnthropicTool(
  schema: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return schema;

  const result: Record<string, unknown> = { ...schema };

  const properties = result.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      normalized[key] =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? normalizeForAnthropicTool(value as Record<string, unknown>, depth + 1)
          : value;
    }
    result.properties = normalized;
  }

  // tuple 形式的 items 需要退化为单对象
  if (Array.isArray(result.items)) {
    // 显式标注 unknown：result.items 是 unknown，Array.isArray 之后
    // 元素类型仍为 any，不加标注会触发 no-unsafe-assignment
    const first: unknown = result.items[0];
    result.items =
      first !== null && typeof first === 'object'
        ? normalizeForAnthropicTool(first as Record<string, unknown>, depth + 1)
        : { type: 'string' };
  } else if (result.items !== null && typeof result.items === 'object') {
    result.items = normalizeForAnthropicTool(result.items as Record<string, unknown>, depth + 1);
  }

  return result;
}

/** 系统提示词 */
function buildSystemPrompt(params: ProviderInvokeParams, label: string): string {
  const parts = [`你是 SVH 内容创作 Agent 的模型执行端（Provider：${label}）。请严格按要求输出。`];
  if (params.negativePrompt !== undefined && params.negativePrompt.length > 0) {
    parts.push(`避免出现：${params.negativePrompt}`);
  }
  return parts.join('\n');
}

/** 从纯文本里尽力提取 JSON（模型偶尔会忽略工具调用） */
function parseJsonFromText(text: string | undefined): unknown {
  if (text === undefined) return null;
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 提取用量：Anthropic 用 input_tokens / output_tokens */
function extractUsage(json: Record<string, unknown>): ProviderRawResult['usage'] | undefined {
  const usage = json.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;

  const input = asNumber(record.input_tokens);
  const output = asNumber(record.output_tokens);
  if (input === undefined && output === undefined) return undefined;

  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
