# 资产本地化转存 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成的图片/视频资产在任务完成时自动转存到服务器本地磁盘（3 次退避重试，失败宽落库），经鉴权流式路由播放，并提供手动重试入口。

**Architecture:** 共享下载器 `localizeToFile` 放 `@svh/production`（worker 主路径与 server 手动重试共用）；worker handler 在 createAsset 后转存并 `updateAssetFields` 回写 `workspacePath` + `metadata.localization`；新 `GET /api/media/:assetId?token=` 路由做鉴权 Range 流式；零 DB 迁移（全部落在既有列与 metadata JSON）。

**Tech Stack:** TS 5.8 strict ESM、pnpm monorepo、Fastify 5、node:test + tsx、better-sqlite3/drizzle、React+antd（web）。

**Spec:** docs/superpowers/specs/2026-09-07-asset-localization-design.md（已获用户批准）

## Global Constraints

- 不新增 DB 列/表（迁移风险面为0是 spec 决策；如发现必须迁移，停下请示）。
- 转存失败**绝不**改变任务终态、绝不重复生成计费（宽落库）。
- 下载器只在 `@svh/production` 一份实现；worker 不 import server，server 不 import worker。
- 中文注释；`type` import 分离；node:test（server 用 `src/**/*.test.ts`，其余 `test/**/*.test.ts`）；commit 中文 `type(scope): 描述`。
- 测试全部离线假 fetchImpl，零真实网络；真实链路验证只在 Task 6（用户已批准小额费用）。
- 视图/响应不得外泄内部绝对路径：`workspacePath` 是工作区相对路径，可入视图（既有行为），media 路由不接受用户输入路径段。
- 每任务结束跑：所在包测试 + 根 `pnpm typecheck && pnpm lint`。

## 现状事实（写给零上下文实现者）

- `production_assets` 已有 `workspace_path`（可空，`validateWorkspacePath` 校验）与 `metadata`（JSON）列；`ProductionAsset` 类型两者已暴露（packages/production/src/asset/asset-types.ts:27），web 类型已含（apps/web/src/types/production-types.ts:131）。
- `ProductionService`（packages/production/src/service.ts）现有 createAsset(:501)/getAsset(:529)/deleteAsset(:537)，**没有 updateAsset**——Task 1 新增窄接口。
- worker handler 成功路径：`apps/worker/src/handlers.ts` image 分支 createAsset 后 `finishTask("completed",{outputUrl...})`；video 分支 completed 后同构。终态写守卫 `updateRunning`/`finishTask`（queue.ts）。
- worker 配置 `apps/worker/src/config.ts` 已有仓库根解析（d027a86 引入 `resolveFromRoot` 同款）；`SVH_WORKER_ID/CONCURRENCY/TICK_MS/POLL_MS/STALE_MS/MAXWAIT_MS` 在 loadWorkerConfig。
- server 鉴权钩子 `apps/server/src/app.ts:139`：`onRequest` 对 `/api/*` 非 `PUBLIC_AUTH_PATHS` 前缀一律 `authenticate(request)`（Bearer）。
- HTTP 冒烟 harness 已存在：`apps/server/src/routes/production.generation.test.ts`（② 引入，commits a46b128/1c6e61b：手工 AppConfig + buildApp({logger:false}) + inject + 临时库 + 真实注册/登录拿 token 的两用户夹具）。generate-video/image 响应现均为 `{ task }`。
- 资产删除路由：`apps/server/src/routes/production.ts:302`（`deps.production.deleteAsset`）。
- DashScope 输出 URL：OSS 直链、24h 过期、支持 https GET。

---

### Task 1: @svh/production 下载器 + updateAssetFields

**Files:**
- Create: `packages/production/src/localizer.ts`
- Modify: `packages/production/src/repository.ts`（接口 +2 方法声明）、`packages/production/src/sqlite-repository.ts`（实现）、`packages/production/src/service.ts`（包装）、`packages/production/src/index.ts`（导出）
- Test: `packages/production/test/localizer.test.ts`、`packages/production/test/asset-update.test.ts`（或并入既有 asset 测试文件）

