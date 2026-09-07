# SVH apps/worker 生成任务队列化设计（V0.2 收尾增强）

- 日期：2026-09-07
- 状态：已批准（用户选定方案 B：图片+视频生成任务全量队列化）
- 关联：V0.2 技术实施文档 §13/§14/§16；`docs/production-guide.md` §5

## 1. 背景与问题

现状（`apps/server/src/modules/production/generation-service.ts`）：

- **视频**：提交任务后 DB 行落 `production_tasks`，但**轮询与结果落库在 server 进程内异步循环**
  （`void this.pollVideoTask(...)` + 内存 `taskControllers`）。server 重启 = 运行中任务的
  结果永久丢失（供应商 URL 24h 过期，资产无法补录）。
- **图片**：同步长请求（8s-60s）占用 HTTP 连接与 server 并发能力。
- **取消**：依赖同进程内存 AbortController，进程边界即失效。

目标：

1. 生成任务与 server 进程解耦：**server 只入队 / 查询 / 标记取消**；
   独立 `apps/worker` 进程负责**调用 Provider、轮询、资产落库**。
2. server/worker 崩溃重启后可**自动接管**未完成任务（心跳超时回收）。
3. 不引入 Redis/BullMQ 等外部依赖；**SQLite 任务表即队列**（WAL 多进程）。
4. 不修改 Agent Runtime / Workflow 执行模型（workflow run 本次**不**入队）。

非目标：

- workflow 节点执行队列化、跨进程 SSE（留 V0.3）
- 音频/TTS 任务（队列架构预留 `kind: audio`，本次只实现 image/video handler）
- 任务优先级 / 定时任务 / 重试退避（失败即终态，用户重新提交）

## 2. 方案对比（已裁决）

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 仅视频轮询入 worker | createTask 留在 server，只移走轮询 | 图片长请求问题仍在；worker 职责单一，改动两次 |
| **B. 图片+视频全量队列化** | 两类任务统一 queued→running→终态 | ✅ 采纳：语义统一、server 最薄、一次到位 |
| C. 生成+workflow 全入队 | workflow run 也交给 worker | 需跨进程事件桥接，改动面过大，否决 |

队列介质：SQLite（WAL + busy_timeout）任务表原子 claim。BullMQ/Redis 违反零外部依赖前提，否决。

## 3. 数据模型（packages/database）

`production_tasks` 加 3 列（新库 INIT_SQL 直接建列；旧库 `migrateSchema` ALTER TABLE 补列）：

```text
payload       TEXT    -- JSON：worker 执行所需的一切（见 §4），入队时由 server 写入
claimed_by    TEXT    -- worker 实例 id（接管/排障用）
heartbeat_at  INTEGER -- 最近心跳（毫秒时间戳），超时=僵尸任务可被回收
```

要点：

- **payload 内含已解析的 model 配置（含 apiKey）**。理由：worker 独立进程没有
  SettingsService；`settings` 表本来就明文存 Key，信任边界不变（DB 文件本身即机密载体）。
- server 入队时用 `getSkillModelConfigWithMeta(modelName, userId, [kind])` 解析——
  **配置类错误（无 prompt / 未启用模型）仍然 400 即时反馈**。
- Provider 类错误改为异步：出现在 `task.error`，前端任务条展示（方案 B 的已知代价）。

payload 结构（version 字段便于演进）：

```json
{
  "v": 1,
  "prompt": "…",
  "imageUrl": "…",            // 仅 video-i2v
  "size": "1024*1024",         // 仅 image
  "duration": 5, "resolution": "720p",  // 仅 video
  "providerId": "dashscope",
  "model": "qwen-image",
  "baseUrl": "…", "apiKey": "…",
  "assetName": "…（prompt 前 40 字）"
}
```

## 4. Worker（apps/worker，新包 `@svh/worker`）

依赖：`@svh/shared / @svh/database / @svh/production / @svh/providers` + tsx + typescript。

### 4.1 主循环（tick，默认 2s）

