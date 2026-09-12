/**
 * Provider 适配器集成测试
 *
 * 策略：起一个**本地 HTTP 服务器**扮演 Provider，让适配器真的发请求过去，
 * 然后断言「请求构造是否正确」与「响应/错误是否正确翻译」。
 *
 * 为什么不用 mock 掉 fetch：适配器最容易出错的地方恰恰是**报文形状**
 * （字段名、嵌套层级、鉴权头的位置）。把 fetch 换掉就测不出这些，
 * 而这正是接真实 Provider 时最先炸的地方。
 *
 * 覆盖三类事实：
 * 1. 请求构造：路径、鉴权头、字段映射、结构化输出的模式适配
 * 2. 响应解析：文本、结构化数据、文件（base64 与 URL）、用量
 * 3. 错误映射：401/404/429/5xx/内容拦截 → 正确的领域错误与可重试性
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSvhError, type SvhError } from '@svh/domain';

import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { fillPathTemplate, GeminiAdapter } from '../src/providers/gemini.js';
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.js';
import type { ProviderDescriptor, ProviderInvokeParams } from '../src/ports.js';

/** 记录到服务器的一次请求 */
interface CapturedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * 服务器的响应脚本。
 *
 * 允许返回 Promise：测试超时与取消时需要「延迟响应」，
 * 同步签名无法表达这一点。
 */
type ResponderResult = { status: number; body: unknown; contentType?: string };
type Responder = (req: CapturedRequest) => ResponderResult | Promise<ResponderResult>;

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let responder: Responder = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = raw.length > 0 ? safeParse(raw) : null;
      const url = new URL(req.url ?? '/', 'http://localhost');

      const request: CapturedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body: parsed,
      };
      captured.push(request);

      void Promise.resolve(responder(request))
        .then((result) => {
          res.writeHead(result.status, {
            'Content-Type': result.contentType ?? 'application/json',
          });
          res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
        })
        .catch(() => {
          // 响应脚本自身出错时给出 500，避免测试挂起等待
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '测试响应脚本异常' } }));
        });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取测试服务器端口');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 每个用例前重置捕获与响应脚本 */
function reset(next: Responder): void {
  captured = [];
  responder = next;
}

/** 构造 Provider 描述 */
function provider(kind: ProviderDescriptor['kind'], config?: Record<string, unknown>): ProviderDescriptor {
  return {
    providerId: 'p1',
    name: '测试 Provider',
    kind,
    baseUrl,
    concurrency: 4,
    enabled: true,
    ...(config !== undefined ? { config } : {}),
  };
}

/** 构造调用参数 */
function invokeParams(overrides: Partial<ProviderInvokeParams> = {}): ProviderInvokeParams {
  return {
    modelKey: 'test-model',
    capability: 'text',
    prompt: '你好',
    params: {},
    referenceImages: [],
    provider: provider('openai_compatible'),
    apiKey: 'sk-test-key-1234567890',
    timeoutMs: 5000,
    ...overrides,
  };
}

/** 捕获领域错误，便于断言错误码与可重试性 */
async function catchSvhError(fn: () => Promise<unknown>): Promise<SvhError> {
  try {
    await fn();
    throw new Error('预期抛出错误，但调用成功了');
  } catch (err) {
    if (!isSvhError(err)) throw err;
    return err;
  }
}

/* -------------------------------------------------------------------------- */
/* OpenAI 兼容协议                                                             */
/* -------------------------------------------------------------------------- */

