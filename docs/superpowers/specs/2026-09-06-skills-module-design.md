# 技能模块（Skills）V1 设计文档

日期：2026-09-06
状态：待评审

## 1. 背景与目标

技能（Skill）是 Agent 的预定义能力：每项技能完成一个特定任务（例：剧本拆解 = 将一段文字拆解为短剧剧本）。

- 技能声明自己可调用的**模型类型**（例：剧本拆解只能调用文本模型）。
- 会话输入栏可**选择技能**与**可用的模型**。
- 技能拥有自己的**输入参数**，执行后产生**模型结果**；结果按类型展示，媒体结果（图片/视频/音频）后续可加入「我的资产」。

V1 范围（与用户确认）：

- 仅内置文本技能（剧本拆解、分镜脚本），无管理界面。
- 技能参数：**主文本参数在输入栏直接输入**；其余参数以输入框上方内联控件行设置。
- 技能执行结果以消息卡片展示于会话流；文本结果支持复制 / 下载 .md（不自动入资产）。
- 图片/视频/音频结果展示与「加入资产」管线为**预留接口**，不在 V1 实现生成。

## 2. 架构总览

```
内置技能注册表（服务端代码定义，无 DB 表）
        │
        ├── GET /api/skills                 → 技能定义列表（含参数定义）
        └── POST /api/sessions/:id/skill    → 技能执行（SSE 流，复用 run 事件协议）
                                        │
                    技能执行服务（SkillRunService）
                    参数校验 → 按技能 modelTypes 解析模型 → 渲染提示词
                    → LLM 单轮补全（不经 Agent 循环/Tools）→ 持久化消息 → SSE 转发
```

- 零新增数据库表：技能运行以普通消息写入 `messages` 表，
  `metadata.skill = { skillId, name, params, modelName, resultKind }` 标记。
- ContextBuilder 构建上下文时**跳过**带 `metadata.skill` 标记的消息（隔离语义，用户确认）。
- 权限门禁沿用 `agent.basic`（技能属于 Agent 能力）。

## 3. 技能定义（服务端内置）

文件：`apps/server/src/modules/skills/definitions.ts`

```ts
type SkillParamType = "text" | "textarea" | "number" | "select";

interface SkillParamDef {
  key: string;              // 参数键（{{key}} 占位 / 校验用）
  label: string;            // 中文标签
  type: SkillParamType;
  primary?: boolean;        // 主文本参数：输入栏直接输入（type 须为 text/textarea）
  required?: boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>; // select 专用
  default?: string | number;
}

interface SkillDefinition {
  id: string;               // 如 script-breakdown
  name: string;             // 剧本拆解
  description: string;
  modelTypes: ModelType[];  // 允许调用的模型类型（V1 均为 ["text"]）
  params: SkillParamDef[];
  systemPrompt?: string;    // 技能专属系统提示
  promptTemplate: string;   // 用户消息模板，{{param}} 占位
  resultKind: "text" | "image" | "video" | "audio"; // V1 全 text
}
```

V1 内置技能：

| id | 名称 | 主参数 | 其余参数 |
| --- | --- | --- | --- |
| script-breakdown | 剧本拆解 | 原始文本（textarea, primary, required） | 集数（number, 默认 5）；输出格式（select: 短剧剧本/分镜大纲） |
| storyboard | 分镜脚本 | 剧本文本（textarea, primary, required） | 镜头数量（number, 默认 8） |

约束：

- 每个技能至多一个 `primary` 参数；`primary` 参数不能同时是 required 校验的例外。
- 模板渲染：仅允许 `{{key}}` 占位，未提供且无默认值的必填参数 → 参数错误。
- 未知参数键直接拒绝（防止前端泄漏字段）。

## 4. 服务端 API

### GET /api/skills

返回技能定义列表（剔除 `systemPrompt`/`promptTemplate`？——保留模板不对外无妨，仅返回 `id/name/description/modelTypes/params/resultKind`，模板不下发）。

### POST /api/sessions/:id/skill → text/event-stream

请求体：`{ skillId: string; params?: Record<string, string|number>; modelName?: string }`

执行流程（所有校验在 `reply.hijack()` 前完成，错误走 JSON）：

