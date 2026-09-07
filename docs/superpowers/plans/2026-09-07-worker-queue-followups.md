# worker 队列化——合入后挂账（V0.3 候选）

来源：2026-09-07 worker-queue 计划的逐任务评审与全分支终审遗留，合入时逐项分诊为「不阻塞、挂后续」。

## 契约与形状

- routes 层 `app.inject()` 冒烟测试（本仓从无路由集成测试，本次响应形状破坏性变更只有类型层保护）。

## 队列与运维

- 旧库升级时 payload=NULL 的 queued/running 行会永久停留（claim 刻意排除）：加开机清理 `UPDATE production_tasks SET status='failed', error='旧版本遗留任务' WHERE payload IS NULL AND status IN ('queued','running')` 或文档说明。
- 多开 worker 总并发 = 各进程 SVH_WORKER_CONCURRENCY 之和，成本无全局护栏（guide env 表已有警示句）；需要时上单写者优先锁或全局并发配置。
- providerTaskId 回写前被 stale 接管的毫秒级双提交窗口（批准设计固有残留，崩溃才触发）：可 updateRunning 加 claimed_by 或写后复验。
- worker reclaim（回收他死任务）无显式日志行；claim SQL 的 `payload IS NOT NULL`/`heartbeat_at IS NULL` 谓词加行内注释。
- `SVH_WORKER_MAXWAIT_MS` 改名 `SVH_WORKER_MAX_WAIT_MS` 对齐风格（趁未发布尽快）。
- 默认 workerId 以 pid 兜底，多机共享 DB 会撞 id（非当前目标，文档已限定）。

## 测试加固

- 并发迁移测试加「子进程 stderr 时间戳 + 父进程断言区间重叠」防静默退化为串行 false-green。
- `setWalWithRetry` 成功后复检 `pragma("journal_mode",{simple:true})==="wal"`（防不抛错切不动的静默降级）。
- 供应商侧 cancelled → 本地写 cancelled 分支（handlers.ts）无用例。
- 迁移 DDL 若变重超 busy_timeout 5s 排队预算，双进程冷启动第二方显式失败——届时上 schema 版本表方案。

## 杂项

- idx_tasks_status 被 idx_tasks_queue 左前缀覆盖成冗余（删索引需迁移决策，避开冷启动锁窗口）。
- client.ts workflow_nodes 守卫双调用+107 字符旧行（先于本计划存在）。
- web：取消成功后 `setQueryData` 即时反映终态（现最长 3s 轮询延迟）；Popconfirm `void onCancel()` 吞 409 reject；`ProductionGenerationTask.kind` 收敛为 union。
- 图片任务生成期间被取消：资产已落库但仅在 completed 时 invalidate 列表，需切页方见（边缘）。
- parsePayload 版本不符走「无法解析」文案，语义略偏，可精确为「载荷版本不支持」。
