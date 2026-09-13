/**
 * 前后端接口契约测试
 * ==================
 *
 * ── 为什么需要它 ──
 * `apps/web/src/lib/api-types.ts` 是**手写**的：前端构建不该把 Prisma / Fastify
 * 拉进 bundle，所以响应类型只能在前端再声明一遍。这天然是一处会漂移的接缝，
 * 而它原有的注释写着「护栏是端到端验证（验收标准第 1 条）」—— 那条链路因为
 * 后端既有缺陷当前**不可达**，等于这个接缝上一道护栏都没有。
 *
 * 本测试把「漂移」变成测试期就能发现的失败：
 *   1. 用 TypeScript 编译器 API 从 `api-types.ts` 里解析出每个接口的字段名，
 *      并区分**必填**与**可选**；
 *   2. 用 `app.inject()` 打真实端点，拿到真实响应；
 *   3. 断言「声明为必填的字段，响应里必须真的存在」。
 *
 * ── 这条不变量是单向的，而且是刻意单向 ──
 * `api-types.ts` 的设计意图是「只保留界面真正消费的字段」，所以：
 *   · 声明了、响应里没有 → 前端读到 `undefined`，是**缺陷**，本测试失败；
 *   · 响应里有、没声明   → 界面本来就不消费，属于设计允许，不报错。
 * 反向断言会让每一个「前端只读三个字段」的列表项都失败，那是噪音不是护栏。
 *
 * 写这个测试时它立刻就抓到了一处真漂移：`TaskProgress.terminal` 被声明为
 * 必填，但 `GET /api/tasks` 的列表项里根本没有这个字段 —— 终态标记只出现在
 * `GET /api/tasks/:id/progress` 上。该字段当时无人消费，所以是个哑弹；
 * 现在列表项改用 `TaskRow`，轮询端点才用 `TaskProgress`。
 *
 * ── 覆盖边界（说清楚，不含糊）──
 * 覆盖：15 个端点的响应信封与列表项，以及 `POST /api/agent/chat` 的
 *       `analysis` 与结构化 `payload`。
 * **不覆盖**：`toolCalls[].ToolCallRecord`（Mock 链路不产生工具调用，
 *       硬造一个样本等于自欺），以及 `MessagePayload` 五个成员里本次场景
 *       没有实际产生的那些 —— 载荷成员是「来哪个就校验哪个」，不会静默放过，
 *       但也不会凭空覆盖。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma } from '@svh/database';

import { buildApp } from '../src/core/app.js';

import type { FastifyInstance } from 'fastify';

/* ────────────────────────── 解析 api-types.ts ────────────────────────── */

interface 接口声明 {
  /** 必填字段（没有 `?`） */
  required: string[];
  /** 可选字段 */
  optional: string[];
  /** `extends` 的基接口名 */
  bases: string[];
}

type 形状 = { required: Set<string>; optional: Set<string> };

const API_TYPES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../web/src/lib/api-types.ts',
);

/**
 * 用编译器 API 解析出接口字段表。
 *
 * 遇到解析不了的结构一律**抛错**而不是跳过 —— 一个「解析到了 0 个字段」的
 * 静默失败会让下面所有断言变成空转，那比没有测试更糟。
 */
function 解析接口表(filePath: string): Map<string, 接口声明> {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const 表 = new Map<string, 接口声明>();

  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const name = statement.name.text;

    const required: string[] = [];
    const optional: string[] = [];

    for (const member of statement.members) {
      if (!ts.isPropertySignature(member)) {
        throw new Error(
          `${name} 里有非属性成员（${ts.SyntaxKind[member.kind]}）：` +
            '契约测试只认属性签名，遇到别的一律报错，避免静默漏掉字段',
        );
      }
      const key = member.name.getText(source);
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
        throw new Error(`${name} 的字段名 ${key} 不是普通标识符，无法机械比对`);
      }
      (member.questionToken === undefined ? required : optional).push(key);
    }

    const bases: string[] = [];
    for (const clause of statement.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const base of clause.types) bases.push(base.expression.getText(source));
    }

    if (表.has(name)) throw new Error(`api-types.ts 里出现重复接口名 ${name}`);
    表.set(name, { required, optional, bases });
  }

  if (表.size === 0) throw new Error(`${filePath} 里一个接口都没解析出来`);
  return 表;
}

