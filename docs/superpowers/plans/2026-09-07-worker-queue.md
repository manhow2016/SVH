# apps/worker 生成任务队列化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图片/视频生成任务全量队列化——server 只入队/查询/标记取消，独立 `apps/worker` 进程执行 Provider 调用、轮询与资产落库，崩溃后可自动接管。

**Architecture:** SQLite 任务表（`production_tasks`）即队列：加 `payload/claimed_by/heartbeat_at` 三列，worker 用原子 `UPDATE ... WHERE id IN (SELECT ...) RETURNING` claim + 心跳超时回收（WAL + busy_timeout 多进程）。不引入 Redis/BullMQ；workflow 执行保持 server 内。

**Tech Stack:** pnpm monorepo、TypeScript 5.8 strict（ESM、verbatimModuleSyntax）、Drizzle + better-sqlite3、Fastify、React + @tanstack/react-query、node:test（`node --import tsx --test`）。

**Spec:** `docs/superpowers/specs/2026-09-07-worker-queue-design.md`（已批准，§ 引用均以此为准）

## Global Constraints

- 所有回复/注释/commit message 使用简体中文；commit 格式 `type(scope): 描述`。
- 测试一律 **node:test**（禁 vitest），包目录内运行：`cd <pkg> && node --import tsx --test "test/**/*.test.ts"`；server 测试在 `src/**/*.test.ts`。
- 不修改 Agent Runtime / Session / Workspace / Tool / Provider **注册表**；只允许本计划列出的增量。
- TS 严格模式（`noUncheckedIndexedAccess`）；type import 与 value import 分开（`consistent-type-imports`）。
- 每任务结束必须：该包/应用测试全绿 + `pnpm typecheck` 全绿；涉及行为改动跑 `pnpm lint`。
- `payload` 含明文 apiKey（与 settings 表同级信任边界）：**任何返回给前端的视图（ProductionTaskView）不得包含 payload/claimedBy/heartbeatAt**。
- SQLite 列名 snake_case（`payload`/`claimed_by`/`heartbeat_at`/`provider_task_id`），Drizzle 属性 camelCase。

---

### Task 1: database — 队列表列 + busy_timeout

**Files:**
- Modify: `packages/database/src/schema/workflow.ts`（productionTasks 定义，约 :48-73）
- Modify: `packages/database/src/client.ts`（INIT_SQL 内 `CREATE TABLE IF NOT EXISTS production_tasks` 块 :318-332；`createDatabase` :453-466；`migrateSchema` :473-503）
- Modify: `packages/database/package.json`（devDependencies 加 `"tsx": "^4.20.0"`）
- Test: `packages/database/test/schema.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `productionTasks` 表新列 `payload: string | null`、`claimedBy: string | null`、`heartbeatAt: number | null`（毫秒 int，不用 timestamp_ms 模式——SQL 直接比较）；`createDatabase()` 对旧库自动补列并设 `busy_timeout=5000`。

- [ ] **Step 1: 写失败测试**

`packages/database/test/schema.test.ts`（新库结构 + 旧库迁移双断言）：

```ts
/**
 * 队列化列（V0.2 收尾：worker 任务队列）结构测试。
 * 新库：INIT_SQL 直接建列；旧库：migrateSchema ALTER 补列（幂等）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/client";

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "svh-db-test-"));
  dirs.push(dir);
  return join(dir, "test.db");
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function columnsOf(db: ReturnType<typeof createDatabase>): string[] {
  return (
    db.$client.prepare("PRAGMA table_info(production_tasks)").all() as Array<{ name: string }>
  ).map((c) => c.name);
}

test("新库 production_tasks 含 payload/claimed_by/heartbeat_at 队列列", () => {
  const db = createDatabase(tmpFile());
  for (const col of ["payload", "claimed_by", "heartbeat_at"]) {
    assert.ok(columnsOf(db).includes(col), `缺少列 ${col}`);
  }
});

test("旧库缺队列列时 createDatabase 自动补列且幂等", () => {
  const file = tmpFile();
  const db = createDatabase(file);
  // 模拟旧库：删掉三个新列（SQLite ≥3.35 支持 DROP COLUMN）
  db.$client.exec(
    "ALTER TABLE production_tasks DROP COLUMN payload;" +
      "ALTER TABLE production_tasks DROP COLUMN claimed_by;" +
      "ALTER TABLE production_tasks DROP COLUMN heartbeat_at;",
  );
  assert.ok(!columnsOf(db).includes("payload"));
  db.$client.close();

  const reopened = createDatabase(file); // 第一次迁移
  const reopened2 = createDatabase(file); // 再开一次验证幂等（不报错）
  for (const col of ["payload", "claimed_by", "heartbeat_at"]) {
    assert.ok(columnsOf(reopened).includes(col), `迁移后缺列 ${col}`);
    assert.ok(columnsOf(reopened2).includes(col));
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/database && node --import tsx --test "test/**/*.test.ts"`
Expected: FAIL（`缺少列 payload`）

- [ ] **Step 3: 实现 schema + INIT_SQL + migrateSchema + pragma**

`schema/workflow.ts` productionTasks 中 `error: text("error"),` 之后加：

```ts
  /** 任务入参 JSON（worker 执行所需；视图层禁止外泄） */
  payload: text("payload"),
  /** 认领该任务的 worker 实例 id */
  claimedBy: text("claimed_by"),
  /** 最近心跳（毫秒时间戳；NULL=从未认领）。心跳超时=僵尸任务，可被回收 */
  heartbeatAt: integer("heartbeat_at"),
```

`client.ts` INIT_SQL 的 `production_tasks (` 块内 `error TEXT,` 后加：

```sql
  payload TEXT,
  claimed_by TEXT,
  heartbeat_at INTEGER,
```

`createDatabase` 内 `sqlite.pragma("foreign_keys = ON");` 后加：

```ts
  // 多进程（server + worker）共享单文件：写锁竞争时等待而非立即报错
  sqlite.pragma("busy_timeout = 5000");
```

`migrateSchema` 末尾（workflow_nodes 段之后）加：

```ts
  // V0.2 队列化：production_tasks 增加 payload / claimed_by / heartbeat_at
  if (columns("production_tasks").includes("id") && !columns("production_tasks").includes("payload")) {
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN payload TEXT;");
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN claimed_by TEXT;");
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN heartbeat_at INTEGER;");
  }
```

