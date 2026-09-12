# Phase 5 设计：Agent UI 与 SSE 实时推送

> 状态：已确认，待实施
> 前置阶段：Phase 0 ~ Phase 4（已完成并提交）
> 对应技术文档：第 12、47、56、66、71、72 条；第 78 条架构原则；第 90、91 条验收示例

## 1. 背景与目标

Phase 4 交付了 Creative Agent 的完整后端能力：意图分析、上下文装配、流程规划、
Prompt 编译与 8 个工具的多步调用循环。但**没有界面**，用户只能通过 `curl`
调用 `/api/agent/chat`。同时任务进度只能轮询，无法实时呈现。

本阶段交付：

1. 用户可操作的 Agent 工作台（对话 + 计划 + 结果卡 + 确认交互）
2. SSE 实时推送（任务状态、进度、资产变更）
3. 项目入口（Agent 必须以 `projectId` 为上下文，否则用户无法进入）
4. 模型 Provider 配置页（不配模型则 Agent 无可用能力，界面等于空壳）

本阶段**不做**：Creative Canvas、Timeline、资产库交互界面、版本对比界面、
工作流执行引擎推进。这些属于 Phase 6 ~ Phase 9。

## 2. 必须先修复的既有缺陷

### 2.1 缺陷描述

Agent 存在**两条互不相通的确认路径**：

| 路径 | 触发点 | 是否落任务 | `POST /confirm` 能否恢复 |
| --- | --- | --- | --- |
| A. 执行中确认 | Worker 执行技能时抛 `ConfirmationRequiredError`，任务置 `waiting_user` | 是 | 能 |
| B. 执行前确认 | Agent 工具循环中 `skill.execute` 遇到 `risk === 'high'` 且 `confirmationPolicy === 'reject'` | **否** | **不能** |

路径 B 的代码位于 `packages/agent/src/tools.ts`：

```ts
if (skill.risk === 'high' && ctx.confirmationPolicy === 'reject') {
  return {
    ok: false,
    requiresConfirmation: true,
    error: `「${skill.name}」属于高成本操作，需要用户确认后才执行`,
  };
}
```

它直接返回而**不创建任何任务**。`packages/agent/src/runtime.ts` 随后构造的载荷为：

```ts
payload: {
  type: 'confirmation_request',
  summary: `即将执行：${tool.name}`,
  impacts: [['操作', tool.name]],
  planTaskIds: [],        // 恒为空
}
```

而 `POST /api/agent/sessions/:id/confirm` 的实现是：

```ts
const waiting = await prisma.agentTask.findMany({
  where: { sessionId: id, status: 'waiting_user', ... },
});
```

### 2.2 后果

用户点击「确认执行」→ 接口查到 0 条等待任务 → 返回
`{ resumed: [], message: '没有等待确认的操作。' }` → **操作永远不会发生**，
而用户界面显示的是「已确认」。

这属于技术文档第 66 条与第 78 条明确禁止的「看似成功的失败」，
且恰好落在 Phase 5 要交付的核心交互上。

### 2.3 修复方案

**让高风险技能在需要确认时照常创建任务，初始状态为 `waiting_user`。**

改动点：

1. `packages/database/src/tasks.ts` 的 enqueue 支持 `initialStatus?: 'pending' | 'waiting_user'`
   - `waiting_user` 状态**不得**入队（队列层不感知它，抢占查询已排除该状态）
2. `packages/agent/src/tools.ts` 的 `skill.execute` 在 `requiresConfirmation` 分支中
   先创建任务并置为 `waiting_user`，再把 `taskId` 放进工具结果
3. `packages/agent/src/runtime.ts` 从工具结果读取 `taskId`，写入
   `confirmation_request` 载荷的 `taskId` 与 `planTaskIds`

收益：

- 确认有真实对象，`/confirm` 无需改动即可恢复
- **刷新页面后确认请求依然存在**（参考项目 dramai 的缺陷之一正是刷新后进度丢失）
- 自动继承既有的幂等三件套（唯一键 + 确定性 jobId + CAS 抢占）与审计轨迹

`/confirm` 已支持不传 `taskIds` 时放行该会话全部等待任务，因此确认卡可提供
「确认执行」（全部）与「仅确认这一个」两个动作，无需新增接口。