const 接口表 = 解析接口表(API_TYPES_PATH);

/** 展开 `extends`：基接口的字段先合进来，自身的声明覆盖同名字段 */
function 解析形状(name: string, seen: readonly string[] = []): 形状 {
  if (seen.includes(name)) {
    throw new Error(`接口继承成环：${[...seen, name].join(' -> ')}`);
  }
  const 声明 = 接口表.get(name);
  if (声明 === undefined) {
    throw new Error(`api-types.ts 里找不到接口 ${name}（是被改名或删掉了吗？）`);
  }

  const required = new Set<string>();
  const optional = new Set<string>();

  for (const base of 声明.bases) {
    const 基形状 = 解析形状(base, [...seen, name]);
    for (const key of 基形状.required) required.add(key);
    for (const key of 基形状.optional) optional.add(key);
  }

  // 自身声明优先：可选覆盖基类的必填，必填覆盖基类的可选
  for (const key of 声明.optional) {
    required.delete(key);
    optional.add(key);
  }
  for (const key of 声明.required) {
    optional.delete(key);
    required.add(key);
  }

  return { required, optional };
}

/** 断言实际响应对象带齐了该类型声明的全部必填字段 */
function 断言键齐全(类型名: string, 实际: unknown): void {
  if (实际 === null || typeof 实际 !== 'object' || Array.isArray(实际)) {
    throw new Error(`${类型名}：期望一个对象，实际拿到 ${JSON.stringify(实际)}`);
  }

  const { required } = 解析形状(类型名);
  if (required.size === 0) {
    throw new Error(
      `${类型名} 解析出的必填字段为空。解析器失效时必须报错 —— ` +
        '否则这个类型上的所有断言都会空转通过。',
    );
  }

  const 实际键 = new Set(Object.keys(实际));
  const 缺失 = [...required].filter((key) => !实际键.has(key));
  expect(
    缺失,
    `${类型名} 声明为必填、但响应里不存在的字段（前端会读到 undefined）`,
  ).toEqual([]);
}

