# Phase 5A：后端实时通道与确认链路修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「任务事件从 Worker/API 实时推送到客户端」的通道，并修复导致「确认执行」按钮永远失效的确认链路缺陷。

**Architecture:** 新增 `@svh/realtime` 包，用 Redis Stream 承载会话事件：`XADD` 发布、`XRANGE` 补发 + `XREAD BLOCK` 实时订阅。一条命令序列同时完成补发与订阅，从结构上消除「先 replay 再 subscribe」之间的空窗（审计报告 P0 缺陷 ⑫）。SSE 端点在 API 进程内把 Stream 事件转成 `text/event-stream` 帧。发布是**增强能力而非业务前置条件**，因此发布失败只记日志、不阻塞业务。

**Tech Stack:** TypeScript（纯 ESM / NodeNext）、Redis Stream、ioredis 5.11.1、Fastify、Vitest、Prisma

**Spec:** `docs/superpowers/specs/2026-09-12-phase5-agent-ui-design.md`

## Global Constraints

- 全部代码与注释使用**简体中文**；提交信息格式 `type(scope): 描述`
- 纯 ESM：`module`/`moduleResolution` 均为 `NodeNext`，相对导入必须带 `.js` 后缀
- 包入口 `main`/`types`/`exports` 一律指向 `src/*.ts`（开发零构建）；`build` 用独立 `tsconfig.build.json`（`rootDir: src`，排除测试）
- TypeScript 严格模式 + `noUncheckedIndexedAccess`：索引访问结果必须判空
- 禁止非空断言 `!`、禁止显式 `any`（仅测试文件放宽）；禁止浮空 Promise
- 测试文件放各包独立 `test/` 目录；需要外部服务的用例在服务不可用时**跳过而非失败**
- 包依赖不得成环：`@svh/realtime` 只依赖 `@svh/domain` 与 `ioredis`，**不得**依赖 `@svh/database`
- `@svh/realtime` **不读环境变量**，连接参数由调用方注入
- 任何新增依赖的下载走代理 `http://192.168.240.1:10808`
- 运行测试前需用户确认（遵循项目约定）

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/realtime/package.json` | 包定义与脚本 |
| `packages/realtime/tsconfig.json` | 含测试的类型检查配置 |
| `packages/realtime/tsconfig.build.json` | 仅 src 的构建配置 |
| `packages/realtime/vitest.config.ts` | 串行执行（避免争抢同一 Redis 库） |
| `packages/realtime/src/keys.ts` | Redis Key 约定与常量 |
| `packages/realtime/src/ports.ts` | 注入式接口与事件类型 |
| `packages/realtime/src/parse.ts` | 防御式解析 Redis 返回结构 |
| `packages/realtime/src/publisher.ts` | 事件发布器 |
| `packages/realtime/src/subscriber.ts` | 事件订阅器（补发 + 实时 + 取消清理） |
| `packages/realtime/src/index.ts` | 对外导出 |
| `packages/realtime/test/keys.test.ts` | Key 约定测试 |
| `packages/realtime/test/parse.test.ts` | 解析边界测试（无需 Redis） |
| `packages/realtime/test/publisher.test.ts` | 发布测试（需 Redis） |
| `packages/realtime/test/subscriber.test.ts` | 订阅与补发测试（需 Redis） |
| `apps/api/src/core/events.ts` | API 侧发布器单例与便捷函数 |
| `apps/api/src/routes/events.ts` | SSE 端点 |
| `apps/worker/src/events.ts` | Worker 侧事件汇聚端口（含空实现） |
| `docs/ARCHITECTURE.md` | 更新交付边界与已知限制 |

被修改的既有文件：

| 文件 | 改动 |
| --- | --- |
| `packages/database/src/tasks.ts` | `createTask` 支持 `initialStatus` |
| `packages/agent/src/ports.ts` | `AgentTaskPort.enqueue` 支持 `initialStatus` |
| `packages/agent/src/tools.ts` | 高风险技能改为创建 `waiting_user` 任务 |
| `packages/agent/src/runtime.ts` | 确认载荷回填真实 `taskId` |
| `apps/api/src/core/tasks.ts` | `enqueueSkillTask` 支持 `initialStatus` 且不为其入队 |
| `apps/api/src/core/agent-deps.ts` | 透传 `initialStatus` |
| `apps/api/src/core/app.ts` | 注册事件路由 |
| `apps/api/src/index.ts` | 关闭时释放事件连接 |
| `apps/api/src/routes/agent.ts` | 发布 Agent 轮次事件、确认放行事件 |
| `apps/worker/src/runner.ts` | 发布任务状态 / 进度 / 资产事件 |
| `apps/worker/src/index.ts` | 装配事件汇聚器 |
| `apps/api/package.json`、`apps/worker/package.json` | 增加 `@svh/realtime` 依赖 |
| `apps/api/vitest.config.ts` | 串行执行（SSE 测试需要） |

---

## Task 1: `@svh/realtime` 包骨架与 Key 约定

**Files:**
- Create: `packages/realtime/package.json`
- Create: `packages/realtime/tsconfig.json`
- Create: `packages/realtime/tsconfig.build.json`
- Create: `packages/realtime/vitest.config.ts`
- Create: `packages/realtime/src/keys.ts`
- Create: `packages/realtime/src/index.ts`
- Test: `packages/realtime/test/keys.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `eventStreamKey(sessionId: string): string`、`eventSeqKey(sessionId: string): string`、`STREAM_MAXLEN`、`STREAM_TTL_SECONDS`、`DEFAULT_BLOCK_MS`、`READ_COUNT`

- [ ] **Step 1: 创建包定义**

`packages/realtime/package.json`：

```json
{
  "name": "@svh/realtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "SVH 实时事件总线：基于 Redis Stream 的会话事件发布与订阅（含断点续传）",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": [
    "src",
    "dist"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src test",
    "clean": "rm -rf dist .turbo *.tsbuildinfo"
  },
  "dependencies": {
    "@svh/domain": "workspace:*",
    "ioredis": "^5.11.1"
  },
  "devDependencies": {
    "@svh/config": "workspace:*",
    "@svh/queue": "workspace:*",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 创建 TypeScript 配置**

`packages/realtime/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

`packages/realtime/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test"]
}
```

- [ ] **Step 3: 创建 Vitest 配置**

`packages/realtime/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 事件流测试共享同一个 Redis 库，串行执行避免用例之间互相看到对方的流
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: 编写失败的测试**

`packages/realtime/test/keys.test.ts`：

```ts
/**
 * Redis Key 约定测试
 *
 * 这些断言看起来琐碎，但它们是**会话隔离**的第一道防线：
 * 一旦两个会话的键发生碰撞，事件就会推送错人。
 */
import { describe, expect, it } from 'vitest';

import {
  eventSeqKey,
  eventStreamKey,
  READ_COUNT,
  STREAM_MAXLEN,
  STREAM_TTL_SECONDS,
} from '../src/index.js';

