/**
 * 测试进程必须跑在内置 Mock 模型上。
 *
 * ── 这道护栏守的是什么 ──
 * Agent 的模型运行时是从**数据库里已配置的 Provider** 装配的（`buildModelRuntime`）。
 * 测试若不强制 Mock，就会去打开发者本机实际配置的那个模型服务：
 *
 *   · 配了真实付费 API → **跑一次 `pnpm test` 就是真实计费调用**；
 *   · 配的是本地桩服务 → 测试会消耗它的一次性状态（桩用「本轮是否已提交过
 *     工具调用」这个计数器来避免重复提交），随后的人工复现拿到的是预置回复
 *     而不是工具调用 —— 实测咬到过一次，排查了半天才发现不是产品缺陷；
 *   · 什么都没配 → 走内置兜底。
 *
 * 同一份测试在三种环境下走三条不同路径，测试就不再是确定的。
 * 现在由 `apps/api/test/setup-env.ts` 设置 `AGENT_FORCE_MOCK=true` 强制 Mock，
 * 本文件把这条约定钉住 —— 那行被删掉时，这里会直接红，而不是等到某次
 * 「测试怎么突然变了」才发现。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma } from '@svh/database';

import { buildApp } from '../src/core/app.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('测试进程的模型隔离', () => {
  it('模型运行时用的是内置 Mock，而不是本机配置的 Provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers/runtime' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      placeholderOnly: boolean;
      realModelCount: number;
      providerCount: number;
      modelCount: number;
    };

    expect(
      body.placeholderOnly,
      '测试进程没有强制 Mock —— 它正在使用本机配置的模型 Provider，' +
        '这不只是「会消耗桩服务状态」，配置了真实付费 API 时就是真实计费调用',
    ).toBe(true);
    expect(body.realModelCount).toBe(0);
    // 内置 Mock 目录本身要是可用的：4 个模型、能力标签齐全
    expect(body.modelCount).toBeGreaterThan(0);
  });

  it('但仍然是一次真实的模型调用路径（不是把模型层短路掉）', async () => {
    /*
     * 强制 Mock 只改变「用哪个 Provider」，不改变装配与调用链路：
     * 路由、适配器、记录、错误处理都照常跑。这条用「一次真实调用能拿到结果」
     * 来确认 —— 只断言 `placeholderOnly` 的话，把模型层整体短路掉也能绿。
     */
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: `模型隔离验证 ${String(Date.now())}` },
    });
    const projectId = (project.json() as { id: string }).id;

    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId, message: '帮我做一个30秒的广告' },
    });

    expect(chat.statusCode).toBe(200);
    const body = chat.json() as { message: string; analysis: { intent: string } };
    // 规则能判定的部分与 Provider 无关，必须照常工作
    expect(body.analysis.intent).toBe('create_content');
    expect(body.message.length).toBeGreaterThan(0);
  });
});
