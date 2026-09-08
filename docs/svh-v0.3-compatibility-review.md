# SVH V0.3 兼容性评审报告（Phase 0）

> 本文档是 V0.3 实施前的「当前代码兼容性评审」，对应实施文档「§0 / 实施顺序 Phase 0」。
> 目标：核实 V0.2 的真实代码结构，明确每个 V0.3 概念应落在哪些文件、哪些是复用、哪些是扩展，避免重复建设。
> 结论优先兼容当前代码结构，不强行套用实施文档中的路径。

---

## 一、代码结构总览（已核实）

```text
svh/
├── apps/
│   ├── web/          # React 18 + Vite + AntD + TanStack Query（制作中心 / 工作台）
│   ├── server/       # Fastify + SSE + 生产/工作流编排 + 生成任务入队（GenerationService）
│   └── worker/       # 生成任务队列 worker（认领 / 心跳 / stale 接管 / 执行图片/视频生成）
├── packages/
│   ├── core/         # Agent Runtime / Loop / Profile / ContextBuilder / Workflow 状态机
│   ├── production/   # 纯领域包：Project/Script/Character/Scene/Storyboard/Shot/Asset + Service + Repository Port + sqlite 适配
│   ├── database/     # Drizzle schema（workspaces/sessions/settings/production/workflow 等）
│   ├── providers/    # LLM / Image / Video Provider 接口 + Registry
│   ├── tools/        # Tool 抽象 + Registry + 文件工具 + 16 个生产工具
│   ├── workspace/    # WorkspaceManager / FileManager（安全路径）
│   └── shared/       # 共享类型 / randomId
└── docs/             # production-guide.md
```

依赖方向：`shared ← database ← production ← {workspace,providers,tools} ← core ← server ← web`。

分层纪律（V0.2 已有，V0.3 必须保持）：
- `packages/production` 纯领域：**禁止 SQL / HTTP / AI / React**；只有 `service.ts`（编排+规则）+ `repository.ts`（Port）+ `sqlite-repository.ts`（drizzle 适配）。
- `packages/core` 只依赖纯数据对象，禁止 Fastify/React 进 Core。
- `server ↔ worker` 经 **JSON 契约**（`TaskPayload`）解耦，双端手写字面量、刻意不跨包 import。
- Web 不依赖 server 包：`apps/web/src/types/production-types.ts` 是领域类型镜像。

---

## 二、逐个 V0.3 概念的当前实现 → 落点映射

### 1. Production Context（Phase 1）

**现状**：
- 唯一的 Context 构建在 `packages/core/src/context/context-builder.ts`。
- 当前 `build()` 顺序：`DEFAULT_SYSTEM_PROMPT` → 可选 Agent Profile systemPrompt → `VIDEO_AGENTS.md` → Workspace Summary（根目录文件列表）→ 最近 50 条历史消息 → 当前用户消息。
- `AgentRunInput`（`packages/core/src/agent/agent-types.ts`）只有 `sessionId / workspaceId / userMessage / modelConfig / profile` —— **没有 projectId，也没有任何 Production 概念**。
- `ContextBuilder` 完全不感知 Project/Script/Character/Scene/Storyboard/Shot。

**结论**：V0.2 **没有** Production Context。实施文档「§5 recommended ContextBuilder + ProductionContextBuilder」的骨架在当前代码里**不存在**，需要新建。这不算“第二套 Context 系统”，而是给**现有 `ContextBuilder`** 增加一个可选的 Production 投影注入（文档明确允许）。

**落点建议**：
- 扩展 `packages/core/src/context/context-builder.ts`（增加一个可选的生产上下文注入点）**或**新增 `ProductionContextBuilder`/`ProductionContextResolver` 放在 `packages/production/src/context/`（更贴合“纯领域”分层，且不污染 core）。
- 因为 Core 不能依赖 production，推荐：`ProductionContextResolver` 放 `packages/production`（面向 Agent 的投影，纯数据），由 **server 层**在构造 `ContextBuilder` 或组装 `AgentRunInput` 时调用并注入，不改 Core 的依赖方向。

> ⚠️ 设计决策点：Context 注入位置。是 (A) 在 `ContextBuilder` 里加可选 hook（Core 只收纯数据投影，不含 production import），还是 (B) server 层在调用 Runtime 前先构建 ProductionContext 并作为 `modelConfig`-like 参数传下去。推荐 (B)：Core 完全不动，生产上下文由 server 组装。

### 2. Prompt Composition（Phase 2）

