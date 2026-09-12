/**
 * Google Gemini 协议适配器
 *
 * 与 OpenAI 兼容协议的六处关键差异：
 *
 * 1. **鉴权**：API Key 作为 `?key=` 查询参数，或 `x-goog-api-key` 头。
 *    这里用请求头（查询参数会出现在日志与浏览器历史里）
 * 2. **模型在路径里**：`/models/{model}:generateContent`，
 *    而不是把模型名放进请求体
 * 3. **消息结构**：`contents[].parts[].text`，角色是 `user` / `model`
 *    （不是 `assistant`）
 * 4. **系统提示词**：顶层 `systemInstruction`，且结构也是 `parts`
 * 5. **生成参数**：全部嵌在 `generationConfig` 下，字段名是
 *    `temperature` / `maxOutputTokens` / `responseMimeType`
 * 6. **结构化输出**：原生支持 `responseSchema`，但**只接受 OpenAPI 的子集**，
 *    且不支持 `additionalProperties`、`$ref` 等关键字，需要显式裁剪
 *
 * 媒体生成：Gemini 系（含 Imagen、Veo）在部分版本上支持图片与视频，
 * 但端点形态差异大，因此与 OpenAI 适配器一样通过 config 覆盖路径。
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

/** 支持的能力（其余由配置覆盖后走通用分支） */
const NATIVE_CAPABILITIES: readonly ModelCapability[] = [
  'text',
  'script',
  'subtitle',
  'embedding',
  'image',
  'image_edit',
  'video',
  'video_extend',
];

/** Gemini 协议侧的配置 */
interface GeminiConfig {
  /** 覆盖端点路径模板，`{model}` 会被替换为模型名 */
  routes?: Record<string, string>;
  /** 是否使用 x-goog-api-key 头（false 时用 ?key= 查询参数） */
  useApiKeyHeader?: boolean;
  /** 异步任务轮询模板（Veo 等长任务） */
  asyncRoutes?: { submit: string; poll: string };
}

/** 默认端点模板 */
const DEFAULT_ROUTE = '/models/{model}:generateContent';

export class GeminiAdapter implements ProviderAdapter {
  readonly kind = 'gemini_compatible' as const;

  async invoke(params: ProviderInvokeParams): Promise<ProviderRawResult> {
    const config = readConfig(params.provider);
    const label = params.provider.name;

    // 异步长任务（视频）
    if (
      config.asyncRoutes !== undefined &&
      (params.capability === 'video' || params.capability === 'video_extend')
    ) {
      return this.invokeAsync(params, config, label);
    }

    if (!NATIVE_CAPABILITIES.includes(params.capability)) {
      throw new ModelBadOutputError(
        `${label}（Gemini 协议）不支持「${params.capability}」能力，请为该能力配置其它协议的模型`,
        {
          retryable: false,
          userMessage: '当前模型不支持这项生成能力，请更换模型。',
          suggestions: ['在设置中为该项能力配置对应协议的模型'],
          context: { capability: params.capability, providerLabel: label },
        },
      );
    }

    return params.capability === 'embedding'
      ? this.invokeEmbedding(params, config, label)
      : this.invokeGenerate(params, config, label);
  }

  /** 文本 / 图片生成：统一走 generateContent */
  private async invokeGenerate(
    params: ProviderInvokeParams,
    config: GeminiConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const body = this.buildBody(params, label);

    const json = await this.post(params, config, label, body);
    return this.extractResult(json, params, label);
  }

  /** 构造 generateContent 请求体 */
  private buildBody(params: ProviderInvokeParams, label: string): Record<string, unknown> {
    const parts: Array<Record<string, unknown>> = [{ text: params.prompt }];

    // 参考图以 inlineData 形式附在 parts 里（图生图 / 视频首帧）
    for (const image of params.referenceImages) {
      const inline = toInlineData(image);
      if (inline !== null) parts.push({ inlineData: inline });
    }

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      // 系统提示词是顶层字段，结构同样是 parts
      systemInstruction: { parts: [{ text: buildSystemPrompt(params, label) }] },
      generationConfig: buildGenerationConfig(params),
    };