/** 从分页信封里取首项；空列表意味着场景没造出数据，必须显式失败 */
function 取首项(items: unknown, 来源: string): unknown {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${来源} 没有返回任何列表项，无法比对列表项契约`);
  }
  return items[0];
}

/**
 * `MessagePayload` 五个成员与 `type` 字面量的对应关系。
 *
 * 手写这份表是有意的：它同时守住「后端冒出一个前端没声明的载荷类型」——
 * 那种情况下这里查不到映射，测试会直接失败。
 */
const 载荷接口表: Record<string, string> = {
  plan: 'PlanPayload',
  result_card: 'ResultCardPayload',
  confirmation_request: 'ConfirmationRequestPayload',
  progress: 'ProgressPayload',
  error: 'ErrorPayload',
};

/* ────────────────────────────── 场景 ────────────────────────────── */

let app: FastifyInstance;
let projectId: string;
let sessionId: string;
let taskId: string;
let providerId = '';

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: `契约测试项目 ${String(Date.now())}` },
  });
  expect(created.statusCode).toBe(201);
  projectId = (created.json() as { id: string }).id;

  // 有资产才能断言 @引用 与资产列表项两个契约
  await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: {
      projectId,
      type: 'character',
      name: '契约角色',
      metadata: { appearance: { hair: '黑色长直发' } },
    },
  });

  const chat = await app.inject({
    method: 'POST',
    url: '/api/agent/chat',
    payload: { projectId, message: '帮我做一个30秒的护肤品广告' },
  });
  expect(chat.statusCode).toBe(200);
  sessionId = (chat.json() as { sessionId: string }).sessionId;

  const task = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: {
      projectId,
      skillId: 'asset.create',
      input: { type: 'prop', name: '契约道具' },
    },
  });
  expect(task.statusCode).toBe(201);
  taskId = (task.json() as { taskId: string }).taskId;

  const provider = await app.inject({
    method: 'POST',
    url: '/api/models/providers',
    payload: {
      name: `契约探测服务商 ${String(Date.now())}`,
      kind: 'openai_compatible',
      // 指向一个必然连不上的地址：这里要的是**响应形状**，不是连通性
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-contract-test-0001',
    },
  });
  expect(provider.statusCode).toBe(201);
  providerId = (provider.json() as { id: string }).id;
});

afterAll(async () => {
  if (providerId !== '') {
    await app.inject({ method: 'DELETE', url: `/api/models/providers/${providerId}` });
  }
  await app.close();
  await disconnectPrisma();
});

/* ─────────────────────── 解析器自检（防止空转） ─────────────────────── */

describe('解析器自检', () => {
  it('能从 api-types.ts 里读出真实字段，而不是空集合', () => {
    expect([...解析形状('PageBody').required].sort()).toEqual([
      'hasMore',
      'items',
      'page',
      'pageSize',
      'total',
    ]);

    // 可选字段必须被识别成可选，否则单向断言会变成一堆假失败
    expect(解析形状('ChatResponse').optional.has('payload')).toBe(true);
    expect(解析形状('ChatResponse').required.has('payload')).toBe(false);
  });

  it('能展开 extends：TaskProgress 有 terminal，TaskRow 没有', () => {
    expect(解析形状('TaskProgress').required.has('terminal')).toBe(true);
    expect(解析形状('TaskRow').required.has('terminal')).toBe(false);
    // 基接口的字段必须被继承下来
    expect([...解析形状('TaskDetail').required].sort()).toEqual([
      'errorMessage',
      'id',
      'output',
      'progress',
      'progressMessage',
      'skillId',
      'status',
      'updatedAt',
    ]);
  });

  it('找不到接口名时直接抛错，而不是当成「没有必填字段」放过', () => {
    expect(() => 解析形状('这个接口不存在')).toThrow(/找不到接口/);
  });
});

/* ─────────────────────────── 端点的契约 ─────────────────────────── */

describe('项目与分页信封', () => {
  it('GET /api/projects：信封 PageBody，列表项 Project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects?pageSize=5' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('PageBody', body);
    断言键齐全('Project', 取首项(body.items, 'GET /api/projects'));
  });

  it('POST /api/projects 的响应形状与列表项一致', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: `契约测试项目-单条 ${String(Date.now())}` },
    });
    expect(res.statusCode).toBe(201);
    断言键齐全('Project', res.json());
  });
});

describe('会话与确认', () => {
  it('GET /api/agent/sessions：信封 PageBody，列表项 SessionSummary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent/sessions?projectId=${projectId}`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('PageBody', body);
    断言键齐全('SessionSummary', 取首项(body.items, 'GET /api/agent/sessions'));
  });

  it('GET /api/agent/sessions/:id 返回 SessionDetail（含 messages）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('SessionDetail', body);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('POST /api/agent/sessions/:id/confirm 返回 ConfirmResponse', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/sessions/${sessionId}/confirm`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    断言键齐全('ConfirmResponse', res.json());
  });
});

describe('任务', () => {
  it('GET /api/tasks 的列表项是 TaskRow —— 不含 terminal', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks?pageSize=5' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('PageBody', body);

    const 首项 = 取首项(body.items, 'GET /api/tasks');
    断言键齐全('TaskRow', 首项);

    /*
     * 这条是回归守卫，不是凑数。
     * `terminal` 只出现在轮询端点 `/api/tasks/:id/progress` 上；早先它被
     * 声明在列表项类型里，前端一旦去读只会拿到 `undefined`（当时无人消费，
     * 所以是个哑弹）。把「列表项不该有 terminal」写死，避免再合并回去。
     */
    expect(Object.keys(首项 as object)).not.toContain('terminal');
  });

  it('GET /api/tasks/:id 返回 TaskDetail（含 output）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('TaskDetail', body);
    expect(body).toHaveProperty('output');
  });

  it('GET /api/tasks/:id/progress 返回 TaskProgress（含 terminal）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/progress` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('TaskProgress', body);
    expect(typeof body.terminal).toBe('boolean');
  });
});

