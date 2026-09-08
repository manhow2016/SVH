# ① 工作流编排打通（生成节点）设计

- 日期：2026-09-08
- 上游：worker 队列已上线（2026-09-07-worker-queue-design.md）、资产本地化已上线（2026-09-07-asset-localization-design.md）
- 目标仓库状态：origin/master ≥ 51124ff
- 阶段裁决记录：范围=「先打通引擎节点」（R14）；粒度=「按阶段批量扇出」；呈现方式=完整设计分节评审，已获「通过」

## 1. 背景与问题

工作流引擎（`packages/core` + `apps/server/src/modules/production/workflow-service.ts`）目前节点执行器只有一种形态：一次进程内 Agent Run（`apps/server/src/app.ts` 的 `executorFactory`）。这意味着工作流跑到「分镜已生成」就停了——图/视频要靠人去资产面板手填表单逐个生成，再人工绑回镜头。「编排打通」要补的就是这一段：让工作流节点能把分镜批量交给生产队列、等全部产物落地、自动绑定。

约束（本设计全程遵守）：

- 不重写引擎/会话/工作区/工具/Provider 注册表；引擎核心（`packages/core`）改动为零。
- 零数据库迁移：所有新数据落现有列（JSON 列、预留列）。
- 成本入口保持手动：auto-pipeline（聊天触发）默认 4 节点模板不变，生成节点只进显式创建的工作流。
- worker 运行时行为零改动（payload 契约只做容忍性扩展）。

## 2. 范围

**做**：

1. 两种新节点类型 `image.generate` / `video.generate`，批量扇出 → 等待终态 → 自动绑定。
2. 入队首次写入 `production_tasks.workflowId/nodeId` 预留列；payload 增加可选 `storyboardId`。
3. 节点重跑幂等（以任务表为权威）；取消/超时向队列传播；server 启动对账孤儿 running。
4. `FULL_PIPELINE_NODES` 模板常量 + WorkflowPanel 标签与结果摘要的最小前端面。

**不做**（明确留给后续增量）：

- auto-pipeline 一键成片（含成本确认交互）。
- 角色图/场景图生成节点；每分镜实时进度 UI（现在只有节点级状态 + 结束后摘要）。
- 分镜审批门禁（approved 过滤）与生成前人工确认点。
- shot 级扇出（见 §3 裁决）。

## 3. 节点契约

### 3.1 扇出单位：storyboard（不是 shot）

地面真值：提示词在 `production_storyboards.imagePrompt/videoPrompt`（[schema] `packages/database/src/schema/production.ts:118-119`）；绑定字段在 `production_shots.imageAssetId/videoAssetId`（:139-140）；shot 是 storyboard 的时长细分（1:N，可以 0 个）。

裁决：**每个 storyboard 行扇出一个任务**（提示词所在层，shot 级扇出会导致同分镜重复计费）；产物资产绑定到该 storyboard **全部 shot** 的对应字段。storyboard 无 shot 时资产仍落资产面板、节点 output 仍记录，只是绑定集为空（合法结果）。

### 3.2 类型与分派

- 新 type 字符串：`image.generate`、`video.generate`（沿用 `script.generate` 等点号风格）。
- **不加 type 枚举校验**（type 自由字符串是既有事实）。改 `app.ts` 的 `executorFactory`：先判 `node.type` 是否生成类型 → 走生成执行器；否则维持现状（`PROFILE_BY_NODE_TYPE` 映射 + director 兜底），未知类型行为不变。

### 3.3 节点 input（全部可选，无必填项）

```ts
interface GenerationNodeInput {
  storyboardIds?: string[];   // 限定集合；缺省 = 项目全部合格 storyboard
  regenerateAll?: true;       // 缺省 false：已绑对应资产的 storyboard 跳过
  modelName?: string;         // 透传给 getSkillModelConfigWithMeta 的模型偏好
  size?: string;              // 图片：尺寸；video 忽略
  duration?: number;          // 视频：时长秒；缺省用 storyboard.duration
  resolution?: string;        // 视频：分辨率
}
```

### 3.4 扫描与跳过判据

`image.generate` 合格判据：`imagePrompt` 非空。
`video.generate` 合格判据：`videoPrompt` 非空，**或**该 storyboard 任一 shot 已绑 `imageAssetId`（图生视频）。
两者皆不满足 → 该 storyboard 记 `{status:"skipped", reason:"无可用提示"}`。
状态不过滤：draft/approved 均参与（Agent 产物默认 draft，若要求 approved 则手动整跑必然空扇出，与「打通」矛盾——本条为对早期沟通措辞的正式修订）。
`regenerateAll` 未开时：`image.generate` 发现全部 shot 已绑 `imageAssetId`、`video.generate` 发现全部 shot 已绑 `videoAssetId` → 记 `{status:"skipped", reason:"已绑定"}`。