**Interfaces:**
- Consumes: 无（纯新增）
- Produces（Task 2/4 逐字依赖）:
  - `localizeToFile(opts: LocalizeOptions): Promise<LocalizeResult>`
  - `type LocalizeOptions = { url: string; destPath: string; maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }`
  - `type LocalizeResult = { ok: true; bytes: number; contentType?: string } | { ok: false; error: string }`
  - `extFromContentType(contentType: string | undefined): "mp4" | "png" | "webp" | "jpg" | null`
  - `readLocalizeConfig(env: NodeJS.ProcessEnv): { maxBytes: number; timeoutMs: number }`（`SVH_LOCALIZE_MAX_BYTES` 默认 `500*1024*1024`；`SVH_LOCALIZE_TIMEOUT_MS` 默认 60000）
  - `ProductionService.updateAssetFields(id, patch: { workspacePath?: string | null; metadata?: Record<string, unknown> | null; mimeType?: string | null }): Promise<ProductionAsset>`
  - `LocalizeMetadata` 约定键名：`metadata.localization = { state: "ready"|"failed", error?: string, bytes?: number, at?: string }`

- [ ] **Step 1: 写 localizer 失败测试**（`test/localizer.test.ts`，node:test + 真临时目录 + 假 fetchImpl）

覆盖用例（每条给全断言，不许只写名字）：
1. 一次成功：假 fetch 返回 `{ok:true, headers:{"content-type":"video/mp4"}, body: Readable.toWeb(stream)}`，bytes 落盘正确、`destPath.part` 不残留、返回 `{ok:true,bytes,contentType}`。
2. 前 2 次 throw 第 3 次成功（注入 `sleep` 记录退避序列，断言 `[500,2000]`）→ ok。
3. 3 次全 throw → `{ok:false,error}` 含最后错误，**不抛异常**，目录里无任何残留文件（含 part）。
4. HTTP 500 → 视为失败重试，3 次后 `{ok:false, error 含状态码}`。
5. Content-Length 超 maxBytes → 立即失败不再重试，part 不留。
6. 流式超上限（无 Content-Length，body 字节数超）→ 中止 + part 不留。
7. `extFromContentType`：`video/mp4→mp4`、`image/png→png`、`image/webp→webp`、`image/jpeg→jpg`、`text/html→null`、undefined→null。
8. `readLocalizeConfig({})` 返回默认；env 字符串数字化正确 + 非法值回退默认。

- [ ] **Step 2: 跑测试确认红**：`cd packages/production && node --import tsx --test "test/localizer.test.ts"`（模块不存在）
- [ ] **Step 3: 实现 localizer.ts**

要点（逐条钉死）：
```ts
const BACKOFF_MS = [500, 2000, 8000]; // 3 次尝试之间的退避（第 3 次失败后不再等待）
// 每次尝试：fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) → !res.ok/!res.body → 失败记录
// → 写 res.body（Web stream → Node Readable：Readable.fromWeb）到 destPath.part，
//   计数 bytes，maxBytes 超限 destroy+unlink+break（此错误标记 unretryable 直接返回）
// → 成功后 fs.rename(part, destPath)（同目录原子）
// catch：错误分类累计，attempt<3 时 await sleep(BACKOFF_MS[attempt])；错误信息含 url 主机名不含 query（防签名 URL 入日志）
```
默认 `sleep` 用 `setTimeout` promise 版；`fetchImpl` 默认 globalThis.fetch。**Content-Length 解析失败（NaN）不算超限预检，交给流式计数兜底。**
- [ ] **Step 4: 跑绿** 同 Step 2 命令
- [ ] **Step 5: updateAssetFields 测试→实现**：repo 层（drizzle update set 仅 patch 中出现的键 + `updated_at`，returning 判存在，不存在抛与 getAsset 同款的 NotFound 错误——看 service.ts:529-536 现有错误口径）；service 层先 `getAsset(id)` 存在性校验再透传；测试用真临时库：写 workspacePath+metadata 后 getAsset 读回一致、null 能清空、不存在 id 抛错。
- [ ] **Step 6: 全量回归 + commit**

