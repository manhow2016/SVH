/**
 * OpenAI 兼容协议适配器
 *
 * 覆盖范围最广的一类：OpenAI 官方、Azure OpenAI、以及大量「OpenAI 兼容」
 * 的第三方与自建服务（vLLM、Ollama、DashScope 兼容模式、火山方舟、
 * DeepSeek、Moonshot 等）。因此它也是默认协议。
 *
 * ── 适配器的职责边界 ──
 * 只做「领域参数 → 协议报文」的翻译与 HTTP 调用。
 * 重试、降级、成本计算由 Model Router 负责；
 * 超时与取消由 `requestJson` 统一处理。
 *
 * ── 媒体生成的现实情况 ──
 * 「OpenAI 兼容」只对文本接口真正统一，图片与视频各家的路径与报文差异很大。
 * 因此这里通过 `provider.config` 提供可覆盖的端点与字段名映射，
 * 而不是假设所有兼容服务都长得一样。
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

/** 各能力的默认端点路径（可被 provider.config.routes 覆盖） */
const DEFAULT_ROUTES: Record<string, string> = {
  text: '/chat/completions',
  script: '/chat/completions',
  image: '/images/generations',
  image_edit: '/images/edits',
  embedding: '/embeddings',
  // 视频与音频没有统一标准，默认沿用常见路径，通常需要显式覆盖
  video: '/video/generations',
  video_extend: '/video/generations',
  audio: '/audio/speech',
  voice: '/audio/speech',
  music: '/audio/music',
  digital_human: '/digital-human/generations',
  subtitle: '/chat/completions',
};

/** Provider 的协议侧配置（来自 model_providers.config） */
interface OpenAICompatConfig {
  /** 覆盖端点路径 */
  routes?: Record<string, string>;
  /**
   * 异步任务的提交/查询路径模板。
   * 这类接口（视频、数字人）通常是「提交拿 taskId，再轮询」。
   */
  asyncRoutes?: {
    submit: string;
    /** 查询模板，`{id}` 会被替换为任务 id */
    poll: string;
  };
  /** 提交报文里任务 id 的字段路径，如 `data.task_id` */
  taskIdPath?: string;
  /** 轮询结果中表示完成的字段路径与其取值 */
  statusPath?: string;
  successValues?: string[];
  failureValues?: string[];
  /**
   * 图片报文使用 width/height 还是 size。
   * 多数用 size（`1024x1024`），部分国内厂商用 width/height。
   */
  imageSizeMode?: 'size' | 'width_height';
  /** 是否在请求里发送 response_format */
  supportsResponseFormat?: boolean;
  /** 结构性输出使用 json_schema（严格）还是 json_object（宽松） */
  structuredOutputMode?: 'json_schema' | 'json_object';
}

/** 读取并向默认值合并配置 */
function readConfig(provider: ProviderDescriptor): OpenAICompatConfig {
  const raw = (provider as { config?: unknown }).config;
  if (raw === null || typeof raw !== 'object') return {};
  return raw as OpenAICompatConfig;
}

/** 把宽高转为各家通用的尺寸字符串 */
function toSizeString(width: number | undefined, height: number | undefined): string {
  const w = width ?? 1024;
  const h = height ?? 1024;
  return `${w}x${h}`;
}