`package.json` devDependencies 加 `"tsx": "^4.20.0"` 并 `pnpm install`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/database && node --import tsx --test "test/**/*.test.ts"` → PASS（2 tests）
Run: `pnpm --filter @svh/database typecheck && pnpm --filter @svh/server typecheck` → 绿（server 现有任务行 payload=NULL 兼容）。

- [ ] **Step 5: Commit**

```bash
git add packages/database && git commit -m "feat(database): production_tasks 增加 payload/claimed_by/heartbeat_at 队列列"
```

---

### Task 2: production — Drizzle 仓储适配器迁入包内

**Files:**
- Move: `apps/server/src/modules/production/repository.ts` → `packages/production/src/sqlite-repository.ts`
- Move: `apps/server/src/modules/production/repository.test.ts` → `packages/production/test/sqlite-repository.test.ts`
- Modify: `packages/production/src/index.ts`、`packages/production/package.json`（加 `@svh/database`、`drizzle-orm` 依赖）
- Modify（仅 import 行）: `apps/server/src/app.ts:34`、`apps/server/src/modules/production/tools.test.ts:15`、`generation-service.test.ts:15`、`workflow-service.test.ts:16`

**Interfaces:**
- Consumes: Task 1 不改接口；本任务不改任何行为。
- Produces: `@svh/production` 导出 `DrizzleProductionRepository`（构造 `(db: SVHDatabase)`，实现 `ProductionRepository`）。Task 5 的 worker 用 `new ProductionService(new DrizzleProductionRepository(db))` 写资产。

- [ ] **Step 1: 迁文件 + 改包依赖**

```bash
git mv apps/server/src/modules/production/repository.ts packages/production/src/sqlite-repository.ts
git mv apps/server/src/modules/production/repository.test.ts packages/production/test/sqlite-repository.test.ts
```

`packages/production/package.json` dependencies 加：

```json
    "@svh/database": "workspace:*",
    "drizzle-orm": "^0.44.0"
```

`packages/production/src/index.ts` 在 `export * from "./repository";` 后加：

```ts
export * from "./sqlite-repository";
```

- [ ] **Step 2: 修 import**

`sqlite-repository.ts` 头部注释「适配层（Adapter）位于 server 模块」改为「drizzle 适配器与领域包同包维护（server 与 worker 共用）」；其 `from "@svh/production"` 的 type import 改为 `from "./repository"`（同包内部引用）。
`test/sqlite-repository.test.ts`：`import { DrizzleProductionRepository } from "./repository";` → `from "../src/sqlite-repository";`；`ProductionService` 与 `ProductionRepository` 相关 import 由 `"@svh/production"` 同理改 `"../src/index"`（与同目录其他测试一致，包内测试不引自己包名）。
server 4 处（app.ts + 3 个测试文件）`import { DrizzleProductionRepository } from "…repository";` → `import { DrizzleProductionRepository } from "@svh/production";`（app.ts 合入既有 `import type { ProductionService } from "@svh/production";` 处改为 value import）。

- [ ] **Step 3: 安装并回归**

```bash
pnpm install
cd packages/production && node --import tsx --test "test/**/*.test.ts"   # 46+ 原测试 + 迁移仓储测试全绿
cd apps/server && node --import tsx --test "src/**/*.test.ts"            # 65 全绿
pnpm typecheck && pnpm lint
```

Expected: 全绿（纯搬迁，零行为变化）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(production): DrizzleProductionRepository 迁入 @svh/production 供 server 与 worker 共用"
```

---

### Task 3: providers — image/video 供应商路由工厂

**Files:**
- Create: `packages/providers/src/factory.ts`
- Modify: `packages/providers/src/index.ts`（加 `export * from "./factory";`）
- Test: `packages/providers/test/factory.test.ts`（新建）

**Interfaces:**
- Consumes: `ImageProvider`（image/provider.ts:32）、`VideoProvider`（video/provider.ts:40）、`ModelConfig`（llm/provider.ts:62：`providerId/baseUrl/apiKey/model`）、`DashScopeImageProvider`/`OpenAICompatibleImageProvider`/`DashScopeVideoProvider` 现有构造签名。
- Produces（Task 5/6 引用，签名必须一致）:

```ts
createImageProvider(input: { providerId: string; config: ModelConfig }): ImageProvider
createVideoProvider(input: { providerId: string; config: ModelConfig }): VideoProvider
```

- [ ] **Step 1: 写失败测试**

```ts
/**
 * 供应商路由工厂测试：dashscope → 原生适配器；其余图片 → OpenAI 兼容；非 dashscope 视频 → 抛错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createImageProvider, createVideoProvider } from "../src/index";

const config = { providerId: "x", model: "m", baseUrl: "https://example.com/v1", apiKey: "k" };

test("createImageProvider：dashscope 走原生适配器，其余走 OpenAI 兼容", () => {
  assert.equal(createImageProvider({ providerId: "dashscope", config }).id, "dashscope-image");
  assert.equal(
    createImageProvider({ providerId: "volcengine", config }).id,
    "openai-compatible-image",
  );
});

test("createVideoProvider：仅 dashscope；其他供应商明确报错", () => {
  assert.equal(createVideoProvider({ providerId: "dashscope", config }).id, "dashscope-async");
  assert.throws(
    () => createVideoProvider({ providerId: "volcengine", config }),
    /仅支持百炼/,
  );
});
```

（两个适配器实例 id 断言以源码实际值为准：`dashscope-image` 见 `image/dashscope.ts`；视频实例 id 与 OpenAI 兼容图片实例 id 写测试前先 `grep -n 'id = '` 核对，以实际值替换。）

- [ ] **Step 2: 运行确认失败** → Run: `cd packages/providers && node --import tsx --test "test/factory.test.ts"`；Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 factory.ts**

