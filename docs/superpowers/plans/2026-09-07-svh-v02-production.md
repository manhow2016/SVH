# SVH V0.2 AI 短剧生产系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 SVH Harness（Agent Runtime / Session / Workspace / Tool Registry / Provider Registry / Membership / Web 基础架构）的前提下，增量引入生产领域模型、专业 Agent Profile 与 Workflow Engine，使 SVH 从通用 AI Agent Harness 升级为 AI Video Production Harness。

**Architecture:** 新增 `packages/production`（纯领域：类型 + 规则 + 仓储 Port，无 DB/SQL/HTTP/AI）；`packages/database` 增加生产数据表；`packages/tools/src/production/` 提供领域操作工具（依赖注入 Port 实现）；`packages/core` 增加 AgentProfile 注入（小改）与 `workflow/` 纯状态机引擎；`packages/providers` 增加 image/video 能力目录；`apps/server` 增加 production 模块（drizzle 仓储实现 + 路由 + 工作流执行器 + 生成服务）；`apps/web` 增加制作中心页面。依赖方向保持 `shared ← database ← workspace/providers/tools/production ← core ← server ← web`，无循环。

**Tech Stack:** TypeScript 5.8 (strict) / pnpm 11 / Node 24 / Fastify 5 / drizzle + better-sqlite3 / React 18 + antd 5.25 + zustand + TanStack Query / node:test + tsx。

**Spec:** 本文档即为实施规格（用户提供的《SVH V0.2 AI 短剧生产系统技术实施文档》，见对话记录；本计划的所有「接口」均从该规格推导，执行者以本文档为准）。

---

## Global Constraints

- 禁止推翻现有架构：不删除现有 packages、不重写 Agent Runtime / Provider Registry / Tool Registry / Membership。
- 依赖方向：`shared ← database ← workspace/providers/tools/production ← core ← server ← web`；如与现状冲突，遵循「最小改动、保持依赖单向、避免循环依赖」。
- Production Domain（packages/production）禁止：OpenAI/DeepSeek API 调用、HTTP 请求、React UI、数据库 SQL（drizzle query builder 只在 server 仓储实现中使用；production 包只声明 Port 接口）。
- 新表必须关联 `workspace_id` 与 `user_id`（冗余 user_id 便于未来团队协作，写入时从 workspace 行取值）；归属校验走 workspace→user 传递（与 sessions 一致），路由层 `getOwned` 风格 404 不泄漏存在性。
- 表创建 = 4 处同步：`packages/database/src/schema/production.ts`（drizzle 定义）+ `schema/index.ts` 导出 + `client.ts` INIT_SQL（CREATE TABLE IF NOT EXISTS + 索引）+ 服务/路由/注册。严禁对 `settings` 表使用 `onConflictDoUpdate({ target: settings.key })`（drizzle 与真实 DB 复合主键漂移）。
- ID 使用 `@svh/shared` 的 `randomId(prefix)`；新前缀：`prj`(project) / `sct`(script) / `chr`(character) / `scn`(scene) / `sbd`(storyboard) / `sht`(shot) / `ast`(asset) / `wfl`(workflow) / `wno`(workflow node) / `ptk`(production task)。
- 时间字段统一 `timestamp_ms`，写入用 `new Date()`；种子时间戳为 0 的坑不适用于新表（新表无种子）。
- 工具错误保持 `{ error: string }` 形状（前端 `isErrorOutput` 与 Agent Loop 错误回传均依赖该形状）；工具 `inputSchema` 仅给模型看，执行前必须自写校验（抛 `ToolError("INVALID_INPUT", ...)`）。
- 事件类型三处镜像（core `agent-events.ts` ↔ web `api-types.ts` ↔ server run-service switch）：V0.2 尽量复用现有 9 种事件，新事件必须三处同步。
- Web 端类型镜像放 `apps/web/src/types/`（注释「web 不依赖 server 包」），任何 server 侧新类型都要同步镜像。
- 代码注释用简体中文；禁 emoji 做 UI 图标（统一 @ant-design/icons）；antd 新代码统一 `destroyOnHidden`（5.25 API）。
- 每个 Phase 完成必须执行：`pnpm -r run typecheck` + `eslint <改动文件>` + `node --import tsx --test <测试文件>`（先征得用户同意） + `pnpm -r run build` + 手动验证核心流程；然后 commit（`type(scope): 中文`）。
- 已知问题（本 V0.2 计划默认不处理，除非用户另行要求）：①INSERT OR IGNORE 种子删后重启复活；②资源无二进制上传/静态媒体服务（Phase 7/8 先存供应商远程 URL）；③ProviderRegistry 跨会话并发覆盖注册窗口；④`session.modelId` 实存 modelName 的语义误导。

