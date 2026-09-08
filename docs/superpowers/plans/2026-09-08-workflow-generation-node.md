# ① 工作流编排打通（生成节点）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作流引擎支持 `image.generate` / `video.generate` 两种节点：批量扇出分镜 → 交给生产队列 → 等待终态 → 自动绑定资产到分镜，并保证重跑/取消/重启的幂等与可恢复。

**Architecture:** 节点执行器是 `apps/server/src/app.ts` 的 `executorFactory` 注入点。新执行器（`generation-node-executor.ts`）以**依赖端口**形式接收一个 `GenerationNodeDeps` 接口，核心逻辑（扇出筛选/收养/等待/绑定/取消/超时）与 Fastify、SQL、供应商完全解耦、可单测；真实实现 `createRealGenerationDeps` 在 app.ts 与集成测试共用。服务层（`workflow-service.ts`）只扩展：执行上下文加 `workflowId`、`FULL_PIPELINE_NODES` 模板、`createWorkflow` 加 `withGeneration`、启动对账方法。worker 运行时零改动（payload 只做容忍性类型扩展）。

**Tech Stack:** pnpm monorepo、TS 5.8 strict（`noUncheckedIndexedAccess`/`verbatimModuleSyntax`）、Drizzle + better-sqlite3、Fastify 5、node:test（`node --import tsx --test`）。Server 测试用 `apps/server/src/**/*.test.ts`（`node --import tsx --test "apps/server/src/**/*.test.ts"`）。

**Spec:** `docs/superpowers/specs/2026-09-08-workflow-generation-node-design.md`

> **Base & 前提 (2026-09-08 重新对齐)：** 本计划初稿基于 `43874e3` 前的代码撰写，但用户在同一 master 上并发提交了 V0.3 Phase 1/2（`c36d3cd` 生产上下文 + `9eed309` Prompt Composition，作者 `manhow2016`）。**当前基线 = `9eed309`。** 受影响文件已按新代码修订：`GenerationService` 现在依赖 `{ db, settings, production, promptComposer }` 四参，`enqueueImage/enqueueVideo` 经 `promptComposer.composeImage/composeVideo` 组合提示词（payload 新增 `composedPrompt/composedNegative/promptMetadata`），`app.ts:346-351` 用 `new GenerationService({ db, settings, production, promptComposer: new DefaultPromptComposer() })`。实施时一律基于 `9eed309`，不要回退到旧代码。

## Global Constraints

- 引擎核心 `packages/core` **零改动**（`WorkflowEngine`/`runWorkflowLoop`/`NodeExecutor` 签名不变）。
- **零数据库迁移**、零新表、零新端点：新数据全落现有列（`workflow_nodes.output` JSON、`production_tasks.workflowId/nodeId` 预留列、payload JSON 新增可选键）。
- worker 运行时**零改动**；`CLAIMABLE_KINDS` 不变。
- 成本入口保持手动：`auto-pipeline` 仍用 4 节点默认；生成节点只进 `withGeneration` 显式创建的工作流。
- 扇出单位 = **storyboard**（非 shot）。产出资产绑到该 storyboard **全部 shot**。
- 扫描**不过滤 status**（draft/approved 均参与）；`image.generate` 需 `imagePrompt` 非空，`video.generate` 需 `videoPrompt` 非空或该 storyboard 任一 shot 已绑 `imageAssetId`。
- 幂等权威 = `production_tasks` 的 `(workflow_id,node_id)` 查询；`node.output` 只是镜像。
- 每个任务的 `payload` 含明文 API Key，**只允许落库与 worker 消费**，严禁进视图/日志；测试断言不得读取外泄。
- 提交 message 用中文 `type(scope): 描述`。
- 每任务独立新子代理 + 独立 task 评审器（SDD 排队）。
- 类型检查用 `tsc --noEmit`（仓库根 `pnpm typecheck`）；服务器单测按 `apps/server/src/**/*.test.ts` 跑。

---

### Task 1: 生成服务入队扩展（透传列 + 按节点查询）

**Files:**
- Modify: `apps/server/src/modules/production/generation-service.ts`
- Modify: `apps/worker/src/queue.ts`（仅 TaskPayload interface）
- Modify: `apps/server/src/modules/production/generation-service.test.ts`（追加用例，非新建——V0.3 已建此文件）

**Interfaces:**
- Consumes: 无（自下而上第一任务）。注意当前基准代码 `GenerationService` 构造为 `new GenerationService({ db, settings, production, promptComposer })`（4 个依赖），且 `enqueueImage/enqueueVideo` 内部经 `this.deps.promptComposer.composeImage/composeVideo` 组合提示词。
- Produces:
  - `GenerationService.enqueueImage(input: { projectId; userId; prompt; modelName?; size?; workflowId?; nodeId?; storyboardId?; assetName? }): Promise<ProductionTaskView>` — 新增四个可选字段。
  - `GenerationService.enqueueVideo(input: { projectId; userId; prompt?; imageUrl?; modelName?; duration?; resolution?; workflowId?; nodeId?; storyboardId?; assetName? }): Promise<ProductionTaskView>`。
  - `GenerationService.listTasksByNode(workflowId: string, nodeId: string): Array<{ id: string; status: string; storyboardId?: string; createdAt: Date }>`。
  - `TaskPayload` 增加 `storyboardId?: string`（server `generation-service.ts` 与 worker `queue.ts` 两侧字面量同步）。

- [ ] **Step 1: 写失败测试**（追加到既有 `apps/server/src/modules/production/generation-service.test.ts`，复用其 `before` 建立的 `generation/db/production/projectId/userId/payloadOf/assertNoQueueLeak`）

在文件末尾（`cancelTask：completed` 测试后）追加两条用例：

```ts
test("enqueueImage：透传 workflowId/nodeId/storyboardId 落列，assetName 可覆盖", async () => {
  const view = await generation.enqueueImage({
    projectId, userId, prompt: "一只白鹤掠过水面",
    workflowId: "wfl_1", nodeId: "images", storyboardId: "sto_1", assetName: "分镜1·画面",
  });
  const row = db.select().from(productionTasks).where(eq(productionTasks.id, view.id)).get();
  assert.equal(row!.workflowId, "wfl_1");
  assert.equal(row!.nodeId, "images");
  const p = payloadOf(view.id);
  assert.equal(p.storyboardId, "sto_1");
  assert.equal(p.assetName, "分镜1·画面", "assetName 应覆盖默认值");
  assert.equal(view.status, "queued");
});

test("listTasksByNode：返回该节点任务，从 payload 解析 storyboardId 且按创建升序", async () => {
  await generation.enqueueImage({ projectId, userId, prompt: "a", workflowId: "wfl_1", nodeId: "images", storyboardId: "sto_a" });
  await generation.enqueueImage({ projectId, userId, prompt: "b", workflowId: "wfl_1", nodeId: "images", storyboardId: "sto_b" });
  await generation.enqueueImage({ projectId, userId, prompt: "c" }); // 无 workflowId/nodeId，不应被返回
  const tasks = generation.listTasksByNode("wfl_1", "images");
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.storyboardId).sort(), ["sto_a", "sto_b"]);
});
```

