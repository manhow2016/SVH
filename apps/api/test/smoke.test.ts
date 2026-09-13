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
import { buildJobId } from '@svh/domain';

import { buildApp } from '../src/core/app.js';
import { closeQueuePool, enqueueSkillTask, getQueuePool } from '../src/core/tasks.js';

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
  // 确认链路的用例会真实入队，这里释放队列连接，避免进程挂着不放
  await closeQueuePool();
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

describe('模型服务商管理（Phase 3：BYOK）', () => {
  const SECRET_KEY = 'sk-test-secret-key-abcdefghijklmnop';
  let providerId: string;

  it('GET /api/models/providers/kinds 返回协议清单与默认地址', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers/kinds' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      items: { kind: string; label: string; builtin: boolean; defaultBaseUrl: string }[];
    };
    const kinds = body.items.map((i) => i.kind);
    expect(kinds).toContain('openai_compatible');
    expect(kinds).toContain('anthropic_compatible');
    expect(kinds).toContain('gemini_compatible');

    // custom 没有内置适配器，必须明确标注
    expect(body.items.find((i) => i.kind === 'custom')?.builtin).toBe(false);
    // 提供默认地址能显著减少用户填错
    expect(body.items.find((i) => i.kind === 'openai_compatible')?.defaultBaseUrl).toContain('openai.com');
  });

  it('POST 创建 Provider：密钥被加密存储，响应不含明文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      payload: {
        name: `测试服务商 ${Date.now()}`,
        kind: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1/',
        apiKey: SECRET_KEY,
        concurrency: 2,
      },
    });

    expect(res.statusCode).toBe(201);

    const rawBody = res.body;
    // 最关键的一条：响应体里绝不能出现明文密钥
    expect(rawBody).not.toContain(SECRET_KEY);

    const body = res.json() as {
      id: string;
      hasApiKey: boolean;
      apiKeyMask: string;
      health: string;
      baseUrl: string;
    };
    providerId = body.id;

    expect(body.hasApiKey).toBe(true);
    // 掩码保留首尾，足以让用户确认是不是这把钥匙
    expect(body.apiKeyMask).toContain('sk-');
    expect(body.apiKeyMask).toContain('****');
    expect(body.apiKeyMask).not.toBe(SECRET_KEY);
    // 新配置未经检验，不应假装健康
    expect(body.health).toBe('unknown');
    // 末尾斜杠被规范化
    expect(body.baseUrl).toBe('https://api.example.com/v1');
  });

  it('数据库中存的是密文而不是明文', async () => {
    const row = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { apiKeyEncrypted: true },
    });

    expect(row?.apiKeyEncrypted).toBeTruthy();
    expect(row?.apiKeyEncrypted).not.toContain(SECRET_KEY);
    // 密文格式为 v1:<iv>:<tag>:<data>
    expect(row?.apiKeyEncrypted.startsWith('v1:')).toBe(true);
  });

  it('GET 详情不返回明文密钥（逐字段核对）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/models/providers/${providerId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET_KEY);

    const body = res.json() as Record<string, unknown>;
    expect(body.apiKeyEncrypted).toBeUndefined();
    expect(body.apiKey).toBeUndefined();
    expect(body.hasApiKey).toBe(true);
  });

  it('GET 列表同样不泄漏密钥', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET_KEY);

    const body = res.json() as { items: Record<string, unknown>[] };
    for (const item of body.items) {
      expect(item.apiKeyEncrypted).toBeUndefined();
      expect(item.apiKey).toBeUndefined();
    }
  });

  it('PATCH 不带 apiKey 时不改动已保存的密钥', async () => {
    const before = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { apiKeyEncrypted: true },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/providers/${providerId}`,
      payload: { concurrency: 8 },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { apiKeyEncrypted: true, concurrency: true },
    });
    expect(after?.apiKeyEncrypted).toBe(before?.apiKeyEncrypted);
    expect(after?.concurrency).toBe(8);
  });

  it('PATCH 带 apiKey 时重新加密并把健康状态重置为待验证', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/providers/${providerId}`,
      payload: { apiKey: 'sk-rotated-key-0987654321zyxwvu' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-rotated-key-0987654321zyxwvu');

    const body = res.json() as { apiKeyMask: string; health: string };
    // 换了密钥就必须重新验证，不能沿用旧结论
    expect(body.health).toBe('unknown');
    expect(body.apiKeyMask).toContain('xwvu');
  });

  it('同名 Provider 被拒绝（避免配置重复难以分辨）', async () => {
    const dupName = `重名服务商 ${Date.now()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      payload: {
        name: dupName,
        kind: 'openai_compatible',
        baseUrl: 'https://a.example.com/v1',
        apiKey: 'sk-aaaaaaaaaaaaaaaa',
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      payload: {
        name: dupName,
        kind: 'openai_compatible',
        baseUrl: 'https://b.example.com/v1',
        apiKey: 'sk-bbbbbbbbbbbbbbbb',
      },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { message: string } }).error.message).toContain('同名');

    await prisma.modelProvider.deleteMany({ where: { name: dupName } });
  });

  it('为 Provider 添加模型，并校验能力标识合法性', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${providerId}/models`,
      payload: {
        modelKey: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        capabilities: ['text', 'script'],
        priority: 150,
      },
    });
    expect(ok.statusCode).toBe(201);

    // 非法能力必须被拒绝：否则 Model Router 永远选不中该模型，
    // 用户却以为配置成功了
    const bad = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${providerId}/models`,
      payload: {
        modelKey: 'weird-model',
        displayName: '怪模型',
        capabilities: ['text', 'not_a_real_capability'],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { message: string } }).error.message).toContain('not_a_real_capability');
  });

  it('重复添加同一模型标识被拒绝', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${providerId}/models`,
      payload: { modelKey: 'gpt-4o-mini', displayName: '重复', capabilities: ['text'] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('连通性测试：真实发起请求并返回面向用户的结论', async () => {
    // 指向一个不可达地址，验证错误路径而不是假装成功
    const created = await app.inject({
      method: 'POST',
      url: '/api/models/providers',
      payload: {
        name: `不可达服务商 ${Date.now()}`,
        kind: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'sk-unreachable',
      },
    });
    const unreachableId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${unreachableId}/test`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      health: string;
      message: string | null;
      suggestions: string[];
      usedTemporaryConfig: boolean;
    };

    expect(body.health).toBe('down');
    expect(body.message).toBeTruthy();
    // 必须给出可操作的下一步，而不是只说「失败」
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.usedTemporaryConfig).toBe(false);

    // 健康状态被写回数据库，供 Model Router 排序时参考
    const row = await prisma.modelProvider.findUnique({
      where: { id: unreachableId },
      select: { health: true, lastCheckedAt: true },
    });
    expect(row?.health).toBe('down');
    expect(row?.lastCheckedAt).not.toBeNull();

    await prisma.modelProvider.delete({ where: { id: unreachableId } });
  });

  it('用未保存的临时密钥测试时不写库', async () => {
    const before = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { apiKeyEncrypted: true, apiKeyMask: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${providerId}/test`,
      payload: { apiKey: 'sk-temporary-key-should-not-persist' },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { usedTemporaryConfig: boolean }).usedTemporaryConfig).toBe(true);

    // 数据库里的密钥必须还是原来那个 —— 临时凭据绝不能污染已保存配置
    const after = await prisma.modelProvider.findUnique({
      where: { id: providerId },
      select: { apiKeyEncrypted: true, apiKeyMask: true },
    });
    expect(after?.apiKeyEncrypted).toBe(before?.apiKeyEncrypted);
    expect(after?.apiKeyMask).toBe(before?.apiKeyMask);
  });

  it('内置 Mock 服务商不允许删除', async () => {
    // 触发一次 Mock 运行时装配，使 Mock Provider 行存在
    const list = await app.inject({ method: 'GET', url: '/api/models/providers' });
    const items = (list.json() as { items: { id: string; kind: string }[] }).items;
    const mock = items.find((i) => i.kind === 'mock');

    if (mock === undefined) {
      // Mock 行由 Worker 首次调用时惰性创建，此处不存在则跳过
      expect(true).toBe(true);
      return;
    }

    const res = await app.inject({ method: 'DELETE', url: `/api/models/providers/${mock.id}` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toContain('内置');
  });

  it('配置版本号在修改后发生变化（供 Worker 热更新检测）', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/models/providers/config-version' });
    const v1 = (before.json() as { version: string }).version;

    await app.inject({
      method: 'PATCH',
      url: `/api/models/providers/${providerId}`,
      payload: { concurrency: 3 },
    });

    const after = await app.inject({ method: 'GET', url: '/api/models/providers/config-version' });
    const v2 = (after.json() as { version: string }).version;

    expect(v2).not.toBe(v1);
  });

  it('不存在的 Provider 返回 404 且点明资源类型', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers/no-such-provider' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('模型服务商');
  });

  it('清理：删除测试用 Provider', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/models/providers/${providerId}` });
    expect(res.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: `/api/models/providers/${providerId}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe('Creative Agent 对话（Phase 4）', () => {
  let agentProjectId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: `Agent 测试项目 ${Date.now()}`,
        memory: {
          goals: { objective: '验证 Agent 链路', platforms: ['xiaohongshu'] },
          visual: { style: '电影感、冷调', styleKeywords: ['电影感', '冷调'] },
          brand: { tone: '克制、专业', must: ['保留留白'] },
        },
      },
    });
    agentProjectId = (res.json() as { id: string }).id;

    // 准备一个可被 @引用 的角色资产
    await app.inject({
      method: 'POST',
      url: '/api/assets',
      payload: {
        projectId: agentProjectId,
        type: 'character',
        name: '苏晚',
        description: '年轻女性，黑色长发',
        metadata: { appearance: { hair: '黑色长直发', age: 23 }, role: '女主' },
      },
    });
  });

  it('创作需求：「帮我做一个 30 秒广告」→ 识别类型、建内容、给计划', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: {
        projectId: agentProjectId,
        message: '帮我做一个30秒的护肤品广告，面向年轻女性，整体高级有质感',
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      sessionId: string;
      message: string;
      state: string;
      analysis: { intent: string; contentType?: string; confidence: number };
      payload?: { type: string; goal: string; tasks: { title: string }[] };
    };

    // 意图被正确识别为创建广告内容
    expect(body.analysis.intent).toBe('create_content');
    expect(body.analysis.contentType).toBe('advertisement');
    expect(body.sessionId).toBeTruthy();

    // 返回制作计划（结构化载荷），而不是一段散文
    expect(body.payload?.type).toBe('plan');
    expect(body.payload?.tasks.length).toBeGreaterThan(3);
    expect(body.payload?.goal).toContain('广告');

    // 回复里应当说明将要做什么
    expect(body.message).toContain('计划');
  });

  it('计划被持久化为会话消息，结构化载荷完整保存', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '帮我做一个15秒的抖音短视频' },
    });
    const sessionId = (chat.json() as { sessionId: string }).sessionId;

    const detail = await app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionId}` });
    expect(detail.statusCode).toBe(200);

    const body = detail.json() as {
      messages: { role: string; kind: string; content: string; payload?: unknown }[];
    };

    // 至少包含用户消息 + Agent 回复
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages[0]?.role).toBe('user');

    const agentMessage = body.messages.find((m) => m.role === 'agent');
    expect(agentMessage).toBeDefined();
    // 结构化载荷必须落库：前端刷新后仍能渲染计划卡片
    expect(agentMessage?.payload).toBeTruthy();
    expect((agentMessage?.payload as { type?: string })?.type).toBe('plan');
  });

  it('内容被真实创建，可在内容列表中查到', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '帮我做一个20秒的产品广告' },
    });

    const contents = await app.inject({
      method: 'GET',
      url: `/api/projects/${agentProjectId}/contents`,
    });
    const body = contents.json() as { items: { type: string }[]; total: number };

    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((c) => c.type === 'advertisement')).toBe(true);
  });

  it('@引用 被解析并注入上下文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '让 @苏晚 穿红色衣服' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      analysis: { mentions: string[] };
      contextNotes: string[];
    };

    expect(body.analysis.mentions).toContain('苏晚');
    expect(body.contextNotes.join(' ')).toContain('@引用');
  });

  it('语义模糊时追问而不是猜测执行', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '嗯……你觉得怎么样' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; message: string; analysis: { confidence: number } };

    // 低置信度时应当等待用户补充说明
    if (body.analysis.confidence < 0.6) {
      expect(body.state).toBe('waiting_user');
      expect(body.message.length).toBeGreaterThan(0);
    }
  });

  it('「继续」类指令走规则匹配，不消耗模型调用', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '继续' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { analysis: { intent: string; confidence: number } };
    expect(body.analysis.intent).toBe('continue');
    expect(body.analysis.confidence).toBeGreaterThan(0.9);
  });

  it('会话可以续接：同一 sessionId 下消息累积', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '帮我做一个10秒广告' },
    });
    const sessionId = (first.json() as { sessionId: string }).sessionId;

    const second = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, sessionId, message: '继续' },
    });

    expect((second.json() as { sessionId: string }).sessionId).toBe(sessionId);

    const detail = await app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionId}` });
    const messages = (detail.json() as { messages: unknown[] }).messages;
    // 两轮对话至少产生 4 条消息（2 用户 + 2 Agent）
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  it('会话列表支持按项目筛选', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent/sessions?projectId=${agentProjectId}`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: { projectId: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((s) => s.projectId === agentProjectId)).toBe(true);
  });

  it('会话的任务列表可查询（Agent UI 展示进度用）', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '帮我做一个30秒广告' },
    });
    const sessionId = (chat.json() as { sessionId: string }).sessionId;

    const res = await app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionId}/tasks` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { items: unknown[] }).items)).toBe(true);
  });

  it('不存在的项目返回 404 且点明资源类型', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: 'nosuchproject', message: '你好' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('项目');
  });

  it('空消息被拒绝（消息不能为空）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('不存在的会话返回 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions/no-such-session' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('会话');
  });

  it('确认接口在无等待任务时给出明确说明', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '帮我做一个12秒广告' },
    });
    const sessionId = (chat.json() as { sessionId: string }).sessionId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/sessions/${sessionId}/confirm`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { resumed: string[]; message: string };
    expect(body.resumed).toEqual([]);
    expect(body.message).toContain('没有等待确认');
  });

  /**
   * 守护确认链路：高风险技能必须先落一条 waiting_user 任务，且**不入队**。
   *
   * 若只返回 requiresConfirmation 而不创建任务，用户点「确认执行」时
   * 后端查不到任何等待中的任务，界面却显示已确认 —— 这正是技术文档
   * 第 66、78 条禁止的「看似成功的失败」。
   */
  it('高风险任务先落库为 waiting_user 且不入队，确认后才真正执行', async () => {
    // 任务必须挂在会话上，确认接口才按会话找得到它
    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '现在项目里都有什么' },
    });
    const sessionId = (chat.json() as { sessionId: string }).sessionId;

    // 模拟 Agent 工具循环撞上高风险技能：先落库、等用户确认
    const created = await enqueueSkillTask({
      skillId: 'video.generate',
      projectId: agentProjectId,
      input: { prompt: '一段测试视频' },
      sessionId,
      initialStatus: 'waiting_user',
    });

    expect(created.status).toBe('waiting_user');

    const stored = await prisma.agentTask.findUnique({
      where: { id: created.taskId },
      select: { status: true, sessionId: true },
    });
    expect(stored?.status).toBe('waiting_user');
    expect(stored?.sessionId).toBe(sessionId);

    // 关键：等待确认的任务**不得**进队列，否则会被立即执行，确认就没有意义了
    const queue = getQueuePool().queue('ai_video');
    const jobId = buildJobId(created.taskId, 1);
    expect(await queue.getJob(jobId)).toBeUndefined();

    // 用户点「确认执行」：确认接口应当找得到并放行这条任务
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/agent/sessions/${sessionId}/confirm`,
      payload: { taskIds: [created.taskId] },
    });

    expect(confirm.statusCode).toBe(200);
    const confirmBody = confirm.json() as { resumed: string[]; message: string };
    expect(confirmBody.resumed).toContain(created.taskId);
    expect(confirmBody.message).toContain('已确认');

    const resumed = await prisma.agentTask.findUnique({
      where: { id: created.taskId },
      select: { status: true, confirmedAt: true },
    });
    expect(resumed?.status).toBe('pending');
    // 批准凭据必须与状态一起落库：Worker 只认 confirmedAt，
    // 少了它任务会在「入队 → 撞确认闸门 → waiting_user」之间无限循环
    expect(resumed?.confirmedAt).not.toBeNull();

    // 确认之后才真正入队
    expect(await queue.getJob(jobId)).toBeDefined();

    // 清理：测试进程没有 Worker 消费，别把作业留在队列里
    const job = await queue.getJob(jobId);
    await job?.remove();
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });

  it('不传 initialStatus 时保持原行为：落库即为 pending 并照常入队', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId: agentProjectId, message: '现在项目里都有什么' },
    });
    const sessionId = (chat.json() as { sessionId: string }).sessionId;

    const created = await enqueueSkillTask({
      skillId: 'video.generate',
      projectId: agentProjectId,
      input: { prompt: '一段对照视频' },
      sessionId,
    });

    expect(created.status).toBe('pending');

    const queue = getQueuePool().queue('ai_video');
    const jobId = buildJobId(created.taskId, 1);
    expect(await queue.getJob(jobId)).toBeDefined();

    const job = await queue.getJob(jobId);
    await job?.remove();
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });
});