---

## Phase 1：代码审查与架构确认（已完成）

4 份只读深度分析报告已产出（Agent Runtime/工具/Workspace、数据库/Server、Provider/模型、Web 前端），关键结论：

1. **Agent Runtime**：`AgentRuntime.run` → `ContextBuilder.build`（DEFAULT_SYSTEM_PROMPT → VIDEO_AGENTS.md → Workspace Summary → 最近 50 条历史 → 当前消息）→ `runAgentLoop`（上限 20 轮，工具结果 JSON.stringify 回传，工具异常不中断）。仓库**无 AgentProfile 概念**；`video-agents.ts` 只是 `DEFAULT_VIDEO_AGENTS_MD` 字符串常量（含 script.md/storyboard.json 产物约定）。
2. **工具**：`Tool { name, description, inputSchema, execute(input, ToolContext) }`；`ToolContext` 固定 `{ workspaceId, sessionId, workspaceRoot }`；注册唯一入口 `app.ts` L131-135；无按角色的工具过滤。**生产工具所需 DB/领域依赖用工厂闭包注入（勿改 ToolContext）**。
3. **Provider**：运行时 providerId 恒为 `"openai-compatible"`（`buildModelConfig` 硬编码，service.ts L210-212）；`ModelProviderMeta` 无 capability 字段、`fixedEndpoint` 是死字段；`ModelType = "text" | "image" | "video" | "audio"` 已有雏形；模型目录种子已含 image/video/audio 模型（seedream/wanx/tts 等）；`Registry<T>` 泛型化是对现有 `ProviderRegistry` 的最小侵入改造。
4. **数据库/Server**：无迁移框架，`createDatabase()` 每次启动重放 INIT_SQL + 手写 migrate；路由约定：无 data 包装、错误 `{error:{code,message,details?}}`、创建 201/删除 204、login/register 顶层 `{token,user}` 唯一例外；SSE 校验必须发生在 `reply.hijack()` 前；所有权校验在路由/编排层（service 查询不过滤用户）；会员功能码 seed 已有 `assets.library` / `workflow.automation` / `agent.basic` 等 10 个。
5. **Web**：手写 hash 路由（无 react-router，精确字符串 switch，需前缀解析支持 `#/production/:id`）；antd 5.25 + CSS 变量 token（11 色） + inline style；react-query + zustand；SSE 手写 `ssePost`（api/run.ts）；弹窗范本 SettingsModal（左导航大 Modal）/ AssetsModal（左右分栏）；权限前端 `membership-store.can(code)` 展示、后端 `requireFeature` 权威校验；Header 40px 放「我的资产/会员中心」入口按钮（制作中心入口同款）。

---

## Phase 2：Production Domain（packages/production + 数据表）

**交付：** 纯领域包（类型 + 规则 + 仓储 Port + ProductionService）+ 7 张生产表 + drizzle 仓储实现 + 各类测试。不影响现有功能（零改动现有模块）。

### 文件结构

```
packages/production/
├── package.json                 # name: "@svh/production", 依赖: @svh/shared (workspace:*)
├── tsconfig.json                # 照抄 packages/tools/tsconfig.json
└── src/
    ├── ids.ts                   # randomId 复用导出（工具类）
    ├── project/project-types.ts # ProductionProject / ProjectType / ProjectStatus / ProjectSettings
    ├── project/project.ts       # 领域规则：默认 settings、状态机、校验函数
    ├── script/script-types.ts   # ProductionScript 等
    ├── script/script.ts
    ├── character/character-types.ts
    ├── character/character.ts
    ├── scene/scene-types.ts
    ├── scene/scene.ts
    ├── storyboard/storyboard-types.ts
    ├── storyboard/storyboard.ts
    ├── shot/shot-types.ts
    ├── shot/shot.ts
    ├── asset/asset-types.ts
    ├── asset/asset.ts
    ├── repository.ts            # ProductionRepository Port（全部仓储方法，纯接口）
    ├── service.ts               # ProductionService（应用领域规则 + 调仓储，无 DB/SQL）
    ├── errors.ts                # ProductionError（领域错误）
    └── index.ts
```

### 核心接口（Phase 2 必须按此签名实现，后续 Phase 依赖）