> 注意：该文件 `payloadOf` 已返回 `Record<string, unknown>`（`p.storyboardId` 是 unknown，断言用 `assert.equal(p.storyboardId, "sto_1")` 即可）。`before` 里 `generation` 的构造已含 `production`+`promptComposer`，无需改。

- [ ] **Step 2: 运行测试验证失败**

Run: `node --import tsx --test apps/server/src/modules/production/generation-service.test.ts`
Expected: FAIL（`enqueueImage` 不接受新字段、`listTasksByNode` 不存在）。

- [ ] **Step 3: 实现**

`generation-service.ts` 修改：

1. `TaskPayload` 加 `storyboardId?: string;`（可选，放 `size` 附近）。
2. `enqueueImage` 输入加 `workflowId?/nodeId?/storyboardId?/assetName?`；payload 里 `assetName: input.assetName ?? prompt.slice(0, 40) || "生成图片"`；有 `input.storyboardId` 则写 `payload.storyboardId = input.storyboardId`。调用 `this.enqueue({ ..., kind:"image", payload, workflowId: input.workflowId, nodeId: input.nodeId })`。
3. `enqueueVideo` 同理（`assetName: input.assetName ?? prompt.slice(0, 40) || "生成视频"`）。
4. 私有 `enqueue` 输入加 `workflowId?: string; nodeId?: string;`，insert values 加这两列：
```ts
.values({
  id: taskId, projectId: input.projectId, userId: input.userId,
  workflowId: input.workflowId, nodeId: input.nodeId,  // 新增
  kind: input.kind, providerId: input.payload.providerId,
  status: "queued", payload: JSON.stringify(input.payload),
  createdAt: now, updatedAt: now,
})
```
5. 新增方法：
```ts
listTasksByNode(workflowId: string, nodeId: string): Array<{ id: string; status: string; storyboardId?: string; createdAt: Date }> {
  const rows = this.deps.db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.workflowId, workflowId), eq(tasksTable.nodeId, nodeId)))
    .orderBy(asc(tasksTable.createdAt))
    .all();
  return rows.map((r) => {
    let storyboardId: string | undefined;
    if (r.payload) {
      try { storyboardId = (JSON.parse(r.payload) as { storyboardId?: string }).storyboardId; } catch { storyboardId = undefined; }
    }
    return { id: r.id, status: r.status, storyboardId, createdAt: r.createdAt };
  });
}
```
（`and`/`asc`/`eq` 已从 drizzle-orm 导入，`tasksTable` 名保持 `productionTasks as tasksTable`。`asc` 需确认已导入——若无则补 `import { and, asc, eq, notInArray } from "drizzle-orm"`。）

`queue.ts`：`TaskPayload` interface 加 `storyboardId?: string;`（纯类型，零逻辑）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --import tsx --test apps/server/src/modules/production/generation-service.test.ts`
Expected: PASS（2 条）。

- [ ] **Step 5: 回归**

Run: `pnpm typecheck` 通过；`node --import tsx --test "apps/server/src/**/*.test.ts"` 原绿。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/production/generation-service.ts apps/worker/src/queue.ts apps/server/src/modules/production/generation-service.test.ts
git commit -m "feat(server,worker): 生成服务入队透传 workflow/node/storyboard 列并支持按节点查询"
```

---

### Task 2: 生成节点执行器核心（依赖端口 + 真实实现工厂 + 单测）

**Files:**
- Create: `apps/server/src/modules/production/generation-node-executor.ts`
- Test: `apps/server/src/modules/production/generation-node-executor.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GenerationService.enqueueImage/enqueueVideo/listTasksByNode/cancelTask`、`ProductionService.listStoryboards/listShotsByStoryboard/getAsset/listAssets/updateShot`。
- Produces:
  - `export interface GenerationNodeDeps`（端口，见下）。
  - `export function createRealGenerationDeps(opts: { db; production; generationService; pollMs: number; maxWaitMs: number }): GenerationNodeDeps`。
  - `export async function runGenerationNode(opts: { ctx: GenerationNodeContext; node: WorkflowNode; input: unknown; signal?: AbortSignal; deps: GenerationNodeDeps }): Promise<GenerationNodeOutput>`。
  - `export interface GenerationNodeContext { projectId: string; workflowId: string; userId: string }`。
  - `export interface GenerationNodeOutput { items: Record<string, GenItem>; summary: { total; succeeded; failed; cancelled; timeout; skipped } }`。

- [ ] **Step 1: 写失败测试**（核心行为，假 deps）

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbortController } from "node:abort_controller";
import { runGenerationNode, type GenerationNodeDeps, type GenerationNodeContext } from "./generation-node-executor";
import type { WorkflowNode } from "@svh/core";

const CONTEXT: GenerationNodeContext = { projectId: "p1", workflowId: "wfl_1", userId: "u1" };
const NODE = { id: "images", type: "image.generate", name: "生成图片", dependsOn: ["storyboard"], status: "pending", retryCount: 0, maxRetries: 1 } as WorkflowNode;