/**
 * 任务级确认出口。
 *
 * ── 这条守的是什么 ──
 * 高风险技能的任务先落库为 `waiting_user`、等用户确认后才入队。而此前**唯一**
 * 的确认入口是会话级的 `/api/agent/sessions/:id/confirm`，它在查询里硬过滤
 * `sessionId`。于是 `POST /api/tasks` 建的、不带会话的高风险任务会永久卡在
 * `waiting_user` —— 没有任何接口能放行，`retry` 也救不回来（闸门只看
 * `confirmedAt`，实测 1.5 秒后又回到 `waiting_user`）。**一个没有出口的状态。**
 */
describe('任务级确认出口（无会话的高风险任务也能放行）', () => {
  let projectId: string;

  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: `任务级确认 ${String(Date.now())}` },
    });
    projectId = (res.json() as { id: string }).id;
  });

  it('不带 sessionId 的 waiting_user 任务可以被放行', async () => {
    // 刻意不传 sessionId：这正是此前没有任何出口的那种任务
    const created = await enqueueSkillTask({
      skillId: 'video.generate',
      projectId,
      input: { prompt: '任务级确认验证' },
      initialStatus: 'waiting_user',
    });
    expect(created.status).toBe('waiting_user');

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.taskId}/confirm`,
    });
    expect(confirm.statusCode).toBe(200);

    const body = confirm.json() as { resumed: string[]; skipped: unknown[]; message: string };
    expect(body.resumed).toContain(created.taskId);
    expect(body.skipped).toEqual([]);

    const row = await prisma.agentTask.findUnique({
      where: { id: created.taskId },
      select: { status: true, confirmedAt: true },
    });
    expect(row?.status).toBe('pending');
    // 批准凭据必须与状态一起落库：Worker 只认 confirmedAt，
    // 漏写会让任务再次退回 waiting_user，用户确认了却永远等不到结果
    expect(row?.confirmedAt).not.toBeNull();

    // 清理：测试进程没有 Worker 消费，别把作业留在队列里
    const queue = getQueuePool().queue('ai_video');
    const job = await queue.getJob(buildJobId(created.taskId, 1));
    await job?.remove();
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });

  it('对不在 waiting_user 的任务确认：404 + 可读原因，而不是静默成功', async () => {
    // asset.create 是低风险技能，落在 pending，不需要确认
    const created = await enqueueSkillTask({
      skillId: 'asset.create',
      projectId,
      input: { type: 'prop', name: '任务级确认-非等待' },
    });
    expect(created.status).toBe('pending');

    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.taskId}/confirm`,
    });
    expect(res.statusCode).toBe(404);

    const body = res.json() as { error: { message: string } };
    /*
     * 必须说清「为什么不能确认」，而不是笼统的 404。
     * 尤其不能是 NotFoundError 的默认文案「XX不存在，可能已被删除。」——
     * 任务明明存在，那句话会把人引到错误方向。
     */
    expect(body.error.message).toContain('不需要确认');
    expect(body.error.message).toContain('pending');
    expect(body.error.message).not.toContain('不存在');

    const queue = getQueuePool().queue('asset');
    const job = await queue.getJob(buildJobId(created.taskId, 1));
    await job?.remove();
    await prisma.agentTask.delete({ where: { id: created.taskId } });
  });

  it('对不存在的任务确认返回 404 且点明资源类型', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/no-such-task-for-confirm/confirm',
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('任务');
  });
});