### 3.5 视频节点的取图规则

图生视频优先：查该 storyboard 任一 shot 的 `imageAssetId` → 读资产 `url`（远程 URL，worker 可下载）作 `imageUrl`，`videoPrompt` 作运动提示。资产无 `url`（b64 直落型仅有 workspacePath）→ 降级纯文生视频（用 `videoPrompt`），不引入带 token 的媒体端点 URL 传给 worker。

### 3.6 节点 output（执行中增量落库，终态同形）

```json
{
  "items": {
    "<storyboardId>": {
      "taskId": "ptk_…",              // skipped 项可为 null
      "assetId": "ast_…",             // 未成功时 null
      "status": "completed|failed|cancelled|timeout|skipped",
      "reason": "…",                   // failed/timeout/skipped 的人读原因
      "boundShotIds": ["sho_…"]
    }
  },
  "summary": { "total": 12, "succeeded": 10, "failed": 1, "cancelled": 0, "timeout": 0, "skipped": 1 }
}
```

### 3.7 payload v1 容忍性扩展

`TaskPayload` 增加可选 `storyboardId?: string`。依据：worker `parsePayload` 只校验 `v===1` + `model/providerId` 的 typeof（`apps/worker/src/queue.ts:96-106`），未知键原样保留——**worker 运行时零改动**；两侧 interface 字面量同步加字段仅作契约文档（③ 已确立「改动需双侧同步」注释纪律）。

### 3.8 enqueue 落列

`GenerationService.enqueue` 私有方法增加可选 `workflowId/nodeId/storyboardId/assetName` 透传：前两者写 `production_tasks.workflowId/nodeId`（预留列首次启用，[schema] `packages/database/src/schema/workflow.ts:50-52`），`storyboardId` 进 payload，`assetName` 覆盖默认的 `prompt.slice(0,40)`（生成节点传 `分镜${order}·画面` / `分镜${order}·动态`，批量场景可辨识）。既有路由调用不带这些参数，行为不变。

### 3.9 执行上下文扩展

`WorkflowRunContext` 增加 `projectId`、`workflowId` 两字段（`runWorkflow` 已加载 workflow 行，零额外查询）。生成执行器需要：定位 storyboard/shot/资产、增量写 `workflow_nodes.output`、按 `(workflowId,nodeId)` 查询收养任务。

## 4. 执行模型（Q1 裁决）

**裁决：节点内 await 轮询 + server 启动对账。不复活 `waiting` 挂起态，不用「入队即完成」。**

否决理由记录：挂起/恢复需要给生成器循环加断点续跑语义 + 多恢复源 + 工作流状态机新活跃态，改动面失控；「入队即完成」让下游依赖语义变假。

流程（`image.generate` 视角，`video.generate` 同构）：

1. **收养阶段**：查询 `production_tasks WHERE workflow_id=? AND node_id=?`（含 payload 供 storyboardId 匹配）。非 failed/cancelled 的既有任务按 §5 收养，**绝不重复入队**。
2. **入队阶段**：扫描合格 storyboard（§3.4），对未收养的每个入队 `enqueueImage/enqueueVideo`（记 taskId↔storyboardId 映射）。空扇出（0 合格）→ 抛错「无合格分镜可生成（检查提示词/绑定/重跑范围）」→ 节点 failed，提示可操作。
3. **等待阶段**：每 `SVH_WORKFLOW_GEN_POLL_MS`（默认 3000）轮询未终态任务；每观测到终态立即处理该条（§6 绑定）+ 增量 UPDATE `workflow_nodes.output`。每轮检查 `signal.aborted`（§7）。
4. **收尾**：全部终态且无失败 → 节点 return output（completed）；有任何 failed/cancelled/timeout 项 → 抛错（错误信息含失败清单摘要），节点 failed——**成功项的绑定不回滚**。

已知代价（明示接受）：

- 串行引擎被占住：等待期间同工作流不并行其他分支（默认 DAG 线性，无损；跨工作流互不影响，现状即每工作流独立后台循环）。
- Agent 节点完全不受影响；生成节点不消费 `ctx.modelConfig`/session（它不调 LLM）。

### 4.1 server 重启对账

现状缺口：`running` 状态只存 DB，内存循环随进程消失，重启后永远假 running（agent 节点同样中招，③ 前既有）。生成节点把窗口从 ~1 分钟放大到分钟级，必须补：

