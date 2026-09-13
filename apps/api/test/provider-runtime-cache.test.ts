/**
 * Provider 配置写路径 → Agent 模型运行时缓存失效
 *
 * ── 这条用例守的是什么 ──
 * `getAgentModelRuntime()`（apps/api/src/core/agent-deps.ts）把 Model Runtime
 * 缓存在**模块级变量**里，本身不设过期。修复前它导出的
 * `invalidateAgentModelRuntime()` 没有任何调用方，于是：用户在
 * `/settings/providers` 里配好真实模型、连接测试也通过，Agent 对话仍然用
 * 进程启动时装配的那一份（未配置模型时就是 Mock 回落）—— 界面上看不到
 * 任何异常，只是回复永远是占位文本，必须重启 API 才恢复。
 *
 * 修法是在 `routes/providers.ts` 里挂一条 `onResponse` 钩子：非 GET 请求
 * 结束后失效缓存。这里用**可观察的身份变化**把它钉住：
 *
 *   ① 连续两次 `getAgentModelRuntime()` → 同一实例（缓存确实在生效，
 *      否则这条用例会因为「每次都是新实例」而变成永真断言）；
 *   ② 中间夹一个 GET → 仍是同一实例（读配置不该导致重建）；
 *   ③ 中间夹一个写请求 → 必须是**新实例**（缓存被失效、重新查库装配）。
 *
 * 只用 HTTP 层驱动，不 import 路由内部实现：钩子挂在哪一层、怎么挂的都属于实现细节。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma } from '@svh/database';

import { buildApp } from '../src/core/app.js';
import { getAgentModelRuntime } from '../src/core/agent-deps.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

/** 临时 Provider 的名字：用时间戳保证不与库里已有配置冲突 */
const tempName = `缓存失效验证 ${String(Date.now())}`;

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('Provider 配置写路径 → 模型运行时缓存失效', () => {
  it('读请求不重建，写请求必须重建', async () => {
    const first = await getAgentModelRuntime();
    // 缓存真的在生效：否则下面的「新实例」断言毫无意义
    expect(await getAgentModelRuntime()).toBe(first);

    const read = await app.inject({ method: 'GET', url: '/api/models/providers?pageSize=1' });
    expect(read.statusCode).toBe(200);
    expect(await getAgentModelRuntime(), 'GET 不该让运行时缓存失效').toBe(first);

    /*
     * 写请求：新建一个**禁用**的 Provider（不会被装配读到），
     * 断言缓存失效之后再删掉它 —— 不给开发库留下残留配置。
     */
    const created = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      payload: {
        name: tempName,
        kind: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-cache-invalidation-probe',
        // 禁用：这条配置只是用来触发写路径，不该参与装配
        enabled: false,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdBody = created.json<{ id: string }>();

    const afterWrite = await getAgentModelRuntime();
    expect(afterWrite, '写请求之后必须重新装配，否则用户改完配置不重启不生效').not.toBe(first);

    // 收尾：删掉临时配置（同时再触发一次失效，不影响断言）
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/models/providers/${createdBody.id}`,
    });
    expect(removed.statusCode).toBe(204);
  });
});