**现状**：
- 生成入口在 `apps/server/src/routes/production.ts` 的 `generate-image` / `generate-video`，直接调 `GenerationService.enqueueImage/enqueueVideo`。
- `apps/server/src/modules/production/generation-service.ts`：**直接接收端到端 prompt**（`input.prompt`），校验后连带 model/baseUrl/apiKey 拼进 `TaskPayload` 落库。
- `apps/worker/src/handlers.ts`：`runImageTask` 直接 `provider.generate({ model, prompt: p.prompt, size })`；`runVideoTask` 直接 `provider.createTask({ model, prompt: p.prompt, ... })`。
- Storyboard 已有 `imagePrompt` / `videoPrompt` 字段（用户/Agent 可以手填），但生成链路**不做任何组合/注入**。

**结论**：实施文档「§13.2 禁止直接拼字符串」的现状，V0.2 **正是直接拼字符串**——`GenerationService` + `worker` + `Provider` 都只是透传 prompt。没有任何 `PromptComposer`。这必须新建。

**落点建议**：
- 新增 `packages/production/src/prompt/`：`PromptComposer` 接口 + `ImagePromptComposer` / `VideoPromptComposer` / `PromptTemplate`（纯领域，无 HTTP/AI）。
- 在 **server 层**（`GenerationService.enqueue` 之前的入队路径）调用 composer 生成最终 prompt + negative + metadata，作为 `TaskPayload` 的新字段（`composedPrompt` / `composedNegative` / `promptMetadata`）传递；worker 端改用 payload 里的已组合 prompt。
- 这样 worker 不含业务 Prompt 逻辑（实施文档禁止项），Provider 也不含生产逻辑。

### 3. Character Consistency（Phase 3）

**现状**（`packages/production/src/character/character-types.ts` + `service.ts`）：
- `Character`：`id / projectId / name / description / appearance{gender,age,hairstyle,clothing,facialFeatures,style} / personality / referenceAssetId`。
- 没有 `visualPrompt` / `negativePrompt` / `promptAnchor` / `referenceAssets[]`（只有单个 `referenceAssetId`）。

**结论**：需要**扩展**现有 `Character`（实施文档明确“禁止新建 Character Entity”）。
- 需要 `CharacterVisualProfile`（appearancePrompt / identityPrompt / costumePrompt / stylePrompt / negativePrompt / referenceAssetIds）。
- 需要 `Character Prompt Anchor`（从 appearance 派生或直接存储的稳定描述段）。

**落点建议**：
- 扩展现有 `character-types.ts` 与 `service.ts`（新增字段 + normalize/validate），同时扩展数据库表 `production_characters`（drizzle 加列）。
- `ReferenceResolver`：放 `packages/production`（判断 Provider 是否支持 reference，不支持则回退 prompt anchor）。Provider 能力判定需要读取 provider 接口（`packages/providers`），可在 server 层注入一个 `providerCapabilities` 函数。

### 4. Visual Style（Phase 4）

**现状**：
- `ProductionProjectSettings`：`{ duration?, style?, generation? }`，`style` 是**单个字符串**（如 `"chinese_fantasy"`）。
- 没有结构化 `VisualStyleProfile`（visualPrompt / lighting / colorTone / cameraStyle / renderingStyle / negativePrompt）。
- Style 继承/覆盖优先级（Shot > Scene > Project > Global）**不存在**。

**结论**：扩展 `ProductionProject`（settings 增加结构化 style）或新增 `VisualStyleProfile`，推荐新增独立 Profile 表/结构，保持 settings.style 兼容。

**落点建议**：
- 新增 `VisualStyleProfile` 领域类型 + service 方法；数据库加 `production_visual_styles` 表或作为 project 的 JSON 列。
- `StyleResolver`（场景/镜头覆盖解析）+ `Style Prompt Injection`（并入 `PromptComposer`）。

### 5. Generation Review / History / Version（Phase 5）

**现状**：
- 无任何 generation 历史/版本/review 概念。
- `ProductionTaskStatus` = `queued/running/completed/failed/cancelled`；`ProductionAsset` 有 `generation{providerId,modelId,prompt,taskId}`（单次记录，无版本）。
- Shot 有 `imageAssetId / videoAssetId`（直接指向 asset，无“多个版本+选中”）。
- Workflow 状态机已有 `waiting_user` 状态（`workflow-node.ts` WORKFLOW_TRANSITIONS），但执行器 `workflow-executor.ts` 只把它当**普通运行中**状态处理，**没有真正阻塞等待用户审核**的节点类型。

**结论**：需要新增：
- `GenerationRecord` / `GenerationVersion`（一次生成一个记录带版本号，可复用/回放）。
- `GenerationReviewStatus`（pending/generating/generated/reviewing/approved/rejected/replaced）**与** `TaskStatus` 分离（实施文档明确要求分离）。
- Review 动作（approve/reject/regenerate/replace/修改 prompt）。
- Shot 的**已选中 asset**（多版本并存，不覆盖旧 asset）。