```bash
cd packages/production && node --import tsx --test "test/**/*.test.ts"
cd /home/yesheng/projects/SVH && pnpm typecheck && pnpm lint
git add -A && git commit -m "feat(production): 新增本地化下载器 localizeToFile 与资产窄更新接口"
```

---

### Task 2: worker 转存集成

**Files:**
- Modify: `apps/worker/src/config.ts`（+`workspaceRoot`、`localize` 配置）、`apps/worker/src/handlers.ts`（成功路径接入）、`apps/worker/src/main.ts`/`index.ts`（deps 透传）、`apps/worker/test/helpers/setup.ts`（createTestEnv 支持注入）
- Test: `apps/worker/test/handlers.test.ts`（新增 4 用例）

**Interfaces:**
- Consumes: Task 1 的 `localizeToFile/extFromContentType/readLocalizeConfig/updateAssetFields`、`HandlerDeps` 既有形状
- Produces: `HandlerDeps` 新增可选字段 `workspaceRoot?: string`、`fetchImpl?: typeof fetch`、`localizeConfig?: {maxBytes,timeoutMs}`；worker 资产 metadata.localization 语义（Task 3/4/5 依赖：ready 必有 workspacePath；failed 时 workspacePath 为 null 且 error 在案）

- [ ] **Step 1: 写 4 条失败用例**
1. image 成功 + fetchImpl 正常 → createAsset 后 localizeToFile 被调（断言目标路径 = `workspaceRoot/<workspaceId>/media/<assetId>.png`，workspaceId 从项目反查——**实现注意：asset 行自带 workspaceId，用 createAsset 返回值**），updateAssetFields 写入 `workspacePath + metadata.localization.state==="ready"`，文件真实存在，任务仍 completed。
2. fetchImpl 全失败 → 资产仍落库且 `url` 为远程、`metadata.localization.state==="failed"`、workspacePath 空；任务 completed 不变；finishTask outputUrl 仍存远程地址。
3. 转存成功但扩展名推断失败（contentType: "application/octet-stream"）→ 按 kind 兜底（image→png，video→mp4）。
4. `workspaceRoot` 未配置（undefined）→ 跳过转存不报错（metadata 无 localization 键）——开发环境容错。
- [ ] **Step 2: 跑红**（用例引用不存在的 deps 字段）
- [ ] **Step 3: 实现**

config.ts：`workspaceRoot: env.SVH_WORKSPACE_ROOT ? 仓库根解析 : 仓库根 + "data/workspaces"`（与 server 默认 `./data/workspaces` resolveFromRoot 同语义，复用 d027a86 的镜像函数）；`main.ts` 把 `config.workspaceRoot` 与 `readLocalizeConfig(process.env)` 注入 loop deps。handlers.ts：抽 `localizeAsset(production, asset, kind, deps)` 私有函数放两处成功路径共用（先 createAsset 拿 id→组 dest→localizeToFile→updateAssetFields；全程 try/catch 兜底成 failed，绝不让异常冒出任务处理）。
- [ ] **Step 4: worker 全量绿**（存量 30 条不许改语义；确需适配的（如默认 log）在报告说明）
- [ ] **Step 5: commit** `feat(worker): 生成成功后自动转存资产到本地工作区（失败宽落库）`

---

### Task 3: media 鉴权流式路由

**Files:**
- Create: `apps/server/src/routes/media.ts`
- Modify: `apps/server/src/app.ts`（注册 + auth 钩子豁免 `/api/media`）、`packages/workspace/src/*`（如需 resolveSafeWorkspacePath 复用则 import，不新写路径逻辑）
- Test: `apps/server/src/routes/media.test.ts`（buildApp+inject 模式，参考 production.generation.test.ts）

**Interfaces:**
- Consumes: ② 的测试 harness 模式（production.generation.test.ts，已在 master）；`AuthService`（app.ts:116 附近，看其 verify 方法真实名称——实现时读 modules/auth/）；`ProductionService.getAsset`；`config.workspaceRoot`
- Produces: `GET /api/media/:assetId?token=<jwt>`：200/206/401/404/410/416 语义（Task 5 前端拼 URL 依赖 query 名 `token`，HTTP Range 标准头）