    return body;
  }

  /** 发起请求 */
  private async post(
    params: ProviderInvokeParams,
    config: GeminiConfig,
    label: string,
    body: Record<string, unknown>,
    pathOverride?: string,
  ): Promise<Record<string, unknown>> {
    const useHeader = config.useApiKeyHeader ?? true;
    const template =
      pathOverride ??
      config.routes?.[params.capability] ??
      DEFAULT_ROUTE;
    const path = fillPathTemplate(template, { model: params.modelKey });

    const headers: Record<string, string> = { ...(params.provider.headers ?? {}) };
    let url = joinUrl(params.provider.baseUrl, path);
    if (useHeader) {
      headers['x-goog-api-key'] = params.apiKey ?? '';
    } else if (params.apiKey !== null) {
      // 用查询参数鉴权（部分私有部署只支持这种方式）
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}key=${encodeURIComponent(params.apiKey)}`;
    }

    const result = await requestJson({
      url,
      method: 'POST',
      headers,
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    return ensureJsonObject(result, label);
  }

  /**
   * 从响应中提取结果。
   *
   * 需要处理三种情况：
   * 1. 正常文本 → candidates[0].content.parts[].text
   * 2. 结构化输出 → 同一位置的文本，但内容是被 responseSchema 约束的 JSON
   * 3. 图片生成 → candidates[0].content.parts[].inlineData（base64）
   * 4. 被安全策略拦截 → promptFeedback.blockReason 或 finishReason=SAFETY
   */
  private extractResult(
    json: Record<string, unknown>,
    params: ProviderInvokeParams,
    label: string,
  ): ProviderRawResult {
    // ① 提示词本身被拦截
    const blockReason = getPath(json, 'promptFeedback', 'blockReason');
    if (typeof blockReason === 'string' && blockReason.length > 0) {
      throw new ModelBadOutputError(`${label} 拦截了该提示词（${blockReason}）`, {
        retryable: false,
        userMessage: '内容未通过模型的安全校验，请调整描述后重试。',
        suggestions: ['调整描述用词后重试', '避免涉及敏感内容'],
        context: { providerLabel: label, blockReason },
      });
    }

    const candidate = getPath(json, 'candidates', '0');
    if (candidate === null || typeof candidate !== 'object') {
      throw new ModelBadOutputError(`${label} 的响应中没有候选结果`, {
        context: { providerLabel: label },
      });
    }

    // ② 生成过程被拦截
    const finishReason = (candidate as Record<string, unknown>).finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      throw new ModelBadOutputError(`${label} 因安全策略中止了生成（${String(finishReason)}）`, {
        retryable: false,
        userMessage: '内容未通过模型的安全校验，请调整描述后重试。',
        suggestions: ['调整描述用词后重试'],
        context: { providerLabel: label, finishReason: String(finishReason) },
      });
    }

    const parts = getPath(candidate, 'content', 'parts');
    if (!Array.isArray(parts)) {
      throw new ModelBadOutputError(`${label} 的候选结果中没有内容部分`, {
        context: { providerLabel: label },
      });
    }

    const texts: string[] = [];
    const files: NonNullable<ProviderRawResult['files']> = [];

    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;

      if (typeof record.text === 'string') {
        texts.push(record.text);
      }

      // 图片以 inlineData 返回
      const inline = record.inlineData;
      if (inline !== null && typeof inline === 'object') {
        const data = (inline as Record<string, unknown>).data;
        const mimeType = (inline as Record<string, unknown>).mimeType;
        if (typeof data === 'string') {
          const mime = typeof mimeType === 'string' ? mimeType : 'image/png';
          files.push({ url: `data:${mime};base64,${data}`, mimeType: mime });
        }
      }

      // 部分版本用 fileData 返回已上传文件的引用
      const fileData = record.fileData;
      if (fileData !== null && typeof fileData === 'object') {
        const uri = (fileData as Record<string, unknown>).fileUri;
        if (typeof uri === 'string') files.push({ url: uri });
      }
    }

    const usage = extractUsage(json);

    if (files.length > 0) {
      return { files, ...(texts.length > 0 ? { text: texts.join('\n') } : {}), ...(usage !== undefined ? { usage } : {}) };
    }

    if (texts.length === 0) {
      throw new ModelBadOutputError(`${label} 的响应中既没有文本也没有文件`, {
        context: { providerLabel: label, finishReason: describeValue(finishReason) },
      });
    }

    const text = texts.join('\n');

    // ③ 有结构化约束时解析 JSON
    if (params.responseSchema !== undefined) {
      const parsed = parseJsonLoose(text);
      if (parsed === null) {
        throw new ModelBadOutputError(`${label} 返回的内容不是合法 JSON`, {
          context: { providerLabel: label, preview: text.slice(0, 200) },
        });
      }
      return { data: parsed, text, ...(usage !== undefined ? { usage } : {}) };
    }

    return { text, ...(usage !== undefined ? { usage } : {}) };
  }

  /** 向量化：走 embedContent 端点 */
  private async invokeEmbedding(
    params: ProviderInvokeParams,
    config: GeminiConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const template = config.routes?.embedding ?? '/models/{model}:embedContent';
    const json = await this.post(
      params,
      config,
      label,
      { content: { parts: [{ text: params.prompt }] } },
      template,
    );

    const values = getPath(json, 'embedding', 'values');
    if (!Array.isArray(values)) {
      throw new ModelBadOutputError(`${label} 的响应中缺少向量数据`, {
        context: { providerLabel: label },
      });
    }
    return { data: values };
  }

  /**
   * 异步长任务（Veo 视频生成）。
   *
   * Gemini 的长任务用 `operations` 模型：提交后返回 operation name，
   * 轮询该 name 直到 `done: true`，结果在 `response` 里。
   */
  private async invokeAsync(
    params: ProviderInvokeParams,
    config: GeminiConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const asyncRoutes = config.asyncRoutes;
    if (asyncRoutes === undefined) {
      throw new ModelBadOutputError(`${label} 未配置异步任务端点`, { context: { providerLabel: label } });
    }

    const submitPath = fillPathTemplate(asyncRoutes.submit, { model: params.modelKey });
    const submitBody: Record<string, unknown> = {
      instances: [{ prompt: params.prompt }],
      parameters: {
        ...(params.params.duration !== undefined ? { durationSeconds: params.params.duration } : {}),
        ...(params.params.aspectRatio !== undefined ? { aspectRatio: params.params.aspectRatio } : {}),
      },
    };

    const submitted = await this.post(params, config, label, submitBody, submitPath);
    const operationName = submitted.name;
    if (typeof operationName !== 'string' || operationName.length === 0) {
      throw new ModelBadOutputError(`${label} 的异步提交没有返回 operation name`, {
        context: { providerLabel: label },
      });
    }

    const deadline = Date.now() + params.timeoutMs;
    let intervalMs = 3000;

    for (;;) {
      if (params.signal?.aborted === true) {
        throw new ModelBadOutputError(`${label} 的异步任务已被取消`, {
          retryable: false,
          userMessage: '任务已取消。',
        });
      }
      if (Date.now() > deadline) {
        throw new ModelBadOutputError(`${label} 的异步任务超时`, {
          context: { providerLabel: label, operation: operationName },
        });
      }

      const pollUrl = joinUrl(
        params.provider.baseUrl,
        fillPathTemplate(asyncRoutes.poll, { operation: operationName }),
      );
      const headers: Record<string, string> = { ...(params.provider.headers ?? {}) };
      if (config.useApiKeyHeader ?? true) {
        headers['x-goog-api-key'] = params.apiKey ?? '';
      }
      const url =
        (config.useApiKeyHeader ?? true) || params.apiKey === null
          ? pollUrl
          : `${pollUrl}${pollUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(params.apiKey)}`;

      const result = await requestJson({
        url,
        method: 'GET',
        headers,
        timeoutMs: 30_000,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        providerLabel: label,
      });
      const json = ensureJsonObject(result, label);

      if (json.done === true) {
        const error = json.error;
        if (error !== null && typeof error === 'object') {
          const message = (error as Record<string, unknown>).message;
          throw new ModelBadOutputError(
            `${label} 的异步任务失败：${typeof message === 'string' ? message : '未知原因'}`,
            { context: { providerLabel: label, operation: operationName } },
          );
        }

        const files = extractAsyncFiles(json);
        if (files.length === 0) {
          throw new ModelBadOutputError(`${label} 的异步任务已完成但没有产出文件`, {
            context: { providerLabel: label, operation: operationName },
          });
        }
        return { files, externalId: operationName };
      }

      await sleep(intervalMs, params.signal);
      intervalMs = Math.min(intervalMs * 1.5, 15_000);
    }
  }

  /**
   * 连通性检查：用 `/models` 列表端点。
   * Gemini 的模型列表路径为 `/models`，鉴权方式与生成一致。
   */
  async checkHealth(provider: ProviderDescriptor, apiKey: string | null): Promise<'healthy' | 'degraded' | 'down'> {
    if (apiKey === null || apiKey.length === 0) return 'down';

    const config = readConfig(provider);
    const useHeader = config.useApiKeyHeader ?? true;

    try {
      const url = joinUrl(provider.baseUrl, '/models');
      const finalUrl = useHeader
        ? url
        : `${url}?key=${encodeURIComponent(apiKey)}`;

      const result = await requestJson({
        url: finalUrl,
        method: 'GET',
        headers: useHeader ? { 'x-goog-api-key': apiKey } : {},
        timeoutMs: 10_000,
        providerLabel: provider.name,
      });

      if (result.status >= 200 && result.status < 300) return 'healthy';
      if (result.status === 401 || result.status === 403) return 'down';
      return 'degraded';
    } catch {
      return 'down';
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 共享辅助                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 把模板中的占位符替换为路径值，并**逐段编码**。
 *
 * 为什么不能直接 `encodeURIComponent(value)`：
 * Gemini 的路径占位符可以是多段路径，例如
 *   - 模型名：`models/gemini-2.0-flash`
 *   - operation 名：`operations/abc123` 或 `models/x/operations/abc`
 * 整体编码会把 `/` 变成 `%2F`，请求打到错误的端点上（服务端返回 404）。
 * 正确做法是按 `/` 切分后逐段编码，保留路径层级。
 */
export function fillPathTemplate(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    const encoded = value
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    result = result.split(`{${key}}`).join(encoded);
  }
  return result;
}

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

function readConfig(provider: ProviderDescriptor): GeminiConfig {
  const raw = provider.config;
  if (raw === null || raw === undefined || typeof raw !== 'object') return {};
  return raw as GeminiConfig;
}

/** 构造 generationConfig：Gemini 把所有生成参数都放在这里 */
function buildGenerationConfig(params: ProviderInvokeParams): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (params.params.temperature !== undefined) config.temperature = params.params.temperature;
  if (params.params.topP !== undefined) config.topP = params.params.topP;
  if (params.params.topK !== undefined) config.topK = params.params.topK;
  if (params.params.maxTokens !== undefined) config.maxOutputTokens = params.params.maxTokens;
  if (params.params.seed !== undefined) config.seed = params.params.seed;
  if (params.params.stopSequences !== undefined) config.stopSequences = params.params.stopSequences;

  // 结构化输出：Gemini 用 responseMimeType + responseSchema
  if (params.responseSchema !== undefined) {
    config.responseMimeType = 'application/json';
    config.responseSchema = normalizeForGemini(params.responseSchema);
  }

  return config;
}

/**
 * 把 JSON Schema 裁剪为 Gemini 接受的 OpenAPI 子集。
 *
 * Gemini 的 responseSchema **不接受** `additionalProperties`、`$ref`、
 * `oneOf`（部分版本）等关键字，直接传完整 JSON Schema 会返回 400。
 * 因此这里做白名单式裁剪，只保留它认识的字段。
 */
export function normalizeForGemini(
  schema: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return { type: 'string' };

  const result: Record<string, unknown> = {};

  // Gemini 使用大写类型名
  const type = typeof schema.type === 'string' ? schema.type.toUpperCase() : undefined;
  if (type !== undefined) {
    result.type = type === 'RECORD' ? 'OBJECT' : type;
  }

  if (typeof schema.description === 'string') result.description = schema.description;

  if (Array.isArray(schema.enum)) result.enum = schema.enum;

  // 数值约束
  if (typeof schema.minimum === 'number') result.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') result.maximum = schema.maximum;
  if (typeof schema.minLength === 'number') result.minLength = schema.minLength;
  if (typeof schema.maxLength === 'number') result.maxLength = schema.maxLength;

  const properties = schema.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      normalized[key] =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? normalizeForGemini(value as Record<string, unknown>, depth + 1)
          : { type: 'STRING' };
    }
    result.properties = normalized;
    if (!('type' in result)) result.type = 'OBJECT';
  }

  // required 是 Gemini 接受的（字段名一致）
  if (Array.isArray(schema.required)) result.required = schema.required;

  const items = schema.items;
  if (items !== null && typeof items === 'object') {
    if (Array.isArray(items)) {
      const first: unknown = items[0];
      result.items =
        first !== null && typeof first === 'object'
          ? normalizeForGemini(first as Record<string, unknown>, depth + 1)
          : { type: 'STRING' };
    } else {
      result.items = normalizeForGemini(items as Record<string, unknown>, depth + 1);
    }
    if (!('type' in result)) result.type = 'ARRAY';
  }

  if (!('type' in result)) result.type = 'STRING';
  return result;
}

/** 把参考图转为 inlineData（支持 data URL 与纯 base64） */
function toInlineData(image: string): { mimeType: string; data: string } | null {
  if (image.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(image);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { mimeType: match[1], data: match[2] };
    }
    return null;
  }
  // http(s) URL 需要先下载再转 base64；此处不代劳，交由上层处理
  if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('mock://')) {
    return null;
  }
  return { mimeType: 'image/png', data: image };
}

/** 从异步任务结果里提取文件 */
function extractAsyncFiles(json: Record<string, unknown>): NonNullable<ProviderRawResult['files']> {
  const files: NonNullable<ProviderRawResult['files']> = [];

  const response = json.response;
  if (response === null || typeof response !== 'object') return files;

  const record = response as Record<string, unknown>;

  // Veo：response.generateVideoResponse.generatedSamples[].video.uri
  const samples = getPath(record, 'generateVideoResponse', 'generatedSamples');
  if (Array.isArray(samples)) {
    for (const sample of samples) {
      const uri = getPath(sample, 'video', 'uri');
      if (typeof uri === 'string') files.push({ url: uri, mimeType: 'video/mp4' });
    }
  }

  // 通用兜底：response 里的 uri / url 字段
  if (files.length === 0) {
    const uri = record.uri ?? record.url ?? record.videoUri;
    if (typeof uri === 'string') files.push({ url: uri, mimeType: 'video/mp4' });
  }

  return files;
}

/** 提取用量：Gemini 用 usageMetadata */
function extractUsage(json: Record<string, unknown>): ProviderRawResult['usage'] | undefined {
  const meta = json.usageMetadata;
  if (meta === null || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;

  const input = asNumber(record.promptTokenCount);
  const output = asNumber(record.candidatesTokenCount);
  const total = asNumber(record.totalTokenCount);
  if (input === undefined && output === undefined && total === undefined) return undefined;

  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/** 系统提示词 */
function buildSystemPrompt(params: ProviderInvokeParams, label: string): string {
  const parts = [`你是 SVH 内容创作 Agent 的模型执行端（Provider：${label}）。请严格按要求输出。`];
  if (params.negativePrompt !== undefined && params.negativePrompt.length > 0) {
    parts.push(`避免出现：${params.negativePrompt}`);
  }
  return parts.join('\n');
}

/** 宽松 JSON 解析（兼容代码块包裹） */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试
    }
  }
  return null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