```ts
// packages/production/src/project/project-types.ts
export type ProjectType = "short_video" | "short_drama" | "animation" | "advertisement";
export type ProjectStatus = "draft" | "planning" | "producing" | "completed" | "archived";
export interface ProductionProjectSettings {
  /** 目标时长（秒） */
  duration?: number;
  style?: string;
  /** AI 生成相关配置（模型名、供应商等由 server 侧生成服务解析，域内只存字符串） */
  generation?: Record<string, unknown>;
}
export interface ProductionProject {
  id: string; workspaceId: string; userId: string;
  name: string; description?: string;
  type: ProjectType; status: ProjectStatus;
  settings: ProductionProjectSettings;
  createdAt: Date; updatedAt: Date;
}
export const PROJECT_TYPES: ProjectType[] = ["short_video", "short_drama", "animation", "advertisement"];
export const PROJECT_STATUSES: ProjectStatus[] = ["draft", "planning", "producing", "completed", "archived"];
export function isProjectStatus(v: unknown): v is ProjectStatus;

// script/script-types.ts
export type ScriptStatus = "draft" | "reviewing" | "approved";
export interface ProductionScript {
  id: string; projectId: string;
  title: string; content: string; version: number;
  status: ScriptStatus; createdAt: Date; updatedAt: Date;
}

// character/character-types.ts
export interface CharacterAppearance {
  gender?: string; age?: string; hairstyle?: string; clothing?: string;
  facialFeatures?: string; style?: string;
}
export interface Character {
  id: string; projectId: string;
  name: string; description: string; appearance: CharacterAppearance;
  personality?: string; referenceAssetId?: string;
  createdAt: Date; updatedAt: Date;
}

// scene/scene-types.ts
export interface ProductionScene {
  id: string; projectId: string; scriptId?: string;
  order: number; name: string; description: string;
  location?: string; time?: string; characters: string[];
  createdAt: Date; updatedAt: Date;
}

// storyboard/storyboard-types.ts
export type StoryboardStatus = "draft" | "approved";
export interface Storyboard {
  id: string; projectId: string; sceneId: string; order: number;
  description: string; duration: number; shotType: string;
  cameraMovement?: string; imagePrompt?: string; videoPrompt?: string;
  status: StoryboardStatus; createdAt: Date; updatedAt: Date;
}

// shot/shot-types.ts
export type ShotStatus = "pending" | "generating" | "ready" | "failed";
export interface ProductionShot {
  id: string; projectId: string; storyboardId: string; order: number; duration: number;
  framing?: string; cameraMovement?: string; action?: string; dialogue?: string;
  imageAssetId?: string; videoAssetId?: string;
  status: ShotStatus; createdAt: Date; updatedAt: Date;
}

// asset/asset-types.ts
export type AssetType = "image" | "video" | "audio" | "document" | "subtitle" | "reference";
export interface AssetGeneration {
  providerId: string; modelId?: string; prompt?: string; taskId?: string;
}
export interface ProductionAsset {
  id: string; projectId: string; workspaceId: string; userId: string;
  type: AssetType; name: string; url?: string; workspacePath?: string; mimeType?: string;
  metadata?: Record<string, unknown>; generation?: AssetGeneration;
  createdAt: Date; updatedAt: Date;
}

// repository.ts —— 仓储 Port（server 用 drizzle 实现；工具/服务只依赖它）
export interface ProductionRepository {
  // project
  createProject(data: Omit<ProductionProject, "id" | "createdAt" | "updatedAt">): Promise<ProductionProject>;
  listProjects(workspaceId: string): Promise<ProductionProject[]>;
  getProject(id: string): Promise<ProductionProject | null>;
  updateProject(id: string, patch: Partial<Omit<ProductionProject, "id" | "workspaceId" | "userId">>): Promise<ProductionProject>;
  // script
  createScript(...): Promise<ProductionScript>;
  listScripts(projectId: string): Promise<ProductionScript[]>;
  getScript(id: string): Promise<ProductionScript | null>;
  updateScript(id: string, patch: ...): Promise<ProductionScript>;
  // character / scene / storyboard / shot / asset 同构（list 均按 projectId 过滤；shots 额外支持 listByStoryboard(storyboardId)）
  deleteAsset(id: string): Promise<void>;
  // 原子性辅助
  transaction<T>(fn: (repo: ProductionRepository) => Promise<T>): Promise<T>;
}

// service.ts —— 领域编排（id 生成用 randomId("prj") 等；校验失败抛 ProductionError）
export class ProductionService {
  constructor(private readonly repo: ProductionRepository) {}
  createProject(input: { workspaceId: string; userId: string; name: string; type?: ProjectType; description?: string; settings?: ProductionProjectSettings }): Promise<ProductionProject>;
  listProjects(workspaceId: string): Promise<ProductionProject[]>;
  getProject(id: string): Promise<ProductionProject>;
  updateProject(id: string, patch): Promise<ProductionProject>;
  // scripts/characters/scenes/storyboards/shots/assets 同构：create/list/get/update /(asset additionally remove)
  // 领域规则示例：
  //   createStoryboard 校验 scene 属于 project；shot.duration ≤ storyboard.duration 总和校验由 updateStoryboard 提供（storyboard.duration 变更时校验）
  //   createShot 校验 storyboard 存在；updateShot 状态机 pending→generating→ready|failed
  //   createAsset 若带 generation 必须至少含 providerId；type 必须属于 AssetType
}
```