- server 启动时（`buildApp` 内，workflowService 构造后）执行一次性对账：DB 中 `status='running'` 的 workflow → 置 `failed`（error=「服务重启导致执行中断，可重试失败节点」）；其 `running` 节点 → 同样置 failed。
- 崩溃窗口内的队列任务照常由 worker 跑完落资产；重试节点经收养阶段（§5）认领 completed 任务并补绑——**重启损失只剩延迟，不丢钱不重复计费**。
- 此对账同时是「retryNode 前置修复」：workflow 置 failed 后既有 retry 端点自然可用。

### 4.2 maxRetries 语义

默认节点 `maxRetries:1` 保留。生成节点失败后的自动重试因幂等收养只是「重新对账 + 补缺」，不产生重复计费——由 §5 保证，无需特判。

## 5. 重跑幂等（Q2 裁决）

**幂等权威 = 任务表 `(workflowId,nodeId)` 查询结果**；node.output 仅为镜像（崩溃发生在入队后、写 output 前的窗口时 output 不可信）。

逐 storyboard 判定（收养规则）：

| 既有任务状态 | 处置 |
|---|---|
| queued / running | 收养进等待集合（不新增行） |
| completed | 收养 + 立即执行绑定（补历史欠账，含崩溃窗口内已产出未绑的） |
| failed / cancelled | 忽略旧行留档；本轮重新入队（新行） |
| 同 storyboard 多行 | 取 createdAt 最新一条判定 |

叠加判据（第二保险）：storyboard 已绑对应资产且未开 `regenerateAll` → skipped。
效果：**retryNode / 重启后 run = 只补缺失项，零重复计费**，兑现批量扇出粒度的重跑承诺。

## 6. 产物→资产→shot 绑定闭环（Q4 裁决）

绑定动作在**生成执行器内**（server 层），worker 保持领域无关、不认识 storyboard。

- 任务 `completed` 时反查资产：`SELECT … WHERE json_extract(generation,'$.taskId') = ?`（worker 在 `apps/worker/src/handlers.ts:265,374` 已写入 `generation.taskId`，含 ③ 本地化链路——localize 发生在 finishTask **之前**，completed 可见时 `url/workspacePath` 已就绪，无竞态）。
- 绑定：对该 storyboard 全部 shot 调既有 `ProductionService.updateShot(id,{imageAssetId|videoAssetId})`（`packages/production/src/service.ts:458`），记录 `boundShotIds`。
- 反查不到资产（理论不该发生）：该条记 failed（reason=「任务完成但未找到产物资产」），不炸整节点。
- 取消后已 completed 的任务照常绑定，不回收资产；生成中的供应商费用退不回（既有模型固有代价，文档写明）。

## 7. 取消与超时传播（Q3 裁决）

- **workflow cancel**：`cancelWorkflow` → AbortController.abort（既有链路）→ 等待循环下一轮（≤ 轮询间隔）观察到 `signal.aborted` → 对本节点全部未终态任务调既有 `GenerationService.cancelTask`（`apps/server/src/modules/production/generation-service.ts:163-187`，守卫写；与 worker 竞态的 409 视为已收敛，吞掉；404 吞掉）→ 相应条记 cancelled → 执行器抛错；引擎在取消窗口 catch 到抛错且 `control.isCancelled()` 时把节点与全部未完成节点置 `cancelled`、workflow 置 `cancelled`（`packages/core/src/workflow/workflow-executor.ts:106-118` 既有语义，零改动）。已 completed 任务不受影响。worker 侧归属自查 + 守卫回写已保证 cancelled 不复活（② 前设计已备）。
- **总预算超时**：`SVH_WORKFLOW_GEN_MAX_WAIT_MS`（默认 1800000=30min，覆盖 worker 单任务 15min maxWait 的批内排队尾部）。到期 → 与取消同路径批量 cancel，条记 timeout，节点 failed。
- **单任务快速失败**：轮询发现 failed/cancelled 即刻记录并继续等其余，不空耗预算。

## 8. 契约扩展面同步（Q5 裁决）与前端最小面