### 2.4 回归测试要求

- 断言高风险技能经 Agent 调用后，`agent_tasks` 中确实存在 `waiting_user` 记录
- 断言 `confirmation_request` 载荷的 `taskId` 非空
- 断言对该会话调用 `/confirm` 后任务状态变为 `pending` 并入队

## 3. 新增单元

```
packages/realtime/                    Redis Stream 事件总线
apps/web/                             React + Vite + CSS Modules 前端
apps/api/src/routes/events.ts         SSE 端点
```

### 3.1 `@svh/realtime` 的隔离约束

沿用项目既有的 ports/adapters 风格：

- **不读环境变量**：连接参数由调用方注入
- **不依赖 `@svh/database`**：事件总线不感知业务模型
- **不依赖 HTTP 框架**：只提供「发布」与「订阅」两个能力
- 依赖：`ioredis`（已作为 bullmq 的传递依赖存在于 pnpm store，无需额外下载）

导出：

```ts
createEventPublisher({ connection, logger })   // publish(envelope) => streamId
createEventStream({ connection, logger })      // subscribe(sessionId, lastId, signal) => AsyncGenerator
```

## 4. 事件总线设计

### 4.1 存储结构

| Key | 类型 | 用途 |
| --- | --- | --- |
| `svh:events:session:{sessionId}` | Stream | 会话事件流，`MAXLEN ~ 2000`，`EXPIRE 86400` |
| `svh:seq:{sessionId}` | String（计数器） | 提供领域契约要求的整数 `seq` |

领域契约 `SseEnvelope.seq` 要求**会话内单调递增整数**，而 Redis Stream ID 形如
`1700000000000-0`。二者用途不同，因此分开：`seq` 进事件体供前端排序与展示，
Stream ID 作为 SSE 的 `id:` 字段供 `Last-Event-ID` 续传。

### 4.2 为什么是 Stream 而不是 Pub/Sub

核心是这一条命令：

```
XREAD BLOCK 15000 COUNT 50 STREAMS svh:events:session:{sid} <lastId>
```

它**同时完成补发与实时订阅**：`lastId` 之后的历史事件立即返回，之后自动阻塞
等待新事件。这从结构上消除了审计报告 P0 缺陷 ⑫（「重连后推送永久静默」）——
该缺陷的根因是「先 replay 再订阅」之间存在空窗，而 Stream 的语义使这个空窗
根本不存在。

Pub/Sub 无法提供该保证：断线期间的事件直接丢失，补发需要另建存储。

### 4.3 发布

```
XADD svh:events:session:{sid} MAXLEN ~ 2000 * type <t> at <iso> sessionId <sid> seq <n> data <json>
```

同时 `INCR` 计数器、`EXPIRE` 刷新 TTL。发布失败**不得**影响业务主流程：
事件推送是增强能力，不是业务前置条件，因此发布异常只记日志。

### 4.4 无事件时的行为

- `XREAD` 阻塞 15 秒无结果 → 发送 `ping` 心跳（契约已定义该类型）
- 心跳同时用于检测连接是否仍然可写，写失败即结束订阅

## 5. SSE 端点

`GET /api/agent/sessions/:id/events`

### 5.1 建立流程

1. 校验会话存在（不存在返回 404，错误体遵循统一契约）
2. `XADD` 一条 `session.ready`，取其 Stream ID 作为**起点基准**
3. 写响应头：`text/event-stream`、`no-cache`、`X-Accel-Buffering: no`
4. 下发 `retry: 3000` 与 `id: <readyId>`
5. 若请求带 `Last-Event-ID` → `XRANGE` 补发 `(lastEventId, readyId]` 区间
6. 进入 `XREAD BLOCK` 实时循环

第 2 步的 `session.ready` 同时解决了「Stream 不存在时 `XREAD` 立即返回空导致
忙循环」的问题——流此刻必定存在。

### 5.2 会话隔离

`SseEnvelope.sessionId` 为强制字段，服务端按 key 订阅，**结构上**不可能把
A 会话的事件发给 B 会话。请求头中的 `Last-Event-ID` 只在当前会话的 Stream 内
解析，跨会话的 ID 查不到数据，不会泄漏内容。