```ts
/**
 * 生成供应商路由工厂（spec §4.2/§5）：按目录 providerId 选择具体适配器实现。
 * server（入队前校验/取消）与 worker（执行）共用，杜绝两侧路由逻辑漂移。
 */
import type { ModelConfig } from "./llm/provider";
import type { ImageProvider } from "./image/provider";
import type { VideoProvider } from "./video/provider";
import { DashScopeImageProvider } from "./image/dashscope";
import { OpenAICompatibleImageProvider } from "./image/openai-compatible";
import { DashScopeVideoProvider } from "./video/dashscope";

/** 图片：百炼走 DashScope 原生同步接口，其余走 OpenAI 兼容 /images/generations */
export function createImageProvider(input: { providerId: string; config: ModelConfig }): ImageProvider {
  if (input.providerId === "dashscope") {
    return new DashScopeImageProvider({ apiKey: input.config.apiKey });
  }
  return new OpenAICompatibleImageProvider({
    baseUrl: input.config.baseUrl,
    apiKey: input.config.apiKey,
  });
}

/** 视频：当前仅支持百炼异步任务 */
export function createVideoProvider(input: { providerId: string; config: ModelConfig }): VideoProvider {
  if (input.providerId !== "dashscope") {
    throw new Error("当前版本视频生成仅支持百炼（DashScope）模型");
  }
  return new DashScopeVideoProvider({ apiKey: input.config.apiKey });
}
```

- [ ] **Step 4: 回归 + Commit**

Run: `cd packages/providers && node --import tsx --test "test/**/*.test.ts"`（19+2 全绿）；`pnpm --filter @svh/providers typecheck`。

```bash
git add packages/providers && git commit -m "feat(providers): 新增图片/视频供应商路由工厂 createImageProvider/createVideoProvider"
```

---

### Task 4: apps/worker 包骨架 + 队列核心（claim/心跳/回收）

**Files:**
- Create: `apps/worker/package.json`、`apps/worker/tsconfig.json`、`apps/worker/tsconfig.build.json`、`apps/worker/src/config.ts`、`apps/worker/src/queue.ts`
- Create: `apps/worker/test/helpers/setup.ts`、`apps/worker/test/queue.test.ts`
- Modify: `eslint.config.mjs:36`（node glob 加 worker）、根 `package.json`（dev 脚本）

**Interfaces:**
- Consumes: Task 1 的 `productionTasks.payload/claimedBy/heartbeatAt`；`SVHDatabase.$client`。
- Produces（Task 5 依赖，签名固定）:

```ts
// apps/worker/src/queue.ts
export interface TaskPayload {
  v: number;
  prompt?: string;
  imageUrl?: string;
  size?: string;
  duration?: number;
  resolution?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  assetName: string;
}
export interface ClaimedTask {
  id: string;
  kind: "image" | "video";
  projectId: string;
  userId: string;
  providerTaskId: string | null;
  payload: TaskPayload;
}
claimTasks(db: SVHDatabase, workerId: string, opts: { limit: number; staleMs: number; now?: number }): ClaimedTask[]
heartbeat(db: SVHDatabase, workerId: string, now?: number): void
setTaskRunning(db: SVHDatabase, id: string, patch: { progress?: number | null; error?: string | null; providerTaskId?: string | null; status?: "running" }): void
finishTask(db: SVHDatabase, id: string, patch: { status: "completed" | "failed" | "cancelled"; outputUrl?: string | null; error?: string | null; progress?: number | null }): boolean
getTaskStatus(db: SVHDatabase, id: string): string | null
// apps/worker/src/config.ts
loadWorkerConfig(): { databaseUrl; workerId; concurrency; tickMs; pollMs; staleMs }
```

- [ ] **Step 1: 包骨架**

`apps/worker/package.json`：

```json
{
  "name": "@svh/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@svh/database": "workspace:*",
    "@svh/production": "workspace:*",
    "@svh/providers": "workspace:*",
    "@svh/shared": "workspace:*",
    "drizzle-orm": "^0.44.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "typescript": "^5.8.3"
  }
}
```

`tsconfig.json` / `tsconfig.build.json` 逐字复制 `apps/server/` 同名文件。根 `package.json` dev 脚本改为：

```json
"dev": "concurrently -n server,worker,web -c blue,magenta,green \"pnpm --filter @svh/server dev\" \"pnpm --filter @svh/worker dev\" \"pnpm --filter @svh/web dev\""
```

`eslint.config.mjs` 第 36 行 files 改：`files: ["apps/{server,worker}/**/*.ts", "packages/**/*.ts", "scripts/**/*.mjs"],`

`src/config.ts`：

```ts
/** worker 配置（spec §4.4）：全部 env 可覆盖，默认适配本地单文件库 */
export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  concurrency: number;
  tickMs: number;
  pollMs: number;
  staleMs: number;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: env.SVH_DATABASE_URL ?? "./data/svh.db",
    workerId: env.SVH_WORKER_ID ?? `wkr-${process.pid}`,
    concurrency: num(env.SVH_WORKER_CONCURRENCY, 2),
    tickMs: num(env.SVH_WORKER_TICK_MS, 2000),
    pollMs: num(env.SVH_WORKER_POLL_MS, 5000),
    staleMs: num(env.SVH_WORKER_STALE_MS, 60_000),
  };
}
```

- [ ] **Step 2: 写失败测试（queue 核心）**

`test/helpers/setup.ts`（复用 server 测试建库模式，Task 5/6 共用）：

```ts
/** 临时库 + 用户/工作区/项目种子（worker 测试通用夹具） */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { ProductionService } from "@svh/production";
import { DrizzleProductionRepository } from "@svh/production";

export interface TestEnv {
  dir: string;
  db: SVHDatabase;
  userId: string;
  projectId: string;
  production: ProductionService;
  cleanup(): void;
}

export async function createTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "svh-worker-"));
  const db = createDatabase(join(dir, "test.db"));
  const userId = randomId("usr");
  db.insert(users)
    .values({ id: userId, username: "wk", email: "wk@test.local", passwordHash: "x",
      role: "user", status: "active", createdAt: new Date(), updatedAt: new Date() })
    .run();
  const wsId = randomId("ws");
  db.insert(workspaces)
    .values({ id: wsId, name: "wk-ws", rootPath: join(dir, wsId), userId,
      createdAt: new Date(), updatedAt: new Date() })
    .run();
  const production = new ProductionService(new DrizzleProductionRepository(db));
  const projectId = (await production.createProject({ workspaceId: wsId, name: "队列项目" })).id;
  return { dir, db, userId, projectId, production, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 插入一条 queued 图片任务（默认值可覆盖；payload 传 null 模拟损坏） */
export function seedTask(
  db: SVHDatabase,
  input: {
    projectId: string;
    userId: string;
    kind?: string;
    status?: string;
    payload?: Partial<TaskPayload> | null;
    providerTaskId?: string | null;
    heartbeatAt?: number | null;
  },
): string {
  const id = randomId("ptk");
  const now = new Date();
  const payload: TaskPayload = {
    v: 1, prompt: "p", providerId: "dashscope", model: "m", baseUrl: "", apiKey: "k", assetName: "任务",
    ...(input.payload ?? {}),
  };
  db.insert(productionTasks)
    .values({
      id,
      projectId: input.projectId,
      userId: input.userId,
      kind: input.kind ?? "image",
      status: input.status ?? "queued",
      providerTaskId: input.providerTaskId ?? null,
      heartbeatAt: input.heartbeatAt ?? null,
      payload: input.payload === null ? null : JSON.stringify(payload),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}
```