describe('OpenAI 兼容适配器', () => {
  const adapter = new OpenAICompatibleAdapter();

  it('文本调用：路径、鉴权头、系统提示词与采样参数', async () => {
    reset(() => ({
      status: 200,
      body: {
        choices: [{ message: { role: 'assistant', content: '你好，我是模型' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      },
    }));

    const result = await adapter.invoke(
      invokeParams({ params: { temperature: 0.7, maxTokens: 512 } }),
    );

    expect(result.text).toBe('你好，我是模型');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });

    const req = captured[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/chat/completions');
    expect(req?.headers.authorization).toBe('Bearer sk-test-key-1234567890');
    expect(req?.headers['content-type']).toBe('application/json');

    const body = req?.body as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(512);

    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.content).toBe('你好');
  });

  it('结构化输出：使用 json_schema 且 required 覆盖全部字段（strict 要求）', async () => {
    reset(() => ({
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify({ name: '苏晚', age: 23 }) } }],
      },
    }));

    await adapter.invoke(
      invokeParams({
        responseSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name'], // 故意只写一个，验证适配器会补全
        },
      }),
    );

    const body = captured[0]?.body as Record<string, unknown>;
    const format = body.response_format as {
      type: string;
      json_schema: { strict: boolean; schema: { required: string[]; additionalProperties: boolean } };
    };

    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    // strict 要求 required 列出全部字段，否则 OpenAI 直接返回 400
    expect(format.json_schema.schema.required).toEqual(['name', 'age']);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
  });

  it('结构化输出：内容被代码块包裹时也能解析', async () => {
    reset(() => ({
      status: 200,
      body: {
        choices: [
          { message: { content: '```json\n{"shotCount": 6}\n```' } },
        ],
      },
    }));

    const result = await adapter.invoke(
      invokeParams({ responseSchema: { type: 'object', properties: { shotCount: { type: 'number' } } } }),
    );

    expect(result.data).toEqual({ shotCount: 6 });
  });

  it('结构化输出：模型返回非 JSON 时抛 MODEL_BAD_OUTPUT（可重试）', async () => {
    reset(() => ({
      status: 200,
      body: { choices: [{ message: { content: '抱歉，我无法完成这个任务。' } }] },
    }));

    const error = await catchSvhError(() =>
      adapter.invoke(
        invokeParams({ responseSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
      ),
    );

    expect(error.code).toBe('MODEL_BAD_OUTPUT');
    expect(error.retryable).toBe(true);
  });

  it('图片生成：默认使用 size 字段；配置可切换为 width/height', async () => {
    reset(() => ({
      status: 200,
      body: { data: [{ url: 'https://cdn.test/img.png' }] },
    }));

    const result = await adapter.invoke(
      invokeParams({
        capability: 'image',
        prompt: '一杯咖啡',
        params: { width: 1024, height: 1792 },
      }),
    );

    const body = captured[0]?.body as Record<string, unknown>;
    expect(body.size).toBe('1024x1792');
    expect(body.n).toBe(1);
    expect(body.prompt).toBe('一杯咖啡');
    expect(result.files?.[0]?.url).toBe('https://cdn.test/img.png');
    expect(result.files?.[0]?.width).toBe(1024);

    // 切换为国内厂商常见的 width/height 模式
    reset(() => ({ status: 200, body: { data: [{ url: 'https://cdn.test/img2.png' }] } }));
    await adapter.invoke(
      invokeParams({
        capability: 'image',
        prompt: '一杯咖啡',
        params: { width: 768, height: 768 },
        provider: provider('openai_compatible', { imageSizeMode: 'width_height' }),
      }),
    );

    const body2 = captured[0]?.body as Record<string, unknown>;
    expect(body2.width).toBe(768);
    expect(body2.height).toBe(768);
    expect(body2.size).toBeUndefined();
  });

  it('图片生成：base64 响应被转成 data URL，前端可直接渲染', async () => {
    reset(() => ({
      status: 200,
      body: { data: [{ b64_json: 'aGVsbG8=', mime_type: 'image/jpeg' }] },
    }));

    const result = await adapter.invoke(invokeParams({ capability: 'image', prompt: 'x' }));
    expect(result.files?.[0]?.url).toBe('data:image/jpeg;base64,aGVsbG8=');
  });

  it('端点路径可被 provider.config.routes 覆盖（国内厂商常见需求）', async () => {
    reset(() => ({ status: 200, body: { data: [{ url: 'https://cdn.test/x.png' }] } }));

    await adapter.invoke(
      invokeParams({
        capability: 'image',
        prompt: 'x',
        provider: provider('openai_compatible', {
          routes: { image: '/v1/images/text2image' },
        }),
      }),
    );

    expect(captured[0]?.path).toBe('/v1/images/text2image');
  });

  it('异步能力未配置端点时给出可操作的错误，而不是发出必然失败的请求', async () => {
    reset(() => ({ status: 200, body: {} }));

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ capability: 'video', prompt: 'x' })),
    );

    expect(error.code).toBe('MODEL_BAD_OUTPUT');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('asyncRoutes');
    // 不应发出任何请求
    expect(captured).toHaveLength(0);
  });

  it('异步能力：提交 → 轮询 → 取结果', async () => {
    let pollCount = 0;
    reset(() => {
      // 第一次是提交，之后是轮询
      if (captured.length === 1) {
        return { status: 200, body: { data: { task_id: 'task-abc' } } };
      }
      pollCount += 1;
      if (pollCount < 2) {
        return { status: 200, body: { status: 'running' } };
      }
      return {
        status: 200,
        body: { status: 'succeeded', data: [{ url: 'https://cdn.test/video.mp4', duration: 5 }] },
      };
    });

    const result = await adapter.invoke(
      invokeParams({
        capability: 'video',
        prompt: '一段视频',
        params: { duration: 5, aspectRatio: '9:16' },
        timeoutMs: 20_000,
        provider: provider('openai_compatible', {
          asyncRoutes: { submit: '/video/submit', poll: '/video/tasks/{id}' },
          taskIdPath: 'data.task_id',
        }),
      }),
    );

    expect(result.files?.[0]?.url).toBe('https://cdn.test/video.mp4');
    expect(result.externalId).toBe('task-abc');

    // 提交请求不带 id，轮询请求带
    expect(captured[0]?.path).toBe('/video/submit');
    expect(captured[0]?.method).toBe('POST');
    expect(captured[1]?.path).toBe('/video/tasks/task-abc');
    expect(captured[1]?.method).toBe('GET');
  });
});