**落点建议**：
- 新增数据库表 `generation_records`（一次生成 = 一行：provider/model/prompt/negative/inputRef/taskId/输出 asset/status/createdAt）+ `generation_versions`（关联 shot，版本号 + 记录 + selected 标记）。或合并为一张 `generation_records` 带 `shotId/version/status/selected`。
- Shot 增加“当前选中 asset”字段（`selectedImageAssetId/selectedVideoAssetId` 或保留 `imageAssetId/videoAssetId` 作为“选中”的语义，另加版本列表）。
- Workflow 增加 `waiting_user` 节点类型 + 真正的“等待审核/恢复”机制（现有 `waiting_user` 状态机已预留，但执行器需支持 Blocking。这是 Phase 5/6 的关键扩展点）。

### 6. Generation Orchestration（Phase 6）

**现状**：
- 队列 `production_tasks`（`packages/database/src/schema/production.ts` 之外，实际在 workflow schema 或独立表；worker `queue.ts` 用 SQLite 作为队列）。
- **没有** `GenerationPlan`（storyboard → plan → batch）。
- 无 per-provider / per-project 并发限制（worker 每次 `claimTasks(limit)`；并发由 worker 进程/轮询控制；无全局/provider/project 分层的并发预算）。
- 无 Provider fallback 链路（单个 provider，失败即 failed，无重试primary→fallback→failed 的编排）。

**结论**：`GenerationPlan` / 批量生成 / 并发预算 / provider fallback 都是**新增**。需要：
- `GenerationPlan`（项目 → plan items：shotId/type/priority/dependencies/providerPreference/status）。
- 批量入队（scene/storyboard/selected/all pending）。
- 并发预算（global/provider/project）。
- Provider fallback（retry primary → fallback → failed）。

**落点建议**：
- `GenerationPlan` 纯领域放 `packages/production`；批量入队编排放 **server** 层（`GenerationService` 或新 `GenerationOrchestrator`）。
- 避开“直接在 server 进程内 for-await 全量生成”——V0.2 已经是「任务队列 + worker」架构，应**继续用队列**：`GenerationOrchestrator` 负责把 plan 转成多条 `production_tasks` 入队，并发/fallback 由队列与 worker 层实现。
- Provider fallback：可在入队时解析出候选 provider 序列写进 payload，worker 端按序失败重试。

### 7. Web UI（Phase 5/6 审核与生成）

**现状**（`apps/web/src/features/production/panels.tsx`）：
- `ScriptsPanel / CharactersPanel / ScenesPanel / StoryboardsPanel / AssetsPanel`。
- `AssetsPanel`：有生成表单（输入 prompt → 选模型 → 生成 → 任务条轮询 → 结果入库资产），**没有**多版本、无 Approve/Reject/Regenerate/Replace，无 Prompt Inspector。
- `WorkflowPanel`：SSE 实时节点状态 + 暂停/恢复/取消/重试。
- 生成入口在 AssetsPanel 用**自由 prompt**，与 Storyboard/Shot 无绑定。

**结论**：需要新增/重构：
- `Shot Detail Panel`（镜头：描述/角色/场景/相机/Prompt/References/Generated Assets/Review）。
- `Prompt Inspector`（展示 Project Style + Scene + Character + Shot + Camera → Final，可查看/复制/修改/重生成）。
- `Generation Review UI`（v1/v2/v3 卡片 + Approve/Regenerate/Replace；最终一个 Selected Asset）。

**落点建议**：
- 在 `apps/web/src/features/production/` 新增 `ShotDetailPanel` / `PromptInspector`（或在新组件里组合），复用现有 Design Token（`--color-*`）、AntD 组件与 `productionApi`。
- 新增 web 类型（`apps/web/src/types/production-types.ts` 扩展：generation record/version/review/style profile），新增 `productionApi` 方法。

### 8. Tool 系统（实施文档 §42）

**现状**（`packages/tools/src/tool.ts` + `production/*`）：`Tool` 抽象（name/description/inputSchema/execute + ToolContext{workspaceId,sessionId,workspaceRoot}），Registry，16 个生产工具。工具在 server 层由 Agent Runtime 注入（`run-service`）。Profile 白名单控制可用工具。

**结论**：V0.3 可新增工具（`get_production_context` / `update_character_visual_profile` / `set_character_reference` / `set_project_visual_style` / `preview_prompt` / `regenerate_asset` / `approve_generation` / `reject_generation` / `replace_asset`），**复用**现有 `Tool` 接口 + Registry + Profile 白名单，不建第二套 Tool 系统。注意：现有 `ToolContext` 没有 `projectId`，若新工具需要 project 上下文需在调用时解析（从执行时的会话/工作区定位，或扩展 context）。