### 数据库表（Phase 2 建 7 张；workflows/workflow_nodes/production_tasks 留 Phase 5）

`packages/database/src/schema/production.ts`（drizzle，全部 `text/date`+`timestamp_ms`，外键 `REFERENCES workspaces(id) ON DELETE CASCADE` / `project_id` 同）：

```
production_projects   id PK | workspace_id (idx) | user_id | name | description | type | status | settings(json text) | created_at | updated_at
production_scripts    id PK | project_id (idx) | title | content | version | status | created_at | updated_at
production_characters id PK | project_id (idx) | name | description | appearance(json) | personality | reference_asset_id | created_at | updated_at
production_scenes     id PK | project_id (idx) | script_id | order | name | description | location | time | characters(json) | created_at | updated_at
production_storyboards id PK | project_id (idx) | scene_id (idx) | order | description | duration | shot_type | camera_movement | image_prompt | video_prompt | status | created_at | updated_at
production_shots      id PK | project_id (idx) | storyboard_id (idx) | order | duration | framing | camera_movement | action | dialogue | image_asset_id | video_asset_id | status | created_at | updated_at
production_assets     id PK | project_id (idx) | workspace_id (idx) | user_id | type | name | url | workspace_path | mime_type | metadata(json) | generation(json) | created_at | updated_at
```

INIT_SQL 同步 DDL（`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS idx_production_*`）。

### 测试

- `packages/production/test/*.test.ts`（node:test）：纯规则 —— 默认 settings/状态机/校验函数/`isProjectStatus` 等；Service 用**内存仓储假实现**（`FakeProductionRepository` 于 test 内联）测编排规则（scene 归属校验、shot 状态机、asset generation 校验）。
- `apps/server/src/modules/production/repository.test.ts`（真实临时库，仿 `model-settings.test.ts` 的 `createDatabase(mkdtemp)`）：drizzle 仓储实现 CRUD + 隔离（project 只能按 workspace 列出）。

### Tasks

- [ ] **Task 2.1** production 包脚手架（package.json/tsconfig/index.ts/ids.ts）+ `project/` 域（类型+规则+测试）
- [ ] **Task 2.2** `script/` + `character/` 域（类型+规则+测试）
- [ ] **Task 2.3** `scene/` + `storyboard/` + `shot/` 域（含 storyboard↔shot 时长规则约束、状态机，测试）
- [ ] **Task 2.4** `asset/` 域（含 generation 追踪，测试）
- [ ] **Task 2.5** `repository.ts` Port + `service.ts` ProductionService（内存仓储测试）
- [ ] **Task 2.6** database：schema/production.ts + index.ts 导出 + INIT_SQL DDL（4 处同步）
- [ ] **Task 2.7** server：`modules/production/repository.ts`（drizzle 实现）+ repository.test.ts（临时库集成测试）
- [ ] **Task 2.8** Phase 2 验证（typecheck/lint/build/全部单测）+ commit

---

## Phase 3：Production Tools

**文件：**
- `packages/tools/src/production/create-project.ts` / `get-project.ts` / `update-project.ts` / `list-projects.ts`
- `packages/tools/src/production/create-script.ts` / `get-script.ts` / `update-script.ts` / `list-scripts.ts`
- `packages/tools/src/production/create-character.ts` / `update-character.ts` / `list-characters.ts`
- `packages/tools/src/production/create-scene.ts` / `create-storyboard.ts` / `update-storyboard.ts` / `create-shot.ts` / `update-shot.ts`
- `packages/tools/src/production/index.ts`（聚合导出）+ `packages/tools/src/index.ts` 导出
- `apps/server/src/app.ts`：`toolRegistry.register(createProjectTool({ production }))` …（组合根闭包注入 `ProductionService`）

**工具工厂签名（统一模式）：**

```ts
import type { Tool } from "../tool";
import type { ProductionService } from "@svh/production";
export function createProjectTool(deps: { production: ProductionService }): Tool {
  return {
    name: "create_project",
    description: "创建 AI 短剧生产项目。输入项目名称、类型与目标时长，返回项目 id。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, type: { type: "string", enum: ["short_video","short_drama","animation","advertisement"] }, description: { type: "string" }, duration: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      // 校验 input 字段类型；workspace → userId 由 service 内部取（service 方法接收 ctx.workspaceId，userId 由仓库实现按 workspace 行取值，避免扩展 ToolContext）
      ...
    },
  };
}
```