/* -------------------------------------------------------------------------- */
/* 错误映射                                                                    */
/* -------------------------------------------------------------------------- */

describe('HTTP 错误映射（决定用户看到什么与是否重试）', () => {
  const adapter = new OpenAICompatibleAdapter();

  it('401 → 鉴权失败，不可重试，提示检查 API Key', async () => {
    reset(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('API Key');
  });

  it('404 → 模型不存在，不可重试', async () => {
    reset(() => ({ status: 404, body: { error: { message: 'model not found' } } }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('模型名称');
  });

  it('429 → 限流，可重试，适合降级到备用模型', async () => {
    reset(() => ({ status: 429, body: { error: { message: 'rate limit exceeded' } } }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.userMessage).toContain('频繁');
  });

  it('500 → 服务端错误，可重试', async () => {
    reset(() => ({ status: 500, body: { error: { message: 'internal error' } } }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));
    expect(error.retryable).toBe(true);
  });

  it('内容安全拦截 → MODEL_CONTENT_REJECTED，不可重试', async () => {
    reset(() => ({
      status: 400,
      body: { error: { message: 'Your request was rejected by our content policy' } },
    }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));

    expect(error.code).toBe('MODEL_CONTENT_REJECTED');
    // 同样的提示词重试多少次都会被拒，因此不可重试
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('安全校验');
  });

  it('错误信息中的 API Key 被脱敏（不得泄漏到日志或前端）', async () => {
    reset(() => ({
      status: 401,
      body: { error: { message: 'Invalid key: sk-test-key-1234567890abcdefghij' } },
    }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));

    expect(error.message).not.toContain('sk-test-key-1234567890abcdefghij');
    expect(error.message).toContain('已脱敏');
  });

  it('Provider 返回 HTML 错误页时仍给出可读提示', async () => {
    reset(() => ({
      status: 502,
      body: '<html><body>502 Bad Gateway</body></html>',
      contentType: 'text/html',
    }));

    const error = await catchSvhError(() => adapter.invoke(invokeParams()));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('请求超时 → MODEL_TIMEOUT，可重试', async () => {
    reset(async () => {
      // 用一个永不返回的响应模拟超时
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 200, body: {} };
    });

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ timeoutMs: 50 })),
    );

    expect(error.code).toBe('MODEL_TIMEOUT');
    expect(error.retryable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Anthropic 协议                                                              */
/* -------------------------------------------------------------------------- */

describe('Anthropic 适配器', () => {
  const adapter = new AnthropicAdapter();

  it('文本调用：x-api-key 头、anthropic-version 头、系统提示词在顶层', async () => {
    reset(() => ({
      status: 200,
      body: {
        content: [{ type: 'text', text: 'Claude 的回复' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }));

    const result = await adapter.invoke(
      invokeParams({ provider: provider('anthropic_compatible') }),
    );

    expect(result.text).toBe('Claude 的回复');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    const req = captured[0];
    expect(req?.path).toBe('/messages');
    // Anthropic 用 x-api-key，不是 Bearer
    expect(req?.headers['x-api-key']).toBe('sk-test-key-1234567890');
    expect(req?.headers.authorization).toBeUndefined();
    // 缺少 anthropic-version 会返回 400
    expect(req?.headers['anthropic-version']).toBe('2023-06-01');

    const body = req?.body as Record<string, unknown>;
    // 系统提示词是顶层字段，不能进 messages
    expect(typeof body.system).toBe('string');
    const messages = body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(body.max_tokens).toBe(4096);
  });

  it('结构化输出走 Tool Calling 并强制调用', async () => {
    reset(() => ({
      status: 200,
      body: {
        content: [
          {
            type: 'tool_use',
            name: 'svh_structured_output',
            input: { title: '冷萃咖啡广告', shots: 6 },
          },
        ],
      },
    }));

    const result = await adapter.invoke(
      invokeParams({
        provider: provider('anthropic_compatible'),
        responseSchema: {
          type: 'object',
          properties: { title: { type: 'string' }, shots: { type: 'number' } },
          required: ['title'],
        },
      }),
    );

    expect(result.data).toEqual({ title: '冷萃咖啡广告', shots: 6 });

    const body = captured[0]?.body as Record<string, unknown>;
    const tools = body.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('svh_structured_output');
    // 必须强制工具调用，否则模型可能直接文本回复
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'svh_structured_output' });
  });

  it('模型未调用工具时从文本中兜底解析 JSON', async () => {
    reset(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: '{"fallback": true}' }] },
    }));

    const result = await adapter.invoke(
      invokeParams({
        provider: provider('anthropic_compatible'),
        responseSchema: { type: 'object', properties: { fallback: { type: 'boolean' } } },
      }),
    );

    expect(result.data).toEqual({ fallback: true });
  });

  it('refusal 被翻译成内容安全错误', async () => {
    reset(() => ({
      status: 200,
      body: { content: [], stop_reason: 'refusal' },
    }));

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ provider: provider('anthropic_compatible') })),
    );

    expect(error.code).toBe('MODEL_BAD_OUTPUT');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('安全校验');
  });

  it('不支持的能力明确报错，且不发出请求', async () => {
    reset(() => ({ status: 200, body: {} }));

    const error = await catchSvhError(() =>
      adapter.invoke(
        invokeParams({ capability: 'image', provider: provider('anthropic_compatible') }),
      ),
    );

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Anthropic');
    expect(error.message).toContain('image');
    // 关键：不发出必然 404 的请求
    expect(captured).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Gemini 协议                                                                 */
/* -------------------------------------------------------------------------- */

describe('Gemini 适配器', () => {
  const adapter = new GeminiAdapter();

  it('文本调用：模型在路径里、contents 结构、generationConfig 嵌套、用量从 usageMetadata', async () => {
    reset(() => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'Gemini 的回复' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      },
    }));

    const result = await adapter.invoke(
      invokeParams({
        modelKey: 'gemini-2.0-flash',
        params: { temperature: 0.5, maxTokens: 256 },
        provider: provider('gemini_compatible'),
      }),
    );

    expect(result.text).toBe('Gemini 的回复');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });

    const req = captured[0];
    // 模型名在路径里，而不是请求体
    expect(req?.path).toBe('/models/gemini-2.0-flash:generateContent');
    expect(req?.headers['x-goog-api-key']).toBe('sk-test-key-1234567890');

    const body = req?.body as Record<string, unknown>;
    expect(body.model).toBeUndefined();
    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts[0]?.text).toBe('你好');
    // 系统提示词是顶层 systemInstruction
    expect(body.systemInstruction).toBeDefined();

    const config = body.generationConfig as Record<string, unknown>;
    expect(config.temperature).toBe(0.5);
    expect(config.maxOutputTokens).toBe(256);
  });

  it('结构化输出：responseSchema 被裁剪为 Gemini 接受的 OpenAPI 子集', async () => {
    reset(() => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: '{"name":"苏晚"}' }] } }],
      },
    }));

    await adapter.invoke(
      invokeParams({
        provider: provider('gemini_compatible'),
        responseSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name'],
          // Gemini 不接受这个关键字，必须被裁掉
          additionalProperties: false,
        },
      }),
    );

    const body = captured[0]?.body as Record<string, unknown>;
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');

    const schema = config.responseSchema as Record<string, unknown>;
    // 类型名被转为大写（Gemini 的约定）
    expect(schema.type).toBe('OBJECT');
    // 不支持的键被剔除，否则会 400
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.required).toEqual(['name']);

    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.name?.type).toBe('STRING');
    expect(props.tags?.type).toBe('ARRAY');
    expect((props.tags?.items as Record<string, unknown>)?.type).toBe('STRING');
  });

  it('图片生成：inlineData 被转成可直接渲染的 data URL', async () => {
    reset(() => ({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }],
            },
          },
        ],
      },
    }));

    const result = await adapter.invoke(
      invokeParams({ capability: 'image', prompt: 'x', provider: provider('gemini_compatible') }),
    );

    expect(result.files?.[0]?.url).toBe('data:image/png;base64,aW1n');
  });

  it('提示词被拦截（promptFeedback.blockReason）→ 内容安全错误', async () => {
    reset(() => ({
      status: 200,
      body: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
    }));

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ provider: provider('gemini_compatible') })),
    );

    expect(error.code).toBe('MODEL_BAD_OUTPUT');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('安全校验');
  });

  it('生成过程被拦截（finishReason=SAFETY）→ 内容安全错误', async () => {
    reset(() => ({
      status: 200,
      body: {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
      },
    }));

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ provider: provider('gemini_compatible') })),
    );

    expect(error.retryable).toBe(false);
  });

  it('支持用查询参数鉴权（部分私有部署只支持这种方式）', async () => {
    reset(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
    }));

    await adapter.invoke(
      invokeParams({
        provider: provider('gemini_compatible', { useApiKeyHeader: false }),
      }),
    );

    const req = captured[0];
    expect(req?.headers['x-goog-api-key']).toBeUndefined();
    // 用查询参数时 API Key 出现在 URL 上
    expect(req?.query).toContain('key=');
  });

  it('异步长任务：提交 operation 后轮询直到 done', async () => {
    reset(() => {
      if (captured.length === 1) {
        return { status: 200, body: { name: 'operations/abc123' } };
      }
      if (captured.length === 2) {
        return { status: 200, body: { name: 'operations/abc123', done: false } };
      }
      return {
        status: 200,
        body: {
          name: 'operations/abc123',
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: 'https://cdn.test/veo.mp4' } }],
            },
          },
        },
      };
    });

    const result = await adapter.invoke(
      invokeParams({
        capability: 'video',
        prompt: '一段视频',
        timeoutMs: 30_000,
        provider: provider('gemini_compatible', {
          asyncRoutes: {
            submit: '/models/{model}:predictLongRunning',
            poll: '/{operation}',
          },
        }),
      }),
    );

    expect(result.files?.[0]?.url).toBe('https://cdn.test/veo.mp4');
    expect(result.externalId).toBe('operations/abc123');

    expect(captured[0]?.path).toBe('/models/test-model:predictLongRunning');
    expect(captured[1]?.path).toBe('/operations/abc123');
  });
});