1. `membershipService.assertFeature(userId, "agent.basic")`
2. 会话所有权校验（`sessionService.get` + `workspaceService.getOwned`）
3. 技能存在性校验（内置注册表）
4. 参数校验：必填、未知键、类型（number 转数值）、select 枚举值
5. 模型解析：`modelName` 指定 → 校验其 type ∈ 技能 `modelTypes` 且用户启用/全局启用；未指定 → 该技能 `modelTypes` 中首个用户启用的全局启用模型（文本类型复用现有默认逻辑）
6. 渲染 prompt：`systemPrompt`（若有）+ 模板填充
7. 状态流转 idle → running，注册 Provider，调用 `LLMProvider.chat`（流式，无 tools / 无历史上下文）
8. 持久化：user 消息（content = 主参数原文，metadata.skill 标记）+ assistant 消息（content = 结果，metadata.skill 标记含 resultKind/modelName/params）
9. SSE 事件：`run.started` / `message.started` / `message.delta` / `message.completed` / `run.completed` | `run.error`（复用现有事件类型，前端 `useAgentRun` 无需大改）
10. finally：状态回 idle，连接关闭处理同 Agent run

## 5. 上下文隔离

ContextBuilder：历史消息中 `metadata.skill` 存在的消息**一律跳过**（user + assistant 都不进上下文）。普通对话互不感知技能产出，避免长结果撑爆上下文。技能消息仍持久化并展示于会话流。

## 6. 前端

### 6.1 输入栏（ChatInput / AgentChat）

- 新增**技能 Select**（默认「普通对话」）；选择技能后：
  - 主参数 = 输入栏文本框（placeholder 变为技能主参数提示，Enter 发送即执行技能）
  - 输入框上方显示**内联控件行**：其余参数按定义渲染（InputNumber / Select），紧凑一行
  - **模型 Select** 联动：仅列出技能 `modelTypes` ∩ 用户启用模型（无技能时仅文本模型，与现状一致）
- 发送：普通对话走现有 `POST /run`；技能模式走 `POST /sessions/:id/skill`

### 6.2 结果卡片（MessageList）

- assistant 消息带 `metadata.skill` → 渲染 `SkillResultCard`：
  - 头部：技能名 + 模型显示名 + 参数摘要
  - 正文：按 `resultKind` 渲染。V1 text：平文本（等宽/预格式）+ 顶部操作「复制」「下载 .md」
  - 预留：`resultKind` 为 image/video/audio 时渲染对应媒体组件 + 「加入资产」按钮（未实现前显示占位提示）
- 流式运行期间：在现有流式 assistant 行前叠加技能标识（复用 streamItems，增加可选 skill 元数据字段）

### 6.3 状态与错误

- 技能执行中按钮变「停止」、面板不可重复提交
- 参数校验失败：输入栏内联控件行下显示错误（antd Form 提示或 message）
- run.error：复用现有 Alert

## 7. 预留能力（V2，不在 V1）

- 媒体生成管线（图片/视频/音频 → 结果 → 资产库写入）
- 技能管理界面（后台增删改技能）
- 「加入资产」按钮（媒体结果一键写入资产库）
- 用户自定义技能

## 8. 验证清单

1. GET /api/skills 返回两个内置技能定义
2. POST 技能执行：必填缺失 / 未知参数 / select 非法值均报参数错误
3. 模型类型约束：强行指定图片模型给文本技能 → 报错；指定不可用模型名 → 报错
4. 正常执行：SSE 事件流完整、用户消息与结果消息持久化、刷新恢复为结果卡片
5. 上下文隔离：技能执行后发起普通对话，Agent 上下文不含技能消息（观测：普通对话回复不引用技能内容；ContextBuilder 单测或日志验证）
6. 停止：执行中 Stop → abort，会话状态回 idle
7. 前端 typecheck + eslint + build 通过
8. 手工流程：普通对话（不受影响）↔ 技能模式切换正常

## 9. 关键文件

- 新增 `apps/server/src/modules/skills/definitions.ts`
- 新增 `apps/server/src/modules/skills/skill-run-service.ts`
- 新增 `apps/server/src/routes/skills.ts`；`apps/server/src/app.ts` 注册
- `packages/core/src/context/context-builder.ts`：跳过技能消息
- `apps/web/src/api/skills.ts`（新增）、`apps/web/src/types/api-types.ts`
- `apps/web/src/features/chat/ChatInput.tsx`（技能 Select / 模型 Select / 内联参数行）
- `apps/web/src/features/chat/SkillResultCard.tsx`（新增）
- `apps/web/src/features/chat/MessageList.tsx`（渲染技能卡片）
- `apps/web/src/hooks/useAgentRun.ts`（技能运行流支持）