（helper 需 `import { productionTasks } from "@svh/database";` 与 `import type { TaskPayload } from "../../src/queue";`。）

`test/queue.test.ts`（真实临时库，SQL 级行为断言）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { productionTasks } from "@svh/database";
import { eq } from "drizzle-orm";
import { claimTasks, heartbeat, finishTask, getTaskStatus, setTaskRunning } from "../src/queue";
import { createTestEnv, seedTask } from "./helpers/setup";

test("claim：queued 按 created_at 先进先出，limit 限流，认领后置 running/claimed_by/heartbeat", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const now = Date.now();
  const claimed = claimTasks(env.db, "wkr-1", { limit: 1, staleMs: 60_000, now });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.id, a); // 先建先领
  assert.equal(claimed[0]!.payload.model, "m");
  const row = env.db.select().from(productionTasks).where(eq(productionTasks.id, b)).get();
  assert.equal(row!.status, "queued", "第二条约满未领");
});

test("claim 原子性：两个 worker 连续认领不拿到同一任务；未知 kind 不认领", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const b = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, kind: "audio" });
  const one = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  const two = claimTasks(env.db, "wkr-2", { limit: 5, staleMs: 60_000 });
  const ids = [...one, ...two].map((t) => t.id).sort();
  assert.deepEqual(ids, [a, b].sort(), "无重复认领且 audio 未被认领");
});

test("stale 回收：running 且心跳超时（含 NULL）可被其他 worker 接管", async () => {
  const env = await createTestEnv();
  const a = seedTask(env.db, { projectId: env.projectId, userId: env.userId, status: "running", heartbeatAt: 1000 });
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, status: "running", heartbeatAt: Date.now() }); // 新鲜心跳不抢
  const now = Date.now();
  const claimed = claimTasks(env.db, "wkr-2", { limit: 5, staleMs: 60_000, now });
  assert.deepEqual(claimed.map((t) => t.id), [a]);
});

test("坏 payload 直接置 failed 不阻塞队列；heartbeat/setTaskRunning/getTaskStatus/finishTask 语义", async () => {
  const env = await createTestEnv();
  seedTask(env.db, { projectId: env.projectId, userId: env.userId, payload: null });
  const good = seedTask(env.db, { projectId: env.projectId, userId: env.userId });
  const claimed = claimTasks(env.db, "wkr-1", { limit: 5, staleMs: 60_000 });
  assert.deepEqual(claimed.map((t) => t.id), [good], "坏 payload 被跳过并落 failed");
  assert.equal(getTaskStatus(env.db, "ptk-not-exists"), null, "不存在的任务返回 null");

  heartbeat(env.db, "wkr-1", 12345);
  const owned = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(owned!.heartbeatAt, 12345);

  setTaskRunning(env.db, good, { providerTaskId: "pt-1", progress: 10 });
  assert.equal(getTaskStatus(env.db, good), "running");

  assert.equal(finishTask(env.db, good, { status: "completed", outputUrl: "u", progress: 100 }), true);
  assert.equal(finishTask(env.db, good, { status: "failed", error: "x" }), false, "非 running 不覆写（取消竞态守卫）");
  const done = env.db.select().from(productionTasks).where(eq(productionTasks.id, good)).get();
  assert.equal(done!.status, "completed");
  assert.equal(done!.error, null);
  env.cleanup();
});
```

- [ ] **Step 3: 运行确认失败** → `cd apps/worker && node --import tsx --test "test/**/*.test.ts"`；Expected: FAIL（queue.ts 不存在）

- [ ] **Step 4: 实现 queue.ts**

```ts
/**
 * 队列核心（spec §4.1）：SQLite 任务表即队列。
 * claim 用单条 `UPDATE … WHERE id IN (SELECT … LIMIT ?) RETURNING` 原子认领，
 * 多 worker 并发安全靠写锁串行化；心跳超时回收僵尸任务。
 */
import { and, eq } from "drizzle-orm";
import { productionTasks, type SVHDatabase } from "@svh/database";

/** 入队时由 server 解析写入的执行参数（v1；含明文 Key，禁止经任务视图外泄） */
export interface TaskPayload {
  v: number;
  prompt?: string;
  imageUrl?: string;
  size?: string;
  duration?: number;
  resolution?: string;
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  assetName: string;
}

export interface ClaimedTask {
  id: string;
  kind: "image" | "video";
  projectId: string;
  userId: string;
  providerTaskId: string | null;
  payload: TaskPayload;
}

/** worker 认领的任务类型白名单（未来 audio 等注册 handler 后放开） */
export const CLAIMABLE_KINDS = ["image", "video"] as const;

export function claimTasks(
  db: SVHDatabase,
  workerId: string,
  opts: { limit: number; staleMs: number; now?: number },
): ClaimedTask[] {
  if (opts.limit <= 0) return [];
  const now = opts.now ?? Date.now();
  const placeholders = CLAIMABLE_KINDS.map(() => "?").join(", ");
  const rows = db.$client
    .prepare(
      `UPDATE production_tasks
          SET status = 'running', claimed_by = ?, heartbeat_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM production_tasks
           WHERE kind IN (${placeholders})
             AND (status = 'queued'
                  OR (status = 'running'
                      AND (heartbeat_at IS NULL OR heartbeat_at < ?)))
           ORDER BY created_at
           LIMIT ?)
        RETURNING id, kind, project_id, user_id, provider_task_id, payload`,
    )
    .all(
      workerId, now, now,
      ...CLAIMABLE_KINDS,
      now - opts.staleMs,
      opts.limit,
    ) as Array<{
      id: string; kind: string; project_id: string; user_id: string;
      provider_task_id: string | null; payload: string | null;
    }>;

  const claimed: ClaimedTask[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload) {
      // 损坏 payload 显式落终态，避免被反复回收
      finishTask(db, row.id, { status: "failed", error: "任务参数损坏（payload 无法解析）" });
      continue;
    }
    claimed.push({
      id: row.id,
      kind: row.kind as ClaimedTask["kind"],
      projectId: row.project_id,
      userId: row.user_id,
      providerTaskId: row.provider_task_id,
      payload,
    });
  }
  return claimed;
}