/** 解析画幅比例字符串为宽高 */
export function parseAspectRatio(ratio: string | undefined, base = 1024): { width: number; height: number } {
  if (ratio === undefined) return { width: base, height: base };
  const parts = ratio.split(':');
  const w = Number.parseFloat(parts[0] ?? '');
  const h = Number.parseFloat(parts[1] ?? '');
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: base, height: base };
  }
  // 保持总面积接近 base²，避免分辨率失控
  const scale = Math.sqrt((base * base) / (w * h));
  return {
    width: Math.round((w * scale) / 8) * 8,
    height: Math.round((h * scale) / 8) * 8,
  };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = 'openai_compatible' as const;

  async invoke(params: ProviderInvokeParams): Promise<ProviderRawResult> {
    const config = readConfig(params.provider);
    const label = params.provider.name;

    // 需要「提交 + 轮询」的能力走异步分支
    if (config.asyncRoutes !== undefined && isAsyncCapability(params.capability)) {
      return this.invokeAsync(params, config, label);
    }

    switch (params.capability) {
      case 'text':
      case 'script':
      case 'subtitle':
        return this.invokeChat(params, config, label);
      case 'image':
        return this.invokeImage(params, config, label);
      case 'image_edit':
        return this.invokeImageEdit(params, config, label);
      case 'embedding':
        return this.invokeEmbedding(params, config, label);
      case 'audio':
      case 'voice':
      case 'music':
        return this.invokeAudio(params, config, label);
      default:
        // 未覆盖的能力（如视频未配置 asyncRoutes）：
        // 明确报错并指出需要哪项配置，而不是发出一个必然失败的请求
        throw new ModelBadOutputError(
          `${label} 的「${params.capability}」能力需要配置 config.routes / config.asyncRoutes 才能调用`,
          {
            retryable: false,
            userMessage: '该模型尚未配置对应能力的接口地址。',
            suggestions: ['在模型设置中补充接口配置', '改用其它模型'],
            context: { capability: params.capability, providerLabel: label },
          },
        );
    }
  }

  /** 文本 / 脚本 / 字幕：走 chat/completions */
  private async invokeChat(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const path = config.routes?.text ?? DEFAULT_ROUTES.text ?? '/chat/completions';

    const body: Record<string, unknown> = {
      model: params.modelKey,
      messages: [
        { role: 'system', content: buildSystemPrompt(params) },
        { role: 'user', content: params.prompt },
      ],
      ...pickSamplingParams(params.params),
    };

    // 结构化输出：各家支持程度不同，由配置决定用哪种模式
    if (params.responseSchema !== undefined && config.supportsResponseFormat !== false) {
      const mode = config.structuredOutputMode ?? 'json_schema';
      body.response_format =
        mode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: {
                name: 'svh_output',
                // strict 模式要求 schema 的 required 覆盖全部 properties，
                // 且 additionalProperties=false。这里做一次规范化，
                // 否则 OpenAI 会直接拒绝请求。
                schema: normalizeForStrict(params.responseSchema),
                strict: true,
              },
            }
          : { type: 'json_object' };
    }

    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, path),
      method: 'POST',
      headers: authHeaders(params),
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    const content = getPath(json, 'choices', '0', 'message', 'content');
    if (typeof content !== 'string') {
      throw new ModelBadOutputError(`${label} 的响应中缺少 choices[0].message.content`, {
        context: { providerLabel: label, modelKey: params.modelKey },
      });
    }

    const usage = extractUsage(json);

    // 有结构化约束时，把文本再解析成对象；解析失败报 MODEL_BAD_OUTPUT（可重试）
    if (params.responseSchema !== undefined) {
      const parsed = parseJsonLoose(content);
      if (parsed === null) {
        throw new ModelBadOutputError(`${label} 返回的内容不是合法 JSON`, {
          context: { providerLabel: label, preview: content.slice(0, 200) },
        });
      }
      return { data: parsed, text: content, ...(usage !== undefined ? { usage } : {}) };
    }

    return { text: content, ...(usage !== undefined ? { usage } : {}) };
  }

  /** 图片生成 */
  private async invokeImage(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const path = config.routes?.image ?? DEFAULT_ROUTES.image ?? '/images/generations';
    const width = asNumber(params.params.width) ?? parseAspectRatio(asString(params.params.aspectRatio)).width;
    const height = asNumber(params.params.height) ?? parseAspectRatio(asString(params.params.aspectRatio)).height;

    const body: Record<string, unknown> = {
      model: params.modelKey,
      prompt: composeImagePrompt(params),
      n: 1,
      ...(config.imageSizeMode === 'width_height'
        ? { width, height }
        : { size: toSizeString(width, height) }),
    };

    // 部分模型支持负向提示词（国内厂商常见）
    if (params.negativePrompt !== undefined) body.negative_prompt = params.negativePrompt;
    if (params.params.seed !== undefined) body.seed = params.params.seed;
    if (params.params.steps !== undefined) body.steps = params.params.steps;
    if (params.params.guidance !== undefined) body.guidance_scale = params.params.guidance;

    // 图生图：把参考图作为 image 字段传给部分兼容实现
    if (params.referenceImages.length > 0) {
      const first = params.referenceImages[0];
      if (typeof first === 'string') body.image = first;
    }

    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, path),
      method: 'POST',
      headers: authHeaders(params),
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    const files = extractFiles(json, 'data');
    if (files.length === 0) {
      throw new ModelBadOutputError(`${label} 的响应中没有图片数据`, {
        context: { providerLabel: label, modelKey: params.modelKey },
      });
    }

    const usage = extractUsage(json);
    return {
      files: files.map((f) => ({ ...f, width, height })),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /** 图片编辑：走 edits 端点，或在 generations 上带参考图 */
  private async invokeImageEdit(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    // 没有独立的 edits 端点时，退化为「带参考图的生成」
    const hasEditRoute = config.routes?.image_edit !== undefined;

    if (!hasEditRoute) {
      return this.invokeImage(params, config, label);
    }

    const path = config.routes?.image_edit ?? '/images/edits';
    const body: Record<string, unknown> = {
      model: params.modelKey,
      prompt: composeImagePrompt(params),
      n: 1,
      ...(params.referenceImages[0] !== undefined ? { image: params.referenceImages[0] } : {}),
    };

    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, path),
      method: 'POST',
      headers: authHeaders(params),
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    const files = extractFiles(json, 'data');
    if (files.length === 0) {
      throw new ModelBadOutputError(`${label} 的图片编辑响应中没有数据`, {
        context: { providerLabel: label },
      });
    }
    return { files };
  }

  /** 向量化 */
  private async invokeEmbedding(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const path = config.routes?.embedding ?? '/embeddings';
    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, path),
      method: 'POST',
      headers: authHeaders(params),
      json: { model: params.modelKey, input: params.prompt },
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    const embedding = getPath(json, 'data', '0', 'embedding');
    if (!Array.isArray(embedding)) {
      throw new ModelBadOutputError(`${label} 的响应中缺少向量数据`, {
        context: { providerLabel: label },
      });
    }
    const usage = extractUsage(json);
    return { data: embedding, ...(usage !== undefined ? { usage } : {}) };
  }

  /**
   * 音频合成（语音 / 音效 / 音乐）。
   *
   * 这类接口常直接返回二进制音频，但也可能返回 JSON 里的 URL。
   * 这里按 JSON 处理：拿不到 URL 时给出明确提示，
   * 而不是把二进制当 JSON 解析后报一个难懂的错。
   */
  private async invokeAudio(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const path = config.routes?.[params.capability] ?? DEFAULT_ROUTES[params.capability] ?? '/audio/speech';
    const body: Record<string, unknown> = {
      model: params.modelKey,
      input: params.prompt,
      ...(params.params.voiceAssetId !== undefined ? { voice: params.params.voiceAssetId } : {}),
      ...(params.params.speed !== undefined ? { speed: params.params.speed } : {}),
      ...(params.params.format !== undefined ? { response_format: params.params.format } : {}),
    };

    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, path),
      method: 'POST',
      headers: authHeaders(params),
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    const files = extractFiles(json, 'data');
    if (files.length === 0) {
      throw new ModelBadOutputError(
        `${label} 的音频响应中没有可直接使用的地址。若该接口返回二进制音频流，请配置一个返回 URL 的兼容端点。`,
        { context: { providerLabel: label, capability: params.capability } },
      );
    }
    return { files };
  }

  /**
   * 异步任务：提交 → 轮询 → 取结果。
   *
   * 视频与数字人合成通常需要数分钟，Provider 会返回一个任务 id 供轮询。
   * 轮询间隔采用递增策略：前几次快查（可能有即时失败），
   * 之后放慢以免给 Provider 造成压力。
   */
  private async invokeAsync(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
  ): Promise<ProviderRawResult> {
    const asyncRoutes = config.asyncRoutes;
    if (asyncRoutes === undefined) {
      throw new ModelBadOutputError(`${label} 未配置异步任务端点`, { context: { providerLabel: label } });
    }

    const spec = await this.submitAsync(params, config, label, asyncRoutes);
    const polled = await this.pollAsync(params, config, label, asyncRoutes, spec.taskId);

    return {
      files: polled.files,
      ...(polled.usage !== undefined ? { usage: polled.usage } : {}),
      externalId: spec.taskId,
    };
  }

  /** 提交异步任务并取出任务 id */
  private async submitAsync(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
    asyncRoutes: NonNullable<OpenAICompatConfig['asyncRoutes']>,
  ): Promise<{ taskId: string }> {
    const body: Record<string, unknown> = {
      model: params.modelKey,
      prompt: composeImagePrompt(params),
      ...(params.params.duration !== undefined ? { duration: params.params.duration } : {}),
      ...(params.params.aspectRatio !== undefined ? { aspect_ratio: params.params.aspectRatio } : {}),
      ...(params.params.extraSeconds !== undefined ? { extra_seconds: params.params.extraSeconds } : {}),
      ...(params.referenceImages.length > 0 ? { image: params.referenceImages[0] } : {}),
    };

    const result = await requestJson({
      url: joinUrl(params.provider.baseUrl, asyncRoutes.submit),
      method: 'POST',
      headers: authHeaders(params),
      json: body,
      timeoutMs: params.timeoutMs,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      providerLabel: label,
    });

    const json = ensureJsonObject(result, label);
    // 任务 id 的位置各家不同，允许通过 config.taskIdPath 指定
    const taskIdPath = config.taskIdPath ?? 'id';
    const taskId = getPath(json, ...taskIdPath.split('.'));
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new ModelBadOutputError(
        `${label} 的提交响应中没有任务 id（查找路径：${taskIdPath}）`,
        { context: { providerLabel: label, taskIdPath } },
      );
    }
    return { taskId };
  }

  /** 轮询直到完成或超时 */
  private async pollAsync(
    params: ProviderInvokeParams,
    config: OpenAICompatConfig,
    label: string,
    asyncRoutes: NonNullable<OpenAICompatConfig['asyncRoutes']>,
    taskId: string,
  ): Promise<{ files: NonNullable<ProviderRawResult['files']>; usage?: ProviderRawResult['usage'] }> {
    const statusPath = (config.statusPath ?? 'status').split('.');
    const successValues = config.successValues ?? ['succeeded', 'success', 'completed', 'done', 'SUCCESS'];
    const failureValues = config.failureValues ?? ['failed', 'error', 'FAILED', 'canceled', 'cancelled'];

    const pollUrl = joinUrl(params.provider.baseUrl, asyncRoutes.poll.replace('{id}', taskId));
    const deadline = Date.now() + params.timeoutMs;
    let intervalMs = 2000;

    for (;;) {
      if (params.signal?.aborted === true) {
        throw new ModelBadOutputError(`${label} 的异步任务已被取消`, {
          retryable: false,
          userMessage: '任务已取消。',
        });
      }
      if (Date.now() > deadline) {
        // 超时交由上层统一处理（Model Router 会转成 MODEL_TIMEOUT）
        throw new ModelBadOutputError(`${label} 的异步任务超时（任务 id：${taskId}）`, {
          context: { providerLabel: label, taskId },
        });
      }

      const result = await requestJson({
        url: pollUrl,
        method: 'GET',
        headers: authHeaders(params),
        timeoutMs: Math.min(30_000, params.timeoutMs),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        providerLabel: label,
      });

      const json = ensureJsonObject(result, label);
      const status = getPath(json, ...statusPath);
      const statusText = typeof status === 'string' ? status : '';

      if (failureValues.includes(statusText)) {
        throw new ModelBadOutputError(`${label} 的异步任务失败（状态：${statusText}）`, {
          context: { providerLabel: label, taskId, status: statusText },
        });
      }

      if (successValues.includes(statusText)) {
        const files = extractFiles(json, 'data');
        if (files.length === 0) {
          throw new ModelBadOutputError(`${label} 的异步任务已完成但没有产出文件`, {
            context: { providerLabel: label, taskId },
          });
        }
        const usage = extractUsage(json);
        return { files, ...(usage !== undefined ? { usage } : {}) };
      }

      // 未完成：等待后继续，间隔逐步放大到 10 秒
      await sleep(intervalMs, params.signal);
      intervalMs = Math.min(intervalMs * 1.5, 10_000);
    }
  }

  /**
   * 连通性检查。
   *
   * 用 `/models` 端点验证凭据与网络（OpenAI 兼容服务的标准做法）。
   * 部分自建服务不实现该端点，因此 404 也视为「网络可达」——
   * 真正的问题（凭据错误）会返回 401/403。
   */
  async checkHealth(provider: ProviderDescriptor, apiKey: string | null): Promise<'healthy' | 'degraded' | 'down'> {
    if (apiKey === null || apiKey.length === 0) return 'down';

    try {
      const result = await requestJson({
        url: joinUrl(provider.baseUrl, '/models'),
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 10_000,
        providerLabel: provider.name,
      });

      if (result.status >= 200 && result.status < 300) return 'healthy';
      // 401/403 说明凭据有问题 → down；其它（含 404）说明网络通 → degraded
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

/** 判断某能力是否需要异步（提交 + 轮询） */
function isAsyncCapability(capability: ModelCapability): boolean {
  return capability === 'video' || capability === 'video_extend' || capability === 'digital_human';
}

/** 构造鉴权请求头；自定义 headers 可覆盖（部分中转服务需要额外字段） */
function authHeaders(params: ProviderInvokeParams): Record<string, string> {
  return {
    ...(params.provider.headers ?? {}),
    ...(params.apiKey !== null ? { Authorization: `Bearer ${params.apiKey}` } : {}),
  };
}

/** 组装系统提示词：把负向约束与风格要求显式表达 */
function buildSystemPrompt(params: ProviderInvokeParams): string {
  const parts = ['你是 SVH 内容创作 Agent 的模型执行端。请严格按要求输出。'];
  if (params.negativePrompt !== undefined && params.negativePrompt.length > 0) {
    parts.push(`避免出现：${params.negativePrompt}`);
  }
  return parts.join('\n');
}

/** 抽取采样参数（只取协议认识的字段，避免透传未知键被拒） */
function pickSamplingParams(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const mapping: Record<string, string> = {
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_tokens',
    seed: 'seed',
    frequencyPenalty: 'frequency_penalty',
    presencePenalty: 'presence_penalty',
  };
  for (const [domainKey, wireKey] of Object.entries(mapping)) {
    const value = source[domainKey];
    if (value !== undefined) result[wireKey] = value;
  }
  return result;
}

/** 组合图片提示词：把风格与负向约束并入正向提示词 */
function composeImagePrompt(params: ProviderInvokeParams): string {
  return params.prompt;
}

/** 从响应中提取文件列表（兼容 url 与 base64 两种返回形式） */
function extractFiles(
  json: Record<string, unknown>,
  dataKey: string,
): NonNullable<ProviderRawResult['files']> {
  const data = json[dataKey];
  if (!Array.isArray(data)) return [];

  const files: NonNullable<ProviderRawResult['files']> = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    const url = firstString(record.url, record.video_url, record.audio_url, record.output);
    if (url !== null) {
      files.push({
        url,
        ...(typeof record.mime_type === 'string' ? { mimeType: record.mime_type } : {}),
        ...(typeof record.duration === 'number' ? { duration: record.duration } : {}),
      });
      continue;
    }

    // base64 形式：拼成 data URL，让前端可直接渲染
    const b64 = firstString(record.b64_json, record.base64, record.image_base64);
    if (b64 !== null) {
      const mime = typeof record.mime_type === 'string' ? record.mime_type : 'image/png';
      files.push({ url: `data:${mime};base64,${b64}`, mimeType: mime });
    }
  }
  return files;
}

/** 提取用量（各家用词不同） */
function extractUsage(json: Record<string, unknown>): ProviderRawResult['usage'] | undefined {
  const usage = json.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;

  const input = asNumber(record.prompt_tokens) ?? asNumber(record.input_tokens);
  const output = asNumber(record.completion_tokens) ?? asNumber(record.output_tokens);
  const total = asNumber(record.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);

  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/**
 * 规范化 JSON Schema 以适配 OpenAI 的 strict 模式。
 *
 * strict 的硬性要求（不满足会被直接拒绝）：
 * 1. `required` 必须列出**全部** properties
 * 2. 每个 object 必须显式写 `additionalProperties: false`
 *
 * 这是最容易踩的坑之一：本地用宽松 Schema 测试通过，
 * 一接真实 OpenAI 就报 400。
 */
export function normalizeForStrict(schema: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 8) return schema;

  const result: Record<string, unknown> = { ...schema };

  const properties = result.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const normalizedProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      normalizedProps[key] =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? normalizeForStrict(value as Record<string, unknown>, depth + 1)
          : value;
    }
    result.properties = normalizedProps;
    // 强制 required 覆盖全部字段
    result.required = Object.keys(normalizedProps);
    result.additionalProperties = false;
  }

  if (Array.isArray(result.items) && result.items.length > 0) {
    // 同上：显式标注 unknown 以避免 any 扩散
    const first: unknown = result.items[0];
    if (first !== null && typeof first === 'object') {
      result.items = normalizeForStrict(first as Record<string, unknown>, depth + 1);
    }
  } else if (result.items !== null && typeof result.items === 'object') {
    result.items = normalizeForStrict(result.items as Record<string, unknown>, depth + 1);
  }

  return result;
}

/**
 * 宽松解析 JSON：模型经常把 JSON 包在代码块里，或前后带解释文字。
 * 依次尝试「直接解析 → 去掉代码块 → 截取首个花括号区间」。
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();

  const attempts: string[] = [trimmed];

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenceMatch?.[1] !== undefined) attempts.push(fenceMatch[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一种
    }
  }
  return null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** 可被取消的 sleep */
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
