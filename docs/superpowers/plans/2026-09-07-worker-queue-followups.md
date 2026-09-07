# worker 队列化——合入后挂账（V0.3 候选）

来源：2026-09-07 worker-queue 计划的逐任务评审与全分支终审遗留，合入时逐项分诊为「不阻塞、挂后续」。
资产本地化计划（2026-09-07-asset-localization）Task 6 收尾复核：「契约与形状」三条已由 a46b128/1c6e61b 落地并销账；本文另补本地化相关挂账。

## 队列与运维

- 旧库升级时 payload=NULL 的 queued/running 行会永久停留（claim 刻意排除）：加开机清理 `UPDATE production_tasks SET status='failed', error='旧版本遗留任务' WHERE payload IS NULL AND status IN ('queued','running')` 或文档说明。
- 多开 worker 总并发 = 各进程 SVH_WORKER_CONCURRENCY 之和，成本无全局护栏（guide env 表已有警示句）；需要时上单写者优先锁或全局并发配置。
- providerTaskId 回写前被 stale 接管的毫秒级双提交窗口（批准设计固有残留，崩溃才触发）：可 updateRunning 加 claimed_by 或写后复验。
- 转存/生成接管重跑的资产查重：崩溃窗口（createTask 已成功、providerTaskId 未落库）被接管会二次 createTask——供应商双计费且落两条资产；可按 `generation.taskId`/输出 URL 在 createAsset 前查重（本地化 Task 6 评审挂账）。
- worker reclaim（回收他死任务）无显式日志行；claim SQL 的 `payload IS NOT NULL`/`heartbeat_at IS NULL` 谓词加行内注释。
- `SVH_WORKER_MAXWAIT_MS` 改名 `SVH_WORKER_MAX_WAIT_MS` 对齐风格（趁未发布尽快）。
- 默认 workerId 以 pid 兜底，多机共享 DB 会撞 id（非当前目标，文档已限定）。
- 转存回写 metadata 快照整列覆写（Task 2 报告 M3；worker localizeAsset 与 server 手动 localize 同源）：两者都是「入口读资产 → spread 旧快照 → 整列写回」，与任何并发 metadata 写入者（b64 直写键、后续业务键、另一条转存链路）的读-改-写窗口内会互丢键；方向：repo 层 JSON merge 原语，或回写前重读合并 + updatedAt 乐观校验。
- localize 并发与孤儿文件（Task 4 裁决的残留面）：同资产双击/worker 与手动赛跑不上锁，靠 part+rename 原子 + 后写胜出（「并发同 dest 互斥」同源项）；由此派生——重试换扩展名（旧命名沿用失败后 kind 兜底变化）会留旧 `media/<id>.<旧ext>` 孤儿；下载中途资产被 DELETE 则回写炸 500 且新文件永久孤儿。方向：media/ 定期清扫对账（DB 引用集差集）+ 手动 localize 回写失败兜底删刚落地文件。
- 项目/工作区删除的磁盘级联清理：资产转存文件目前仅在单资产 DELETE 时回收（media/ 前缀判据），项目删除（尚无 API）后 media/ 目录整体滞留；上项目删除功能时同步做磁盘级联或孤儿清扫（本地化计划 Task 6 挂账）。

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
- web 本地化体验（Task 5 移交面）：failed 原因只挂 Tooltip，触屏无 hover 不可见（改点击展开或行内小字）；422 错误文案上限 400 字符，toast 超长应截断；重登录 token 换发后，query 缓存里的 `/api/media/...?token=旧` 一次性过期——token 变更事件需使媒体预览重新取源。