当前无认证体系，因此不做用户级鉴权（见技术文档第 68 条，随用户体系一并实现）。

### 5.3 事件来源

| 事件类型 | 产生进程 | 触发点 |
| --- | --- | --- |
| `session.ready` | API | SSE 连接建立 |
| `agent.state` | API | Agent 轮次开始（`thinking`）与结束（`idle` / `waiting_user`） |
| `agent.message` | API | 轮次返回，携带自然语言回复 |
| `agent.plan` | API | 轮次返回计划载荷 |
| `agent.confirmation` | API | 轮次返回确认请求载荷 |
| `task.status` | API + Worker | 任务状态跃迁。Worker 负责执行态（`running` / `success` / `failed`）；API 负责确认放行后的 `waiting_user → pending` |
| `task.progress` | Worker | `updateTaskProgress` 成功写入后 |
| `asset.changed` | Worker | 技能执行产出资产后 |
| `content.changed` | Worker | 内容状态变更 |
| `ping` | API | 心跳 |

> `agent.result_card` 事件类型已在传输契约中定义，但**当前 Agent 轮次不产生该载荷**
> （`AgentRuntime` 只产出 `plan` 与 `confirmation_request`）。结果卡的实际来源是
> 任务产出，见 §6.3。本阶段保留该事件类型供后续启用，不伪造数据。

任务若无 `sessionId`（例如直接经 `POST /api/skills/:id/execute` 创建），
则不推送，前端回退到轮询该任务——这是刻意的：不假装推送成功。

## 6. 前端结构

### 6.1 目录

```
apps/web/
  index.html
  vite.config.ts                  /api 代理到 127.0.0.1:3030
  src/
    main.tsx
    App.tsx                       路由
    styles/
      tokens.css                  Design Token 唯一来源
      global.css                  reset 与基础排版
    lib/
      api.ts                      fetch 封装，解析统一错误体
      sse.ts                      EventSource 封装，退避重连
      format.ts                   时间、字节、时长格式化
    components/                   自建通用件
      Button / IconButton / Field / Dialog / Drawer
      ProgressBar / Skeleton / Spinner
      EmptyState / ErrorState / Toast
      Icon                        统一 SVG 图标集
    features/
      projects/                   项目列表、新建
      agent/
        AgentWorkspace.tsx
        MessageList.tsx
        MessageItem.tsx
        renderers/{PlanCard,ResultCard,ConfirmationCard,ErrorCard,ProgressLine}.tsx
        Composer.tsx              /技能 与 @资产 补全
        ToolTrace.tsx             工具调用轨迹（可折叠）
        TaskPanel.tsx             实时任务面板
      settings/ProviderSettings.tsx
```

### 6.2 页面结构

按技术文档第 12 条的创作任务流组织，而非「左侧表单 + 右侧大卡片」：

```
项目列表
  └── 项目工作台
        ├── 主区：对话流
        │     消息气泡 + 五类结构化载荷
        ├── 侧区：实时任务面板 + 上下文说明（@引用命中、token 估算）
        └── 输入区：多行输入 + /技能 与 @资产 补全
```

### 6.3 关键交互链路

```
「帮我做一个 30 秒护肤品广告」
  → 计划卡（13 步，requiresApproval = true），Content 记录已创建
  → 用户点「开始制作」→ 发送回复消息，触发新一轮 Agent 轮次
  → 高成本步骤产生确认卡（修复后对应真实任务）
  → 用户点「确认执行」→ POST /confirm → 任务转 pending 并入队
  → SSE task.progress 实时推进 → task.status 完成
  → 前端拉取 /api/tasks/:id → 渲染 output.card 结果卡
```

**关于「开始制作」的真实语义**：计划目前不是可执行的持久化对象
（`planTaskIds` 恒为空，计划仅作为消息载荷存在）。点击后由模型依据对话历史
决定调用哪些技能，而非按计划逐步精确执行。按计划精确推进属于 Phase 9。
本阶段如实呈现这一行为，不假装计划在执行。

**结果卡片的数据来源**：15 处技能实现产出 `result_card`，经 `SkillResult.card`
写入 `task.output.card`。因此结果卡由「任务完成事件 + 拉取任务详情」得到，
而不是由 Agent 轮次直接返回。