1. **心跳**：把本 worker `claimed_by` 且 running 的任务 `heartbeat_at=now`。
2. **claim**（原子 SQL，多 worker 互斥）：

   ```sql
   UPDATE production_tasks
      SET status='running', claimed_by=?, heartbeat_at=?, updated_at=?
    WHERE id = (
      SELECT id FROM production_tasks
       WHERE kind IN ('image','video')
         AND (status='queued'
              OR (status='running' AND heartbeat_at < ?))   -- stale 超时（默认 60s）
       ORDER BY created_at LIMIT 1)
   RETURNING id, kind, payload;
   ```

   （SQLite 允许 UPDATE 子查询引用同表；`better-sqlite3` 经 drizzle `.returning().get()`。）
3. 有空闲并发槽（`SVH_WORKER_CONCURRENCY`，默认 2）才 claim；每 claim 一个任务即启动
   异步 handler，不阻塞 tick。
4. 启动/重启**无需特殊恢复代码**：崩溃遗留的 running 任务心跳过期后自然被回收。

### 4.2 image handler

`payload → provider 路由（providerId==='dashscope' ? DashScopeImageProvider :
OpenAICompatibleImageProvider）→ generate()` →
成功：`ProductionService.createAsset(type:'image')` + task `completed`（outputUrl=图片 URL，
progress=100）；异常：task `failed` + error（截断存储）。

### 4.3 video handler

1. 查 DB 行状态：若已 `cancelled` → 跳过（不再发起远端任务），保持终态。
2. `provider.createTask()` → 回写 `providerTaskId`。
3. 轮询循环（每 `SVH_WORKER_POLL_MS`=5s）：
   - 每轮先读 DB 行：`cancelled` → best-effort `provider.cancelTask()` → 退出；
   - `provider.getTask()` → 更新 `status/progress/error`；
   - `completed` → `createAsset(type:'video', generation.taskId)` + task 终态；`failed` → 终态。
4. 全程 try/catch 兜底置 `failed`；取消竞态（server 标记 cancelled 时 handler 刚
   createTask）由第 3 步首轮 DB 检查收敛。

### 4.4 配置（env）

```text
SVH_DATABASE_URL            同 server（必须指向同一 DB 文件）
SVH_WORKER_CONCURRENCY=2    并发 handler 上限
SVH_WORKER_TICK_MS=2000     主循环间隔
SVH_WORKER_POLL_MS=5000     视频轮询间隔
SVH_WORKER_STALE_MS=60000   心跳超时回收阈值
SVH_WORKER_ID=<随机>        实例 id（日志/claimed_by）
```

日志：极简 console（`[worker]` 前缀 + 时间戳），不引 pino。
退出：SIGINT/SIGTERM → 停止 tick，等待运行中 handler 收尾（best-effort，5s 内退出）。

### 4.5 createDatabase 调整

`packages/database/src/client.ts` 加 `sqlite.pragma("busy_timeout = 5000")`（多进程写竞争兜底）。

## 5. Server 变更（apps/server）

`GenerationService` 变薄：

- `generateImage` / `startVideoTask` → **`enqueueImage` / `enqueueVideo`**：
  校验 + 解析模型配置 + insert `status='queued'` 行 → 返回 `ProductionTaskView`。
  （HTTP 路由路径不变：`POST /api/projects/:id/assets/generate-image|generate-video`、
  `GET /api/tasks/:id`、`POST /api/tasks/:id/cancel`；image 响应从 `{asset, created}`
  改为 `{task}`——**破坏性 API 变更**，仅 web 前端消费，一并改。）
- `cancelTask`：只做状态标记（queued→直接 cancelled 终态；running→置 cancelled，
  由 worker 下一轮观察后 best-effort 通知供应商）。删除 `taskControllers`、
  `pollVideoTask`、`videoAdapterFactory`、502 包装（IMAGE/VIDEO_PROVIDER_ERROR 不再由
  server 抛出；错误进 task.error）。
- `getTask` 不变（读 DB，worker 更新它）。