**要点：**
- 不改 `ToolContext`；`execute` 内部用 `ctx.workspaceId` + `deps.production` 完成归属（生产服务从 workspace 行取 user_id → 跨用户隔离与 session 同构）。
- 所有 `input` 手写 typeof 校验，失败抛 `ToolError("INVALID_INPUT", "字段 xxx 必须为 string")`；领域错误转 `{ error: message }` 形状（返回 output，不抛给循环）。
- 工具名唯一注册进 ToolRegistry 后，所有会话的 Agent 均可调用（现状无按工具权限过滤；Phase 4 起由 Profile 白名单过滤）。
- 测试：`apps/server/src/modules/production/tools.test.ts`（临时库 + 真实 ProductionService + 直接调 `execute`，断言成功/INVALID_INPUT/归属隔离）。
- 提交：`feat(production): 新增生产领域工具集（create_project 等 14 个）`。

---

## Phase 4：Agent Profiles（Director / Script / Storyboard）

**文件：**
- `packages/core/src/agent/agent-profile.ts`（新，只放类型 + 从 index.ts 导出）：

```ts
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** 工具白名单（缺省 = 全部可用） */
  allowedTools?: string[];
}
```

- `packages/core/src/agent/agent-types.ts`：`AgentRunInput` 增加 `profileId?: string`。
- `packages/core/src/context/context-builder.ts`：`ContextBuilderOptions` 增加 `resolveProfile?: (profileId: string) => AgentProfile | undefined`；`build` 中 system prompt 顺序改为 `DEFAULT_SYSTEM_PROMPT → profile.systemPrompt → VIDEO_AGENTS.md → Workspace Summary`（profile 存在时叠加）。
- `packages/core/src/agent/agent-runtime.ts`：options 增加 `profileResolver`（或复用 contextBuilder 的 resolveProfile，推荐 runtime 直接依赖自己的 options 字段）；`run` 中按 `profile.allowedTools` 过滤 `toolRegistry.list()` 后转换下发。
- `apps/server/src/modules/agent/profiles.ts`（仿 skills/definitions.ts）：`export const AGENT_PROFILES: AgentProfile[]`（director / script / storyboard 三个，中文 systemPrompt：
  - director：理解用户需求 → 生成 Production Plan（JSON）→ 规划 workflow 步骤；只有计划类工具（create_project / create_workflow / list_projects / get_project 等，禁止 generate_*）；
  - script：原始故事/剧本改编（read_file/write_file + create_script/update_script），禁止 generate_image/video；
  - storyboard：脚本→场景→分镜 Shot List，**必须输出结构化数据**（create_scene/create_storyboard/create_shot），禁止只返回自然语言）+ `getProfileById(id)`。
- `apps/server/src/modules/agent/run-service.ts`：可选 `profileId` 注入（路由 body 透传；缺省无 profile 保持现状）。
- 测试：core 无 DB 部分用 node:test 测 profile 注入后的 systemPrompt 顺序与工具过滤；server 侧 profiles.test.ts 校验三 profile 白名单与关键禁止项。
- 提交：`feat(agent): 新增 Agent Profile 注入与 Director/Script/Storyboard 角色`。

---

## Phase 5：Workflow Engine（core 纯引擎 + server 持久化执行器）

### core 部分（无 DB/HTTP，纯状态机）

**文件：** `packages/core/src/workflow/`（workflow-types.ts / workflow-engine.ts / workflow-executor.ts / workflow-node.ts / workflow-events.ts / index.ts）

