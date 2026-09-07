# 资产本地化转存——设计文档

日期：2026-09-07　状态：已获用户批准设计（对话逐节确认）
前置：worker 队列化（docs/superpowers/specs/2026-09-07-worker-queue-design.md，已合入）

## 1. 背景与目标

图片/视频生成资产目前只存供应商远程 URL（DashScope OSS，约 24 小时过期）。生成成功即扣费，链接过期等于产物丢失。本功能把生成产物转存到服务器本地磁盘，并提供鉴权流式访问，使资产在远程链接过期后仍可播放。

决策记录（用户确认）：
- **失败策略 c**：下载带 3 次指数退避重试；仍失败 → 宽落库（任务仍 completed，资产以远程 URL 存在并标「未本地化」，提供手动重试）。**任何情况下不因转存失败重复生成、二次扣费。**
- **送达方式 a**：鉴权流式路由 `GET /api/media/:assetId?token=<JWT>`（Range 支持），不做公共直链、不做 HMAC 签名。

## 2. 非目标

- 旧存量远程资产不回补（链接可能已过期，无法验证转存可行性）。
- 无自动清理、无配额强制（容量仅在文档提示；V1 明确不做）。
- 非生成类资产（脚本/分镜/手动上传）不改行为；它们本就有 workspacePath 语义。
- 项目删除的磁盘级联清理本期不做（资产删除路径做文件清理即可；项目级挂 followups）。

## 3. 数据模型（零迁移）

不新增列。复用 `production_assets` 既有字段：

- `workspacePath`：本地化成功后写入工作区相对路径 `media/<assetId>.<ext>`（ext：按 Content-Type 推断 mp4/png/webp/jpg，兜底按资产 kind 给 mp4/png）。既有 `validateWorkspacePath` 保证安全边界。
- `metadata.localization`（JSON 内嵌对象）：
  `{ state: "ready" | "failed", error?: string, bytes?: number, at?: string /*ISO*/ }`
  - 无 `localization` 键 = 从未尝试（远程模式）。
  - `state:"failed"` → error 记最后一次失败原因；UI 角标 + 手动重试。
  - `state:"ready"` → `url` 字段仍保留远程地址不动（审计/兜底），本地文件为播放首选。
- 判定「本地可用」的唯一谓词：`workspacePath != null && metadata.localization?.state === "ready"` 且文件存在（media 路由 stat 兜底）。

理由：少一次表迁移 = 少一类双进程冷启动风险面；查询需求仅单行读取，metadata JSON 足够。

## 4. worker 转存管线

新模块 `packages/production/src/localizer.ts`：worker 与 server（§6 手动重试）共用同一实现；放 @svh/production 的依赖方向合法（两端本就依赖它，不引入反向依赖；下载属文件 I/O，与「server 不做 Provider 调用」原则不冲突）。

```
localizeToFile({ url, destPath, maxBytes = 500MB, timeoutMs = 60_000, fetchImpl? })
  → { ok: true, bytes } | { ok: false, error }
```
- 3 次尝试，退避 500ms / 2s / 8s；单次 fetch 用 AbortSignal.timeout。
- 边下边写 `destPath.part`；Content-Length 或累计字节超 maxBytes → 中止、删 part、判失败；HTTP 非 2xx 判失败。
- 全部尝试失败不抛出，返回 `{ok:false,error}`（调用方决定落库语义）；成功 rename 原子到位（同目录）。
- 可注入 fetchImpl（测试假网络：成功/前二次失败第三次成功/皆败/超大/半途断流）。

worker handler 改动（`apps/worker/src/handlers.ts`）：image/video 的「成功创建资产」步骤变为——先 `createAsset`（远程 URL，无 localization 键），随后立即转存；转存结果 `updateAsset` 写 `workspacePath` + `metadata.localization`。转存失败不回滚任务状态（宽落库）。`fetchImpl` 进 `HandlerDeps`。

时序理由：先落库再转存，进程中途崩溃时资产不丢（远程 URL 在 24h 内仍可手动/后续补救）；media 路由以「ready+文件存在」为准，无「半初始化」窗口。

## 5. media 流式路由（server）

`GET /api/media/:assetId?token=<JWT>`（新文件 `apps/server/src/routes/media.ts`，注册进 app.ts；**token 走 query**，因 `<img>/<video>` 无法带 Authorization 头；与 Bearer 同一验签路径，认证钩子需放行该路径前缀并改为从 query.token 验——仅此路由，其余不变）：
1. 鉴权：query.token 验签 → userId；失败 401。
2. 资产加载 + 归属（project→user 链，复用 assertProjectOwned 逻辑按 assetId 变体）；不可见 → 404（不泄露存在性）。
3. 谓词 §3；文件 stat 失败 → 410（曾 ready 但文件丢失，明确状态码便于前端提示重新生成）。
4. Range 解析：单区间 → 206 + Content-Range/Accept-Ranges；坏语法 416；无 Range → 200。MIME 按扩展名（video/mp4、image/png、image/webp、image/jpeg）。
5. `createReadStream` 管道，断开即销毁流；无路径注入面（路径由 DB 记录拼 workspaceRoot，不接受用户输入路径段）。

