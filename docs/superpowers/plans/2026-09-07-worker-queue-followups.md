# worker 队列化——合入后挂账（V0.3 候选）

来源：2026-09-07 worker-queue 计划的逐任务评审与全分支终审遗留，合入时逐项分诊为「不阻塞、挂后续」。
资产本地化计划（2026-09-07-asset-localization）Task 6 收尾复核：「契约与形状」三条已由 a46b128/1c6e61b 落地并销账；本文另补本地化相关挂账。

## 队列与运维

- 旧库升级时 payload=NULL 的 queued/running 行会永久停留（claim 刻意排除）：加开机清理 `UPDATE production_tasks SET status='failed', error='旧版本遗留任务' WHERE payload IS NULL AND status IN ('queued','running')` 或文档说明。
- 多开 worker 总并发 = 各进程 SVH_WORKER_CONCURRENCY 之和，成本无全局护栏（guide env 表已有警示句）；需要时上单写者优先锁或全局并发配置。
- providerTaskId 回写前被 stale 接管的毫秒级双提交窗口（批准设计固有残留，崩溃才触发）：可 updateRunning 加 claimed_by 或写后复验。
- 转存/生成接管重跑的资产查重：崩溃窗口（createTask 已成功、providerTaskId 未落库）被接管会二次 createTask——供应商双计费且落两条资产；可按 `generation.taskId`/输出 URL 在 createAsset 前查重（本地化 Task 6 评审挂账）。
- worker reclaim（回收他死任务）无显式日志行；claim SQL 的 `payload IS NOT NULL`/`heartbeat_at IS NULL` 谓词加行内注释。
- worker 转存成功路径零日志（localizeAsset 只在失败/跳过/回写炸时记）：真实链路排障只能靠 DB ready + 磁盘对账（Task 6 活体即如此）；ready 时补一行 info（资产 id + bytes）成本极低。
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
- Fastify 解析层错误（如 `FST_ERR_CTP_EMPTY_JSON_BODY`，自带 statusCode=400）不被 normalizeError 认识，一律吞成 500 INTERNAL——任何 JSON 路由收「有 Content-Type 无 body」即触发（真实链路冒烟 2026-09-07 活体复现）；normalizeError 应认 FastifyError 并 honor 其 statusCode。
- web 本地化体验（Task 5 移交面）：failed 原因只挂 Tooltip，触屏无 hover 不可见（改点击展开或行内小字）；422 错误文案上限 400 字符，toast 超长应截断；重登录 token 换发后，query 缓存里的 `/api/media/...?token=旧` 一次性过期——token 变更事件需使媒体预览重新取源。

## 终审收尾观察（asset-localization，2026-09-07）

- 三复审观察（不阻塞）：① app.ts 豁免面对 PUBLIC/`/api/media/` 用 startsWith——日后若 PUBLIC 清单扩短前缀（如 `/api/auth`）会连带放行子路径，扩清单时须带尾斜杠+用例；② 本仓自定义 `app.setNotFoundHandler`（app.ts）把 `req.url` 原文内插回显（含编码字符），严格面应只回方法+路径常量（现无反射风险，保守记账——改的是自己一行，非框架默认）；③ 三态同构 404（media/localize）响应体一致但耗时随归属链查询有微秒级差异，理论上高噪声信道仍可辨「存在+他人」vs「不存在」——V1 接受，多租户公开部署前需 timing 对齐或统一短路。
- I1 UI 半边（复审收尾移交）：ready+文件悬空态 media 返 410 且文案引导「重试转存」，但 panels.tsx 重试按钮仅 failed 渲染、onError 只静默回退远程——远端 24h 过期后该卡「坏图+无按钮」（API 侧 POST localize 已可自愈，UI 入口补一行：localFailed 时同样渲染重试）。
- T4 Minor-1 残留：非 image/video 类型资产 POST localize → 400「仅 image / video 资产支持本地化转存」分支无独立用例（harness 家族 type 恒 image），行为由代码钉死；补一行直插 audio 行的用例即可闭环。
- localizeToFile 理论破口（终审 Minor③）：`Readable.fromWeb(response.body)` 装配同步抛（畸形 body 流）时不在其内部 try 域内——worker 侧有外层双保险收敛 failed，server 手动 localize 侧该形态未被外层 catch 包裹，最坏 500（不半途落脏）。方向：localizer 内包 fromWeb 或路由套同款双保险。media 的 `getUserForAuth` 失败被吞成 401（Bearer 同情形 500），DB 真故障会读成「人人掉登录」，该分支宜补 warn。
- 终审 Minor②④⑥ 打包：media 与 localize 的同构 404 文案在两文件各写一份（字面漂移会静默破同构，缺 cross-check 用例/共享常量）；worker `errMessage` 截断 500 不进 localizer sanitize（异常文本含完整 URL 时入库面比 422 路径宽）；DELETE 清理与 media 读、localize 写在「media/ 前缀 vs resolveSafeWorkspacePath」上不对称（读/删有 resolve 层拒越界，写路径靠组装可信假设无 resolve 校验）——三处均低危一致性项，统一在 V0.3 收口。