```ts
// workflow-types.ts
export type WorkflowStatus = "draft" | "queued" | "running" | "waiting_user" | "paused" | "completed" | "failed" | "cancelled";
export type WorkflowNodeStatus = "pending" | "queued" | "running" | "retrying" | "waiting" | "completed" | "failed" | "cancelled";
export interface WorkflowNode {
  id: string; type: string; name: string; status: WorkflowNodeStatus;
  dependsOn: string[]; input?: unknown; output?: unknown;
  retryCount: number; maxRetries: number;
}
export interface Workflow {
  id: string; projectId: string; status: WorkflowStatus;
  nodes: WorkflowNode[]; createdAt: Date; updatedAt: Date;
}
// workflow-node.ts
export interface NodeExecutor {
  /** 执行节点；返回结构化 output；抛错视为失败（由引擎按 retry 策略重试） */
  execute(node: WorkflowNode, input: unknown, signal?: AbortSignal): Promise<unknown>;
}
// workflow-engine.ts —— 状态机 + 调度（DAG 拓扑：入度=0 的 pending 节点可入队；节点失败→按 maxRetries 重试/置 failed；依赖失败→下游 cancelled）
export class WorkflowEngine {
  run(wf: Workflow, executor: NodeExecutor, opts?: { signal?: AbortSignal }): AsyncIterable<WorkflowEvent>;
  pause(wf: Workflow): void; resume(wf: Workflow): void; cancel(wf: Workflow): void;
}
// workflow-events.ts
export type WorkflowEvent =
  | { type: "workflow.started" } | { type: "workflow.completed" } | { type: "workflow.failed"; error: string } | { type: "workflow.cancelled" }
  | { type: "node.started"; nodeId: string } | { type: "node.completed"; nodeId: string; output?: unknown }
  | { type: "node.failed"; nodeId: string; error: string; retryCount: number } | { type: "node.retrying"; nodeId: string; attempt: number }
  | { type: "node.waiting"; nodeId: string };
// workflow-executor.ts —— 串行/并行调度实现（V0.2 简化：所有节点串行执行，但保留 DAG 依赖排序）
```

引擎规则：`run` 遍历依赖拓扑（可用 Kahn 算法纯函数 `topoSort(nodes)` 导出于 workflow-node.ts 便于测试）；`pause`/`resume` 由注入的运行时控制器协作（V0.2 简化：pause 立即置状态并在下一节点边界生效）；`cancel` 触发 AbortSignal 并置 cancelled；retry 由引擎自动执行（`retryCount < maxRetries` 时重试，每次 `node.retrying` 事件，前一次失败原因带出）。

### server 部分

**文件：** `packages/database/src/schema/workflow.ts`（workflows / workflow_nodes / production_tasks 3 表 + INIT_SQL + index.ts）+ `apps/server/src/modules/production/workflow-service.ts` + `apps/server/src/routes/production.ts`

- workflows 表：`id PK | project_id (idx) | user_id | status | nodes(json 快照) | created_at | updated_at`
- workflow_nodes 表：`id PK | workflow_id (idx) | node_id | type | name | status | depends_on(json) | input(json) | output(json) | retry_count | max_retries | error | created_at | updated_at`（节点过程状态持久化）
- production_tasks 表：`id PK | workflow_id | node_id | project_id | user_id | kind(image|video|audio|text) | provider_id | provider_task_id | status(queued|running|completed|failed|cancelled) | progress | output_url | error | created_at | updated_at`（异步生成任务，Phase 7/8 使用）
- workflow-service.ts：`createWorkflow(projectId, nodes)`（默认 DAG：script.generate ← character.extract / scene.generate ← storyboard.generate ← script；文档 §12 示例）/ `getWorkflow` / `runWorkflow`（校验 `workflow.automation` 会员功能 + 创建 worker 内部异步执行）/ `pause` / `resume` / `cancel` / `retryNode` / `listWorkflows(projectId)`；节点执行器 `AgentNodeExecutor`（调 `AgentRunService.run` 带 profileId=该节点类型对应 profile，依赖 DB 持久化节点状态 + 事件流落库）。
- 路由（`/api/projects/:projectId/workflows` 以下）：
  - `GET /api/projects/:projectId/workflows` 列表；`POST /api/projects/:projectId/workflows` 创建（body `{ nodes? }`）
  - `GET /api/workflows/:id` 详情（含节点）；`POST /api/workflows/:id/run`；`POST /api/workflows/:id/pause|resume|cancel`；`POST /api/workflows/:id/nodes/:nodeId/retry`
  - `GET /api/workflows/:id/events` SSE（复用 lib/sse.ts；事件 = core WorkflowEvent 的 JSON）
  - 全部路由挂 `requireFeature(membershipService, "workflow.automation")`。
- 测试：core `workflow-engine.test.ts`（拓扑排序/失败重试/依赖失败级联 cancelled/pause-resume/cancel 状态机，node:test）；server `workflow-service.test.ts`（临时库：创建默认 DAG、run 到 completed、retry、取消）。
- 提交：`feat(workflow): 新增 Workflow Engine（DAG 状态机 + 暂停/恢复/取消/重试）」+ `feat(production): 新增生产工作流路由与异步执行器」。

---

## Phase 6：Web Production UI