安全注记（文档披露）：token 会出现在 URL/服务器日志——自托管小团队场景接受；替代方案在 followups。

## 6. 手动重试 API

`POST /api/assets/:assetId/localize`（routes/production.ts，auth 中间件同现状）：归属校验 → 谓词非 ready → 调 @svh/production 的 `localizeToFile` 同步执行（生成媒体 MB 级、数十秒内，接受同步等待；已核实 Fastify 5 默认 requestTimeout=0 无请求级超时，可行）→ 成功 updateAsset 转 ready；失败返回 422 + error 文案。已 ready → 幂等返回当前状态。**架构注记**：下载执行发生在 server 进程内，与队列化原则「server 不做 Provider 调用」不冲突（文件下载非生成计费）；若后续要统一收口到 worker，可挂账 `kind:"localize"` 队列任务方案，本期取同步最小实现。

## 7. UI（apps/web）

- 资产卡片（AssetsPanel）：ready 不显示角标；failed 显示「未存本地」小标 + 「重试转存」按钮（调 §6，进行中禁用，结果 message 反馈）；无 localization 键（旧资产）→ 远程模式不显示角标。
- 播放/预览源：ready → `/api/media/<id>?token=<当前会话 token>`；否则 → `url`（远程，过期自然 404，图片 onError/视频 error 已有占位）。
- token 从现有 auth store 取（生产资产组件已在登录态内）。
- 遵循 UI 规范：无新装饰、状态文案含下一步指引。

## 8. 生命周期

- `DELETE /api/assets/:id`（production.deleteAsset 路径）：DB 删除成功后，若 workspacePath 指向 media/ 下文件 → 静默删文件（失败仅日志）。
- 磁盘提示写入 production-guide：容量无护栏 + 多 worker 已有警示同节。

## 9. 测试

- localizer 单测（@svh/production，假 fetchImpl + 真临时目录）：成功/退避后成功/皆败宽落库语义（返回不抛）/超大拒收且不留 part/断流不留 part/非 2xx。
- worker handler 集成（真临时 DB）：image/video 完成 → ready + workspacePath 落库；注入失败 fetch → failed 键 + 任务仍 completed + 资产仍有远程 url。
- media 路由冒烟（沿用 ② 的 buildApp+inject 基建）：200 全量、Range 单区间 206、坏 Range 416、无 token/错 token 401、越权 404、failed 资产 404、文件被删 410。
- localize API 用例：ready 幂等、failed 重试成功转 ready、越权 404。
- deleteAsset 文件清理用例。
- 真实链路（用户批准小额费用）：一条 480P/5s 视频端到端——ready 落库、media 206 播放头、rename 后无 part 残留；清理 smoke 数据。

## 10. 文档

production-guide：新「资产本地化」节（策略、状态语义、容量提示、token-in-URL 安全披露）；README 能力表一行；followups 勾掉相关项。

## 11. 风险与权衡

- 500MB 上限/60s 超时是拍脑袋常数——env 可调（`SVH_LOCALIZE_MAX_BYTES/SVH_LOCALIZE_TIMEOUT_MS`）写进计划。
- 同步 localize 大文件占用 HTTP 连接数十秒：V1 接受（手动重试是小概率路径），worker 主路径不受影响。
- 磁盘写满：表现为下载写失败 → failed 宽落库，UI 可见可重试，无静默丢失。

## 12. 修订记录（正文冻结，此处为准）

- §4 尝试口径：4 次尝试 = 首次下载 + 3 次重试，失败之间依次等待 500 / 2000 / 8000ms（末次失败不再等待；确定性超限即刻返回，不消耗退避）。
- §5 Content-Type 与扩展名口径：Content-Type 以 DB `mimeType` 为权威（缺省才按扩展名小表兜底），文件名扩展名按 kind 先行兜底且落库后不二次改名；白名单 Content-Type 仅用于兜正 `mimeType`，未知类型不倒灌 DB。
- §5/§6 鉴权与恢复口径（终审 I1/I2）：媒体通道在验签之后补用户态检查（getUserForAuth + disabled 拒），与 Bearer 通道同强度——禁用/不存在即刻 401（与坏 token 同形），原讨论的「24h→7d 禁用宽限」取消；手动重试的 ready 幂等短路补「文件在场」校验，ready 悬空（media 410 形态）落入重下载自愈而非空 200。