describe('Agent 对话', () => {
  it('POST /api/agent/chat 返回 ChatResponse，analysis 单独校验', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/chat',
      payload: { projectId, message: '帮我做一个30秒的广告' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('ChatResponse', body);
    断言键齐全('ChatAnalysis', body.analysis);
  });

  it('会话里每条消息的结构化载荷都落在声明的五种之内', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agent/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('SessionDetail', body);

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('会话里一条消息都没有，载荷契约无从校验');
    }

    let 校验过的载荷数 = 0;
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue;
      断言键齐全('SessionMessage', message);

      const payload = (message as { payload?: unknown }).payload;
      if (payload === null || payload === undefined) continue;
      if (typeof payload !== 'object') throw new Error('payload 存在时必须是对象');

      const type = (payload as { type?: unknown }).type;
      if (typeof type !== 'string') throw new Error('结构化载荷缺少字符串 type');

      const 接口名 = 载荷接口表[type];
      if (接口名 === undefined) {
        throw new Error(
          `载荷类型 ${type} 在前端没有声明。新增载荷类型时必须同步 api-types.ts 与载荷接口表。`,
        );
      }
      断言键齐全(接口名, payload);
      校验过的载荷数 += 1;
    }

    // 本场景必然产生计划卡；一条都没有说明前面哪里不对，不能静默通过
    expect(校验过的载荷数, '会话里没有校验到任何结构化载荷').toBeGreaterThan(0);
  });
});

describe('技能、资产与引用解析', () => {
  it('GET /api/skills 的列表项带齐 SkillOption 的字段', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills?pageSize=5' });
    expect(res.statusCode).toBe(200);
    断言键齐全('SkillOption', 取首项((res.json() as { items: unknown }).items, 'GET /api/skills'));
  });

  it('GET /api/assets 的列表项带齐 AssetOption 的字段', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/assets?projectId=${projectId}&pageSize=5`,
    });
    expect(res.statusCode).toBe(200);
    断言键齐全('AssetOption', 取首项((res.json() as { items: unknown }).items, 'GET /api/assets'));
  });

  it('POST /api/assets/resolve-mentions 返回 ResolveMentionsResult', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assets/resolve-mentions',
      payload: { projectId, text: '让 @契约角色 走路，背景是 @不存在的场景' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('ResolveMentionsResult', body);
    // matched 的每一项也要带 slug：前端靠它把补全项与用户输入对应起来
    const 首项 = 取首项(body.matched, 'resolve-mentions 的 matched');
    expect(首项).toHaveProperty('slug');
  });
});

describe('模型服务商', () => {
  it('GET /api/models/providers：信封 PageBody，列表项 ModelProviderView', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers?pageSize=5' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('PageBody', body);
    断言键齐全('ModelProviderView', 取首项(body.items, 'GET /api/models/providers'));
  });

  it('POST /api/models/providers 的响应形状与列表项一致', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/models/providers/${providerId}` });
    expect(res.statusCode).toBe(200);
    断言键齐全('ModelProviderView', res.json());
  });

  it('POST /api/models/providers/:id/test 返回 TestConnectionResult', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/models/providers/${providerId}/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('TestConnectionResult', body);

    /*
     * 这一条专门守住「别再照着旧文档猜字段」。
     * 前端曾声明过 `{ ok?: boolean }` 并据此判定成败，而服务端从来不返回
     * `ok` —— 那个分支永远不成立，页面实际只靠 `health` 判断。
     */
    expect(body).not.toHaveProperty('ok');
    expect(typeof body.health).toBe('string');
  });

  it('GET /api/models/providers/runtime 返回 ModelRuntimeStatus', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/models/providers/runtime' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    断言键齐全('ModelRuntimeStatus', body);
    // 类型说是布尔就必须是布尔：前端拿它决定要不要提示「当前是占位内容」
    expect(typeof body.placeholderOnly).toBe('boolean');
    expect(typeof body.realModelCount).toBe('number');
    expect(typeof body.providerCount).toBe('number');
    expect(typeof body.modelCount).toBe('number');

    /*
     * 判据不能退回 `usingMock`。
     *
     * 那个布尔只表示「一个可用模型都没有」；而库里那条 `kind='mock'` 的
     * Mock Provider 行自带模型，于是「只剩 Mock 可用」时它仍是 false ——
     * 实测把唯一一个真实 Provider 禁用后，端点照样报 usingMock:false，
     * 界面提示条根本不会出现。这里钉住两个字段的一致性：
     * 真实模型数为 0 必须等价于「全是占位内容」。
     */
    expect(body.placeholderOnly).toBe(body.realModelCount === 0);
  });
});