**文件：**
- `apps/web/src/types/production-types.ts`（镜像 production 包类型 + Workflow/WorkflowNode + SSE 事件）
- `apps/web/src/api/production.ts`（`productionApi = { list, get, create, update, remove, listWorkflows, createWorkflow, getWorkflow, runWorkflow, pauseWorkflow, resumeWorkflow, cancelWorkflow, retryNode }`，照 client.ts 平面模式 + encodeURIComponent）
- `apps/web/src/pages/ProductionPage.tsx`（项目列表：Header「‹ 返回工作台」+ 标题「制作中心」+ primary「新建项目」；列表空态四件套；行：名称/类型 Tag/状态/更新时间/进入）
- `apps/web/src/pages/ProductionDetailPage.tsx`（`#/production/:id` 前缀解析；左 180px 导航（脚本/角色/场景/分镜/资产/工作流，照 SettingsModal SETTING_SECTIONS 模式）+ 右内容区）
  - 脚本面板：版本列表 + `MonacoEditor`（md，languageFromPath）+ 「AI 生成脚本」按钮（复用 useAgentRun？不——调用 workflow run 或 skills 流，V0.2 用 workflow run 带 script.generate；简化：按钮直接 `createScript` + 提示）
  - 角色/场景/分镜面板：列表 + 表单 Modal（antd Form）+ 状态 Tag；分镜每行展开显示 prompts 与关联 shot
  - 资产面板：按类型 Tabs（image/video/audio/…，照 AssetsModal），图片/视频用 `url` 渲染 `<img>`/`<video controls>`（远程 URL，V0.2 不做本地下载）
  - 工作流面板：节点时间线（状态图标：pending ▢ / running ◉ / completed ✓（antd Icon，无 emoji）/ failed ✕）+ Run/Pause/Resume/Cancel/Retry 按钮（`can("workflow.automation")` 门控 + 无权限提示升级回 `#/membership`）；SSE `ssePost("/api/workflows/:id/events")` 订阅节点状态（unmount 时 abort）
- `apps/web/src/App.tsx`：`route.startsWith("production")` 前缀分支（`#/production` 列表 / `#/production/:id` 详情）
- `apps/web/src/features/header/WorkbenchHeader.tsx`：新增「制作中心」入口按钮（照「我的资产」同款样式，onClick `window.location.hash = "#/production"`）
- Query keys：`["productions"]` / `["production", id]` / `["workflow", id]` / `["production-scripts", projectId]` 等（防与 `["workspaces"]` 前缀歧义）
- 提交：`feat(web): 新增制作中心（项目/脚本/角色/场景/分镜/资产/工作流面板）`

---

## Phase 7：Image Provider

**文件：**
- `packages/providers/src/registry.ts`：`class Registry<T extends { id: string }>`（原 ProviderRegistry 逻辑泛型化）+ `export class ProviderRegistry extends Registry<LLMProvider> {}`（兼容现有 5 处调用，零改动）
- `packages/providers/src/image/provider.ts`（ImageProvider / ImageGenerationInput / ImageGenerationResult 接口）+ `image/openai-compatible.ts`（`OpenAICompatibleImageProvider implements ImageProvider`：`POST {baseUrl}/images/generations`，body `{ model, prompt, n?, size?, response_format?, seed? }`，解析 `data[].url|b64_json`）+ `image/index.ts`；`providers/src/index.ts` 追加导出
- `packages/providers/src/http.ts`：从 openai-compatible.ts 上提公共工具（`normalizeBaseUrl` / `authHeaders(apiKey)` / `parseErrorDetail`），chat 实现改为引用（行为不变）
- `apps/server/src/modules/settings/model-catalog.ts`：`ModelProviderMeta` 增加可选 `capabilities?: ModelCapability[]`（`ModelCapability = "text" | "image" | "video" | "audio"`，缺省只读兼容）+ 同步 web `api-types.ts` 镜像
- server `modules/production/generation-service.ts`：`generateImage({ projectId, prompt, modelName?, size? })` —— 复用 settings 解析（按 `type: "image"` 的 `getSkillModelConfig` 同款逻辑解析 modelName/baseUrl/apiKey）→ `OpenAICompatibleImageProvider` → 结果写入 `production_assets`（type=image，url=远程，`generation:{providerId, modelId, prompt}`）
- 路由：`POST /api/projects/:projectId/assets/generate-image`（body `{ prompt, modelName?, size? }`）
- 测试：providers `image/openai-compatible.test.ts`（mockFetch 模式，仿 provider-verify.test.ts：URL/method/body 断言 + 非 2xx 错误 + b64_json 分支）；generation-service 集成测试留 Phase 8 一并（V0.2 先过 provider 测试）
- 提交：`feat(providers): 新增 ImageProvider（OpenAI 兼容 /images/generations）与 Registry 泛型化`