### 6.4 输入补全

- `/` 触发技能补全 → `GET /api/skills`
- `@` 触发资产补全 → `GET /api/projects/:id/assets`
- 发送前调用 `POST /api/assets/resolve-mentions` 换回真实资产 id，
  前端不自行维护「引用名 → id」映射

## 7. 视觉系统

### 7.1 Design Token

`tokens.css` 是颜色、字号、间距、圆角的**唯一来源**，组件内禁止字面值。

- **Color**：`background` / `surface` / `surface-secondary` / `border` /
  `text-primary` / `text-secondary` / `text-tertiary` / `primary` /
  `success` / `warning` / `error`
- **Typography**：页面标题 / Section 标题 / 卡片标题 / 正文 / 辅助 / Caption / 按钮
- **Spacing**：4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48
- **Radius**：小组件 6 / 普通组件 8 / 大容器 12 / Dialog 16

风格取克制的深色中性色 + 单一强调色。明确禁止：大面积渐变、玻璃拟态、
emoji 图标（自建统一 SVG 图标集）、大面积阴影、无意义统计卡片。

### 7.2 Card 使用边界

Card **只**用于有独立操作边界的对象：计划卡、结果卡、确认卡、错误卡、
Provider 条目。对话流本身用留白与分隔线分层，不套卡片。
禁止 Card 嵌套 Card。

### 7.3 状态设计

- **Loading**：会话加载用 Skeleton（贴合真实布局），任务生成用进度条 + 状态文案，
  不使用裸 `Loading...`
- **Empty**：项目列表、对话流、任务面板、Provider 列表均需空状态，
  包含图标、标题、说明、主操作
- **Error**：说明「发生了什么 / 可能原因 / 下一步怎么做」，
  直接消费后端错误体的 `message` 与 `suggestions`，`retryable` 为真时给重试按钮

### 7.4 SSE 断线降级

断线时顶部显示降级提示条「实时连接已中断，正在重连」，
同时**自动回退到轮询** `/api/tasks/:id/progress`。绝不静默——
用户必须知道当前进度可能不是最新的。

### 7.5 响应式

Desktop / Tablet / Mobile 三档。窄屏时侧区折叠为抽屉，输入区固定在底部，
任务面板转为顶部的可展开条。表格与媒体网格不得横向溢出。

## 8. 测试计划

| 范围 | 内容 |
| --- | --- |
| `packages/realtime` | `seq` 单调性、补发边界（含 `lastId` 早于流起点 / 不存在）、MAXLEN 截断、订阅取消时连接清理 |
| `packages/agent` | 高风险技能调用后任务真实落库、载荷 `taskId` 非空 |
| `apps/api` | SSE 端点真连 Redis：订阅后发布能收到、`Last-Event-ID` 补发缺失段、**跨会话隔离**（A 收不到 B）、会话不存在返回 404 |
| `apps/web` | 五个载荷渲染器、API 错误映射、SSE 重连状态机（用假 EventSource）、空/错误/加载状态 |
| 回归 | 修复确认链路后 Phase 0~4 的 394 个测试必须全绿 |

## 9. 新增依赖

`apps/web`：`react`、`react-dom`、`react-router-dom`、`vite`、`@vitejs/plugin-react`、
`vitest`、`@testing-library/react`、`@testing-library/user-event`、`jsdom`

`packages/realtime`：`ioredis`

下载走代理 `http://192.168.240.1:10808`。

## 10. 验收标准

1. 在界面上完成「30 秒护肤品广告」全流程：计划卡 → 开始制作 → 确认 → 实时进度 → 结果卡
2. 生成过程中刷新页面，任务进度能恢复（SSE + REST 双重保障）
3. 断开 API 进程后界面显示降级提示并回退轮询，恢复后自动重连并补齐事件
4. 未配置任何模型时，界面明确提示去配置，而不是报错或静默失败
5. `lint` / `typecheck` / `test` / `build` 全绿，且 Phase 0~4 测试无回归
6. Desktop / Tablet / Mobile 三档无横向溢出、无按钮溢出、信息层级不丢失