/* -------------------------------------------------------------------------- */
/* 健康检查                                                                    */
/* -------------------------------------------------------------------------- */

describe('连通性检查', () => {
  it('OpenAI 兼容：200 为健康，401 为不可用', async () => {
    const adapter = new OpenAICompatibleAdapter();

    reset(() => ({ status: 200, body: { data: [] } }));
    expect(await adapter.checkHealth(provider('openai_compatible'), 'key')).toBe('healthy');

    reset(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
    expect(await adapter.checkHealth(provider('openai_compatible'), 'key')).toBe('down');

    // 没有密钥直接判定不可用，不浪费一次请求
    reset(() => ({ status: 200, body: {} }));
    expect(await adapter.checkHealth(provider('openai_compatible'), null)).toBe('down');
    expect(captured).toHaveLength(0);
  });

  it('Anthropic：未实现 /models 端点，404 视为可用（凭据有效）', async () => {
    const adapter = new AnthropicAdapter();

    reset(() => ({ status: 404, body: { error: { message: 'not found' } } }));
    expect(await adapter.checkHealth(provider('anthropic_compatible'), 'key')).toBe('healthy');

    reset(() => ({ status: 401, body: {} }));
    expect(await adapter.checkHealth(provider('anthropic_compatible'), 'key')).toBe('down');
  });

  it('Gemini：用 /models 列表端点', async () => {
    const adapter = new GeminiAdapter();

    reset(() => ({ status: 200, body: { models: [] } }));
    expect(await adapter.checkHealth(provider('gemini_compatible'), 'key')).toBe('healthy');

    reset(() => ({ status: 403, body: {} }));
    expect(await adapter.checkHealth(provider('gemini_compatible'), 'key')).toBe('down');
  });

  it('网络不可达时返回 down 而不是抛错', async () => {
    const adapter = new OpenAICompatibleAdapter();
    const unreachable: ProviderDescriptor = {
      ...provider('openai_compatible'),
      // 指向一个必定拒绝连接的端口
      baseUrl: 'http://127.0.0.1:1',
    };
    expect(await adapter.checkHealth(unreachable, 'key')).toBe('down');
  });
});

/* -------------------------------------------------------------------------- */
/* 取消传导                                                                    */
/* -------------------------------------------------------------------------- */

describe('取消信号传导（避免用户取消后仍在计费）', () => {
  it('外部 abort 会中断进行中的请求', async () => {
    const adapter = new OpenAICompatibleAdapter();
    reset(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const error = await catchSvhError(() =>
      adapter.invoke(invokeParams({ signal: controller.signal, timeoutMs: 5000 })),
    );

    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('取消');
  });
});

/* -------------------------------------------------------------------------- */
/* 路径模板填充（曾因整体编码导致 404）                                        */
/* -------------------------------------------------------------------------- */

describe('fillPathTemplate', () => {
  it('保留路径层级（模型名与 operation 名都可能含斜杠）', () => {
    // 整体 encodeURIComponent 会把 / 变成 %2F，请求打到错误端点
    expect(fillPathTemplate('/{operation}', { operation: 'operations/abc123' })).toBe(
      '/operations/abc123',
    );
    expect(fillPathTemplate('/models/{model}:generateContent', { model: 'gemini-2.0-flash' })).toBe(
      '/models/gemini-2.0-flash:generateContent',
    );
  });

  it('多段 operation 名也保持正确', () => {
    expect(
      fillPathTemplate('/{operation}', { operation: 'models/x/operations/abc' }),
    ).toBe('/models/x/operations/abc');
  });

  it('单段内的特殊字符仍被编码', () => {
    // 空格等字符必须编码，但斜杠要保留
    expect(fillPathTemplate('/{m}', { m: 'a b/c d' })).toBe('/a%20b/c%20d');
  });

  it('模板中不存在的键保持原样', () => {
    expect(fillPathTemplate('/{a}/{b}', { a: 'x' })).toBe('/x/{b}');
  });
});