function parsePayload(raw: string | null): TaskPayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as TaskPayload;
    return typeof obj.model === "string" && typeof obj.providerId === "string" ? obj : null;
  } catch {
    return null;
  }
}

/** 本 worker 全部 running 任务刷心跳（tick 内调用） */
export function heartbeat(db: SVHDatabase, workerId: string, now?: number): void {
  db.$client
    .prepare(`UPDATE production_tasks SET heartbeat_at = ? WHERE claimed_by = ? AND status = 'running'`)
    .run(now ?? Date.now(), workerId);
}

/** running 期间回写（仅状态推进：providerTaskId / progress / error 暂存） */
export function setTaskRunning(
  db: SVHDatabase,
  id: string,
  patch: { progress?: number | null; error?: string | null; providerTaskId?: string | null },
): void {
  db.update(productionTasks)
    .set({
      status: "running",
      ...(patch.providerTaskId !== undefined ? { providerTaskId: patch.providerTaskId } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(productionTasks.id, id))
    .run();
}

/**
 * 终态写入：带 `status='running'` 守卫（spec §4.2）——
 * server 已标记 cancelled 时返回 false，调用方放弃覆写（取消竞态收敛点）。
 */
export function finishTask(
  db: SVHDatabase,
  id: string,
  patch: { status: "completed" | "failed" | "cancelled"; outputUrl?: string | null; error?: string | null; progress?: number | null },
): boolean {
  const res = db
    .update(productionTasks)
    .set({
      status: patch.status,
      outputUrl: patch.outputUrl ?? null,
      error: patch.error ?? null,
      progress: patch.progress ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(productionTasks.id, id), eq(productionTasks.status, "running")))
    .returning({ id: productionTasks.id })
    .get();
  return res != null;
}

/** 读当前状态（video handler 每轮检测 server 侧取消） */
export function getTaskStatus(db: SVHDatabase, id: string): string | null {
  const row = db
    .select({ status: productionTasks.status })
    .from(productionTasks)
    .where(eq(productionTasks.id, id))
    .get();
  return row?.status ?? null;
}
```

**注意（实现时修正）**：上面 `finishTask` 的 where 条件漏了 `and(...)`——已在代码块中为正确版本；`heartbeat`/`setTaskRunning`/`getTaskStatus` 按块实现即可。

- [ ] **Step 5: 运行测试通过 + 提交**

`cd apps/worker && node --import tsx --test "test/**/*.test.ts"` → 4 tests PASS。
`pnpm install` 后 `pnpm typecheck && pnpm lint` 全绿。

```bash
git add -A && git commit -m "feat(worker): 新增 apps/worker 包与队列核心（原子 claim / 心跳 / stale 回收）"
```

---

### Task 5: worker — image/video handler + 主循环

**Files:**
- Create: `apps/worker/src/handlers.ts`、`apps/worker/src/index.ts`
- Modify: `apps/worker/src/queue.ts`（如需补 `getRow(db,id)` 则一并）
- Test: `apps/worker/test/handlers.test.ts`

**Interfaces:**
- Consumes: Task 3 `createImageProvider/createVideoProvider({providerId, config: ModelConfig})`；Task 2 `ProductionService.createAsset`；Task 4 queue 全部函数；`VideoTask`（video/provider.ts:10）。
- Produces:

```ts
export interface HandlerDeps {
  pollIntervalMs: number;
  /** 供应商工厂（测试注入假实现；缺省走 providers 包路由工厂） */
  imageProviderFactory?: (p: TaskPayload) => ImageProvider;
  videoProviderFactory?: (p: TaskPayload) => VideoProvider;
  /** 定时器（测试注入 0ms） */
  sleep?: (ms: number) => Promise<void>;
  /** 视频任务最长等待（缺省 15 分钟） */
  maxWaitMs?: number;
}
runTask(db: SVHDatabase, production: ProductionService, task: ClaimedTask, deps: HandlerDeps): Promise<void>
// index.ts 导出 createWorkerLoop(db, production, config, deps): { tick(): void; active(): number; stop(): Promise<void> }
```

- [ ] **Step 1: 写失败测试**

`test/handlers.test.ts` 覆盖（每条独立 test，复用 setup 夹具 + 假 Provider）：

1. **image 成功**：fake `generate` 返回 `{images:[{url:"https://x/a.png"}], created:1}` → 断言 task `completed`、progress=100、outputUrl 正确、`production.listAssets(projectId,"image")` 长度 1 且 `generation.modelId==="m"`、`generation.taskId===task.id`。
2. **image 失败**：fake `generate` 抛 `Error("401 key invalid")` → task `failed`，error 含 `401`。
3. **video 全流程**：fake createTask→`{providerTaskId:"pt-9"}`；getTask 依次 `[running, completed(outputUrl)]`；`sleep` 注入 `() => Promise.resolve()` → 断言：`setTaskRunning` 已写 `providerTaskId="pt-9"`；task `completed`；video 资产落库且 `generation.taskId` 存在。
4. **video 取消**：getTask 第一轮返回 running 前，先把 DB 行置 `cancelled`（模拟 server 取消：`finishTask` 对 running 用守卫失败——直接 `db.update(productionTasks).set({status:"cancelled"})`）→ handler 观察后调用假 `cancelTask("pt-9")`、任务保持 `cancelled`、**不落资产**。
5. **video 供应商失败**：getTask 返回 `{status:"failed", error:"quota"}` → task `failed` 不落资产。
6. **runTask 分发**：`kind` 未知（手工构造 ClaimedTask kind 强转 "audio"）→ 任务保持不动或 failed？——定义：`runTask` 对非白名单 kind 直接 `finishTask failed（"暂不支持的任务类型"）`；断言之。

假 Provider 模式沿用 server 旧测试的 `videoBehavior`（序列数组 + calls 记录），从 `@svh/providers` import type `VideoProvider, ImageProvider, VideoTask`。

- [ ] **Step 2: 确认失败** → FAIL（handlers.ts 不存在）

- [ ] **Step 3: 实现 handlers.ts**

```ts
/**
 * 任务处理器（spec §4.2/§4.3）：payload → Provider → 资产落库 → 终态。
 * 所有异常内吞并落 task 终态——worker 主循环永不因单任务崩溃。
 */
import type { SVHDatabase } from "@svh/database";
import type { ProductionService } from "@svh/production";
import {
  createImageProvider,
  createVideoProvider,
  type ImageProvider,
  type ModelConfig,
  type VideoProvider,
} from "@svh/providers";
import { finishTask, getTaskStatus, setTaskRunning, type ClaimedTask, type TaskPayload } from "./queue";

export interface HandlerDeps {
  pollIntervalMs: number;
  imageProviderFactory?: (p: TaskPayload) => ImageProvider;
  videoProviderFactory?: (p: TaskPayload) => VideoProvider;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toConfig(p: TaskPayload): ModelConfig {
  return { providerId: p.providerId, model: p.model, baseUrl: p.baseUrl, apiKey: p.apiKey };
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}

/** 分发入口：主循环唯一调用点 */
export async function runTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  try {
    if (task.kind === "image") return await runImageTask(db, production, task, deps);
    if (task.kind === "video") return await runVideoTask(db, production, task, deps);
    finishTask(db, task.id, { status: "failed", error: `暂不支持的任务类型：${task.kind}` });
  } catch (err) {
    finishTask(db, task.id, { status: "failed", error: errMessage(err) });
  }
}

async function runImageTask(
  db: SVHDatabase,
  production: ProductionService,
  task: ClaimedTask,
  deps: HandlerDeps,
): Promise<void> {
  const p = task.payload;
  const provider =
    deps.imageProviderFactory?.(p) ?? createImageProvider({ providerId: p.providerId, config: toConfig(p) });
  const result = await provider.generate({ model: p.model, prompt: p.prompt ?? "", size: p.size });
  const first = result.images[0];
  if (!first || (!first.url && !first.b64Json)) {
    finishTask(db, task.id, { status: "failed", error: "供应商未返回图片" });
    return;
  }
  await production.createAsset({
    projectId: task.projectId,
    type: "image",
    name: p.assetName,
    url: first.url,
    mimeType: "image/png",
    metadata: first.b64Json ? { b64Json: first.b64Json } : undefined,
    generation: { providerId: p.providerId, modelId: p.model, prompt: p.prompt },
  });
  // 返回 false = server 已标记取消：资产虽落库但状态保持 cancelled（与旧 server 行为一致）
  finishTask(db, task.id, { status: "completed", outputUrl: first.url ?? null, progress: 100 });
}
```

`runVideoTask` 实体（spec §4.3 逐步实现）：

```ts
  const p = task.payload;
  if ((await getTaskStatus(db, task.id)) === "cancelled") return; // 认领后立即被取消
  const provider = deps.videoProviderFactory?.(p) ?? createVideoProvider({ providerId: p.providerId, config: toConfig(p) });
  const sleep = deps.sleep ?? defaultSleep;

  let providerTaskId = task.providerTaskId; // stale 回收接管时已有：续轮询，不重复扣费
  if (!providerTaskId) {
    const handle = await provider.createTask({
      model: p.model, prompt: p.prompt || undefined, imageUrl: p.imageUrl,
      duration: p.duration, resolution: p.resolution,
    });
    providerTaskId = handle.providerTaskId;
    setTaskRunning(db, task.id, { providerTaskId });
  }

  const started = Date.now();
  for (;;) {
    await sleep(deps.pollIntervalMs);
    if (getTaskStatus(db, task.id) === "cancelled") {
      try { await provider.cancelTask(providerTaskId); } catch { /* best-effort（spec §4.3） */ }
      return;
    }
    const t = await provider.getTask(providerTaskId);
    if (t.status === "completed" && t.outputUrl) {
      await production.createAsset({
        projectId: task.projectId, type: "video", name: p.assetName,
        url: t.outputUrl, mimeType: "video/mp4",
        generation: { providerId: p.providerId, modelId: p.model, prompt: p.prompt, taskId: task.id },
      });
      finishTask(db, task.id, { status: "completed", outputUrl: t.outputUrl, progress: 100 });
      return;
    }
    if (t.status === "failed") { finishTask(db, task.id, { status: "failed", error: t.error ?? "供应商任务失败" }); return; }
    if (t.status === "cancelled") { finishTask(db, task.id, { status: "cancelled", error: "任务已在供应商侧取消" }); return; }
    setTaskRunning(db, task.id, { progress: t.progress ?? null }); // queued/running：推进心跳外的可见状态
    if (Date.now() - started > (deps.maxWaitMs ?? 15 * 60_000)) {
      finishTask(db, task.id, { status: "failed", error: "视频任务等待超时（>15 分钟）" });
      return;
    }
  }
```

- [ ] **Step 4: 实现 index.ts（主循环，spec §4.1）**

```ts
/**
 * SVH Worker 入口（spec §4）：tick = 心跳 → 按空闲槽原子 claim → 异步跑 handler。
 * 启动无特殊恢复：崩溃遗留 running 任务由 stale 心跳回收自动接管。
 */
import { createDatabase, type SVHDatabase } from "@svh/database";
import { DrizzleProductionRepository, ProductionService } from "@svh/production";
import { claimTasks, heartbeat, type ClaimedTask } from "./queue";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { runTask, type HandlerDeps } from "./handlers";

export function createWorkerLoop(
  db: SVHDatabase,
  production: ProductionService,
  config: WorkerConfig,
  deps: HandlerDeps,
  log: (msg: string, extra?: Record<string, unknown>) => void = (m) => console.log(`[worker] ${m}`),
): { tick: () => void; active: () => number; stop: () => Promise<void> } {
  let activeCount = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    heartbeat(db, config.workerId);
    const slots = config.concurrency - activeCount;
    if (slots <= 0) return;
    for (const task of claimTasks(db, config.workerId, { limit: slots, staleMs: config.staleMs })) {
      activeCount += 1;
      log(`任务开始 ${task.kind} ${task.id}`);
      void runTask(db, production, task, deps)
        .catch((err) => log(`任务异常 ${task.id}: ${(err as Error).message}`))
        .finally(() => { activeCount -= 1; });
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    const deadline = Date.now() + 5000; // best-effort：等运行中 handler 收尾（spec §4.4）
    while (activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  return { tick, active: () => activeCount, stop };
}

function main(): void {
  const config = loadWorkerConfig();
  const db = createDatabase(config.databaseUrl);
  const production = new ProductionService(new DrizzleProductionRepository(db));
  const loop = createWorkerLoop(db, production, config, { pollIntervalMs: config.pollMs });
  const timer = setInterval(loop.tick, config.tickMs);
  loop.tick(); // 启动立即跑一轮，免等首个 tick
  console.log(`[worker] started id=${config.workerId} db=${config.databaseUrl} concurrency=${config.concurrency}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[worker] ${sig}，停止认领并收尾退出`);
      clearInterval(timer);
      void loop.stop().then(() => process.exit(0));
    });
  }
}

main();
```

**测试可导入性**：`index.ts` 顶层 `main()` 使 import 即启动——将 `main()` 调用包为 `if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) { main(); }`？——不可靠。**定案**：入口逻辑放 `src/main.ts`（上面 `main()` 全量 + 唯一顶层调用），`src/index.ts` 只导出 `createWorkerLoop` 供测试与复用；package.json `dev/start` 指向 `src/main.ts`。

- [ ] **Step 5: 回归 + 提交**

worker 测试全绿（queue 4 + handlers ≥6）；`pnpm typecheck && pnpm lint`；`pnpm build`（worker dist 产出）。

```bash
git add -A && git commit -m "feat(worker): 实现图片/视频任务处理器与主循环（心跳回收自动接管）"
```

---

### Task 6: server — 生成服务改为入队语义

**Files:**
- Rewrite: `apps/server/src/modules/production/generation-service.ts`
- Modify: `apps/server/src/routes/production.ts:306-347`（image 返回 `{ task }`）
- Rewrite: `apps/server/src/modules/production/generation-service.test.ts`

**Interfaces:**
- Consumes: `SettingsService.getSkillModelConfigWithMeta`（不变）；`productionTasks` 新列；payload 形状 = Task 4 `TaskPayload`（server 侧手写字面量对齐字段，**不**跨 app import worker）。
- Produces:

```ts
class GenerationService {
  constructor(deps: { db: SVHDatabase; settings: SettingsService })
  enqueueImage(input: { projectId; userId; prompt; modelName?; size? }): Promise<ProductionTaskView>
  enqueueVideo(input: { projectId; userId; prompt?; imageUrl?; modelName?; duration?; resolution? }): Promise<ProductionTaskView>
  getTask(id): ProductionTaskView
  cancelTask(id): Promise<void>
}
```

`ProductionTaskView` 字段不变（本就不含 payload）。

- [ ] **Step 1: 重写测试（先红）**

`generation-service.test.ts` 新断言集（建库夹具沿用旧文件 before()，`new GenerationService({ db, settings })`）：

1. `enqueueImage`：prompt 空 → `INVALID_INPUT` 400；模型未启用（types 无 image 可用行：用 `settings` 覆盖 enabledModels 为空数组场景或沿用默认目录）→ 断言返回视图：`status==="queued"`、`kind==="image"`；DB 行 `payload` JSON 含 `providerId/model/assetName/prompt/size`；**视图对象无 payload/claimedBy/heartbeatAt 键**。
2. `enqueueImage` 走 dashscope 模型（`modelName: "qwen-image"` 类目录模型）→ payload.providerId==="dashscope"。
3. `enqueueVideo`：prompt 与 imageUrl 均空 → 400；成功 → queued + payload 含 duration/resolution 透传。
4. `getTask`：不存在 → `NOT_FOUND` 404。
5. `cancelTask`：queued 任务 → 置 `cancelled`；再 cancel → `CONFLICT` 409；running 同样置 cancelled（模拟 worker 心跳行）；completed → 409。
6. 旧 mockFetch/502 断言全部删除（Provider 错误不再由 server 抛出，进 task.error，由 worker 测试覆盖）。

- [ ] **Step 2: 运行确认失败**（旧实现无 enqueueImage）

- [ ] **Step 3: 重写实现**

保留文件头注释（更新为「V0.2 收尾：任务入队，执行在 apps/worker」）；核心：

```ts
  /** 图片任务入队（校验与模型解析即时反馈；Provider 调用移入 worker） */
  async enqueueImage(input: { projectId: string; userId: string; prompt: string; modelName?: string; size?: string }): Promise<ProductionTaskView> {
    const prompt = input.prompt.trim();
    if (prompt === "") throw ERRORS.INVALID_INPUT("prompt is required");
    const { config, providerId } = await this.deps.settings.getSkillModelConfigWithMeta(
      input.modelName, input.userId, ["image"],
    );
    if (!config.model) {
      throw ERRORS.INVALID_INPUT("未配置可用的图片模型，请在 Settings 中启用图片模型");
    }
    return this.enqueue({
      projectId: input.projectId, userId: input.userId, kind: "image",
      payload: {
        v: 1, prompt, size: input.size,
        providerId, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey,
        assetName: prompt.slice(0, 40) || "生成图片",
      },
    });
  }