- [ ] **Step 1: 写失败冒烟**（先读 production.generation.test.ts harness 照形）
1. 真临时库插一条 ready 资产（workspacePath 指到 `<tmpRoot>/<wsId>/media/x.png` 真文件）+ 项目/工作区/用户链 → 本人带 token 200，body 字节等于文件，Content-Type 正确。
2. `Range: bytes=0-3` → 206 + Content-Range + 4 字节；`bytes=5-` 超文件长 → 416；无 Range → 200。
3. 无 token / 坏 token → 401；他人 token → 404（不泄露存在性）。
4. failed 资产（无 workspacePath）→ 404；ready 但文件删除 → 410。
5. 视频拖动模拟：`bytes=<len-10>-` 尾 10 字节。
- [ ] **Step 2: 跑红**（路由不存在）
- [ ] **Step 3: 实现**

`registerMediaRoutes(app, deps: { production, authService, workspaceRoot })`；app.ts 钩子豁免：`request.url.startsWith("/api/media")` 时跳过通用 authenticate（路由内自己验 `req.query.token`）。路由内：验签（AuthService 暴露/新增 `verifyTokenOnly(token): {userId}`，失败抛 401——**不改 Bearer 路径行为**）→ getAsset（NotFound→404）→ 归属 userId 校验（复用按 assetId 查项目 owner 的写法，看 routes/production.ts assertProjectOwned 的数据链）→ localization.ready 谓词 → 绝对路径 = `resolveSafeWorkspacePath(join(config.workspaceRoot, asset.workspaceId), asset.workspacePath)`（root 带 wsId 段，与 WorkspaceManager 的 rootPath=join(workspaceRoot,id) 同形；防 DB 被篡改逃逸；包内已有该函数）→ stat 失败→410 → Range 单区间解析（多区间忽略按无 Range）→ createReadStream + content-length/206 头。**Content-Type 以 DB `assets.mimeType` 为准**（落盘扩展名按 kind 先行兜底，.png 名内可能是 jpeg——Task 2 契约）；扩展名映射小表**仅当 mimeType 为空时**作最后兜底。**确认 app.close() 后无句柄泄漏（流 destroy 在 reply 结束/错误时）。**
- [ ] **Step 4: server 套件全绿**（存量 63+②新增不许回归破坏）
- [ ] **Step 5: commit** `feat(server): 新增 /api/media 鉴权流式路由（Range/410 语义）`

---

### Task 4: 手动重试 API + 删除资产文件清理

**Files:**
- Modify: `apps/server/src/routes/production.ts`（+POST localize；:302 DELETE 前先 getAsset）、`apps/server/src/app.ts`（如 localize 需要 localizeConfig/workspaceRoot deps 注入）
- Test: `apps/server/src/routes/production.generation.test.ts` 或新 `production.localize.test.ts`（harness 复用）

**Interfaces:**
- Consumes: Task 1 `localizeToFile/readLocalizeConfig/extFromContentType`、Task 2 的 metadata 语义、`updateAssetFields`
- Produces: `POST /api/assets/:assetId/localize` → 200 `{asset}`（ready 幂等返回同 200）；422 `{error}`；文件清理语义（Task 5 依赖）

- [ ] **Step 1: 失败用例**：failed 资产重试成功（注入假 fetch 到 localize 依赖——路由 deps 收 `fetchImpl?` 供测试）→ asset ready；全失败 → 422 + localization.error；已 ready → 200 幂等（断言未重下载：fetchImpl 计数 0）；越权 404；无远程 url 的资产（手动上传类）→ 400；**DELETE asset：workspacePath 文件被物理删除**（真临时库 + 真文件），非 media/ 前缀路径（用户手放的 workspacePath）→ DB 删但文件保留（只清本特性产物，保守）。
- [ ] **Step 2: 跑红** → **Step 3: 实现**（localize：getAsset→owner 校验→url 非空→已 ready 短路→destPath=同 media 规则（assetId+既有扩展名，无则按 type 兜底）→localizeToFile→updateAssetFields；DELETE：先 getAsset 拿 workspacePath，deleteAsset 后 `startsWith("media/")` 才 unlink，失败记日志不抛）
- [ ] **Step 4: server 套件绿 + commit** `feat(server): 资产手动转存重试接口与删除时文件清理`

