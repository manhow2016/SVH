/**
 * API 冒烟测试
 *
 * 使用 `app.inject()` 直接调用路由，不监听端口。
 * 覆盖范围刻意聚焦在「架构约定是否被真正落实」，而不是业务细节：
 * - 成功响应不用 {code,data,message} 包装（审计结论 ⑤）
 * - 错误响应使用真实 HTTP 状态码 + 面向用户的文案（技术文档第 66 条）
 * - 健康检查区分 liveness 与 readiness
 * - 项目 / 内容 / 资产 / 技能 / 工作流 主链路可用
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, prisma } from '@svh/database';

import { buildApp } from '../src/core/app.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  // .env 已由 vitest setupFiles（test/setup-env.ts）在任何 import 之前加载，
  // 此处只需做 Zod 校验并装配应用。
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('健康检查', () => {
  it('GET /healthz 返回 200，且不依赖外部服务', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { status: string; service: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('svh-api');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('GET /readyz 检查数据库与队列依赖', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    // 本地 PostgreSQL 与 Redis 均在运行，应为 ready
    expect([200, 503]).toContain(res.statusCode);

    const body = res.json() as {
      status: string;
      dependencies: Record<string, { ok: boolean; latencyMs: number }>;
    };
    expect(body.dependencies.database).toBeDefined();
    expect(body.dependencies.queue).toBeDefined();
    expect(body.status).toBe(body.dependencies.database?.ok && body.dependencies.queue?.ok ? 'ready' : 'not_ready');
  });
});

describe('响应形状约定', () => {
  it('成功响应直接返回资源，不套 {code,data,message}', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json() as Record<string, unknown>;

    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('success');
  });

  it('404 返回面向用户的文案与建议，且不含技术堆栈', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);

    const body = res.json() as {
      error: { code: string; message: string; suggestions: string[] };
      requestId: string;
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('不存在');
    expect(body.requestId).toBeTruthy();
    // 不得泄漏技术细节
    expect(JSON.stringify(body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('校验失败返回 400 而不是 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '' }, // name 不能为空
    });
    expect(res.statusCode).toBe(400);

    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // 用户文案必须是中文可读的，不是 Zod 的英文原文
    expect(body.error.message).toMatch(/[\u4e00-\u9fa5]/);
  });
});

describe('项目主链路', () => {
  it('POST /api/projects 创建项目并返回 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: `冒烟测试项目 ${Date.now()}`,
        description: '由 API 冒烟测试创建',
        memory: {
          goals: { objective: '验证 Phase 1 数据模型可用' },
          visual: { style: '电影感、冷调' },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; memory: Record<string, unknown> };
    expect(body.id).toBeTruthy();
    projectId = body.id;

    // Project Memory 应当被持久化
    expect((body.memory as { goals?: { objective?: string } }).goals?.objective).toBe(
      '验证 Phase 1 数据模型可用',
    );
  });

  it('GET /api/projects/:id 返回项目详情与计数', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { id: string; _count: { contents: number } };
    expect(body.id).toBe(projectId);
    expect(body._count.contents).toBe(0);
  });

  it('GET /api/projects/:id 对不存在的项目返回 404 领域错误', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/does-not-exist-xyz' });
    expect(res.statusCode).toBe(404);

    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    // 404 必须点明「什么不存在」，否则用户无法定位问题
    expect(body.error.message).toContain('项目');
  });

  it('不同资源的 404 使用各自的用户文案（而不是统一的通用文案）', async () => {
    const project = await app.inject({ method: 'GET', url: '/api/projects/no-such-project' });
    const content = await app.inject({ method: 'GET', url: '/api/contents/no-such-content' });
    const asset = await app.inject({ method: 'GET', url: '/api/assets/no-such-asset' });

    const messages = [project, content, asset].map(
      (r) => (r.json() as { error: { message: string } }).error.message,
    );

    expect(messages[0]).toContain('项目');
    expect(messages[1]).toContain('内容');
    expect(messages[2]).toContain('资产');
    // 三者文案必须互不相同，否则等于没区分
    expect(new Set(messages).size).toBe(3);
  });

  it('PATCH /api/projects/:id 对 memory 做片段合并而不是整体覆盖', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { memory: { brand: { tone: '克制、专业' } } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      memory: { goals?: { objective?: string }; brand?: { tone?: string } };
    };
    // 原有 goals 片段必须保留
    expect(body.memory.goals?.objective).toBe('验证 Phase 1 数据模型可用');
    expect(body.memory.brand?.tone).toBe('克制、专业');
  });

  it('分页响应用 items/total/page/pageSize/hasMore 结构', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects?page=1&pageSize=5' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('page', 1);
    expect(body).toHaveProperty('pageSize', 5);
    expect(body).toHaveProperty('hasMore');
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe('内容主链路', () => {
  it('在项目下创建内容', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/contents`,
      payload: {
        type: 'advertisement',
        title: '30 秒护肤品广告',
        brief: '面向年轻女性，高级、有质感',
        metadata: { duration: 30, aspectRatio: '16:9', platform: 'xiaohongshu' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { type: string; metadata: { duration: number } };
    expect(body.type).toBe('advertisement');
    expect(body.metadata.duration).toBe(30);
  });

  it('拒绝非法的内容类型（枚举约束生效）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/contents`,
      payload: { type: 'not_a_real_type', title: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/contents/:id/sections 按内容类型返回导航分区', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/contents`,
    });
    const contentId = (list.json() as { items: { id: string }[] }).items[0]?.id;
    expect(contentId).toBeTruthy();

    const res = await app.inject({ method: 'GET', url: `/api/contents/${contentId}/sections` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { type: string; sections: { key: string; label: string }[] };
    expect(body.type).toBe('advertisement');
    // 广告的分区必须是广告语义，而不是短剧的「剧本/角色/分集」
    const keys = body.sections.map((s) => s.key);
    expect(keys).toContain('idea');
    expect(keys).toContain('storyboard');
    expect(keys).not.toContain('episodes');
  });

  it('PATCH 内容时 metadata 做深合并，不丢失原有字段', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/contents` });
    const contentId = (list.json() as { items: { id: string }[] }).items[0]?.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${contentId}`,
      payload: { metadata: { style: ['高级', '有质感'] } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { metadata: { duration?: number; style?: string[] } };
    expect(body.metadata.duration).toBe(30); // 原字段保留
    expect(body.metadata.style).toEqual(['高级', '有质感']);
  });

  it('内容变更会生成版本记录', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/contents` });
    const contentId = (list.json() as { items: { id: string }[] }).items[0]?.id;

    const res = await app.inject({ method: 'GET', url: `/api/contents/${contentId}/versions` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { version: number; changelog: string }[] };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]?.version).toBeGreaterThanOrEqual(1);
  });
});

describe('资产主链路（统一 Asset System）', () => {
  let assetId: string;

  it('创建角色资产，metadata 按类型校验', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: {
        projectId,
        type: 'character',
        name: '苏晚',
        description: '年轻女性，黑色长发',
        metadata: {
          appearance: { gender: 'female', age: 23, hair: '黑色长直发' },
          personality: '清冷疏离',
          role: '女主',
        },
        tags: ['古装', '女主'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; slug: string; metadata: { appearance: { hair: string } } };
    assetId = body.id;
    // slug 保留中文，用户可以用 @苏晚 引用
    expect(body.slug).toBe('苏晚');
    expect(body.metadata.appearance.hair).toBe('黑色长直发');
  });

  it('同一名称再次创建时自动去重 slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: { projectId, type: 'character', name: '苏晚', metadata: {} },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe('苏晚-2');
  });

  it('拒绝与类型不匹配的 metadata（类型安全在写入时生效）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: {
        projectId,
        type: 'character',
        name: '错误角色',
        // appearance 在角色上必须是对象，这里给字符串
        metadata: { appearance: '黑色长发' },
      },
    });
    expect(res.statusCode).toBe(400);

    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toContain('character');
  });

  it('创建资产时自动产生 v1 版本', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/assets/${assetId}/versions` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { version: number; changelog: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.version).toBe(1);
    expect(body.items[0]?.changelog).toBe('创建资产');
  });

  it('更新资产会记录新版本与变更说明', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${assetId}`,
      payload: { metadata: { appearance: { hair: '红色长直发' } } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number; metadata: { appearance: { hair: string } } };
    expect(body.version).toBe(2);
    // 深合并：age 不能被抹掉
    expect((body.metadata.appearance as { age?: number }).age).toBe(23);
    expect(body.metadata.appearance.hair).toBe('红色长直发');
  });

  it('版本历史按倒序返回', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/assets/${assetId}/versions` });
    const body = res.json() as { items: { version: number; changelog: string }[] };
    expect(body.items.length).toBe(2);
    expect(body.items[0]?.version).toBe(2);
    expect(body.items[0]?.changelog).toContain('appearance');
  });

  it('可以恢复到历史版本，且恢复动作本身也形成新版本', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/assets/${assetId}/versions/1/restore`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: number;
      restoredFrom: number;
      metadata: { appearance: { hair: string } };
    };
    expect(body.restoredFrom).toBe(1);
    expect(body.version).toBe(3);
    // 内容应回到 v1 的黑色长发
    expect(body.metadata.appearance.hair).toBe('黑色长直发');
  });

  it('解析 @引用 能把中文引用名换成资产 id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets/resolve-mentions',
      payload: {
        projectId,
        text: '让 @苏晚 穿红色衣服，在 @长安城 的雨夜里走路。',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mentions: string[];
      matched: { slug: string; id: string }[];
      missing: string[];
    };
    expect(body.mentions).toEqual(['苏晚', '长安城']);
    expect(body.matched.map((m) => m.slug)).toContain('苏晚');
    // 未创建的资产应出现在 missing 中，供 Agent 提示用户
    expect(body.missing).toContain('长安城');
  });
});

describe('技能与工作流只读接口', () => {
  it('GET /api/skills 返回技能目录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { id: string; queue: string }[]; total: number };
    expect(body.total).toBeGreaterThan(20);
    expect(body.items.map((s) => s.id)).toContain('image.generate');
  });

  it('按能力筛选技能（Model Router 的基础）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills?capability=video' });
    const body = res.json() as { items: { id: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    // 能力筛选必须依据 capabilities 字段：advertisement.generate 的 id 里
    // 没有 video 字样，但它确实声明了 video 能力，因此应当被选中。
    expect(body.items.map((s) => s.id)).toContain('advertisement.generate');
    expect(body.items.map((s) => s.id)).toContain('video.generate');
  });

  it('GET /api/workflows/builtin 返回四套内置流程', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/builtin' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { contentType: string }[] };
    const types = body.items.map((i) => i.contentType);
    expect(types).toEqual(
      expect.arrayContaining(['advertisement', 'short_video', 'short_drama', 'digital_human']),
    );
  });

  it('内置流程带有拓扑分层信息，前端无需自行实现图算法', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows?type=advertisement' });
    const body = res.json() as { items: { valid: boolean; layers: string[][] }[] };

    expect(body.items.length).toBeGreaterThan(0);
    const ad = body.items.find((w) => w.valid);
    expect(ad).toBeDefined();
    expect(ad?.layers.length).toBeGreaterThan(3);
    // 短剧的角色与场景应在同一层（可并行）
    expect(ad?.layers.flat()).toContain('storyboard');
  });
});

describe('数据一致性守卫', () => {
  it('数据库中的技能枚举与领域定义一致（写入路径可用）', async () => {
    // 直接通过 Prisma 写入一个技能，验证 schema 与领域类型对齐
    const id = `test.skill.${Date.now()}`;
    const created = await prisma.skill.create({
      data: {
        id,
        name: '测试技能',
        category: 'text',
        capabilities: ['text'],
        risk: 'low',
        accessTier: 'free',
      },
    });
    expect(created.risk).toBe('low');

    await prisma.skill.delete({ where: { id } });
  });
});

describe('任务链路（Phase 2：Skill 执行 → 任务队列）', () => {
  let taskProjectId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: `任务链路测试 ${Date.now()}` },
    });
    taskProjectId = (res.json() as { id: string }).id;
  });

  it('POST /api/skills/:id/execute 返回 202 与 taskId，而不是 501', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/asset.create/execute',
      payload: {
        projectId: taskProjectId,
        input: {
          type: 'character',
          name: '任务链路角色',
          metadata: { appearance: { hair: '黑色长直发' } },
        },
      },
    });

    // 202 = 已受理未完成，这是「不阻塞 HTTP」的协议表达
    expect(res.statusCode).toBe(202);

    const body = res.json() as {
      taskId: string;
      status: string;
      queueName: string;
      deduplicated: boolean;
      skill: { id: string; risk: string };
    };
    expect(body.taskId).toBeTruthy();
    expect(body.status).toBe('pending');
    // asset.create 属于轻量资产池
    expect(body.queueName).toBe('asset');
    expect(body.deduplicated).toBe(false);
    expect(body.skill.id).toBe('asset.create');
  });

  it('相同输入的重复调用命中幂等，不会创建第二个任务', async () => {
    const payload = {
      projectId: taskProjectId,
      input: { type: 'scene', name: '幂等场景', metadata: { timeOfDay: '夜' } },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/skills/asset.create/execute',
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/skills/asset.create/execute',
      payload,
    });

    const firstBody = first.json() as { taskId: string; deduplicated: boolean };
    const secondBody = second.json() as { taskId: string; deduplicated: boolean };

    expect(secondBody.taskId).toBe(firstBody.taskId);
    expect(secondBody.deduplicated).toBe(true);
  });

  it('未知技能返回 404 而不是 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/not.a.real.skill/execute',
      payload: { projectId: taskProjectId, input: {} },
    });
    expect(res.statusCode).toBe(404);

    const body = res.json() as { error: { code: string; message: string; suggestions: string[] } };
    expect(body.error.code).toBe('SKILL_NOT_FOUND');
    // 404 必须点明「什么没找到」，而不是笼统的「没有找到对应的内容」
    expect(body.error.message).toContain('技能');
    expect(body.error.suggestions.length).toBeGreaterThan(0);
  });

  it('项目不存在时拒绝创建任务', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/skills/asset.create/execute',
      payload: { projectId: 'no-such-project', input: { type: 'prop', name: 'x' } },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('项目');
  });

  it('GET /api/tasks/:id 返回任务详情与子步骤', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: taskProjectId,
        skillId: 'asset.create',
        input: { type: 'brand', name: '任务详情品牌', metadata: { slogan: '测试' } },
      },
    });
    const taskId = (create.json() as { taskId: string }).taskId;

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      id: string;
      skillId: string;
      status: string;
      progress: number;
      steps: unknown[];
    };
    expect(body.id).toBe(taskId);
    expect(body.skillId).toBe('asset.create');
    expect(body.status).toBe('pending');
    expect(body.progress).toBe(0);
    expect(Array.isArray(body.steps)).toBe(true);
  });

  it('GET /api/tasks/:id/progress 返回轻量进度并标注是否终态', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: taskProjectId, skillId: 'asset.create', input: { type: 'prop', name: '进度道具' } },
    });
    const taskId = (create.json() as { taskId: string }).taskId;

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/progress` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { status: string; terminal: boolean; progress: number };
    expect(body.status).toBe('pending');
    // pending 不是终态，前端应继续轮询
    expect(body.terminal).toBe(false);
  });

  it('任务列表支持按项目与技能筛选', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/tasks?projectId=${taskProjectId}&skillId=asset.create`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { skillId: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((t) => t.skillId === 'asset.create')).toBe(true);
  });

  it('取消任务后状态为 cancelled，且无法再次取消', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: taskProjectId, skillId: 'asset.create', input: { type: 'prop', name: '待取消' } },
    });
    const taskId = (create.json() as { taskId: string }).taskId;

    const cancel = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel`, payload: {} });
    expect(cancel.statusCode).toBe(204);

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect((detail.json() as { status: string }).status).toBe('cancelled');

    // 二次取消应给出可理解的说明而不是静默成功
    const again = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel`, payload: {} });
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: { message: string } }).error.message).toContain('已经结束');
  });

  it('重试已取消的任务会重新入队并回到 pending', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { projectId: taskProjectId, skillId: 'asset.create', input: { type: 'prop', name: '待重试' } },
    });
    const taskId = (create.json() as { taskId: string }).taskId;

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel`, payload: {} });

    const retry = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { retried: boolean }).retried).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const body = detail.json() as { status: string; progress: number; errorMessage: string | null };
    expect(body.status).toBe('pending');
    expect(body.progress).toBe(0);
    expect(body.errorMessage).toBeNull();
  });

  it('不存在的任务返回 404 领域错误', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/no-such-task' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('任务');
  });
});