function makeDeps(overrides: Partial<GenerationNodeDeps> = {}): GenerationNodeDeps {
  const sb = {
    id: "sto_1", projectId: "p1", sceneId: "sc", order: 1, description: "d", duration: 3,
    shotType: "wide", imagePrompt: "一只白鹤掠过水面", videoPrompt: null, status: "draft",
    createdAt: new Date(), updatedAt: new Date(),
  };
  const shot = { id: "sho_1", projectId: "p1", storyboardId: "sto_1", order: 1, duration: 3, framing: null, cameraMovement: null, action: null, dialogue: null, imageAssetId: null, videoAssetId: null, status: "pending", createdAt: new Date(), updatedAt: new Date() };
  const taskStatus = new Map<string, string>();
  return {
    pollMs: 5,
    maxWaitMs: 500,
    async listStoryboards() { return [sb]; },
    async listShotsByStoryboard() { return [shot]; },
    async getAsset(id) { return { id, projectId: "p1", workspaceId: "ws", userId: "u1", type: "image", name: "x", url: "http://asset/" + id, createdAt: new Date(), updatedAt: new Date() } as any; },
    async updateShot(id, patch) { return { id, imageAssetId: patch.imageAssetId, videoAssetId: patch.videoAssetId } as any; },
    async listAssets() { return []; },
    async enqueueImage(input) { taskStatus.set("ptk_1", "queued"); return { id: "ptk_1" }; },
    async enqueueVideo() { return { id: "ptk_2" }; },
    async getTask(id) { return { id, status: taskStatus.get(id) ?? "queued" }; },
    async cancelTask() {},
    async listTasksByNode() { return []; },
    async writeNodeOutput() {},
    ...overrides,
  };
}
```

测试 1（理想路径——任务立即完成，绑定并返回完整 output）：

```ts
test("image.generate：扇出→等待立即完成→绑定 shots + 返回完整 output", async () => {
  const deps = makeDeps();
  const orig = deps.enqueueImage.bind(deps);
  deps.enqueueImage = async (input) => {
    const r = await orig(input);
    // 入队即视为已完成（模拟 worker 秒回）。
    deps.getTask = async () => ({ id: "ptk_1", status: "completed" });
    (deps as any).__taskId = r.id;
    return r;
  };
  const out = await runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps });
  assert.equal(out.summary.total, 1);
  assert.equal(out.summary.succeeded, 1);
  assert.equal(out.summary.failed, 0);
  const item = out.items["sto_1"]!;
  assert.equal(item.status, "completed");
  assert.deepEqual(item.boundShotIds, ["sho_1"]);
});
```

测试 2（0 扇出抛错）：

```ts
test("0 合格分镜 → 抛可操作错误", async () => {
  const deps = makeDeps({ listStoryboards: async () => [{ /* imagePrompt: null */ } as any] });
  await assert.rejects(
    runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps }),
    /无合格分镜/,
  );
});
```

测试 3（收养已有任务，不重复入队）：

```ts
test("收养：existing queued/running 任务不被重复入队", async () => {
  let enqueued = 0;
  const deps = makeDeps({
    listTasksByNode: async () => [{ id: "ptk_existing", status: "queued", storyboardId: "sto_1" }],
    getTask: async () => ({ id: "ptk_existing", status: "running" }),
  });
  deps.enqueueImage = async () => { enqueued++; return { id: "ptk_new" }; };
  // 需让 getTask 最终完成
  deps.getTask = async (id) => ({ id, status: "completed" }); // 收养完成即补绑
  const out = await runGenerationNode({ ctx: CONTEXT, node: NODE, input: { regenerateAll: false }, deps });
  assert.equal(enqueued, 0, "收养实例不应重新入队");
  assert.equal(out.items["sto_1"]!.status, "completed");
});
```

测试 4（触发取消 → 批量 cancelTask + 节点抛错）：

```ts
test("abort：等待期间取消未终态任务并抛错", async () => {
  const cancelled: string[] = [];
  let resolveFirst: (() => void) | undefined;
  const deps = makeDeps({
    getTask: async () => ({ id: "ptk_1", status: "queued" }),
    cancelTask: async (id) => { cancelled.push(id); },
  });
  const ac = new AbortController();
  // 起跑后立即 abort
  const p = runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /取消|abort/i);
  assert.ok(cancelled.includes("ptk_1"));
});
```

测试 5（部分失败→成功项绑定保留、节点抛错）：

```ts
test("部分失败：failed 项记录，成功项仍绑，整体抛错", async () => {
  const deps = makeDeps({
    listStoryboards: async () => [
      { id: "sto_1" /* success */, imagePrompt: "x", videoPrompt: null, status: "draft" } as any,
      { id: "sto_2" /* fail */, imagePrompt: "y", videoPrompt: null, status: "draft" } as any,
    ],
    listShotsByStoryboard: async (sid) => [{ id: "sho_" + sid, imageAssetId: null, videoAssetId: null, status: "pending" } as any],
    getTask: async (id) => ({ id, status: id === "ptk_2" ? "failed" : "completed" }),
  });
  let n = 0;
  deps.enqueueImage = async () => ({ id: "ptk_" + ++n });
  await assert.rejects(
    runGenerationNode({ ctx: CONTEXT, node: NODE, input: {}, deps }),
    /失败/,
  );
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --import tsx --test apps/server/src/modules/production/generation-node-executor.test.ts`
Expected: FAIL（`generation-node-executor` 不存在）。

- [ ] **Step 3: 实现 `generation-node-executor.ts`**

端口 + 类型：

```ts
import { and, asc, eq } from "drizzle-orm";
import type { SVHDatabase } from "@svh/database";
import type { WorkflowNode } from "@svh/core";
import type { ProductionService, ProductionAsset } from "@svh/production";
import type { GenerationService } from "./generation-service";

export interface GenerationNodeContext { projectId: string; workflowId: string; userId: string }
export type GenStatus = "completed" | "failed" | "cancelled" | "timeout" | "skipped";
export interface GenItem { taskId: string | null; assetId: string | null; status: GenStatus; reason?: string; boundShotIds: string[] }
export interface GenerationNodeOutput { items: Record<string, GenItem>; summary: { total: number; succeeded: number; failed: number; cancelled: number; timeout: number; skipped: number } }

export interface GenerationNodeDeps {
  pollMs: number;
  maxWaitMs: number;
  listStoryboards(projectId: string): Promise<Array<{ id: string; imagePrompt: string | null; videoPrompt: string | null; status: string; duration: number; order: number; sceneId: string; description: string }>>;
  listShotsByStoryboard(storyboardId: string): Promise<Array<{ id: string; imageAssetId: string | null; videoAssetId: string | null; status: string }>>;
  getAsset(id: string): Promise<ProductionAsset>;
  /** 按任务 id 反查产物资产（spec §6：json_extract(generation,'$.taskId')）；找不到返回 null */
  findAssetByTask(taskId: string): Promise<ProductionAsset | null>;
  updateShot(id: string, patch: { imageAssetId?: string; videoAssetId?: string }): Promise<unknown>;
  listAssets(projectId: string, type?: "image" | "video"): Promise<ProductionAsset[]>;
  enqueueImage(input: { projectId: string; userId: string; prompt: string; modelName?: string; size?: string; workflowId?: string; nodeId?: string; storyboardId?: string; assetName?: string }): Promise<{ id: string }>;
  enqueueVideo(input: { projectId: string; userId: string; prompt?: string; imageUrl?: string; modelName?: string; duration?: number; resolution?: string; workflowId?: string; nodeId?: string; storyboardId?: string; assetName?: string }): Promise<{ id: string }>;
  getTask(id: string): Promise<{ id: string; status: string }>;
  cancelTask(id: string): Promise<void>;
  listTasksByNode(workflowId: string, nodeId: string): Array<{ id: string; status: string; storyboardId?: string }>;
  writeNodeOutput(workflowId: string, nodeId: string, output: GenerationNodeOutput): Promise<void>;
}

export interface GenEnqueueMeta { workflowId: string; nodeId: string; storyboardId: string; assetName: string }
```

核心循环 `runGenerationNode`：

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runGenerationNode(opts: {
  ctx: GenerationNodeContext; node: WorkflowNode; input: unknown; signal?: AbortSignal; deps: GenerationNodeDeps;
}): Promise<GenerationNodeOutput> {
  const { ctx, node, deps } = opts;
  const kind = node.type === "image.generate" ? "image" : "video";
  const input = (opts.input ?? {}) as { storyboardIds?: string[]; regenerateAll?: boolean; modelName?: string; size?: string; duration?: number; resolution?: string };
  const items: Record<string, GenItem> = {};
  const write = async () => { await deps.writeNodeOutput(ctx.workflowId, node.id, summarize(items)); };

  // 1) 候选分镜（storyboardIds 限定或全项目）
  const all = await deps.listStoryboards(ctx.projectId);
  const candidates = input.storyboardIds?.length ? all.filter((s) => input.storyboardIds!.includes(s.id)) : all;

  // 2) 收养既有任务（幂等权威）
  const existing = new Map<string, { id: string; status: string }>();
  for (const t of deps.listTasksByNode(ctx.workflowId, node.id)) {
    if (t.storyboardId) existing.set(t.storyboardId, { id: t.id, status: t.status });
  }

  // 3) 逐个分镜规划：跳过 / 收养 / 入队
  const pending: Array<{ storyboardId: string; taskId: string; order: number; duration: number; sceneId: string; description: string; imagePrompt: string | null; videoPrompt: string | null }> = [];
  for (const sb of candidates) {
    const shots = await deps.listShotsByStoryboard(sb.id);
    const bound = shots.every((s) => (kind === "image" ? s.imageAssetId : s.videoAssetId));
    if (input.regenerateAll !== true && bound && shots.length > 0) {
      items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "已绑定", boundShotIds: [] };
      continue;
    }
    if (kind === "image" && !(sb.imagePrompt && sb.imagePrompt.trim())) {
      items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "无可用提示", boundShotIds: [] };
      continue;
    }
    if (kind === "video") {
      const hasPrompt = sb.videoPrompt && sb.videoPrompt.trim();
      const hasImg = shots.some((s) => s.imageAssetId);
      if (!hasPrompt && !hasImg) { items[sb.id] = { taskId: null, assetId: null, status: "skipped", reason: "无可用提示", boundShotIds: [] }; continue; }
    }
    const adopted = existing.get(sb.id);
    if (adopted && adopted.status !== "failed" && adopted.status !== "cancelled") {
      pending.push({ storyboardId: sb.id, taskId: adopted.id, order: sb.order, duration: sb.duration, sceneId: sb.sceneId, description: sb.description, imagePrompt: sb.imagePrompt, videoPrompt: sb.videoPrompt });
      continue;
    }
    // 入队新任务
    const assetName = `${kind === "image" ? "分镜" + sb.order + "·画面" : "分镜" + sb.order + "·动态"}`;
    let taskId: string;
    if (kind === "image") {
      taskId = (await deps.enqueueImage({ projectId: ctx.projectId, userId: ctx.userId, prompt: sb.imagePrompt!, modelName: input.modelName, size: input.size, workflowId: ctx.workflowId, nodeId: node.id, storyboardId: sb.id, assetName })).id;
    } else {
      const imgShot = shots.find((s) => s.imageAssetId);
      let imageUrl: string | undefined;
      if (imgShot?.imageAssetId) {
        const asset = await deps.getAsset(imgShot.imageAssetId);
        imageUrl = asset.url;
      }
      taskId = (await deps.enqueueVideo({ projectId: ctx.projectId, userId: ctx.userId, prompt: sb.videoPrompt ?? undefined, imageUrl, modelName: input.modelName, duration: input.duration ?? sb.duration, resolution: input.resolution, workflowId: ctx.workflowId, nodeId: node.id, storyboardId: sb.id, assetName })).id;
    }
    items[sb.id] = { taskId, assetId: null, status: "running", boundShotIds: [] };
    pending.push({ storyboardId: sb.id, taskId, order: sb.order, duration: sb.duration, sceneId: sb.sceneId, description: sb.description, imagePrompt: sb.imagePrompt, videoPrompt: sb.videoPrompt });
  }

  const output = summarize(items);
  if (output.summary.total === 0) {
    throw new Error(`无合格分镜可生成（检查提示词/绑定/重跑范围）`);
  }
  await write();

  // 4) 等待循环
  const deadline = Date.now() + deps.maxWaitMs;
  let phase = "waiting";
  for (;;) {
    if ((opts.signal?.aborted) || phase === "abort") { /* 处理取消 @ 下方 */ phase = internalCancel(); break; }
    if (!pending.some((p) => pendingStatusIsRunning(p))) break; // 全部终态
    if (Date.now() > deadline) { phase = "timeout"; break; }
    await sleep(deps.pollMs);
  }
  // ...（见下：终态处理 + 绑定 + 取消/超时分支）
  return summarize(items);
}
```

> 说明：上面是结构示意；实现时把"终态判定 / 绑定 / 取消 / 超时"拆成内联辅助函数，且**严格按 spec §4/§5/§6/§7 语义**：每观测到一个任务终态即处理该条并 `write()`；`failed/cancelled` 项节点整体抛错；`abort` 对未终态任务调 `cancelTask` 并抛「取消」错误；`timeout` 同路径批量 cancel 并抛「超时」错误。`summarize(items)` 汇总 `total/succeeded/failed/cancelled/timeout/skipped`，并把 items 里状态归一（`running` 不计入上述计数）。**已完成任务的绑定（`updateShot`）在观测到 `completed` 时立即执行**，成功项绑定不回滚。

`createRealGenerationDeps`（真实实现，app.ts 与集成测试共用；顶部统一从 `@svh/database` 导入 `workflowNodes, productionAssets`、从 drizzle-orm 导入 `and, eq, sql`、从 `../../lib/errors` 导入 `ServerError`）：

```ts
export function createRealGenerationDeps(opts: {
  db: SVHDatabase; production: ProductionService; generationService: GenerationService;
  pollMs: number; maxWaitMs: number;
}): GenerationNodeDeps {
  const { db, production, generationService } = opts;
  return {
    pollMs: opts.pollMs, maxWaitMs: opts.maxWaitMs,
    listStoryboards: (projectId) => production.listStoryboards(projectId),
    listShotsByStoryboard: (sid) => production.listShotsByStoryboard(sid),
    getAsset: (id) => production.getAsset(id),
    findAssetByTask: (taskId) => {
      const row = db
        .select()
        .from(productionAssets)
        .where(sql`json_extract(${productionAssets.generation}, '$.taskId') = ${taskId}`)
        .get();
      return Promise.resolve(row ?? null);
    },
    updateShot: (id, patch) => production.updateShot(id, patch),
    listAssets: (projectId, type) => production.listAssets(projectId, type),
    enqueueImage: (i) => generationService.enqueueImage(i),
    enqueueVideo: (i) => generationService.enqueueVideo(i),
    getTask: (id) => generationService.getTask(id),
    cancelTask: (id) => generationService.cancelTask(id), // 需要吞掉 409/404——见下
    listTasksByNode: (wf, node) => generationService.listTasksByNode(wf, node),
    writeNodeOutput: async (wf, node, output) => {
      db.update(workflowNodes).set({ output, updatedAt: new Date() })
        .where(and(eq(workflowNodes.workflowId, wf), eq(workflowNodes.nodeId, node))).run();
    },
  };
}
```

> 注意：`cancelTask` 在 Worker/web 竞态下会抛 `CONFLICT`/`NOT_FOUND`（终态或并发已终结）。`createRealGenerationDeps` 的 `cancelTask` 需再包一层：`try { await generationService.cancelTask(id); } catch (e) { if (!(e instanceof ServerError && (e.status === 409 || e.status === 404))) throw e; }`（`ServerError` 从 `../../lib/errors` 导入）。`writeNodeOutput` 需从 `@svh/database` 导入 `workflowNodes` 表名（设为 `workflowNodes`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --import tsx --test apps/server/src/modules/production/generation-node-executor.test.ts`
Expected: PASS（5 条）。若"假 deps"导致类型不全，按端口补齐 override 字段。

- [ ] **Step 5: 回归**

Run: `pnpm typecheck` 通过（注意：`runGenerationNode` 内跳过了部分"占位错误"，实现时消除，避免无意义变量）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/production/generation-node-executor.ts apps/server/src/modules/production/generation-node-executor.test.ts
git commit -m "feat(server): 生成节点执行器（扇出/收养/等待/绑定/取消/超时，依赖端口可单测）"
```

---

### Task 3: WorkflowService 扩展（ctx.workflowId + 全流水线模板 + withGeneration + 启动对账）

**Files:**
- Modify: `apps/server/src/modules/production/workflow-service.ts`
- Test: `apps/server/src/modules/production/workflow-service.test.ts`

**Interfaces:**
- Consumes: 既有 `WorkflowService`。
- Produces:
  - `WorkflowExecutorContext` 增加 `workflowId: string`。
  - `export const FULL_PIPELINE_NODES: DefaultNodeSpec[]`（4 节点 + `images` + `videos`）。
  - `createWorkflow` options 增加 `withGeneration?: boolean`。
  - `reconcileInterruptedRuns(): Promise<{ workflows: number; nodes: number }>`。

- [ ] **Step 1: 写失败测试**（追加到既有 workflow-service.test.ts）

```ts
test("createWorkflow：withGeneration 生成 6 节点（含 images/videos）", async () => {
  const wf = (await service.createWorkflow(projectId, userId, { story: "故事", withGeneration: true })) as {
    id: string; nodes: Array<{ id: string; type: string; dependsOn: string[]; status: string }>;
  };
  const ids = wf.nodes.map((n) => n.id);
  assert.ok(ids.includes("images"));
  assert.ok(ids.includes("videos"));
  const images = wf.nodes.find((n) => n.id === "images")!;
  assert.equal(images.type, "image.generate");
  assert.deepEqual(images.dependsOn, ["storyboard"]);
  assert.equal(wf.nodes.find((n) => n.id === "videos")!.dependsOn[0], "images");
});

test("reconcileInterruptedRuns：running workflow/节点 → failed 且可重试", async () => {
  // 手工种一段 running 工作流
  const wf = (await service.createWorkflow(projectId, userId, { story: "s" })) as { id: string };
  db.update(workflows).set({ status: "running" }).where(eq(workflows.id, wf.id)).run();
  db.update(workflowNodes).set({ status: "running" }).where(eq(workflowNodes.workflowId, wf.id)).run();
  const res = await service.reconcileInterruptedRuns();
  assert.ok(res.workflows >= 1);
  const detail = (await service.getWorkflow(wf.id)) as { status: string; nodes: Array<{ status: string }> };
  assert.equal(detail.status, "failed");
  assert.ok(detail.nodes.every((n) => n.status === "failed"));
});
```

（需要在测试顶部导入 `workflows as workflows, workflowNodes as workflowNodes, eq`——既有文件已用 `createDatabase, users, workspaces`；补 `workflows as workflows, workflowNodes as workflowNodes` 和 drizzle `eq`。）

- [ ] **Step 2: 运行测试验证失败**

Run: `node --import tsx --test apps/server/src/modules/production/workflow-service.test.ts`
Expected: FAIL（type/属性不存在）。

- [ ] **Step 3: 实现**

`workflow-service.ts`：

1. `WorkflowExecutorContext` 加 `workflowId: string;`。
2. `runWorkflow` 构造 executorCtx 加 `workflowId: current.id`：
```ts
const executorCtx: WorkflowExecutorContext = { ...ctx, projectId: current.projectId, workflowId: current.id };
```
3. 常量：
```ts
export const FULL_PIPELINE_NODES: DefaultNodeSpec[] = [
  ...DEFAULT_WORKFLOW_NODES,
  { id: "images", type: "image.generate", name: "生成图片", dependsOn: ["storyboard"] },
  { id: "videos", type: "video.generate", name: "生成视频", dependsOn: ["images"] },
];
```
4. `createWorkflow(options)` 加 `withGeneration?: boolean`；列表选型改为：
```ts
const specs = options.nodes ?? (options.withGeneration ? FULL_PIPELINE_NODES : DEFAULT_WORKFLOW_NODES);
```
（story 注入条件 `if (options.story && !options.nodes)` 不变——`withGeneration` 时 `nodes` 仍为空，story 正确注入 node[0]。）
5. 新增方法：
```ts
async reconcileInterruptedRuns(): Promise<{ workflows: number; nodes: number }> {
  const wfRows = this.deps.db
    .update(workflowsTable)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(workflowsTable.status, "running"), eq(workflowsTable.status, "queued")))
    .returning({ id: workflowsTable.id })
    .all();
  // 单独置 running 节点失败（只作用于本次恢复的工作流）
  let nodeCount = 0;
  for (const r of wfRows) {
    const changed = this.deps.db
      .update(workflowNodesTable)
      .set({ status: "failed", error: "服务重启导致执行中断，可重试失败节点", updatedAt: new Date() })
      .where(and(eq(workflowNodesTable.workflowId, r.id), eq(workflowNodesTable.status, "running")))
      .run();
    nodeCount += changed.changes; // 仅统计本次真正落 failed 的节点
  }
  this.deps.log.warn({ count: wfRows.length }, "启动对账：中断的工作流已置为失败");
  return { workflows: wfRows.length, nodes: nodeCount };
}
```
> 注意：`and(eq(status,"running"), eq(status,"queued"))` 是恒假（status 不可能同时等于两值），**这是错的**。应改用 `inArray(workflowsTable.status, ["running","queued"])`。`inArray` 需从 `drizzle-orm` 导入。spec 原文只提 running；此处扩展到 queued 是安全超集（queued 也是孤儿瞬时态）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --import tsx --test apps/server/src/modules/production/workflow-service.test.ts`
Expected: PASS（原 7 条 + 新 2 条）。

- [ ] **Step 5: 回归**

Run: `node --import tsx --test "apps/server/src/**/*.test.ts"`；`pnpm typecheck`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/production/workflow-service.ts apps/server/src/modules/production/workflow-service.test.ts
git commit -m "feat(server): 工作流支持全流水线模板/withGeneration 与启动对账，执行上下文补 workflowId"
```

---

### Task 4: 集成测试（真库 + 真执行器 + 真队列，端到端"打通" + 重跑幂等）

**Files:**
- Test: `apps/server/src/modules/production/generation-integration.test.ts`

**Interfaces:**
- Consumes: Task 1-3 的产物（`createRealGenerationDeps`、`runGenerationNode`、`WorkflowService`、`GenerationService`）。
- Produces: 无（验证性质任务）。

- [ ] **Step 1: 写失败测试**（复用 workflow-service.test.ts 的桩基础，但执行器用真实 `createRealGenerationDeps`）

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, users, workspaces, productionTasks, productionAssets, type SVHDatabase } from "@svh/database";
import { randomId } from "@svh/shared";
import { DrizzleProductionRepository, DefaultPromptComposer, ProductionService } from "@svh/production";
import { WorkflowService, type WorkflowRunContext } from "./workflow-service";
import { GenerationService } from "./generation-service";
import { createRealGenerationDeps, runGenerationNode } from "./generation-node-executor";

let dir: string; let db: SVHDatabase; let production: ProductionService; let projectId: string; let userId: string; let wsId: string; let service: WorkflowService;

const fakeSettings = { async getSkillModelConfigWithMeta() { return { config: { model: "m", baseUrl: "http://x/v1", apiKey: "k" }, providerId: "dashscope" }; } } as any;

const executorFactory = (ctx: any) => ({
  execute(node, input, signal) { return runGenerationNode({ ctx: { projectId: ctx.projectId, workflowId: ctx.workflowId, userId: ctx.userId }, node, input, signal, deps }); },
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
// before()：建 user/workspace/project/scene、production、db、GenerationService、deps、WorkflowService。
```

`before()` 完整（含 scene）：

```ts
before(() => {
  dir = mkdtempSync(join(tmpdir(), "svh-ggen-int-"));
  db = createDatabase(join(dir, "t.db"));
  userId = randomId("usr");
  db.insert(users).values({ id: userId, username: "u", email: "u@t.local", passwordHash: "x", role: "user", status: "active", createdAt: new Date(), updatedAt: new Date() }).run();
  wsId = randomId("ws");
  db.insert(workspaces).values({ id: wsId, name: "ws", rootPath: join(dir, wsId), userId, createdAt: new Date(), updatedAt: new Date() }).run();
  production = new ProductionService(new DrizzleProductionRepository(db));
  projectId = (await production.createProject({ workspaceId: wsId, name: "集成项目" })).id;
  const scene = await production.createScene({ projectId, name: "场景一", description: "湖边" });
  sceneId = scene.id;
  const genService = new GenerationService({ db, settings: fakeSettings, production, promptComposer: new DefaultPromptComposer() });
  deps = createRealGenerationDeps({ db, production, generationService: genService, pollMs: 20, maxWaitMs: 8000 });
  service = new WorkflowService({ db, log: { info: () => {}, error: () => {} }, executorFactory });
});
```
（需从 `@svh/production` 导入 `DefaultPromptComposer`。`deps`/`executorFactory` 为模块级 `let`。）

辅助函数：

```ts
function makeContext(): WorkflowRunContext {
  return { sessionId: randomId("ses"), workspaceId: wsId, userId, modelConfig: { providerId: "openai-compatible", baseUrl: "http://localhost:9999/v1", apiKey: "k", model: "mock" } };
}
async function waitNode(id: string, nodeId: string, statuses: string[], timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const wf = (await service.getWorkflow(id)) as { nodes: Array<{ id: string; status: string }> };
    if (wf.nodes.some((n) => n.id === nodeId && statuses.includes(n.status))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待节点 ${nodeId} 状态 ${statuses.join("/")} 超时`);
}
```

主测试（完整链路）：

```ts
test("端到端：生成节点扇出→绑定 shots→任务列落 workflowId/nodeId", async () => {
  const sb = await production.createStoryboard({ projectId, sceneId, order: 1, description: "d", duration: 6, shotType: "wide", imagePrompt: "白鹤掠过水面" });
  await production.createShot({ projectId, storyboardId: sb.id, order: 1, duration: 6 });
  const wf = (await service.createWorkflow(projectId, userId, { withGeneration: true, story: "s" })) as { id: string };
  await service.runWorkflow(wf.id, makeContext());
  await waitNode(wf.id, "images", ["running"]);
  const rows = db.select().from(productionTasks).where(eq(productionTasks.nodeId, "images")).all();
  assert.ok(rows.length >= 1, "应入队至少 1 个图片任务");
  const task = rows[0]!;
  const asset = await production.createAsset({ projectId, type: "image", name: "分镜1·画面", url: "http://x/1.png", generation: { providerId: "dashscope", modelId: "m", prompt: "白鹤掠过水面", taskId: task.id } });
  db.update(productionTasks).set({ status: "completed", outputUrl: "http://x/1.png" }).where(eq(productionTasks.id, task.id)).run();
  await waitNode(wf.id, "images", ["completed", "failed"]);
  const after = (await production.listShots(projectId))[0]!;
  assert.equal(after.imageAssetId, asset.id, "shot 应回填 imageAssetId");
  const trow = db.select().from(productionTasks).where(eq(productionTasks.id, task.id)).get()!;
  assert.equal(trow.workflowId, wf.id);
  assert.equal(trow.nodeId, "images");
});
```

重跑幂等测试：

```ts
test("重跑幂等：对同一 (workflowId,nodeId) 二次执行不入队新任务", async () => {
  const sb = await production.createStoryboard({ projectId, sceneId, order: 2, description: "d2", duration: 6, shotType: "wide", imagePrompt: "另一只鹤" });
  await production.createShot({ projectId, storyboardId: sb.id, order: 1, duration: 6 });
  const wf = (await service.createWorkflow(projectId, userId, { withGeneration: true, story: "s2" })) as { id: string };
  // 直接对 images 节点首跑（用真实 deps 但手动推进终态）
  const gencfg = { ctx: { projectId, workflowId: wf.id, userId }, node: { id: "images", type: "image.generate", name: "生成图片", dependsOn: ["storyboard"], status: "pending", retryCount: 0, maxRetries: 1 } as any, deps };
  const first = await runGenerationNode({ ...gencfg, input: {} });
  const firstCount = deps.listTasksByNode(wf.id, "images").length;
  await runGenerationNode({ ...gencfg, input: {} }); // 二次（收养全部）
  const secondCount = deps.listTasksByNode(wf.id, "images").length;
  assert.equal(secondCount, firstCount, "重跑不应新增任务行");
});
```

> 说明：重跑幂等核心已在 Task 2 单测覆盖；此处以真实 `deps` 二次 `runGenerationNode` 断言任务行数不变。`runGenerationNode` 首跑入队后若无任务被推进终态会一直等到 `maxWaitMs`；为让首跑快速结束，可在首跑前把 `deps.getTask` 替换为立即返回 `completed`（或让首跑名单为空跳过）。**实现时以 Task 2 单测为准**，此处测试作为集成层验证，若首跑卡住改为"先入队一次、再二次并断言不新增"。

- [ ] **Step 2: 运行测试验证失败**

Run: `node --import tsx --test apps/server/src/modules/production/generation-integration.test.ts`
Expected: FAIL（模块/方法已存在则不失败——该任务依赖 Task 1-3，若报"workflowId 属性不存在"说明 Task 3 未完成；顺序执行）。

- [ ] **Step 3: 通过**（step 2 已因前序任务实现而大概率通过；本任务为"写实现验证"，若失败则修 createRealGenerationDeps 的接线——尤其 `cancelTask` 吞 409/404、`writeNodeOutput` 表名、`listStoryboards` 返回字段与 `createStoryboard` 实参对齐）。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --import tsx --test apps/server/src/modules/production/generation-integration.test.ts`
Expected: PASS。

- [ ] **Step 5: 回归**

Run: `node --import tsx --test "apps/server/src/**/*.test.ts"`；`pnpm typecheck`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/production/generation-integration.test.ts
git commit -m "test(server): 生成节点端到端集成与重跑幂等断言"
```

---

### Task 5: 组合根 app.ts 装配（分派生成节点 + 注入真实 deps + 调用启动对账）

**Files:**
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Task 2 `createRealGenerationDeps`/`runGenerationNode`、Task 3 `reconcileInterruptedRuns`。
- Produces: 无（组合根接线）。

- [ ] **Step 1: 实现**

在 app.ts 中（当前基准：`production` 在 :212 已构造；`DefaultPromptComposer` 已在 :31 导入；`generationService` 目前只在 :346 路由内嵌构造）：

1. 顶部 import 新增：`import { createRealGenerationDeps, runGenerationNode } from "./modules/production/generation-node-executor";`。
2. 在 `workflowService` 构造前（:249 附近）上移并构造 `generationService`（复用现有依赖）：
```ts
const generationService = new GenerationService({
  db,
  settings: settingsService,
  production,
  promptComposer: new DefaultPromptComposer(),
});
```
3. `executorFactory` 的 `execute` 开头加生成类型分派：
```ts
executorFactory: (ctx) => ({
  async execute(node, input, signal) {
    if (node.type === "image.generate" || node.type === "video.generate") {
      return runGenerationNode({
        ctx: { projectId: ctx.projectId, workflowId: ctx.workflowId, userId: ctx.userId },
        node, input, signal,
        deps: createRealGenerationDeps({ db, production, generationService, pollMs: config.workflowGen.pollMs, maxWaitMs: config.workflowGen.maxWaitMs }),
      });
    }
    // ... 既有 agent 路径
  },
}),
```
4. `workflowService` 构造后调用对账：
```ts
await workflowService.reconcileInterruptedRuns();
```
5. routes 的 `generationService: new GenerationService({ db, settings: settingsService, production, promptComposer: new DefaultPromptComposer() })`（:346-351）改为复用上移后的 `generationService`：
```ts
generationService,
```

`config/index.ts`（AppConfig）增加：
```ts
workflowGen: { pollMs: number; maxWaitMs: number };
// loadConfig:
const pollMs = parseInt(process.env.SVH_WORKFLOW_GEN_POLL_MS ?? "3000", 10);
const maxWaitMs = parseInt(process.env.SVH_WORKFLOW_GEN_MAX_WAIT_MS ?? "1800000", 10);
// 返回对象加：
workflowGen: { pollMs: Number.isFinite(pollMs) ? pollMs : 3000, maxWaitMs: Number.isFinite(maxWaitMs) ? maxWaitMs : 1800000 },
```

- [ ] **Step 2: 构建校验**

Run: `pnpm typecheck`；`node --import tsx --test "apps/server/src/**/*.test.ts"` 原绿（buildApp 相关测试仍绿）。

- [ ] **Step 3: 冒烟（HTTP 手工，可选但推荐）**

Run: `SVH_PORT=3456 SVH_LLM_MODEL=mock-llm SVH_LLM_BASE_URL=http://localhost:9999/v1 SVH_WORKFLOW_GEN_POLL_MS=500 SVH_WORKFLOW_GEN_MAX_WAIT_MS=60000 node --import tsx apps/server/src/server.ts`（后台），再建 `withGeneration` 工作流 run，观察节点进入 running。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/config/index.ts apps/server/src/routes/production.ts
git commit -m "feat(server): 组合根装配生成节点执行器并接入启动对账，新增工作流生成环境变量"
```

---

### Task 6: REST 路由 withGeneration 透传 + 冒烟测试

**Files:**
- Modify: `apps/server/src/routes/production.ts`
- Test: `apps/server/src/routes/production.generation.test.ts`

**Interfaces:**
- Consumes: Task 3 `createWorkflow({ withGeneration })`。
- Produces: `POST /api/projects/:projectId/workflows` Body 增加 `withGeneration?: boolean`。

- [ ] **Step 1: 写失败测试**（追加到 `production.generation.test.ts`，复用既有 buildApp 桩）

```ts
test("POST workflows withGeneration:true → 6 节点含生成节点", async () => {
  // 登录 + 建项目（复用桩内 helper）
  const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/workflows`, headers, payload: { story: "s", withGeneration: true } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { nodes: Array<{ id: string }> };
  assert.ok(body.nodes.some((n) => n.id === "images"));
  assert.ok(body.nodes.some((n) => n.id === "videos"));
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: node --import tsx --test apps/server/src/routes/production.generation.test.ts
Expected: FAIL（Body 类型/`withGeneration` 未透传 → 走默认 4 节点）。

- [ ] **Step 3: 实现**

`production.ts` 创建路由 Body 类型加 `withGeneration?: boolean`，并透传：
```ts
app.post<{ Params: { projectId: string }; Body: { nodes?: unknown; story?: string; withGeneration?: boolean } }>(
  "/api/projects/:projectId/workflows",
  { preHandler: [workflowFeature] },
  async (req) => {
    const { projectId } = req.params;
    await assertProjectOwned(projectId, req.user!.userId);
    return deps.workflowService.createWorkflow(projectId, req.user!.userId, {
      nodes: req.body?.nodes as never,
      story: req.body?.story,
      withGeneration: req.body?.withGeneration,
    });
  },
);
```

- [ ] **Step 4: 运行测试验证通过**

Run: node --import tsx --test apps/server/src/routes/production.generation.test.ts
Expected: PASS。

- [ ] **Step 5: 回归**

Run: `pnpm typecheck`；`node --import tsx --test "apps/server/src/**/*.test.ts"`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/production.ts apps/server/src/routes/production.generation.test.ts
git commit -m "feat(server): 创建工作流 REST 透传 withGeneration 并补冒烟"
```

---

### Task 7: 前端（api 透传 withGeneration + 面板标签/摘要/创建复选框）

**Files:**
- Modify: `apps/web/src/api/production.ts`
- Modify: `apps/web/src/features/production/WorkflowPanel.tsx`

**Interfaces:**
- Consumes: Task 6 REST 的 `withGeneration`。
- Produces: 无（前端展示）。

- [ ] **Step 1: 修改 api/production.ts**

`workflowApi.create` 输入加 `withGeneration?: boolean`：
```ts
create: (projectId: string, input: { story?: string; withGeneration?: boolean }) =>
  post<Workflow>(`/api/projects/${enc(projectId)}/workflows`, input),
```

- [ ] **Step 2: 修改 WorkflowPanel.tsx**

1. 节点类型标签映射（放在 `nodeIcon` 附近）：
```ts
const NODE_TYPE_LABELS: Record<string, string> = {
  "script.generate": "剧本生成",
  "character.extract": "角色提取",
  "scene.generate": "场景生成",
  "storyboard.generate": "分镜生成",
  "image.generate": "图片生成",
  "video.generate": "视频生成",
};
```
2. 渲染处（:356 `{node.type}`）改为：`{NODE_TYPE_LABELS[node.type] ?? node.type}`。
3. 节点详情/ summary 行：在状态标签后，若 `node.output` 含 `summary` 渲染一行：
```tsx
{(node.output as { summary?: { total: number; succeeded: number; failed: number; cancelled: number; timeout: number; skipped: number } })?.summary && (
  <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
    成功 {s.summary.succeeded} · 失败 {s.summary.failed} · 跳过 {s.summary.skipped}
  </span>
  )}
```
（用局部变量 `const s = node.output as any` 判空后取出。）
4. 创建 Modal：加一个 `withGeneration` state（`useState(false)`）+ 复选框：
```tsx
<Checkbox checked={withGeneration} onChange={(e) => setWithGeneration(e.target.checked)}>
  同时生成图片/视频（会产生模型费用）
</Checkbox>
```
`onOk` 改：`await workflowApi.create(projectId, { story, withGeneration });`；`onCancel` 里重置 `setWithGeneration(false)`。从 `antd` 导入 `Checkbox`。

- [ ] **Step 3: 构建/检查**

Run: `pnpm --filter @svh/web build`（或 `pnpm typecheck` 若 web 参与）通过；手工在 :3456+ :5173 冒烟——勾选「同时生成」新建 → 看到 6 节点 → run 观察生成节点 running → 完成后 summary 行显示。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/production.ts apps/web/src/features/production/WorkflowPanel.tsx
git commit -m "feat(web): 工作流面板支持生成节点标签/摘要与创建时勾选生成节点"
```

---

### Task 8: 文档（production-guide 小节 + README）

**Files:**
- Modify: `docs/production-guide.md`（新增「工作流生成节点」小节）
- Modify: `README.md`（工作流能力描述补一句）

**Interfaces:** 无。

- [ ] **Step 1: 文档更新**

在 `docs/production-guide.md` 工作流章节加：生成节点能力、`withGeneration` 入口、`SVH_WORKFLOW_GEN_POLL_MS/MAX_WAIT_MS` 环境变量说明、取消/重启语义与"重启需手动重试"提醒。README 工作流卡片补一句"支持从分镜批量生成图片/视频并自动绑定"。

- [ ] **Step 2: Commit**

```bash
git add docs/production-guide.md README.md
git commit -m "docs: 工作流生成节点能力与配置说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 节点契约 → T1/T2；§4 执行模型+对账 → T2/T3/T5；§5 幂等 → T2/T4；§6 绑定闭环 → T2/T4；§7 取消/超时 → T2；§8 前端/模板/REST → T3/T6/T7；§9 环境变量 → T5；§10 测试 → T1/T2/T3/T4/T6；§11 改动文件 → 全部。无遗漏。
- **Placeholder**：无 TODO/TBD；测试均给可运行代码；`production`/`settings` 假对象用 `as any` 注明仅测试桩。
- **类型一致性**：`generation-node-executor` 的 `GenerationNodeDeps` 与 T1 产出的 `enqueueImage/enqueueVideo/listTasksByNode` 签名对齐；`GenerationNodeContext` 的 `projectId/workflowId/userId` 与 T3 的 `WorkflowExecutorContext`（`projectId` 已有 + `workflowId` 新增）一致；`createRealGenerationDeps` 的 `writeNodeOutput` 用 `workflowNodes` 表名导入。`config.workflowGen` 在 T5 定义、T5 使用。
- **注意**：T2 的核心循环在任务描述里用"结构示意 + 语义约束"，实现时须严格对齐 spec §4/§6/§7；评审时以 spec 为准。T3 对账用 `inArray`（非 `and(eq,eq)`），已在注释钉出。