组合根：`new GenerationService({ db })` 即可（settings 仍需要用于解析配置）。

## 6. 复用重构（packages/production）

`DrizzleProductionRepository` 从 `apps/server/src/modules/production/repository.ts`
**移入 `@svh/production`**（它只依赖 database/shared，server 侧 4 处 import + 测试改为包导入）。
理由：worker 写资产要复用 `ProductionService.createAsset`，避免重复行映射。
行为不变，属定向重构（用户已批准）。

## 7. 前端（apps/web）

- `api/production.ts`：`generateImage` 返回 `{ task: ProductionGenerationTask }`；
  两函数参数不变。
- `panels.tsx`：
  - `VideoTaskBar` 泛化为 `GenerationTaskBar`（label/图标按 kind 区分）。
  - 图片表单提交后进入同一任务条：3s 轮询；`completed` → invalidate 资产列表 +
    success toast；`failed` → Alert 显示 `task.error`（含"检查 API Key/额度"指引）。
  - 排队中（queued）显示"排队中"；running 显示进度。
- `ProductionTaskStatus` 类型已就绪，无需改。

## 8. 运维与文档

- 根 `package.json` dev 脚本：concurrently 增加 worker 流（`pnpm --filter @svh/worker dev`）。
- README：能力表加「任务队列：SQLite 队列表 + 独立 worker 进程」；V0.3 列表移除该项。
- `docs/production-guide.md` §5 改写：生成链路 = 入队 → worker 执行 → 轮询查询；
  错误语义（配置错误 400 即时 / Provider 错误进任务态）；新增 worker env 说明；
  删除"V0.3 方向：独立 apps/worker 队列化"条目。

## 9. 测试与验收

- **database**：旧库迁移（补列幂等）+ 新库结构断言。
- **worker（node:test，临时 DB 文件 + 注入假 ProviderFactory）**：
  image 成功/失败；video 轮询至 completed 落资产；video 轮询中 DB 置 cancelled → 停止且调用
  fake cancelTask；claim 原子性（两 worker 实例并发 claim 不重复工）；stale running 回收；
  未知 kind 不认领。
- **server（改写现有 generation-service.test.ts）**：入队语义（queued 行 + payload 字段齐）、
  配置错误 400 即时、cancel 终态 CONFLICT、getTask 视图。routes 测试同步更新（image 返回 task）。
- **回归**：typecheck / lint / test（server 65±、providers 19、production 46+迁移、core 13）
  / build / web build 全绿。
- **真实验证（小额，经用户既往同意）**：起 server+worker，qwen-image 生成 1 图（确认资产自动落库）；
  wanx2.1-t2v 1 条 480P/5s 视频（确认轮询/落库/取消）；重启 worker 验证接管。验证后清理 smoke 数据。

## 10. 提交计划（中文 commit）

1. `feat(database): production_tasks 增加 payload/claimed_by/heartbeat_at 队列列`
2. `refactor(production): DrizzleProductionRepository 移入 @svh/production 供 worker 复用`
3. `feat(worker): 新增 apps/worker 队列 worker（image/video handler + 原子 claim + 心跳回收）`
4. `refactor(server): 生成服务改为入队语义，删除进程内轮询与内存取消`
5. `feat(web): 图片生成改为任务条统一展示排队/进度/错误`
6. `docs: README/production-guide 更新任务队列说明与 worker 部署`

## 11. 风险与对策

- **多进程写锁**：WAL + busy_timeout=5s + 短事务（update 单行），冲突概率极低。
- **claim 与 handler 崩溃窗口**：心跳超时回收兜底；video 凭 providerTaskId 续轮询无副作用；
  image 重跑=多一次生成（可接受，供应商幂等无法保证）。
- **取消竞态**：handler 每轮先查 DB；最坏情况任务已 completed 才被标记取消 →
  cancel 返回 409（server 按 DB 现状判定）。
- **payload 明文 Key**：与 settings 表同级信任边界；不新增泄漏面（task API 视图不含 payload）。