- `CLAIMABLE_KINDS` 不变（kind 仍是 image/video）；worker 零改动（§3.7 已证）。
- 模板：`workflow-service.ts` 新导出 `FULL_PIPELINE_NODES = [...DEFAULT_WORKFLOW_NODES, {id:"images",type:"image.generate",…,dependsOn:["storyboard"]}, {id:"videos",type:"video.generate",…,dependsOn:["images"]}]`。`createWorkflow` options 增加 `withGeneration?: boolean`：为真且未传 nodes 时 specs 取 `FULL_PIPELINE_NODES`（story 注入逻辑不变——它判的是 `!options.nodes`）。**模板唯一事实源在 server；前端不镜像节点常量**（避免再造 TaskPayload 式双侧同步债）。**auto-pipeline 继续用 4 节点默认**——聊天触发不烧生成费，成本入口=显式创建。
- REST：`POST /api/projects/:projectId/workflows` 已透传 `nodes`（`apps/server/src/routes/production.ts:519-530`），本增量仅给 Body 加可选 `withGeneration` 布尔透传。
- 前端（`apps/web/src/features/production/WorkflowPanel.tsx`）：创建 Modal 现状仅发 `{story}` 走 `DEFAULT_WORKFLOW_NODES`（:395-400）。本增量给 Modal 加复选框「同时生成图片/视频（会产生模型费用）」，勾选则 body 加 `withGeneration: true`；未勾选行为完全不变。节点类型标签映射补「生成图片 / 生成视频」；节点详情若 output 含 `summary` 渲染「成功 x / 失败 y / 取消 z / 跳过 w」一行。不新增轮询/端点。

## 9. 环境变量

| 变量 | 默认 | 语义 |
|---|---|---|
| `SVH_WORKFLOW_GEN_POLL_MS` | 3000 | 等待循环轮询间隔 |
| `SVH_WORKFLOW_GEN_MAX_WAIT_MS` | 1800000 | 生成节点总预算（到期批量 cancel） |

读取方式与 `SVH_WORKER_*` 同风格（server config 单点解析，执行器注入，测试可覆盖）。

## 10. 测试策略

- **生成执行器单测**（新文件，假 GenerationService/假时钟/假 db 查询面）：扇出筛选（含 0 扇出抛错）、收养四种状态各一、部分失败→成功项绑定保留、abort→批量 cancelTask 被调、超时语义、skipped 判据、payload 携带 storyboardId + 任务行携带 workflowId/nodeId、assetName 命名。
- **sqlite 集成**（复用 ②/③ 测试桩风格，真库 + 手工推进任务终态模拟 worker）：完整链路——建 6 节点工作流→run→分镜数据齐→手工把任务置 completed + createAsset(generation.taskId)→断言 shot 绑定 + 节点 output 映射 + 任务行 workflowId/nodeId 落列；**重跑幂等断言：第二轮任务行数不增**；启动对账测试：种 running workflow → buildApp → workflow/节点变 failed → retryNode 可用。
- **回归**：现有 core 8 + server workflow-service 7 必须原样绿（引擎与 Agent 节点路径零改动是验收标准）；routes 冒烟补一条「POST workflows 带生成节点 nodes 创建成功」。
- **手动冒烟**：:3456 建 6 节点工作流跑通 mock provider 编排；真实成本遵守 R7（届时单笔审批）。

## 11. 改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `apps/server/src/modules/production/generation-node-executor.ts` | 新增：扇出/收养/等待/绑定核心（不依赖 Fastify，可单测） |
| `apps/server/src/modules/production/generation-service.ts` | enqueue 透传可选列 + payload 字段注释 |
| `apps/server/src/modules/production/workflow-service.ts` | `FULL_PIPELINE_NODES`、`createWorkflow` 加 `withGeneration`、启动对账方法、WorkflowRunContext 加 projectId/workflowId |
| `apps/server/src/app.ts` | 执行器分派、生成执行器装配、启动对账调用 |
| `apps/worker/src/queue.ts` | TaskPayload interface 加可选 `storyboardId`（纯类型，零逻辑） |
| `apps/server/src/routes/production.ts` | 创建路由 Body 加可选 `withGeneration` 透传（一处）；测试补冒烟 |
| `apps/web/src/features/production/WorkflowPanel.tsx` + `apps/web/src/api/production.ts` | 类型标签映射 + summary 一行 + 创建 Modal 复选框（api 层透传布尔） |
| docs | production-guide 新小节 + README 一行 |
| 测试 | 执行器单测 + sqlite 集成 + 对账测试 |

零迁移、零新表、零新端点。

## 12. 风险与明示取舍

- **长占串行引擎**：接受（默认 DAG 线性；引擎不动是约束）。
- **重启中断等待但队列照跑**：接受 + §4.1 对账 + §5 收养把损失压到「延迟 + 手动点重试」。
- **取消退不回供应商在途费用**：既有模型固有，文档写明。
- **多工作流同项目并发生成**：资产名/绑定可能互相覆盖（后完成者赢）；V0.3 不管，文档提示。
- **扫描不过滤 status**：draft 直接进生成是有意取舍（§3.4），审批门禁留后续增量。