describe('事件总线的 Redis Key 约定', () => {
  it('不同会话的事件流键不同', () => {
    expect(eventStreamKey('sess_a')).not.toBe(eventStreamKey('sess_b'));
  });

  it('事件流键与序号键不冲突', () => {
    expect(eventStreamKey('sess_a')).not.toBe(eventSeqKey('sess_a'));
  });

  it('序号键与事件流键都带 svh 前缀，避免与同库其它项目冲突', () => {
    expect(eventStreamKey('x').startsWith('svh:')).toBe(true);
    expect(eventSeqKey('x').startsWith('svh:')).toBe(true);
  });

  it('会话 id 被完整保留在键中', () => {
    expect(eventStreamKey('sess_a')).toContain('sess_a');
    expect(eventSeqKey('sess_a')).toContain('sess_a');
  });

  it('裁剪与过期参数处于合理区间', () => {
    // 太小会导致断线重连取不到足够历史；太大则白白占内存
    expect(STREAM_MAXLEN).toBeGreaterThanOrEqual(100);
    expect(STREAM_TTL_SECONDS).toBeGreaterThanOrEqual(3600);
    expect(READ_COUNT).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

```bash
pnpm --filter @svh/realtime test
```

预期：失败，报找不到模块 `../src/index.js`。

- [ ] **Step 6: 实现 Key 约定**

`packages/realtime/src/keys.ts`：

```ts
/**
 * 实时事件总线的 Redis Key 约定
 *
 * 所有键统一以 `svh:` 开头，与 @svh/queue 的 BullMQ 前缀保持一致，
 * 避免与同一 Redis 库中的其它项目冲突。
 *
 * ── 为什么以「会话」而不是「项目」为通道 ──
 * 传输契约（packages/domain/src/transport.ts）把 sessionId 定为强制字段，
 * 并要求服务端按会话过滤。以会话为键，跨会话泄漏在**结构上**不可能发生，
 * 而不是依赖查询条件写对。
 */

/** 键前缀 */
const PREFIX = 'svh';

/** 会话事件流（Redis Stream）。每个会话一条流。 */
export function eventStreamKey(sessionId: string): string {
  return `${PREFIX}:events:session:${sessionId}`;
}

/**
 * 会话事件序号计数器。
 *
 * 领域契约 SseEnvelope.seq 要求**会话内单调递增整数**，而 Redis Stream ID
 * 形如 `1700000000000-0`。两者用途不同：seq 供前端排序与展示，
 * Stream ID 作为 SSE 的 `id:` 字段供 Last-Event-ID 断点续传。
 */
export function eventSeqKey(sessionId: string): string {
  return `${PREFIX}:seq:${sessionId}`;
}

/** 事件流最大长度（近似）。超出后由 Redis 裁剪，防止无限增长。 */
export const STREAM_MAXLEN = 2000;

/** 事件流存活时间（秒）。会话长期不活跃后自动回收。 */
export const STREAM_TTL_SECONDS = 86_400;

/** XREAD 阻塞时长（毫秒）。超时后调用方发送心跳，用于探测断线。 */
export const DEFAULT_BLOCK_MS = 15_000;

/** 单次 XREAD 最多取出的事件数 */
export const READ_COUNT = 50;
```

- [ ] **Step 7: 创建导出入口**

`packages/realtime/src/index.ts`。本任务只导出已存在的模块；
后续任务会在文件末尾各自追加一行导出：

```ts
/**
 * @svh/realtime 实时事件总线
 *
 * 基于 Redis Stream 实现「会话事件」的发布与订阅，供 SSE 端点转发给前端。
 *
 * ── 隔离约束 ──
 * 本包**不读环境变量**、**不依赖数据库**、**不依赖 HTTP 框架**：
 * 连接参数由调用方注入。这样它既能被 API 使用，也能被 Worker 使用，
 * 而两者对配置与数据库的依赖方式完全不同。
 */
export * from './keys.js';
```

- [ ] **Step 8: 安装依赖**

```bash
cd /home/yesheng/projects/SVH
pnpm install --filter @svh/realtime
```

预期：`ioredis` 从 store 中链接（它已作为 bullmq 的传递依赖存在），无需联网下载。

- [ ] **Step 9: 运行测试确认通过**

```bash
pnpm --filter @svh/realtime test
```

预期：5 个用例全部通过。

- [ ] **Step 10: 提交**

```bash
git add packages/realtime pnpm-lock.yaml
git commit -m "feat(realtime): 新增实时事件总线包骨架与 Redis Key 约定"
```

---

## Task 2: 事件类型与防御式解析

**Files:**
- Create: `packages/realtime/src/ports.ts`
- Create: `packages/realtime/src/parse.ts`
- Modify: `packages/realtime/src/index.ts`
- Test: `packages/realtime/test/parse.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Key 约定
- Produces:
  - `RedisConnectionOptions`、`RealtimeLogger`、`PublishInput<T>`、`StreamedEvent`
  - `parseStreamEntry(entry: unknown, sessionId: string): StreamedEvent | null`
  - `parseXreadReply(raw: unknown): RawStreamEntry[]`
  - `parseRangeReply(raw: unknown): RawStreamEntry[]`
  - `type RawStreamEntry = [id: string, fields: string[]]`

- [ ] **Step 1: 编写失败的测试**

`packages/realtime/test/parse.test.ts`：

```ts
/**
 * 事件解析边界测试
 *
 * 解析必须**防御式**：Redis 的返回结构在类型层面是宽松的，而事件推送
 * 属于增强能力 —— 一条结构异常的事件应当被丢弃，而不是抛异常打断整个推送。
 */
import { describe, expect, it } from 'vitest';

import { parseRangeReply, parseStreamEntry, parseXreadReply } from '../src/index.js';

/** 构造一条合法的原始流记录 */
function entry(id: string, overrides: Record<string, string> = {}): [string, string[]] {
  const fields = {
    type: 'task.progress',
    at: '2026-09-12T00:00:00.000Z',
    sessionId: 'sess_a',
    seq: '7',
    data: '{"progress":42}',
    ...overrides,
  };
  return [id, Object.entries(fields).flat()];
}

describe('parseStreamEntry', () => {
  it('解析合法的流记录', () => {
    const parsed = parseStreamEntry(entry('1700000000000-0'), 'sess_a');
    expect(parsed).not.toBeNull();
    expect(parsed?.streamId).toBe('1700000000000-0');
    expect(parsed?.seq).toBe(7);
    expect(parsed?.type).toBe('task.progress');
    expect(parsed?.data).toEqual({ progress: 42 });
  });

  it('以订阅的会话为准，忽略流内伪造的 sessionId', () => {
    // 这是会话隔离的关键：即便流里被写入了别的会话 id，也不能照单全收
    const parsed = parseStreamEntry(entry('1-0', { sessionId: 'sess_b' }), 'sess_a');
    expect(parsed?.sessionId).toBe('sess_a');
  });

  it('未知事件类型返回 null', () => {
    expect(parseStreamEntry(entry('1-0', { type: 'not.a.real.event' }), 'sess_a')).toBeNull();
  });

  it('data 不是合法 JSON 时退化为 null 而不抛异常', () => {
    const parsed = parseStreamEntry(entry('1-0', { data: '{不是 json' }), 'sess_a');
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toBeNull();
  });

  it('seq 缺失或非法时退化为 0', () => {
    expect(parseStreamEntry(entry('1-0', { seq: 'abc' }), 'sess_a')?.seq).toBe(0);
  });

  it('字段个数为奇数时不越界', () => {
    const broken: unknown = ['1-0', ['type', 'task.progress', 'seq']];
    expect(() => parseStreamEntry(broken, 'sess_a')).not.toThrow();
    expect(parseStreamEntry(broken, 'sess_a')?.seq).toBe(0);
  });

  it('结构完全异常时返回 null', () => {
    expect(parseStreamEntry(null, 'sess_a')).toBeNull();
    expect(parseStreamEntry('nope', 'sess_a')).toBeNull();
    expect(parseStreamEntry(['1-0'], 'sess_a')).toBeNull();
    expect(parseStreamEntry(['1-0', 'not-array'], 'sess_a')).toBeNull();
  });
});

describe('parseXreadReply', () => {
  it('展平 XREAD 的嵌套返回结构', () => {
    const reply: unknown = [
      ['svh:events:session:sess_a', [entry('1-0'), entry('2-0')]],
    ];
    expect(parseXreadReply(reply)).toHaveLength(2);
  });

  it('对 null 与结构异常返回空数组', () => {
    expect(parseXreadReply(null)).toEqual([]);
    expect(parseXreadReply('nope')).toEqual([]);
    expect(parseXreadReply([['key']])).toEqual([]);
    expect(parseXreadReply([['key', 'not-array']])).toEqual([]);
  });

  it('跳过结构异常的单条记录但保留其余', () => {
    const reply: unknown = [['key', [entry('1-0'), ['2-0'], entry('3-0')]]];
    expect(parseXreadReply(reply)).toHaveLength(2);
  });
});

describe('parseRangeReply', () => {
  it('解析 XRANGE 的返回结构', () => {
    expect(parseRangeReply([entry('1-0')])).toHaveLength(1);
  });

  it('对异常输入返回空数组', () => {
    expect(parseRangeReply(null)).toEqual([]);
    expect(parseRangeReply({})).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/realtime test parse
```

预期：失败，`parseStreamEntry is not a function`。

- [ ] **Step 3: 实现端口类型**

`packages/realtime/src/ports.ts`：

```ts
/**
 * 实时事件总线的端口定义
 *
 * 本包只依赖**接口**：连接参数与日志器都由调用方注入。
 * 这样 API 与 Worker 可以各自决定如何取得配置与如何记录日志。
 */
import type { SseEventType } from '@svh/domain';

/**
 * Redis 连接参数。
 *
 * 刻意与 `@svh/queue` 的 `parseRedisConnection` 返回结构保持兼容，
 * 因此调用方可以直接把它传进来，无需转换。
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
}

/** 结构化日志接口（与 @svh/skills 的约定一致） */
export interface RealtimeLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 空日志器，用于测试与未注入日志器的场景 */
export const NOOP_REALTIME_LOGGER: RealtimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 待发布事件。seq 与 at 由发布器补齐，调用方不关心。 */
export interface PublishInput<T = unknown> {
  sessionId: string;
  type: SseEventType;
  data: T;
}

/** 发布结果 */
export interface PublishResult {
  /** Redis Stream ID，作为 SSE 的 id: 字段供 Last-Event-ID 断点续传 */
  streamId: string;
  /** 会话内单调递增序号，对应契约的 SseEnvelope.seq */
  seq: number;
  /** 产生时间（ISO 8601） */
  at: string;
}

/** 从流中读出的事件 */
export interface StreamedEvent {
  streamId: string;
  seq: number;
  type: SseEventType;
  at: string;
  /** 归属会话。以**订阅方声明的会话**为准，不信任流内字段。 */
  sessionId: string;
  data: unknown;
}
```

- [ ] **Step 4: 实现防御式解析**

`packages/realtime/src/parse.ts`：

```ts
/**
 * Redis Stream 返回结构的防御式解析
 *
 * Redis 客户端的返回类型在结构上是宽松的。事件推送是增强能力：
 * 一条结构异常的事件应当被**丢弃**，而不是抛异常打断整个推送循环，
 * 更不能因为一条坏数据让用户的任务列表卡住。
 */
import { SSE_EVENT_TYPES, type SseEventType } from '@svh/domain';

import type { StreamedEvent } from './ports.js';

/** 一条原始流记录：[id, [field, value, field, value, ...]] */
export type RawStreamEntry = [id: string, fields: string[]];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(SSE_EVENT_TYPES);

/** 是否为合法的事件类型（用类型守卫，避免 `as` 断言） */
function isSseEventType(value: string): value is SseEventType {
  return EVENT_TYPE_SET.has(value);
}

/** JSON 解析失败时返回 null，而不是抛异常 */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 把「字段数组」折成 Map；长度为奇数时忽略最后一个孤立字段 */
function toFieldMap(fields: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (typeof key === 'string' && typeof value === 'string') {
      map.set(key, value);
    }
  }
  return map;
}

/**
 * 解析一条原始流记录。
 *
 * @param entry 原始记录（结构不可信）
 * @param sessionId 订阅方声明的会话 id —— 作为事件的归属会话，
 *   而不是读取流内字段。这样即便流里被写入了别的会话 id，也不会被当真。
 */
export function parseStreamEntry(entry: unknown, sessionId: string): StreamedEvent | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;

  const rawId: unknown = entry[0];
  const rawFields: unknown = entry[1];
  if (typeof rawId !== 'string' || !Array.isArray(rawFields)) return null;

  const fields = toFieldMap(rawFields);

  const type = fields.get('type');
  if (type === undefined || !isSseEventType(type)) return null;

  const parsedSeq = Number.parseInt(fields.get('seq') ?? '', 10);
  const seq = Number.isFinite(parsedSeq) && parsedSeq >= 0 ? parsedSeq : 0;

  const rawData = fields.get('data');

  return {
    streamId: rawId,
    seq,
    type,
    at: fields.get('at') ?? new Date(0).toISOString(),
    sessionId,
    data: rawData === undefined ? null : safeParseJson(rawData),
  };
}

/** 从一条 XREAD / XRANGE 记录中提取 [id, fields]，结构异常返回 null */
function toRawEntry(value: unknown): RawStreamEntry | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const id: unknown = value[0];
  const fields: unknown = value[1];
  if (typeof id !== 'string' || !Array.isArray(fields)) return null;

  const stringFields: string[] = [];
  for (const field of fields) {
    if (typeof field !== 'string') return null;
    stringFields.push(field);
  }
  return [id, stringFields];
}

/**
 * 解析 XREAD 的返回结构：`[[key, [entry, ...]], ...]`，展平为记录数组。
 * 单条记录结构异常时跳过它，保留其余记录。
 */
export function parseXreadReply(raw: unknown): RawStreamEntry[] {
  if (!Array.isArray(raw)) return [];

  const out: RawStreamEntry[] = [];
  for (const stream of raw) {
    if (!Array.isArray(stream) || stream.length < 2) continue;
    const entries: unknown = stream[1];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const parsed = toRawEntry(entry);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}

/** 解析 XRANGE / XREVRANGE 的返回结构：`[entry, ...]` */
export function parseRangeReply(raw: unknown): RawStreamEntry[] {
  if (!Array.isArray(raw)) return [];

  const out: RawStreamEntry[] = [];
  for (const entry of raw) {
    const parsed = toRawEntry(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
```

- [ ] **Step 5: 补齐导出**

`packages/realtime/src/index.ts`：

```ts
export * from './keys.js';
export * from './ports.js';
export * from './parse.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm --filter @svh/realtime test parse
```

预期：12 个用例全部通过。

- [ ] **Step 7: 类型检查和 lint**

```bash
pnpm --filter @svh/realtime typecheck
pnpm --filter @svh/realtime lint
```

预期：均无错误。

- [ ] **Step 8: 提交**

```bash
git add packages/realtime
git commit -m "feat(realtime): 新增事件端口定义与 Redis 返回结构的防御式解析"
```

---

## Task 3: 事件发布器

**Files:**
- Create: `packages/realtime/src/publisher.ts`
- Modify: `packages/realtime/src/index.ts`
- Test: `packages/realtime/test/publisher.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Key 与常量、Task 2 的 `PublishInput` / `PublishResult` / `RedisConnectionOptions` / `RealtimeLogger`
- Produces:
  - `interface EventPublisher { publish<T>(input: PublishInput<T>): Promise<PublishResult | null>; close(): Promise<void> }`
  - `createEventPublisher(options: { connection: RedisConnectionOptions; logger?: RealtimeLogger }): EventPublisher`

- [ ] **Step 1: 编写失败的测试**

`packages/realtime/test/publisher.test.ts`：

```ts
/**
 * 事件发布器测试
 *
 * 分两组，跳过规则不同：
 * - **需要 Redis 的 5 条**：`describe.skipIf(!canRun)`，未配置 REDIS_URL 时跳过，
 *   这样在没有 Redis 的机器上依然能跑通其余测试 —— 与 @svh/queue 的约定一致；
 * - **失败路径 1 条**：指向必然连不上的端口，不需要外部服务，因此**无条件运行**。
 *   把它一并 gate 掉会让「发布失败返回 null 且不抛异常」这条核心约定
 *   在没有 Redis 的机器上被静默跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '@svh/config';

import { createEventPublisher, eventStreamKey, type EventPublisher } from '../src/index.js';

/*
 * .env 必须在**模块作用域、且在读取 process.env 之前**加载。
 *
 * 两个原因缺一不可：
 * 1. `const canRun` 与 `describe.skipIf` 都在 vitest 的**收集阶段**求值，
 *    而 beforeAll 要等收集之后才执行 —— 放进 beforeAll 会让整组用例静默跳过，
 *    全绿但零验证；
 * 2. 加载必须发生在 `const url = redisUrl()` **之前**，否则 url 先被定成空串，
 *    后面再加载 .env 也来不及。
 *
 * 同 monorepo 的 packages/queue/test/queue.test.ts 曾因这两点同时踩空，
 * 三条 Redis 往返用例空跑很久才被发现（见提交 b838263）。
 */
loadEnvFile(process.cwd());

/** 从环境变量里取 Redis 连接信息 */
function redisUrl(): string {
  return process.env.REDIS_URL ?? '';
}

const url = redisUrl();
const canRun = url.length > 0;

let publisher: EventPublisher;
/** 每个用例用独立会话 id，避免用例之间互相干扰 */
let counter = 0;
function nextSessionId(): string {
  counter += 1;
  return `sess_test_pub_${Date.now()}_${counter}`;
}

/** 直接读流内容做断言（不复用订阅器，避免用被测对象验证被测对象） */
async function readStream(sessionId: string): Promise<Array<Record<string, string>>> {
  const { Redis } = await import('ioredis');
  const { parseRedisConnection } = await import('@svh/queue');
  const client = new Redis(parseRedisConnection(url));
  try {
    const raw: unknown = await client.xrange(eventStreamKey(sessionId), '-', '+');
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
      const fields = (entry as [string, string[]])[1];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (typeof key === 'string' && typeof value === 'string') out[key] = value;
      }
      return out;
    });
  } finally {
    client.disconnect();
  }
}

afterAll(async () => {
  if (publisher !== undefined) await publisher.close();
});

describe.skipIf(!canRun)('事件发布器', () => {
  beforeAll(async () => {
    const { parseRedisConnection } = await import('@svh/queue');
    publisher = createEventPublisher({ connection: parseRedisConnection(url) });
  });

  it('发布后事件进入对应会话的流', async () => {
    const sessionId = nextSessionId();
    const result = await publisher.publish({
      sessionId,
      type: 'task.progress',
      data: { progress: 42, message: '正在生成第 3 个镜头' },
    });

    expect(result).not.toBeNull();
    expect(result?.streamId).toMatch(/^\d+-\d+$/);

    const entries = await readStream(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('task.progress');
    expect(entries[0]?.sessionId).toBe(sessionId);
    expect(JSON.parse(entries[0]?.data ?? 'null')).toEqual({
      progress: 42,
      message: '正在生成第 3 个镜头',
    });
  });

  it('seq 在同一会话内单调递增', async () => {
    const sessionId = nextSessionId();
    const first = await publisher.publish({ sessionId, type: 'agent.message', data: {} });
    const second = await publisher.publish({ sessionId, type: 'agent.message', data: {} });
    const third = await publisher.publish({ sessionId, type: 'agent.message', data: {} });

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(third?.seq).toBe(3);
  });

  it('不同会话的序号互不影响', async () => {
    const a = nextSessionId();
    const b = nextSessionId();
    await publisher.publish({ sessionId: a, type: 'agent.message', data: {} });
    const firstOfB = await publisher.publish({ sessionId: b, type: 'agent.message', data: {} });
    expect(firstOfB?.seq).toBe(1);
  });

  it('不同会话的事件写入不同的流', async () => {
    const a = nextSessionId();
    const b = nextSessionId();
    await publisher.publish({ sessionId: a, type: 'agent.message', data: { to: 'a' } });
    await publisher.publish({ sessionId: b, type: 'agent.message', data: { to: 'b' } });

    const entriesA = await readStream(a);
    expect(entriesA).toHaveLength(1);
    expect(JSON.parse(entriesA[0]?.data ?? 'null')).toEqual({ to: 'a' });
  });

  it('为事件流设置过期时间，避免长期堆积', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'agent.message', data: {} });

    const { Redis } = await import('ioredis');
    const { parseRedisConnection } = await import('@svh/queue');
    const client = new Redis(parseRedisConnection(url));
    try {
      const ttl = await client.ttl(eventStreamKey(sessionId));
      expect(ttl).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });
});

/*
 * 失败路径单独成组，**刻意不加 skipIf**。
 *
 * 它指向一个必然连不上的端口，因此并不需要可用的 Redis —— 把它和被 gate 的
 * 分组放在一起，会让「发布失败返回 null 且不抛异常」这条全任务最核心的约定
 * 在没有 Redis 的机器上被静默跳过。而这条约定在仓库里没有别的用例覆盖。
 *
 * 全局约束的原话是「**需要外部服务**的用例在服务不可用时跳过」，
 * 这一条不需要外部服务，所以它必须始终运行。
 */
describe('事件发布器的失败路径', () => {
  it('Redis 不可用时返回 null 而不抛异常（推送不应拖垮业务）', async () => {
    // 指向一个必然连不上的端口
    const broken = createEventPublisher({
      connection: { host: '127.0.0.1', port: 1 },
    });
    const result = await broken.publish({
      sessionId: nextSessionId(),
      type: 'agent.message',
      data: {},
    });
    expect(result).toBeNull();
    await broken.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/realtime test publisher
```

预期：失败，`createEventPublisher is not a function`。

- [ ] **Step 3: 实现发布器**

`packages/realtime/src/publisher.ts`：

```ts
/**
 * 事件发布器
 *
 * ── 一条硬规则 ──
 * 发布失败**不得**向上抛异常。实时推送是增强能力，不是业务前置条件：
 * 用户的任务该成功还是要成功，不能因为 Redis 抖动就整体失败。
 * 因此这里捕获所有异常并只记日志。
 */
import { Redis } from 'ioredis';

import { eventSeqKey, eventStreamKey, STREAM_MAXLEN, STREAM_TTL_SECONDS } from './keys.js';
import {
  NOOP_REALTIME_LOGGER,
  type PublishInput,
  type PublishResult,
  type RealtimeLogger,
  type RedisConnectionOptions,
} from './ports.js';

/** 事件发布器 */
export interface EventPublisher {
  /** 发布一条事件。失败时返回 null（已记录日志），调用方无需处理异常。 */
  publish<T>(input: PublishInput<T>): Promise<PublishResult | null>;
  /** 释放连接 */
  close(): Promise<void>;
}

/** JSON 序列化；循环引用等异常情况退化为 'null' */
function serializeData(data: unknown): string {
  try {
    const text = JSON.stringify(data);
    return typeof text === 'string' ? text : 'null';
  } catch {
    return 'null';
  }
}

export function createEventPublisher(options: {
  connection: RedisConnectionOptions;
  logger?: RealtimeLogger;
}): EventPublisher {
  const logger = options.logger ?? NOOP_REALTIME_LOGGER;
  // maxRetriesPerRequest 收紧到 2：发布不该长时间挂着重试
  const redis = new Redis({ ...options.connection, maxRetriesPerRequest: 2 });

  // 必须挂 error 监听，否则连接异常会成为未处理的 error 事件导致进程退出
  redis.on('error', (err: Error) => {
    logger.warn('事件总线连接异常', { error: err.message });
  });

  return {
    async publish<T>(input: PublishInput<T>): Promise<PublishResult | null> {
      try {
        // seq 先自增再写入：即便随后 XADD 失败，也只是序号出现空洞，
        // 「会话内单调递增」这一契约仍然成立（空洞不影响单调性）。
        const seq = await redis.incr(eventSeqKey(input.sessionId));
        const at = new Date().toISOString();

        const streamId = await redis.xadd(
          eventStreamKey(input.sessionId),
          'MAXLEN',
          '~',
          String(STREAM_MAXLEN),
          '*',
          'type',
          input.type,
          'at',
          at,
          'sessionId',
          input.sessionId,
          'seq',
          String(seq),
          'data',
          serializeData(input.data),
        );

        if (streamId === null) return null;

        await redis.expire(eventStreamKey(input.sessionId), STREAM_TTL_SECONDS);

        return { streamId, seq, at };
      } catch (err) {
        logger.warn('事件发布失败（已忽略，不影响业务主流程）', {
          sessionId: input.sessionId,
          type: input.type,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    async close(): Promise<void> {
      try {
        await redis.quit();
      } catch {
        // quit 失败通常意味着连接已断，强制断开即可
        redis.disconnect();
      }
    },
  };
}
```

- [ ] **Step 4: 补齐导出**

`packages/realtime/src/index.ts` 追加一行：

```ts
export * from './publisher.js';
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/realtime test publisher
```

预期：6 个用例全部通过（Redis 可用时）。

- [ ] **Step 6: 提交**

```bash
git add packages/realtime
git commit -m "feat(realtime): 新增基于 Redis Stream 的事件发布器"
```

---

## Task 4: 事件订阅器（补发 + 实时 + 取消清理）

**Files:**
- Create: `packages/realtime/src/subscriber.ts`
- Modify: `packages/realtime/src/index.ts`
- Test: `packages/realtime/test/subscriber.test.ts`

**Interfaces:**
- Consumes: Task 1 ~ 3 的全部产出
- Produces:
  - `type RealtimeMessage = { kind: 'event'; event: StreamedEvent } | { kind: 'idle' }`
  - `interface SubscribeOptions { sessionId: string; afterId: string; blockMs?: number; signal: AbortSignal }`
  - `interface EventSubscriber { subscribe(options: SubscribeOptions): AsyncGenerator<RealtimeMessage> }`
  - `createEventStream(options: { connection: RedisConnectionOptions; logger?: RealtimeLogger }): EventSubscriber`

**关键设计说明（实现者必读）：**

1. **每次订阅使用独立 Redis 连接。** `XREAD BLOCK` 会独占连接，共用连接会阻塞该连接上所有其它命令。
2. **取消时直接断开该连接**，而不是等待阻塞超时。否则用户关掉页面后，服务端还要空转最多 15 秒。
3. **补发区间用「包含起点再过滤」而不是排他语法 `(id`**，后者需要 Redis 6.2+，前者在所有版本上都正确。
4. `afterId` 是必填的：SSE 路由在建立连接时必定已持有基准 id（`session.ready` 的 id，或客户端的 `Last-Event-ID`）。这样就不存在「流为空时 `XREAD` 立即返回导致忙循环」的问题。

- [ ] **Step 1: 编写失败的测试**

`packages/realtime/test/subscriber.test.ts`：

```ts
/**
 * 事件订阅器测试
 *
 * 重点覆盖三件事：
 * 1. 补发：afterId 之后的历史事件要能取回
 * 2. 实时：订阅建立**之后**发布的事件要能收到（这是审计 P0 缺陷 ⑫ 的正面证明）
 * 3. 取消：能立即结束，不必等阻塞超时
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '@svh/config';

import {
  createEventPublisher,
  createEventStream,
  type EventPublisher,
  type EventSubscriber,
  type StreamedEvent,
} from '../src/index.js';

// 同 Task 3：必须在模块作用域、且在读 process.env **之前**加载，
// 否则 `const canRun` 在收集阶段读到空串，整组用例静默跳过。
loadEnvFile(process.cwd());

const url = process.env.REDIS_URL ?? '';
const canRun = url.length > 0;
let publisher: EventPublisher;
let stream: EventSubscriber;

let counter = 0;
function nextSessionId(): string {
  counter += 1;
  return `sess_test_sub_${Date.now()}_${counter}`;
}

/** 在后台消费订阅，把事件推进 sink，直到超时或取消 */
function consume(
  sessionId: string,
  afterId: string,
  signal: AbortSignal,
  sink: StreamedEvent[],
): Promise<void> {
  return (async () => {
    for await (const message of stream.subscribe({ sessionId, afterId, blockMs: 300, signal })) {
      if (message.kind === 'event') sink.push(message.event);
    }
  })();
}

/** 等待条件成立，最多等 timeoutMs */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterAll(async () => {
  if (publisher !== undefined) await publisher.close();
});

describe.skipIf(!canRun)('事件订阅器', () => {
  beforeAll(async () => {
    const { parseRedisConnection } = await import('@svh/queue');
    const connection = parseRedisConnection(url);
    publisher = createEventPublisher({ connection });
    stream = createEventStream({ connection });
  });

  it('补发 afterId 之后的历史事件', async () => {
    const sessionId = nextSessionId();
    const first = await publisher.publish({ sessionId, type: 'agent.message', data: { n: 1 } });
    await publisher.publish({ sessionId, type: 'agent.message', data: { n: 2 } });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    const task = consume(sessionId, first?.streamId ?? '0', controller.signal, sink);

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    // afterId 自身不算补发内容，因此只应收到第 2 条
    expect(sink.map((e) => e.data)).toEqual([{ n: 2 }]);
  });

  it('订阅建立之后发布的事件能实时收到', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    const task = consume(sessionId, ready?.streamId ?? '0', controller.signal, sink);

    // 关键：先确认订阅已建立（进入阻塞），再发布。这样才真正验证「实时」。
    await new Promise((resolve) => setTimeout(resolve, 200));
    await publisher.publish({ sessionId, type: 'task.progress', data: { progress: 80 } });

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    expect(sink).toHaveLength(1);
    expect(sink[0]?.type).toBe('task.progress');
    expect(sink[0]?.data).toEqual({ progress: 80 });
  });

  it('afterId 不存在于流中（已被裁剪）时补发全部现存事件', async () => {
    const sessionId = nextSessionId();
    await publisher.publish({ sessionId, type: 'agent.message', data: { n: 1 } });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    // 一个早于任何真实记录的 id
    const task = consume(sessionId, '1-0', controller.signal, sink);

    await waitFor(() => sink.length >= 1);
    controller.abort();
    await task;

    expect(sink).toHaveLength(1);
  });

  it('无事件时产出 idle，供调用方发送心跳', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const kinds: string[] = [];
    const task = (async () => {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: ready?.streamId ?? '0',
        blockMs: 200,
        signal: controller.signal,
      })) {
        kinds.push(message.kind);
      }
    })();

    await waitFor(() => kinds.includes('idle'), 5000);
    controller.abort();
    await task;

    expect(kinds).toContain('idle');
  });

  it('取消信号能立即结束订阅，不必等待阻塞超时', async () => {
    const sessionId = nextSessionId();
    const ready = await publisher.publish({ sessionId, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sink: StreamedEvent[] = [];
    // 阻塞时长故意设得很长（10 秒）
    const task = (async () => {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: ready?.streamId ?? '0',
        blockMs: 10_000,
        signal: controller.signal,
      })) {
        if (message.kind === 'event') sink.push(message.event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    controller.abort();
    await task;
    const elapsed = Date.now() - started;

    // 若实现依赖阻塞超时，这里会等到 10 秒
    expect(elapsed).toBeLessThan(2000);
  });

  it('不同会话的订阅互不干扰', async () => {
    const sessionA = nextSessionId();
    const sessionB = nextSessionId();
    const readyA = await publisher.publish({ sessionId: sessionA, type: 'session.ready', data: {} });
    const readyB = await publisher.publish({ sessionId: sessionB, type: 'session.ready', data: {} });

    const controller = new AbortController();
    const sinkB: StreamedEvent[] = [];
    const taskB = consume(sessionB, readyB?.streamId ?? '0', controller.signal, sinkB);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // 只往 A 发，B 不应收到
    await publisher.publish({ sessionId: sessionA, type: 'agent.message', data: { to: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    controller.abort();
    await taskB;

    expect(sinkB).toHaveLength(0);
    expect(readyA).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/realtime test subscriber
```

预期：失败，`createEventStream is not a function`。

- [ ] **Step 3: 实现订阅器**

`packages/realtime/src/subscriber.ts`：

```ts
/**
 * 事件订阅器
 *
 * ── 这个文件解决的是一个具体的严重缺陷 ──
 * 参考项目（见 docs/ARCHITECTURE_AUDIT_REFERENCE.md 审计结论 ⑫）的 SSE
 * 在断线重连后永久静默：根因是「先 replay、再 subscribe」之间存在空窗，
 * 空窗期产生的事件既不在 replay 结果里，也没被订阅捕获。
 *
 * 这里的做法是把「补发」与「实时」放在**同一个游标**上：
 * 先 XRANGE 补发 afterId 之后的记录，拿到最后一条的 id 作为游标，
 * 紧接着用该游标 XREAD BLOCK。因为 XREAD 的语义是「返回 id 严格大于游标的
 * 记录」，两次调用之间不存在任何缝隙。
 *
 * ── 连接管理 ──
 * XREAD BLOCK 会独占连接，因此每次订阅使用独立 Redis 连接；
 * 取消时直接断开该连接，可立即解除阻塞，无需等待超时。
 */
import { Redis } from 'ioredis';

import { DEFAULT_BLOCK_MS, eventStreamKey, READ_COUNT } from './keys.js';
import { parseRangeReply, parseStreamEntry, parseXreadReply } from './parse.js';
import {
  NOOP_REALTIME_LOGGER,
  type RealtimeLogger,
  type RedisConnectionOptions,
  type StreamedEvent,
} from './ports.js';

/** 订阅产出：一条事件，或「阻塞超时」——调用方据此发送心跳 */
export type RealtimeMessage = { kind: 'event'; event: StreamedEvent } | { kind: 'idle' };

/** 订阅参数 */
export interface SubscribeOptions {
  sessionId: string;
  /**
   * 从该 Stream ID **之后**开始补发，随后自动转入实时推送。
   *
   * 必填：SSE 路由在建立连接时必定已持有基准 id
   * （新建连接的 `session.ready` id，或重连时客户端的 Last-Event-ID）。
   */
  afterId: string;
  /** 阻塞时长，超时产出 idle；测试可调小 */
  blockMs?: number;
  /** 取消信号。触发后立即结束订阅 */
  signal: AbortSignal;
}

/** 事件订阅器 */
export interface EventSubscriber {
  /**
   * 订阅会话事件。先补发 `afterId` 之后的记录，再转入实时推送。
   *
   * 每个订阅自持一条 Redis 连接，并在结束时释放，
   * 因此不需要额外的 close()。
   */
  subscribe(options: SubscribeOptions): AsyncGenerator<RealtimeMessage>;
}

export function createEventStream(options: {
  connection: RedisConnectionOptions;
  logger?: RealtimeLogger;
}): EventSubscriber {
  const logger = options.logger ?? NOOP_REALTIME_LOGGER;

  return {
    async *subscribe(input: SubscribeOptions): AsyncGenerator<RealtimeMessage> {
      const key = eventStreamKey(input.sessionId);
      const blockMs = input.blockMs ?? DEFAULT_BLOCK_MS;
      const { signal } = input;

      // 阻塞式命令独占连接，因此这里新建一条专用连接
      const redis = new Redis({ ...options.connection, maxRetriesPerRequest: null });
      redis.on('error', (err: Error) => {
        // 取消导致的断连是预期行为，不记为异常
        if (!signal.aborted) logger.warn('事件订阅连接异常', { error: err.message });
      });

      // 取消时直接断开连接：这会让挂起的 XREAD 立刻返回，无需等待阻塞超时
      const onAbort = (): void => {
        redis.disconnect();
      };
      signal.addEventListener('abort', onAbort);

      try {
        // ── 1. 补发缺失区间 ──
        // 用「包含起点再过滤」而不是排他语法 `(id`：后者需要 Redis 6.2+，
        // 前者在所有版本上都正确，代价只是多取一条记录。
        const rawBacklog = parseRangeReply(await redis.xrange(key, input.afterId, '+'));
        const backlog = rawBacklog.filter((entry) => entry[0] !== input.afterId);

        for (const entry of backlog) {
          if (signal.aborted) return;
          const event = parseStreamEntry(entry, input.sessionId);
          if (event !== null) yield { kind: 'event', event };
        }

        // ── 2. 实时推送 ──
        // 游标必须接续补发的最后一条，否则补发区间与实时区间之间会出现缝隙
        const lastBacklog = backlog.at(-1);
        let cursor = lastBacklog !== undefined ? lastBacklog[0] : input.afterId;

        while (!signal.aborted) {
          let entries;
          try {
            entries = parseXreadReply(
              await redis.xread(
                'BLOCK',
                String(blockMs),
                'COUNT',
                String(READ_COUNT),
                'STREAMS',
                key,
                cursor,
              ),
            );
          } catch (err) {
            // 取消触发的断连是预期行为，不算错误
            if (signal.aborted) return;
            logger.warn('读取事件流失败', {
              sessionId: input.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            // 不让一次读取失败终止整个订阅：退化为心跳后继续尝试
            yield { kind: 'idle' };
            continue;
          }

          if (entries.length === 0) {
            yield { kind: 'idle' };
            continue;
          }

          for (const entry of entries) {
            cursor = entry[0];
            const event = parseStreamEntry(entry, input.sessionId);
            if (event !== null) yield { kind: 'event', event };
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        redis.disconnect();
      }
    },
  };
}
```

- [ ] **Step 4: 补齐导出**

`packages/realtime/src/index.ts` 追加一行：

```ts
export * from './subscriber.js';
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/realtime test subscriber
```

预期：6 个用例全部通过。

- [ ] **Step 6: 全量验证**

```bash
pnpm --filter @svh/realtime test
pnpm --filter @svh/realtime typecheck
pnpm --filter @svh/realtime lint
pnpm --filter @svh/realtime build
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add packages/realtime
git commit -m "feat(realtime): 新增事件订阅器，补发与实时共用游标消除重连静默"
```

---

## Task 5: 修复高风险技能的确认链路

**背景（实现者必读）：** 当前 Agent 遇到高风险技能时，`skill.execute` 直接返回
`requiresConfirmation: true` 而**不创建任何任务**。用户点「确认执行」后，
`POST /api/agent/sessions/:id/confirm` 查不到等待中的任务，返回
「没有等待确认的操作。」——操作永远不会发生，而界面显示「已确认」。

修法：让高风险技能**照常创建任务**，初始状态为 `waiting_user`，但不入队。
确认接口无需改动即可恢复它。

**Files:**
- Modify: `packages/database/src/tasks.ts`（`createTask` 入参增加 `initialStatus`）
- Modify: `packages/agent/src/ports.ts`（`AgentTaskPort.enqueue` 增加 `initialStatus`）
- Modify: `packages/agent/src/tools.ts`（高风险分支创建 `waiting_user` 任务）
- Modify: `packages/agent/src/runtime.ts`（确认载荷回填真实 `taskId`）
- Modify: `apps/api/src/core/tasks.ts`（透传 `initialStatus`，且不为其入队）
- Modify: `apps/api/src/core/agent-deps.ts`（透传 `initialStatus`）
- Test: `packages/agent/test/confirmation-chain.test.ts`

**Interfaces:**
- Consumes: 既有 `createTask`、`enqueueSkillTask`、`AgentTaskPort`
- Produces: `createTask` 新入参 `initialStatus?: 'pending' | 'waiting_user'`；`AgentTaskPort.enqueue` 新入参同名

- [ ] **Step 1: 编写失败的测试**

`packages/agent/test/confirmation-chain.test.ts`：

```ts
/**
 * 确认链路测试
 *
 * 守护的是一个具体缺陷：高风险技能必须**创建真实的待确认任务**，
 * 否则用户点「确认执行」时后端无事可做，而界面显示已确认 ——
 * 这正是技术文档第 66、78 条禁止的「看似成功的失败」。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentTaskPort } from '../src/ports.js';
import { buildAgentTools } from '../src/tools.js';
import { createTestDeps } from './helpers.js';

/** 高成本技能目录项 */
const HIGH_RISK_SKILL = {
  id: 'video.generate',
  name: '视频生成',
  risk: 'high' as const,
  queue: 'ai_video' as const,
  implemented: true,
};

describe('高风险技能的确认链路', () => {
  it('需要确认时会创建 waiting_user 任务，而不是凭空返回', async () => {
    const enqueue = vi.fn<AgentTaskPort['enqueue']>().mockResolvedValue({
      taskId: 'task_waiting_1',
      status: 'waiting_user',
      deduplicated: false,
    });

    const deps = createTestDeps({
      skills: {
        listImplemented: () => [HIGH_RISK_SKILL],
      },
      tasks: { enqueue },
    });

    const tools = buildAgentTools({ deps });
    const tool = tools.find((t) => t.name === 'skill.execute');
    expect(tool).toBeDefined();

    const result = await tool?.execute(
      { skillId: 'video.generate', input: { prompt: '一段测试视频' } },
      {
        sessionId: 'sess_1',
        projectId: 'proj_1',
        contentId: null,
        confirmationPolicy: 'reject',
        signal: new AbortController().signal,
        recordCall: () => undefined,
      },
    );

    // 必须要求确认
    expect(result?.requiresConfirmation).toBe(true);
    // 关键：必须真的创建了任务，并且以 waiting_user 落库
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].initialStatus).toBe('waiting_user');
    // 关键：taskId 要回传给上层，确认载荷才有真实对象
    expect((result?.result as { taskId?: string } | undefined)?.taskId).toBe('task_waiting_1');
  });

  it('confirmationPolicy 为 allow 时直接入队执行', async () => {
    const enqueue = vi.fn<AgentTaskPort['enqueue']>().mockResolvedValue({
      taskId: 'task_run_1',
      status: 'pending',
      deduplicated: false,
    });

    const deps = createTestDeps({
      skills: { listImplemented: () => [HIGH_RISK_SKILL] },
      tasks: { enqueue },
    });

    const tools = buildAgentTools({ deps });
    const tool = tools.find((t) => t.name === 'skill.execute');

    const result = await tool?.execute(
      { skillId: 'video.generate', input: {} },
      {
        sessionId: 'sess_1',
        projectId: 'proj_1',
        contentId: null,
        confirmationPolicy: 'allow',
        signal: new AbortController().signal,
        recordCall: () => undefined,
      },
    );

    expect(result?.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].initialStatus).toBeUndefined();
  });
});
```

> `createTestDeps` 若测试目录中不存在，实现者需按 `packages/agent/test/` 下既有
> 测试文件的构造方式补齐一个最小工厂（可参考现有 agent 测试中构造 `AgentDeps`
> 的写法）。它需要能按需覆盖 `skills.listImplemented` 与 `tasks.enqueue`。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/agent test confirmation-chain
```

预期：失败 —— `enqueue` 未被调用（当前实现直接返回，不创建任务）。

- [ ] **Step 3: 让 `createTask` 支持初始状态**

修改 `packages/database/src/tasks.ts`。

在 `createTask` 的入参类型中，`maxAttempts` 之后加入：

```ts
  /**
   * 初始状态。
   *
   * `waiting_user` 用于「执行前需用户确认」的高风险任务：先落库、但**不入队**。
   * 这样确认动作有真实对象，用户刷新页面也不会丢失待确认的操作。
   */
  initialStatus?: 'pending' | 'waiting_user';
```

并把 `prisma.agentTask.create` 中的 `status: 'pending'` 改为：

```ts
      status: input.initialStatus ?? 'pending',
```

- [ ] **Step 4: 扩展 Agent 的任务端口**

修改 `packages/agent/src/ports.ts` 的 `AgentTaskPort.enqueue`：

```ts
export interface AgentTaskPort {
  /**
   * 创建并入队一个技能任务。
   *
   * `initialStatus` 为 `waiting_user` 时，任务会被创建但**不入队**，
   * 等待用户确认后由 `POST /api/agent/sessions/:id/confirm` 放行。
   */
  enqueue(input: {
    skillId: string;
    projectId: string;
    input: Record<string, unknown>;
    contentId?: string | null;
    sessionId?: string | null;
    idempotencyKey?: string | null;
    initialStatus?: 'pending' | 'waiting_user';
  }): Promise<{ taskId: string; status: string; deduplicated: boolean }>;
}
```

- [ ] **Step 5: 让 `enqueueSkillTask` 支持初始状态**

修改 `apps/api/src/core/tasks.ts`。

`enqueueSkillTask` 入参增加：

```ts
  /** 初始状态；`waiting_user` 表示先落库、等用户确认后再入队 */
  initialStatus?: 'pending' | 'waiting_user';
```

`createTask` 调用处增加透传：

```ts
  const created = await createTask({
    projectId: input.projectId,
    skillId: input.skillId,
    queueName,
    input: input.input,
    contentId: input.contentId ?? null,
    sessionId: input.sessionId ?? null,
    risk: catalogEntry.definition.risk,
    idempotencyKey: input.idempotencyKey ?? null,
    ...(input.initialStatus !== undefined ? { initialStatus: input.initialStatus } : {}),
  });
```

入队判断改为：

```ts
  // 幂等命中时任务可能已在执行或已完成，不必重复入队；
  // waiting_user 的任务必须等用户确认，这里**不得**入队
  if (!created.deduplicated && input.initialStatus !== 'waiting_user') {
    await getQueuePool().enqueue({
      taskId: created.taskId,
      queueName: created.queueName,
      attempt: 1,
    });
  }
```

- [ ] **Step 6: 在 `agent-deps` 中透传**

修改 `apps/api/src/core/agent-deps.ts` 的 `tasks.enqueue` 实现：

```ts
    tasks: {
      enqueue: async (input) => {
        const result = await enqueueSkillTask({
          skillId: input.skillId,
          projectId: input.projectId,
          input: input.input,
          contentId: input.contentId ?? null,
          sessionId: input.sessionId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          ...(input.initialStatus !== undefined ? { initialStatus: input.initialStatus } : {}),
        });
        return {
          taskId: result.taskId,
          status: result.status,
          deduplicated: result.deduplicated,
        };
      },
    },
```

- [ ] **Step 7: 让 `skill.execute` 创建待确认任务**

修改 `packages/agent/src/tools.ts` 中 `skill.execute` 的高风险分支：

```ts
      // 高成本技能：在保守策略下不直接执行，而是先落一条 waiting_user 任务，
      // 等用户确认后再入队。
      //
      // 为什么必须落库而不是直接返回：确认按钮需要一个真实对象。
      // 若只返回 requiresConfirmation 而不创建任务，
      // POST /api/agent/sessions/:id/confirm 会查不到任何等待中的任务，
      // 于是用户点了「确认执行」却什么都没发生 —— 这正是第 66、78 条
      // 禁止的「看似成功的失败」。
      if (skill.risk === 'high' && ctx.confirmationPolicy === 'reject') {
        const pending = await deps.tasks.enqueue({
          skillId,
          projectId: ctx.projectId,
          input,
          contentId: typeof args.contentId === 'string' ? args.contentId : ctx.contentId,
          sessionId: ctx.sessionId,
          idempotencyKey: undefined,
          initialStatus: 'waiting_user',
        });

        return {
          ok: false,
          requiresConfirmation: true,
          error: `「${skill.name}」属于高成本操作，需要你确认后才执行`,
          message: `「${skill.name}」需要你确认后才会执行`,
          result: {
            taskId: pending.taskId,
            status: pending.status,
            skillId,
            deduplicated: pending.deduplicated,
            requiresConfirmation: true,
          },
        };
      }
```

- [ ] **Step 8: 让确认载荷回填真实 `taskId`**

修改 `packages/agent/src/runtime.ts`，在工具循环里记录待确认任务的 id。

在 `pendingConfirmation` 相关逻辑处，把类型扩展为携带 `taskId`：

```ts
      let pendingConfirmation: { tool: AgentTool; record: ToolCallRecord; taskId?: string } | null =
        null;
```

在处理 `result.requiresConfirmation === true` 的分支里，从工具结果中取出 `taskId`：

```ts
        if (result.requiresConfirmation === true) {
          pendingConfirmation = {
            tool,
            record,
            ...(extractPendingTaskId(result.result) !== undefined
              ? { taskId: extractPendingTaskId(result.result) }
              : {}),
          };
        }
```

并在文件底部加入辅助函数：

```ts
/** 从工具结果中取出待确认任务 id（高风险技能会先落一条 waiting_user 任务） */
function extractPendingTaskId(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const taskId = (result as Record<string, unknown>).taskId;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}
```

最后把确认载荷改为携带真实任务：

```ts
      if (pendingConfirmation !== null) {
        const { tool, record, taskId } = pendingConfirmation;
        return {
          message:
            record.error ??
            `「${tool.description.split('。')[0] ?? tool.name}」需要你确认后才会执行。`,
          payload: {
            type: 'confirmation_request',
            summary: `即将执行：${tool.name}`,
            impacts: [['操作', tool.name]],
            ...(taskId !== undefined ? { taskId } : {}),
            planTaskIds: taskId !== undefined ? [taskId] : [],
          },
          toolCalls,
          state: 'waiting_user',
          analysis,
          contextNotes: context.notes,
          estimatedTokens: context.estimatedTokens,
          modelIds,
          iterations,
        };
      }
```

- [ ] **Step 9: 运行测试确认通过**

```bash
pnpm --filter @svh/agent test confirmation-chain
```

预期：2 个用例通过。

- [ ] **Step 10: 回归测试**

```bash
pnpm --filter @svh/domain test
pnpm --filter @svh/database test
pnpm --filter @svh/agent test
pnpm --filter @svh/api test
```

预期：全部通过（Phase 0~4 的既有测试无回归）。

- [ ] **Step 11: 提交**

```bash
git add packages/database/src/tasks.ts packages/agent/src apps/api/src/core
git commit -m "fix(agent): 高风险技能改为创建真实待确认任务，修复确认按钮失效"
```

---

## Task 6: API 侧事件发布

**Files:**
- Create: `apps/api/src/core/events.ts`
- Modify: `apps/api/src/routes/agent.ts`
- Modify: `apps/api/package.json`（增加 `@svh/realtime` 依赖）
- Modify: `apps/api/src/index.ts`（关闭时释放连接）

**Interfaces:**
- Consumes: `@svh/realtime` 的 `createEventPublisher` / `EventPublisher` / `PublishResult`；`@svh/queue` 的 `parseRedisConnection`
- Produces:
  - `getEventPublisher(): EventPublisher`
  - `closeEventPublisher(): Promise<void>`
  - `publishSessionEvent(sessionId: string | null | undefined, type: SseEventType, data: unknown): Promise<PublishResult | null>`

- [ ] **Step 1: 增加依赖**

```bash
cd /home/yesheng/projects/SVH
pnpm --filter @svh/api add '@svh/realtime@workspace:*'
```

- [ ] **Step 2: 实现 API 侧发布器单例**

`apps/api/src/core/events.ts`：

```ts
/**
 * API 侧的事件总线
 *
 * 与队列池一样采用**惰性单例**：进程内复用一个 Redis 连接，
 * 避免每个请求都新建连接。
 *
 * ── 为什么发布是「发射后不管」 ──
 * 实时推送是增强能力，不是业务前置条件。用户的任务该成功还是要成功，
 * 不能因为 Redis 抖动就整体失败。因此 publishSessionEvent 从不抛异常，
 * 失败只记日志。
 */
import { getEnv } from '@svh/config';
import type { SseEventType } from '@svh/domain';
import { parseRedisConnection } from '@svh/queue';
import { createEventPublisher, type EventPublisher, type PublishResult } from '@svh/realtime';

/** 发布器单例 */
let publisher: EventPublisher | null = null;

/** 取出（必要时创建）事件发布器 */
export function getEventPublisher(): EventPublisher {
  if (publisher === null) {
    publisher = createEventPublisher({
      connection: parseRedisConnection(getEnv().REDIS_URL),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg, meta) => console.warn(`[realtime] ${msg}`, meta ?? ''),
        error: (msg, meta) => console.error(`[realtime] ${msg}`, meta ?? ''),
      },
    });
  }
  return publisher;
}

/** 关闭事件连接（进程退出前调用） */
export async function closeEventPublisher(): Promise<void> {
  if (publisher !== null) {
    await publisher.close();
    publisher = null;
  }
}

/**
 * 发布一条会话事件。
 *
 * `sessionId` 为空时直接跳过 —— 没有会话归属的事件无法路由给任何人，
 * 这不是错误（例如直接经 POST /api/skills/:id/execute 创建的任务）。
 */
export async function publishSessionEvent(
  sessionId: string | null | undefined,
  type: SseEventType,
  data: unknown,
): Promise<PublishResult | null> {
  if (sessionId === null || sessionId === undefined || sessionId.length === 0) return null;
  return getEventPublisher().publish({ sessionId, type, data });
}
```

- [ ] **Step 3: 在 Agent 轮次中发布事件**

修改 `apps/api/src/routes/agent.ts`。

顶部导入：

```ts
import { publishSessionEvent } from '../core/events.js';
```

在 `runtime.runTurn` 调用**之前**加入（让前端立刻知道正在思考）：

```ts
    // 轮次开始：先广播状态，使用户在模型返回前就看到「正在思考」
    await publishSessionEvent(session.id, 'agent.state', { state: 'thinking' });
```

在 `runTurn` 返回之后、写入 Agent 消息之前加入：

```ts
    // 轮次结束：广播最终状态与结构化载荷
    await publishSessionEvent(session.id, 'agent.state', { state: result.state });
    await publishSessionEvent(session.id, 'agent.message', {
      message: result.message,
      state: result.state,
    });
    await publishSessionEvent(
      session.id,
      eventTypeForPayload(result.payload),
      result.payload ?? null,
    );
```

在文件底部加入载荷到事件类型的映射：

```ts
/**
 * 把 Agent 载荷映射为 SSE 事件类型。
 *
 * 映射关系写在服务端而不是让前端猜：前端的渲染器按载荷的 `type` 判别，
 * 而事件类型决定了推送语义（是否追加消息、是否刷新任务面板）。
 */
function eventTypeForPayload(payload: MessagePayload | undefined): SseEventType {
  switch (payload?.type) {
    case 'plan':
      return 'agent.plan';
    case 'confirmation_request':
      return 'agent.confirmation';
    case 'result_card':
      return 'agent.result_card';
    case 'progress':
      // 进度载荷携带 taskId，语义上属于任务进度而不是对话消息
      return 'task.progress';
    case 'error':
      return 'error';
    default:
      return 'agent.message';
  }
}
```

并把导入的类型补齐为：

```ts
import {
  agentChatRequestSchema,
  NotFoundError,
  type MessagePayload,
  type PlanPayload,
  type SseEventType,
} from '@svh/domain';
```

- [ ] **Step 4: 在确认放行时发布任务状态事件**

修改 `apps/api/src/routes/agent.ts` 的 `POST /sessions/:id/confirm`。

在 `getQueuePool().enqueue(...)` 之后加入：

```ts
      // 广播状态变化，使用户立刻看到任务从「待确认」变为「排队中」
      await publishSessionEvent(id, 'task.status', {
        taskId: task.id,
        status: 'pending',
      });
```

- [ ] **Step 5: 进程退出时释放连接**

修改 `apps/api/src/index.ts`，在既有的关闭流程中调用 `closeEventPublisher()`。

查看该文件现有的 `closeQueuePool` 调用位置，在紧邻处加入：

```ts
  await closeEventPublisher();
```

并补充导入：

```ts
import { closeEventPublisher } from './core/events.js';
```

- [ ] **Step 6: 验证**

```bash
pnpm --filter @svh/api typecheck
pnpm --filter @svh/api lint
pnpm --filter @svh/api test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): Agent 轮次与确认放行接入事件总线"
```

---

## Task 7: SSE 端点

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/core/app.ts`（注册路由）
- Modify: `apps/api/src/core/validate.ts`（若 `parseIdParam` 不能直接用于该路径，见 Step 2）
- Test: `apps/api/test/sse.test.ts`

> **文件名说明（控制方裁定）**：Task 6 已创建 `apps/api/test/events.test.ts` 用于验证
> 「事件是否真的写进 Redis Stream」（接线守卫）。本任务的 SSE 端到端测试**另建
> `sse.test.ts`**，不要改写 Task 6 那个已通过审查的文件 —— 两者职责不同：
> 前者守「发布端」，后者守「HTTP 传输端」。

**Interfaces:**
- Consumes: Task 6 的 `getEventPublisher` / `publishSessionEvent`；`@svh/realtime` 的 `createEventStream`
- Produces: `GET /api/agent/sessions/:id/events`（SSE）

**路由挂载位置：** 该端点属于 `agentRoutes` 的路径空间（`/api/agent/sessions/:id/events`），
但 SSE 的响应处理与普通 JSON 路由差异很大，因此**单独成文件**，在 `app.ts` 中以
`/api/agent` 前缀注册，与 `agentRoutes` 并列。

- [ ] **Step 1: 编写失败的测试**

`apps/api/test/sse.test.ts`：

```ts
/**
 * SSE 端点测试
 *
 * 需要 Redis。连接不可用时跳过。
 *
 * 重点验证三件事：
 * 1. 订阅之后发布的事件能被推送（实时性）
 * 2. Last-Event-ID 能补发缺失区间（断点续传）
 * 3. 跨会话隔离 —— A 会话的订阅收不到 B 会话的事件
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { prisma } from '@svh/database';
import { loadEnvFile } from '@svh/config';

import { buildApp } from '../src/core/app.js';
import { closeEventPublisher, publishSessionEvent } from '../src/core/events.js';

// 必须在**模块作用域**加载 .env，不能放进 beforeAll。
//
// apps/api 的 vitest.config.ts 已配 setupFiles，理论上收集阶段就能读到环境变量；
// 但本文件的 `const canRun = (process.env.REDIS_URL ?? '').length > 0` 同样在收集阶段
// 求值，显式在这里加载可以消除对 setupFiles 执行顺序的隐式依赖 ——
// 与 Task 3 / Task 4 的写法保持一致。loadEnvFile 不覆盖已存在的变量，重复调用无副作用。
loadEnvFile(process.cwd());

let app: FastifyInstance;
let baseUrl: string;
let projectId: string;
let sessionA: string;
let sessionB: string;

beforeAll(async () => {
  app = await buildApp({ logLevel: 'silent' });
  await app.ready();
  // 只监听一次：Fastify 重复 listen 会抛 "Already listening"
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  const project = await prisma.project.create({
    data: { name: `SSE 测试项目 ${Date.now()}` },
    select: { id: true },
  });
  projectId = project.id;

  const a = await prisma.session.create({
    data: { projectId, title: 'A', agentState: 'idle' },
    select: { id: true },
  });
  const b = await prisma.session.create({
    data: { projectId, title: 'B', agentState: 'idle' },
    select: { id: true },
  });
  sessionA = a.id;
  sessionB = b.id;
});

afterAll(async () => {
  await closeEventPublisher();
  await prisma.project.deleteMany({ where: { id: projectId } });
  await app.close();
});

/**
 * 用原始 HTTP 读取 SSE 流。
 *
 * 不用 app.inject()：它会把响应缓冲到结束，而 SSE 是永不结束的流。
 */
async function openStream(
  sessionId: string,
  lastEventId?: string,
): Promise<{ frames: string[]; close: () => void }> {
  const controller = new AbortController();
  const frames: string[] = [];

  const response = await fetch(`${baseUrl}/api/agent/sessions/${sessionId}/events`, {
    headers: lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {},
    signal: controller.signal,
  });
  expect(response.status).toBe(200);

  const reader = response.body?.getReader();
  void (async () => {
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 主动关闭导致的读取中断是预期行为
    }
  })();

  return { frames, close: () => controller.abort() };
}

/** 等待条件成立 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 把累计的帧文本拼起来判断是否包含某个事件类型 */
function textOf(frames: string[]): string {
  return frames.join('');
}

const canRun = (process.env.REDIS_URL ?? '').length > 0;

describe.skipIf(!canRun)('SSE 端点', () => {
  it('会话不存在时返回 404 并说明是会话', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agent/sessions/sess_not_exist/events',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain('会话');
  });

  it('建连后立即下发 session.ready 与重连间隔', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    const text = textOf(frames);
    expect(text).toContain('retry:');
    expect(text).toContain('event: session.ready');
    close();
  });

  it('订阅之后发布的事件被实时推送', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionA, 'task.progress', { taskId: 'task_1', progress: 66 });

    await waitFor(() => textOf(frames).includes('task.progress'));
    expect(textOf(frames)).toContain('"progress":66');
    close();
  });

  it('Last-Event-ID 能补发缺失区间', async () => {
    // 先在无人订阅时发布两条事件
    const first = await publishSessionEvent(sessionA, 'agent.message', { n: 1 });
    await publishSessionEvent(sessionA, 'agent.message', { n: 2 });
    expect(first).not.toBeNull();

    const { frames, close } = await openStream(sessionA, first?.streamId);
    await waitFor(() => textOf(frames).includes('"n":2'));

    const text = textOf(frames);
    // 起点自身不应被补发，但起点之后的一条必须补发
    expect(text).toContain('"n":2');
    expect(text).not.toContain('"n":1');
    close();
  });

  it('跨会话隔离：A 的订阅收不到 B 的事件', async () => {
    const { frames, close } = await openStream(sessionA);
    await waitFor(() => textOf(frames).includes('session.ready'));

    await publishSessionEvent(sessionB, 'agent.message', { secret: 'B 的内容' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(textOf(frames)).not.toContain('B 的内容');
    close();
  });
});
```

- [ ] **Step 2: 确认可复用的校验工具**

阅读 `apps/api/src/core/validate.ts`，确认 `parseIdParam` 的签名。它应当从
`request.params` 中取 `id` 并按 `idSchema` 校验。SSE 路由的路径参数名同样是 `id`
（`/sessions/:id/events`），因此可直接复用，无需改动该文件。

- [ ] **Step 3: 实现 SSE 端点**

`apps/api/src/routes/events.ts`：

```ts
/**
 * SSE 实时推送端点
 *
 * 对应技术文档第 72 条。协议定义见 `@svh/domain` 的 transport.ts。
 *
 * ── 为什么用 reply.hijack() ──
 * SSE 是**永不结束**的响应，与 Fastify 默认的「处理函数返回后即发送响应」
 * 模型冲突。hijack 明确表示「这个响应由我自己写」，框架不再插手。
 *
 * ── 断点续传的实现顺序（关键） ──
 * 1. 先 XADD 一条 session.ready，拿到它的 Stream ID 作为**基准游标**
 * 2. 把基准游标作为 SSE 的 id: 下发给客户端
 * 3. 若客户端带 Last-Event-ID，则从客户端游标开始订阅 —— 订阅器内部会
 *    先补发 (客户端游标, 当前] 区间，再用同一游标转入实时
 *
 * 第 3 步的「补发与实时共用同一游标」是审计结论 ⑫ 的正面修复：
 * 参考项目的 SSE 在重连后永久静默，正是因为在 replay 与 subscribe
 * 之间存在空窗。这里不存在空窗。
 */
import type { FastifyInstance } from 'fastify';

import { getEnv } from '@svh/config';
import { NotFoundError, type SseEnvelope } from '@svh/domain';
import { prisma } from '@svh/database';
import { parseRedisConnection } from '@svh/queue';
import { createEventStream, type RedisConnectionOptions } from '@svh/realtime';

import { getEventPublisher } from '../core/events.js';
import { parseIdParam } from '../core/validate.js';

/** 重连建议间隔（毫秒），下发给浏览器 */
const RETRY_MS = 3000;

/**
 * 事件订阅使用**独立**连接。
 *
 * 不能复用发布器的连接：XREAD BLOCK 会独占连接，
 * 复用它会让该连接上的所有发布命令一起被阻塞。
 */
function subscribeConnection(): RedisConnectionOptions {
  return parseRedisConnection(getEnv().REDIS_URL);
}

/**
 * 解析并校验 `Last-Event-ID` 请求头。
 *
 * 这是**外部可控输入**，不能直接透传给订阅器：非法游标会让 XRANGE 与 XREAD
 * 双双失败，客户端表现为「建连即断、反复重试」。
 * 无法识别时回退到基准游标（只订阅新事件），而不是报错 ——
 * 断点续传失败不该让实时通道整个不可用。
 */
function parseLastEventId(header: unknown, fallback: string): string {
  if (typeof header !== 'string' || header.length === 0) return fallback;
  // Redis Stream ID 的合法形态：`<ms>-<seq>`、`<ms>`、`0`、`$`
  return /^(\d+-\d+|\d+|0|\$)$/.test(header) ? header : fallback;
}

/** 把一条事件写成 SSE 帧 */
function frame(envelope: SseEnvelope, streamId?: string): string {
  const lines: string[] = [];
  // 心跳不带 id：避免把客户端的续传游标推进到一个非事件上
  if (streamId !== undefined) lines.push(`id: ${streamId}`);
  lines.push(`event: ${envelope.type}`);
  lines.push(`data: ${JSON.stringify(envelope)}`);
  return `${lines.join('\n')}\n\n`;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sessions/:id/events', async (request, reply) => {
    const sessionId = parseIdParam(request);

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (session === null) {
      throw new NotFoundError(`会话 ${sessionId} 不存在`, {
        resourceLabel: '会话',
        context: { sessionId },
      });
    }

    // 基准游标必须**先**产生：它同时解决了「流不存在时 XREAD 立即返回空」
    // 的问题（此刻流必定已存在），并作为客户端断线重连的起点。
    const readyPayload = { at: new Date().toISOString() };
    const ready = await getEventPublisher().publish({
      sessionId,
      type: 'session.ready',
      data: readyPayload,
    });

    if (ready === null) {
      // 事件通道不可用时明确报错，而不是建立一条永远不会推送的连接
      throw new Error('实时推送通道暂时不可用，请稍后重试');
    }

    // ── 接管响应 ──
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关闭 Nginx 等反向代理的缓冲，否则事件会被攒着一起发
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: ${RETRY_MS}\n\n`);
    raw.write(
      frame(
        { seq: ready.seq, type: 'session.ready', at: ready.at, sessionId, data: readyPayload },
        ready.streamId,
      ),
    );

    // 客户端重连时带上的续传游标；没有则从本次基准游标开始（只订阅新事件）。
    //
    // 必须校验格式：这个值直接来自请求头，是外部可控输入。
    // 非法游标（例如被篡改的 Last-Event-ID）会让 XRANGE 与 XREAD 双双以命令级错误失败，
    // 订阅器虽会在连续 3 次失败后结束订阅（不会死循环），但对客户端表现为
    // 「毫秒级建连又断开、浏览器反复重试」—— 在路由层挡住更干净。
    // 合法形态：`<ms>-<seq>`、`<ms>`、`0`、`$`。
    const lastEventId = parseLastEventId(request.headers['last-event-id'], ready.streamId);

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.raw.on('close', abort);
    request.raw.on('error', abort);

    // 订阅连接在 subscribe() 内部按订阅创建与释放
    const stream = createEventStream({ connection: subscribeConnection() });
    let lastSeq = ready.seq;

    try {
      for await (const message of stream.subscribe({
        sessionId,
        afterId: lastEventId,
        signal: controller.signal,
      })) {
        if (raw.writableEnded) break;

        if (message.kind === 'idle') {
          // 心跳：既让客户端知道连接还在，也顺便探测本端是否仍可写
          raw.write(
            frame(
              { seq: lastSeq, type: 'ping', at: new Date().toISOString(), sessionId, data: {} },
            ),
          );
          continue;
        }

        const { event } = message;
        lastSeq = event.seq;
        raw.write(
          frame(
            {
              seq: event.seq,
              type: event.type,
              at: event.at,
              sessionId: event.sessionId,
              data: event.data,
            },
            event.streamId,
          ),
        );
      }
    } finally {
      request.raw.off('close', abort);
      request.raw.off('error', abort);
      if (!raw.writableEnded) raw.end();
    }
  });
}
```

其中 `subscribeConnection()` 已在文件顶部给出（从 `@svh/config` 取
`REDIS_URL`，用 `@svh/queue` 的 `parseRedisConnection` 解析成连接参数）。
`@svh/api` 已依赖 `@svh/config` 与 `@svh/queue`，无需新增依赖。

- [ ] **Step 4: 注册路由**

修改 `apps/api/src/core/app.ts`：

```ts
import { eventRoutes } from '../routes/events.js';
```

并在 `agentRoutes` 注册之后加入：

```ts
  await app.register(eventRoutes, { prefix: '/api/agent' });
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/api test events
```

预期：5 个用例通过。

> 注意：测试使用 `app.listen({ port: 0 })` 启动真实端口。若 `buildApp` 之外的
> 其它测试文件也调用 `listen`，需在 `apps/api/vitest.config.ts` 中设置
> `fileParallelism: false` 以避免端口与 Redis 库争抢。

- [ ] **Step 6: 全量验证**

```bash
pnpm --filter @svh/api typecheck
pnpm --filter @svh/api lint
pnpm --filter @svh/api test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/api
git commit -m "feat(api): 新增 SSE 端点，支持断点续传与会话隔离"
```

---

## Task 8: Worker 侧事件发布

**Files:**
- Create: `apps/worker/src/events.ts`
- Modify: `apps/worker/src/runner.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/package.json`（增加 `@svh/realtime` 依赖）
- Test: `apps/worker/test/events.test.ts`

**Interfaces:**
- Consumes: `@svh/realtime` 的 `EventPublisher`
- Produces:
  - `interface EventSink { emit(input: { sessionId: string | null | undefined; type: SseEventType; data: unknown }): void }`
  - `NOOP_EVENT_SINK: EventSink`
  - `createEventSink(publisher: EventPublisher): EventSink`
  - `TaskRunner` 构造函数新增可选 `events?: EventSink`

**关键设计：`emit` 是同步的、发射后不管的。**
Worker 的执行路径不应因为 Redis 抖动而变慢或失败。因此 `emit` 返回 `void`，
内部 `void publisher.publish(...)`——`publish` 自身已吞掉所有异常，永不 reject。

- [ ] **Step 1: 增加依赖**

```bash
cd /home/yesheng/projects/SVH
pnpm --filter @svh/worker add '@svh/realtime@workspace:*'
```

- [ ] **Step 2: 编写失败的测试**

`apps/worker/test/events.test.ts`：

```ts
/**
 * Worker 事件汇聚器测试
 *
 * 只测「发射后不管」这一契约：emit 必须同步返回、不抛异常，
 * 且在没有会话归属时直接跳过。
 */
import { describe, expect, it, vi } from 'vitest';

import { createEventSink, NOOP_EVENT_SINK } from '../src/events.js';

describe('EventSink', () => {
  it('把事件转交给发布器', () => {
    const publish = vi.fn().mockResolvedValue({ streamId: '1-0', seq: 1, at: 'now' });
    const sink = createEventSink({ publish, close: vi.fn() });

    sink.emit({ sessionId: 'sess_1', type: 'task.progress', data: { progress: 10 } });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual({
      sessionId: 'sess_1',
      type: 'task.progress',
      data: { progress: 10 },
    });
  });

  it('没有会话归属时跳过，不调用发布器', () => {
    const publish = vi.fn().mockResolvedValue(null);
    const sink = createEventSink({ publish, close: vi.fn() });

    sink.emit({ sessionId: null, type: 'task.progress', data: {} });
    sink.emit({ sessionId: undefined, type: 'task.progress', data: {} });
    sink.emit({ sessionId: '', type: 'task.progress', data: {} });

    expect(publish).not.toHaveBeenCalled();
  });

  it('emit 是同步的，不会等待发布完成', () => {
    let resolved = false;
    const publish = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(null);
          }, 50);
        }),
    );
    const sink = createEventSink({ publish, close: vi.fn() });

    sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} });

    // emit 返回时发布尚未完成
    expect(resolved).toBe(false);
  });

  it('发布器抛出的同步异常不会冒泡到调用方', () => {
    const publish = vi.fn().mockImplementation(() => {
      throw new Error('同步炸了');
    });
    const sink = createEventSink({ publish, close: vi.fn() });

    expect(() => sink.emit({ sessionId: 'sess_1', type: 'task.status', data: {} })).not.toThrow();
  });

  it('空实现不产生任何副作用', () => {
    expect(() => NOOP_EVENT_SINK.emit({ sessionId: 'x', type: 'ping', data: {} })).not.toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @svh/worker test events
```

预期：失败，`createEventSink is not a function`。

- [ ] **Step 4: 实现事件汇聚器**

`apps/worker/src/events.ts`：

```ts
/**
 * Worker 侧的事件汇聚器
 *
 * ── 为什么是同步的 emit ──
 * 任务的执行路径绝不能因为 Redis 抖动而变慢或失败。因此 `emit` 同步返回，
 * 内部「发射后不管」；`publish` 自身已吞掉所有异常且永不 reject。
 *
 * ── 为什么没有会话归属就跳过 ──
 * 直接经 `POST /api/skills/:id/execute` 创建的任务没有 sessionId，
 * 没有会话归属的事件无法路由给任何人。这不是错误，只是无处可推。
 */
import type { SseEventType } from '@svh/domain';
import type { EventPublisher } from '@svh/realtime';

/** 事件汇聚端口 */
export interface EventSink {
  /** 发射一条事件。同步返回，永不抛异常。 */
  emit(input: {
    sessionId: string | null | undefined;
    type: SseEventType;
    data: unknown;
  }): void;
}

/** 空实现：未接入事件总线时使用（例如单元测试） */
export const NOOP_EVENT_SINK: EventSink = {
  emit: () => undefined,
};

/** 用真实发布器构造汇聚器 */
export function createEventSink(publisher: EventPublisher): EventSink {
  return {
    emit(input) {
      const { sessionId } = input;
      if (sessionId === null || sessionId === undefined || sessionId.length === 0) return;

      try {
        // publish 内部已捕获全部异常，这里再包一层是为了防御
        // 「publish 实现被替换成会同步抛异常的版本」这种情形。
        void publisher.publish({ sessionId, type: input.type, data: input.data });
      } catch {
        // 事件推送失败不应影响任务执行
      }
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/worker test events
```

预期：5 个用例通过。

- [ ] **Step 6: 在 TaskRunner 中发布事件**

修改 `apps/worker/src/runner.ts`：

导入：

```ts
import { NOOP_EVENT_SINK, type EventSink } from './events.js';
```

在 `TaskRunner` 的构造函数依赖中增加可选字段（与既有的 `logger` 等并列）：

```ts
  /** 事件汇聚器；未注入时不推送（测试与脚本场景） */
  events?: EventSink;
```

在类内保存：

```ts
  private readonly events: EventSink;
```

构造函数体内：

```ts
    this.events = deps.events ?? NOOP_EVENT_SINK;
```

在 `claimTask` 成功之后（`const ctx: FencingContext = {...}` 之前或之后均可，但必须在抢占成功之后）加入：

```ts
    // 抢占成功即进入执行态，立刻广播，使用户看到任务从排队变为运行中
    this.events.emit({
      sessionId: task.sessionId,
      type: 'task.status',
      data: { taskId, status: 'running', attempt: claim.attempt },
    });
```

在 `buildExecutor` 的 `onProgress` 回调中，进度写入成功后加入：

```ts
        if (written) {
          this.events.emit({
            sessionId: sessionIdOfTask,
            type: 'task.progress',
            data: { taskId, progress, message: message ?? null },
          });
        }
```

> `sessionId` 在 `onProgress` 回调里不可见（回调签名是 `(taskId, progress, message)`）。
> 实现方式：在 `buildExecutor(ctx)` 中把当前任务的 `sessionId` 作为闭包变量捕获 ——
> `buildExecutor` 需要新增一个 `sessionId: string | null` 参数，调用处传入
> `task.sessionId`。把 `private buildExecutor(ctx: FencingContext)` 改为
> `private buildExecutor(ctx: FencingContext, sessionId: string | null)`，
> 并在 `onProgress` 与 `onStep` 中复用该变量。

在 `handleSuccess` 中，`completeTask` 成功写入之后加入：

```ts
    if (written) {
      this.events.emit({
        sessionId: this.sessionIdOf(ctx.taskId),
        type: 'task.status',
        data: { taskId: ctx.taskId, status: 'success', assetCount: result.assetIds.length },
      });

      for (const assetId of result.assetIds) {
        this.events.emit({
          sessionId: this.sessionIdOf(ctx.taskId),
          type: 'asset.changed',
          data: { assetId, taskId: ctx.taskId, change: 'created' },
        });
      }
    }
```

> `handleSuccess` 同样拿不到 `sessionId`。最简做法：给 `handleSuccess` 与
> `handleFailure` 都增加 `sessionId: string | null` 参数，由 `execute()` 中的
> `task.sessionId` 传入。**不要**为此新增一次数据库查询。

在 `handleFailure` 中同理，无论最终是 `failed`、`cancelled` 还是
`waiting_user`，都广播对应的状态：

```ts
    this.events.emit({
      sessionId,
      type: 'task.status',
      data: { taskId: ctx.taskId, status: outcome.status, message: outcome.errorMessage ?? null },
    });
```

> `outcome` 的实际字段名以实现时 `failTask` 的返回类型为准 —— 先读该函数签名
> 再落笔，不要凭猜测写字段。

- [ ] **Step 7: 在 Worker 入口装配事件汇聚器**

修改 `apps/worker/src/index.ts`：

```ts
import { getEnv } from '@svh/config';
import { parseRedisConnection } from '@svh/queue';
import { createEventPublisher } from '@svh/realtime';

import { createEventSink } from './events.js';
```

在创建 runner 之前：

```ts
  // 事件发布器：Worker 产生的任务事件经此推送给 SSE 端点
  const eventPublisher = createEventPublisher({
    connection: parseRedisConnection(getEnv().REDIS_URL),
    logger: { debug: () => undefined, info: () => undefined, warn: log.warn, error: log.error },
  });
  const events = createEventSink(eventPublisher);
```

把 `events` 传入 runner 的构造参数，并在既有的优雅关闭流程中加入：

```ts
  await eventPublisher.close();
```

- [ ] **Step 8: 全量验证**

```bash
pnpm --filter @svh/worker test
pnpm --filter @svh/worker typecheck
pnpm --filter @svh/worker lint
```

预期：全部通过（既有 41 个 worker 测试无回归）。

- [ ] **Step 9: 提交**

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): 任务状态、进度与资产变更接入事件总线"
```

---

## Task 9: 端到端验证与文档更新

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

- [ ] **Step 1: 全仓验证**

```bash
cd /home/yesheng/projects/SVH
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

预期：四个流水线全部成功，测试总数不低于 394 + 新增用例。

- [ ] **Step 2: 手工端到端验证**

启动依赖：

```bash
pnpm api:dev     # 后台
pnpm worker:dev  # 后台
```

验证脚本（另开终端）：

```bash
# 1. 建项目（createProjectSchema 只接受 name / description / memory）
PROJECT_ID=$(curl -s -X POST http://127.0.0.1:3030/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"SSE 验证项目"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. 起一个 SSE 订阅（后台）。SESSION_ID 从第 3 步的响应里取，或直接查库。
curl -N "http://127.0.0.1:3030/api/agent/sessions/SESSION_ID/events" > /tmp/sse.log &

# 3. 触发一次对话
curl -s -X POST http://127.0.0.1:3030/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"message\":\"帮我做一个 30 秒护肤品广告\"}"

# 4. 检查推送
grep -c 'event:' /tmp/sse.log
```

预期：`/tmp/sse.log` 中出现 `event: session.ready`、`event: agent.state`、
`event: agent.message`、`event: agent.plan`。

**断点续传验证**：记下最后一条事件的 `id:`，断开后带
`-H "Last-Event-ID: <该 id>"` 重新连接，确认区间内缺失的事件被补发。

**确认链路验证**：让 Agent 调用一个高风险技能，确认：
1. 返回的 `confirmation_request` 载荷中 `taskId` 非空
2. 数据库 `agent_tasks` 中该任务状态为 `waiting_user`
3. 调用 `POST /api/agent/sessions/:id/confirm` 后返回的 `resumed` 包含该任务 id
4. 任务随后被 Worker 执行

- [ ] **Step 3: 更新架构文档**

在 `docs/ARCHITECTURE.md` 中：

1. 第 7 节「本阶段交付边界」的「尚未实现」表格里，删除
   「SSE 实时推送」一行
2. 第 9 节「已知限制」中把第 9 条改写为：

```markdown
9. **确认回执已闭环**：高风险技能会先落一条 `waiting_user` 任务，
   `POST /api/agent/sessions/:id/confirm` 放行后重新入队执行。
   Agent UI 层面的确认交互由 Phase 5 的前端部分交付。
```

3. 第 9 节中把第 8 条（SSE 未实现）替换为：

```markdown
8. **SSE 已接入**：`GET /api/agent/sessions/:id/events` 基于 Redis Stream
   推送会话事件，支持 `Last-Event-ID` 断点续传。补发与实时订阅共用同一游标，
   不存在「重连后永久静默」的空窗。无 `sessionId` 的任务不推送，前端回退轮询。
```

4. 新增一节「## 6.9 Phase 5A：实时通道」，说明事件总线的 Key 约定、
   事件类型来源表、以及「发布失败不影响业务」这一约定。

- [ ] **Step 4: 更新 README**

在 README 的进度表中把 Phase 5 拆成两行：

```markdown
| Phase 5A | 后端实时通道与确认链路修复 | ✅ 已完成 |
| Phase 5B | Agent UI（项目入口 / 工作台 / Provider 配置页） | ⬜ 待开始 |
```

- [ ] **Step 5: 提交**

```bash
git add docs/ARCHITECTURE.md README.md
git commit -m "docs: 更新 Phase 5A 交付边界与实时通道说明"
```

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 章节 | 对应任务 |
| --- | --- |
| §2 必须先修复的既有缺陷 | Task 5 |
| §3.1 `@svh/realtime` 隔离约束 | Task 1 ~ 4（包内不读 env、不依赖 database） |
| §4.1 存储结构（Stream + 计数器 + TTL） | Task 1、Task 3 |
| §4.2 Stream 而非 Pub/Sub | Task 4（补发与实时共用游标） |
| §4.3 发布失败不影响业务 | Task 3（publisher 吞异常）、Task 8（同步 emit） |
| §4.4 无事件时的心跳 | Task 4（idle 产出）、Task 7（ping 帧） |
| §5.1 建立流程（ready 基准游标 + replay） | Task 7 |
| §5.2 会话隔离 | Task 1（按会话分键）、Task 4（隔离测试）、Task 7（隔离测试） |
| §5.3 事件来源表 | Task 6（API 侧）、Task 8（Worker 侧） |
| §8 测试计划（realtime / agent / api 三部分） | Task 1 ~ 5、7、8 |
| §9 新增依赖（ioredis） | Task 1 Step 8 |
| §10 验收标准 3、5 | Task 9 |

**未覆盖且属于 Phase 5B（前端）的条目**：§6 前端结构、§7 视觉系统、§10 验收标准
1、2、4、6。这些不在本计划范围内，将由 `2026-09-12-phase5b-agent-ui.md` 承接。

**2. 占位符扫描**

已逐条检查：无 `TBD`、无 `TODO`、无「适当处理错误」类空话。
两处刻意保留的「实现时确认」标注（`createTestDeps` 工厂、`failTask` 返回字段名）
都给出了明确的核实指令与理由，而不是含糊其辞 —— 因为这两处的真实签名
在本计划写作时未经阅读确认，凭猜测写出代码比标注出来更危险。

**3. 类型一致性检查**

- `PublishInput` / `PublishResult` / `StreamedEvent` 在 Task 2 定义，
  Task 3（返回 `PublishResult | null`）、Task 4（消费 `StreamedEvent`）、
  Task 6（`publishSessionEvent` 返回 `PublishResult | null`）使用一致
- `RealtimeMessage` 的 `kind` 判别值 `'event' | 'idle'` 在 Task 4 定义，
  Task 7 按 `'idle'` 与 `'event'` 分支处理，一致
- `initialStatus?: 'pending' | 'waiting_user'` 在 Task 5 的
  `createTask`、`AgentTaskPort.enqueue`、`enqueueSkillTask` 三处签名一致
- `EventSink.emit` 的 `sessionId` 类型为 `string | null | undefined`，
  在 Task 8 的所有调用点与 `task.sessionId`（`string | null`）兼容
- `createEventStream` 的参数形状 `{ connection }` 在 Task 4 定义、
  Task 7 使用，一致（注意不是 `{ redisUrl }`）

**4. 已知的实现风险**

| 风险 | 缓解 |
| --- | --- |
| ioredis 的 `xread`/`xrange` 返回类型是宽松类型，直接断言会触发 lint | Task 2 用手写防御式解析，把 `unknown` 收窄，同时顺带覆盖了坏数据场景 |
| 每个 SSE 连接一条 Redis 连接，并发高时连接数上升 | 单用户部署规模下可接受；文档中记录该限制 |
| `MAXLEN ~ 2000` 裁剪后，断线过久的客户端可能取不全历史 | 客户端可回退到 REST 拉取全量消息；`session.ready` 会带上当前游标 |
| Worker 的 `onProgress` 拿不到 `sessionId` | Task 8 Step 6 明确要求给 `buildExecutor` 增加参数，而不是新增数据库查询 |