```

`enqueueVideo` 同型：校验「prompt 或 imageUrl 至少提供一个」→ `await getSkillModelConfigWithMeta(modelName, userId, ["video"])`（空模型文案「未配置可用的视频模型…」）→ payload 含 `prompt: prompt || undefined, imageUrl, duration, resolution`，assetName 默认「生成视频」。
私有 `enqueue(input)`：`randomId("ptk")` + insert（status `queued`、createdAt/updatedAt now、`payload: JSON.stringify(input.payload)`）+ `return this.getTask(taskId)`。
`cancelTask`：读行 → 终态（completed/failed/cancelled）→ 409；否则 update `status:"cancelled"`（worker 下一轮观察收敛，server 不再触供应商）。
**删除**：`taskControllers`、`pollVideoTask`、`resolveVideoProvider`、`videoAdapterFactory`/`pollIntervalMs` deps、`production` deps、IMAGE/VIDEO_PROVIDER_ERROR 502 包装、providers 全部 import（`randomId` 保留）。

routes/production.ts：

```ts
// generate-image handler 内：
return { task: await deps.generationService.enqueueImage({ /* 原入参不变 */ }) };
// generate-video handler 内：startVideoTask → await enqueueVideo（返回形状不变：task view 本体）
```

- [ ] **Step 4: 回归 + 提交**

`cd apps/server && node --import tsx --test "src/**/*.test.ts"` 全绿（数量≈65−删改+新增）；`pnpm typecheck && pnpm lint && pnpm --filter @svh/server build`。

```bash
git add -A && git commit -m "refactor(server): 生成服务改为入队语义，删除进程内轮询与内存取消控制器"
```

---

### Task 7: web — 图片并入任务条（统一排队/进度/错误体验）

**Files:**
- Modify: `apps/web/src/api/production.ts:116-127`
- Modify: `apps/web/src/features/production/panels.tsx:815-920,923-1075,1076-1160`

**Interfaces:**
- Consumes: server 新响应（image `{ task }`；cancel 返回终态 task view）。
- Produces: 无（叶子任务）。

- [ ] **Step 1: API 类型**

```ts
  // ---- 生成（图片/视频统一入队，worker 异步执行，轮询 getTask） ----
  generateImage: (projectId, input) => post<{ task: ProductionGenerationTask }>(`…/generate-image`, input),
  generateVideo: …（不变）
  cancelTask: (id) => post<ProductionGenerationTask>(`/api/tasks/${enc(id)}/cancel`),
