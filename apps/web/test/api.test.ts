/**
 * API 客户端测试。
 *
 * 核心契约：**后端的统一错误体必须被翻译成用户可读的 ApiError**。
 * 这是「错误信息必须说明发生了什么 / 可能原因 / 下一步怎么做」这条规范的第一道落点 ——
 * 如果这里把 suggestions 丢了，界面再怎么写也补不回来。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from '../src/lib/api.js';

/** 构造一个 fetch 返回值 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('成功时直接返回资源本身（后端不用 {code,data,message} 包装）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', name: '项目' })));
    await expect(apiFetch<{ id: string }>('/api/projects/p1')).resolves.toEqual({
      id: 'p1',
      name: '项目',
    });
  });

  it('204 返回 undefined 而不是解析空 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetch<void>('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('把错误体翻译成带 suggestions 与 retryable 的 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: '会话不存在，可能已被删除。',
              suggestions: ['返回项目列表重新进入'],
              retryable: false,
            },
            requestId: 'req_abc',
          },
          404,
        ),
      ),
    );

    const error = await apiFetch('/api/agent/sessions/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe('会话不存在，可能已被删除。');
    expect(apiError.suggestions).toEqual(['返回项目列表重新进入']);
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(404);
    expect(apiError.requestId).toBe('req_abc');
  });

  it('网络不可达时给出可理解的错误，而不是抛原始的 TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    // 面向用户：不能出现 "Failed to fetch" 这类技术术语
    expect(error.message).not.toContain('Failed to fetch');
    expect(error.retryable).toBe(true);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  it('响应不是 JSON 时也给出可理解的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    );
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  it('错误体结构不符预期时回退到通用文案，而不是崩溃', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ oops: true }, 500)));
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('有 body 时默认带 Content-Type，调用方显式指定的头不被丢弃', async () => {
    // 每次调用新建 Response：body 只能读一次，复用同一个实例会报 "Body is unusable"
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/x', { method: 'POST', body: '{}' });
    await apiFetch('/api/x', { method: 'POST', body: '{}', headers: { 'X-Trace': 't1' } });

    // 用 Headers 归一化：直接展开 init.headers 的话，
    // 传 Headers 实例的调用方会**静默丢掉**自己所有的头
    const first = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(first.get('Content-Type')).toBe('application/json');

    const second = new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers);
    expect(second.get('X-Trace')).toBe('t1');
    expect(second.get('Content-Type')).toBe('application/json');
  });
});