---

### Task 5: web 角标、重试按钮与本地播放源

**Files:**
- Modify: `apps/web/src/types/production-types.ts`（metadata 的 localization 类型化：`ProductionAssetMetadata` 增量声明）、`apps/web/src/api/production.ts`（+`localizeAsset(id)` → `{asset}`；client.ts 无请求超时，同步等待可行——已核实）
- Modify: `apps/web/src/features/production/panels.tsx`（资产卡片角标/按钮/预览源）
- Test: `pnpm --filter @svh/web build` + 手工冒烟（本任务无前端单测基建，不新造）

**Interfaces:**
- Consumes: Task 3 的 `/api/media/:id?token=`、Task 4 的 localize API
- Produces: 无下游

- [ ] **Step 1:** types/api 增补（token 从现有 auth store/session 工具取——读 panels 里 401 处理怎么拿 token 同源）。
- [ ] **Step 2:** AssetGrid/卡片渲染处：`const mediaSrc = asset.workspacePath && asset.metadata?.localization?.state==="ready" ? \`/api/media/${asset.id}?token=${token}\` : asset.url`；预览 `<img>/<video>` src 用 mediaSrc；failed → 小标「未存本地」+ Tooltip（error）+「重试转存」按钮（onClick busy 态禁用重复点击，成功 message.success + invalidate 资产查询，失败 message.error 含原因——满足 AGENTS.md 错误三要素）；无 localization 键 → 不显示角标。
- [ ] **Step 3:** 视觉自查：不改信息层级、无新装饰；`pnpm --filter @svh/web build` 绿。
- [ ] **Step 4: commit** `feat(web): 资产本地化角标、手动重试与本地优先播放`

---

### Task 6: 文档 + 全量回归 + 真实链路验证

**Files:**
- Modify: `docs/production-guide.md`（新「资产本地化」节：状态语义表、手动重试、env `SVH_LOCALIZE_MAX_BYTES/SVH_LOCALIZE_TIMEOUT_MS`、容量提示、token-in-URL 安全披露）、`README.md`（能力表加「资产本地化」一行）、`docs/superpowers/plans/2026-09-07-worker-queue-followups.md`（若含相关挂账勾掉；新增「项目删除磁盘级联清理」一条）
- 无代码改动则不出 commit 外快件

- [ ] **Step 1:** 文档落地（中文，术语与本计划一致：转存/本地化/宽落库）。
- [ ] **Step 2:** 全量回归：六包 + server 全绿、根 typecheck/lint/build/web build 全绿，计数写报告。
- [ ] **Step 3: 真实链路（用户已批准小额费用；沿用本会话 DashScope 配置）**：按纪律重启 server+worker（含新 env 缺省）→ 提交 1 条 480P/5s wanx 视频 → completed 后断言：DB ready + 磁盘有 `data/workspaces/<ws>/media/<assetId>.mp4` + `curl -r 0-1023 /api/media/...` 得 206 首块 → **模拟远程过期不可依赖**：media 200 全量字节数与磁盘一致即可（无法真等 24h）→ 清理 smoke（DB 行 + 文件 + 报告贴证据）。
- [ ] **Step 4: commit** `docs(localize): 资产本地化文档与挂账同步`；**不 push**（控制方终审后统一推）。

---

## 验收门槛（全计划）

- 新用例全绿且存量 0 回归；六包计数写入 Task 6 报告。
- 宽落库铁律有钉：转存失败 → 任务 completed、资产可播（远程）、角标可见可重试——Task 2 用例 2 覆盖。
- 无新 DB 迁移、无新依赖包、`git grep "from \"@svh/server\"\|@svh/worker" apps packages | grep -v "apps/worker/src\|node_modules"` 仍为空（依赖方向不破）。