```

- [ ] **Step 2: panels.tsx 三处改造**

1. `VideoTaskBar` → `GenerationTaskBar`，props 加 `kind: "image" | "video"`；内部文案 `视频生成完成/失败` → `${kind === "image" ? "图片" : "视频"}生成完成/失败`；其余逻辑不变。
2. `AssetsPanel`：`{(type === "image" || type === "video") && task && (<GenerationTaskBar kind={task.kind === "video" ? "video" : type} …/>)}`（原 `type === "video" && task` 条件放宽）；注释「视频异步任务」→「生成任务（图片/视频同队列）」。
3. `AssetGenerationForm`：prop `onVideoTask` → `onTask`；image 分支：

```ts
      if (kind === "image") {
        const { task } = await productionApi.generateImage(projectId, { … });
        onTask(task.id);
      } else { const created = await productionApi.generateVideo(…); onTask(created.id); }
```

图片 helper 文案 `"同步生成，通常需数秒到一分钟"` → `"异步任务：排队后由 worker 执行，通常数秒到一分钟"`；两处调用点（`<AssetGenerationForm … onVideoTask={setTaskId}/>`）改名 `onTask`。

- [ ] **Step 3: 验证 + 提交**

`pnpm --filter @svh/web build` 绿；`pnpm typecheck && pnpm lint` 绿。手工 UI 验证并入 Task 8。

```bash
git add -A && git commit -m "feat(web): 图片生成并入任务条，统一展示排队/进度/失败原因"
```

---

### Task 8: 文档 + 全量回归 + 真实链路验证

**Files:**
- Modify: `README.md`（能力表 + 后续列表 :159）
- Modify: `docs/production-guide.md`（§5 生成链路重写 + worker 部署/env + :177 删「队列化未实现」）

- [ ] **Step 1: 文档**

README：能力/架构表加行「任务队列 | `production_tasks` 即 SQLite 队列（payload + 原子 claim + 心跳回收）+ 独立 `apps/worker` 进程执行图片/视频任务，重启自动接管」；:159 后续列表删除「独立 apps/worker 队列化长任务」。
production-guide §5：图片语义改为「入队 → worker 调用 → 任务条轮询；配置错误 400 即时，Provider 错误进 `task.error`」；补「运行 worker：`pnpm --filter @svh/worker dev|start`（须与 server 相同 `SVH_DATABASE_URL`）」+ env 表（SVH_WORKER_CONCURRENCY/TICK_MS/POLL_MS/STALE_MS/ID）；:177 V0.3 列表移除队列化项。

- [ ] **Step 2: 全量回归**

```bash
pnpm typecheck && pnpm lint
for p in packages/database packages/production packages/core packages/providers; do (cd $p && node --import tsx --test "test/**/*.test.ts"); done
(cd apps/server && node --import tsx --test "src/**/*.test.ts")
(cd apps/worker && node --import tsx --test "test/**/*.test.ts")
pnpm build && pnpm --filter @svh/web build
```

Expected: 全绿。

- [ ] **Step 3: 真实链路验证（消耗小额 API 费用，执行时先向用户确认；用户既往已同意小额实验）**

1. 重建 providers/dist 后，按既有纪律（kill-by-listening-PID）重启 :3456 server，另起 worker：`SVH_DATABASE_URL=<server 同值> pnpm --filter @svh/worker start`（nohup 后台）。
2. `POST .../assets/generate-image`（qwen-image）→ 返回 `queued` 任务 → 3-10s 后 `GET /api/tasks/:id` 为 `completed` 且资产自动落库（验证 API 或 UI）。
3. `POST .../assets/generate-video`（wanx2.1-t2v-turbo，无 resolution）→ 轮询 running（观察 `heartbeat_at` 递增）→ completed + video 资产。**接管演示**：任务 running 期间 `kill` worker → 60s 内重启 worker → stale 回收后凭 providerTaskId 续轮询至 completed（验证零丢失卖点；staleMs 可临时设 10000 缩短等待）。
4. 取消路径：再提交一条视频，`POST /api/tasks/:id/cancel` → 任务 cancelled、worker 日志见 best-effort 供应商取消、不落资产。
5. UI 冒烟（browser-skill 或用户手测）：制作中心图片生成出现任务条→资产刷新。
6. **清理**：raw sqlite 删除本次 smoke 项目/资产/任务（列名 snake_case），确认 `leftover smoke: 0`；停临时进程恢复常态。

- [ ] **Step 4: 提交并推送**

```bash
git add -A && git commit -m "docs: README/production-guide 更新生成任务队列化说明"
git push origin master
```

---

## Self-Review 结论（写计划时已核）

- Spec 覆盖：§3→Task1，§6→Task2，§4.2 路由→Task3，§4.1/4.3/4.4/4.5→Task4/5，§5→Task6，§7→Task7，§8/9→各任务 Step + Task8，§10 提交计划逐任务落地。
- 类型一致性：`TaskPayload`（Task4 定义=Task6 server 手写 JSON 字段名）；`createImageProvider({providerId, config})` Task3=Task5 调用式；`finishTask` 守卫语义 Task4=Task5 使用。
- 已知代价（设计批准时确认）：图片不再同步返回；Provider 错误由 502 即时 → task.error 异步。