---

## Phase 8：Video Provider（异步任务 + 轮询 + 重试 + 取消）

**文件：**
- `packages/providers/src/video/provider.ts`（`VideoProvider { createTask/getTask/cancelTask }` + `VideoTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled"` + `VideoTask { id, providerTaskId, status, progress?, outputUrl?, error? }` + `VideoGenerationInput { model, prompt?, imageUrl?, duration?, resolution? }`）+ `video/poll.ts`（纯函数 `pollVideoTask(provider, taskId, { intervalMs=5000, timeoutMs=600000, signal?, onProgress? })`，进度回调 + 超时抛错 + abort）+ `video/dashscope.ts`（DashScope 异步任务适配：
  - `createTask`: `POST {baseUrl}/services/aigc/video-generation/video-synthesis`（text2video）或 `.../video-synthesis-with-image`（image2video，body 带 image URL），头 `X-DashScope-Async: enable` + Authorization（Bearer 或 DashScope 兼容格式），解析 `output.task_id`
  - `getTask`: `GET {baseUrl}/tasks/{taskId}` → 映射 `task_status` PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED → VideoTaskStatus，成功取 `output.video_url`（字段路径以实测为准，标注 TODO 待联调确认）
  - `cancelTask`: `POST {baseUrl}/tasks/{taskId}/cancel`）+ `video/index.ts` + index.ts 导出
- server `modules/production/generation-service.ts` 扩展：`startVideoTask({ projectId, storyboardId?, prompt, imageUrl?, modelName? })` → `production_tasks` 落库（kind=video, provider_task_id, status=queued）+ 后台轮询（`pollVideoTask`，每任务独立 AbortController；断线/超时 → status=failed + error）；`cancelVideoTask(taskId)`；`GET /api/tasks/:id` 查询 + `POST /api/projects/:projectId/assets/generate-video`（同步返回 task，前端轮询 `GET /api/tasks/:id` 直到 completed → 写 production_assets（url=outputUrl, type=video, generation.taskId））
- 路由：`POST /api/projects/:projectId/assets/generate-video` / `GET /api/tasks/:id` / `POST /api/tasks/:id/cancel`
- V0.2 先适配 DashScope（用户已有百炼 Key；wanx2.1-t2v / wanx2.1-i2v 已在模型目录种子），火山 Seedance 适配列后续任务。
- 测试：providers `video/dashscope.test.ts`（mockFetch：createTask 头/端点/body（两分支 text2video/image2video）、状态映射、cancel）；server 轮询服务测试用假 VideoProvider（fake createTask/getTask 序列驱动 queued→running→completed）验证 production_tasks 状态机与资产写入。
- 提交：`feat(providers): 新增 VideoProvider 异步任务接口与 DashScope 适配` + `feat(production): 视频生成任务轮询与资产落库`

---

## Phase 9：Worker（V0.2 不实施）

按照规格 §16 与 §22 Phase 9：第一阶段 Server 内同步/简单异步轮询已覆盖。`apps/worker`（BullMQ 等）**明确不在 V0.2 范围**，待 Image/Video Provider 工作流稳定后另立 V0.3 计划。

---

## Phase 验收清单（V0.2 完成标准 → 本计划任务映射）

| 完成标准 | 对应 |
|---|---|
| 创建 Production Project | Phase 2 + Phase 3 create_project + Phase 6 列表/新建 |
| Chat 可以启动 Production | Phase 4 Director Profile + Phase 5 workflow（Agent 通过 create_project/create_workflow 触发）+ Phase 6 入口 |
| Director Agent 生成 Production Plan | Phase 4 profiles.ts director systemPrompt（plan 输出 JSON） |
| Script Agent 生成 Script | Phase 4 script profile + Phase 5 script.generate 节点 |
| Character/Scene/Storyboard 数据创建保存 | Phase 2 + Phase 3 工具 + Phase 5 节点 |
| Production Tools 可被 Agent 调用 | Phase 3（注册后全会话可见） |
| Workflow 管理/暂停/恢复/取消/失败重试 | Phase 5（core 状态机 + server API） |
| Production UI 查看全部生产数据 | Phase 6 |
| Provider 支持 Image/Video Capability | Phase 7/8 |
| Agent Runtime 无需重写 | 全部 Phase 只做增量扩展 |

## 执行方式

用户确认后（见对话中的确认问题），本计划按 Phase 顺序执行；每个 Phase 内可并行子任务（subagent-driven-development 每 Task 一个子代理 + 两阶段评审）。各 Phase 验收（typecheck/lint/test/build/手动）通过后才进入下一 Phase；运行测试前先征得用户同意。