---

## 三、数据库变更清单（实施文档 §41）

现有 `production.ts` 表：`production_projects / production_scripts / production_characters / production_scenes / production_storyboards / production_shots / production_assets`。另有 `production_tasks`（在 workflow schema，需核实）与 workflow 表。

需要**新增/扩展**（建议）：
- `production_characters`：加 `visualProfile`（json，prompt anchor 等）或独立 `character_visual_profiles` 表。
- `production_projects`：`settings` json 增加结构化 style，或 `production_visual_styles` 表。
- `production_scenes`：加 `environment / atmosphere / visualPrompt`（json 或列）。
- `generation_records`（一次生成一行，含 provider/model/prompt/negative/inputRef/taskId/输出asset/status/createdAt）。
- `generation_versions` 或 `generation_records` 内置 `shotId/version/status(approved/rejected)/selected`。
- `production_shots`：加 `selectedImageAssetId / selectedVideoAssetId`（或复用现有 imageAssetId/videoAssetId 作为“当前选中”，同时保留版本列表）。

> 具体表结构需在实施时按 drizzle 现有约定（`text` 存 JSON + `mode:"json"`、`integer` 时间戳）落地，并写 schema 迁移。注意：V0.2 用 SQLite + drizzle；添加列应提供幂等迁移。

---

## 四、核心设计决策（需用户确认后再实施）

1. **Production Context 注入位置**：推荐 `ProductionContextResolver` 放 `packages/production`，server 层在调用 Runtime 前组装并注入，Core 完全不动（维护现有依赖方向）。
2. **Prompt 组合归属**：`PromptComposer` 放 `packages/production`（纯领域），server 层入队前调用；worker 消费已组合好的 prompt，**不在 worker 拼 prompt**。
3. **数据库结构**：`GenerationRecord` + `GenerationVersion` 是「一次生成 = 一条记录」+「版本与选中」两个维度。倾向一张 `generation_records` + shot 上的「当前选中 asset」字段，避免过度建模。
4. **Review 状态 vs Task 状态**：分离。`production_tasks`（执行）与 generation 记录（审核）各管各的；Shot 的「选中资产」作为最终产物。
5. **Workflow 人类审核**：现有 `waiting_user` 状态已预留，但执行器无「阻塞等待」节点类型。需要新增一个 Blocking 的能力（或复用 run/pause 机制），这是 Phase 5/6 的关键增量。
6. **实施顺序**：严格按文档 Phase 1→7；每个 Phase 完成 typecheck/lint/test/build。**建议每个 Phase 一个独立 commit。**

---

## 五、V0.2 已具备、V0.3 必须**复用**（禁止重写）

- Agent Runtime / Loop（`packages/core/src/agent/agent-runtime.ts`、`agent-loop.ts`）。
- ContextBuilder（`packages/core/src/context/context-builder.ts`）——只扩展，不重写。
- Provider Registry 与 Image/Video Provider 接口（`packages/providers/src/*`）。
- Workflow 状态机/执行器（`packages/core/src/workflow/*`）——只扩展 node 类型与 `waiting_user`，不重写。
- 生产领域包 `packages/production`（实体/service/repository）——只扩展。
- 任务队列 + `apps/worker`（认领/心跳/stale 接管/本地化）——只扩展。
- Tool 抽象 + Registry + Production Tools —— 只新增工具，复用接口。
- Web 制作中心 + 六面板 + WorkflowPanel —— 只扩展/重构相关面板。

---

## 六、结论

V0.2 有一个清晰、可扩展的生产底座，但**没有任何生产上下文、Prompt 组合、角色/风格一致性、生成审核/版本、批量编排**。这些正是 V0.3 的新增点，全部应**在现有分层之上增量落地**，禁止新建平行系统。

建议落地路径（与实施文档一致）：
- **Phase 1**：`ProductionContext`（领域投影 + Resolver + 注入 server 组装）。
- **Phase 2**：`PromptComposer`（Image/Video + 领域组合 + server 入队前调用 + worker 消费）。
- **Phase 3**：`CharacterVisualProfile` + `PromptAnchor` + `ReferenceResolver`。
- **Phase 4**：`VisualStyleProfile` + `StyleResolver` + 注入。
- **Phase 5**：`GenerationRecord/Version` + Review 状态 + 审核动作 + `waiting_user` 工作流节点。
- **Phase 6**：`GenerationPlan` + 批量生成 + 并发预算 + Provider fallback。
- **Phase 7**：类型/测试/重构/文档。

每个 Phase 需独立验证（typecheck/lint/test/build），并保持旧 Production 功能兼容。
