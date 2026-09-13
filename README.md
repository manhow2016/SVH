# SVH —— AI Content Agent

> **用自然语言描述创作目标，SVH Agent 负责完成内容生产。**
>
> 用户不需要选择模型、填写参数、调 Prompt、选尺寸。
> 只需要说：「帮我做一个 30 秒的护肤品广告，面向年轻女性，整体高级、有质感」。

SVH 不是「AI 视频生成器」，也不是「AI 短剧工具」。
它是一个面向多类型内容生产的 **AI Content Agent 平台**：
广告、短视频、短剧、数字人、宣传片、视觉内容都是同一套底层能力上的不同 Workflow。

---

## 当前进度

本仓库处于 **V0.1 · Phase 0 ~ Phase 6 已完成** 状态。
Phase 5B 的 UI 与 Phase 6 的资产库前端均已交付；曾卡住旗舰链路（视频成片）的
两个后端既有缺陷**都已修复**，「计划 → 确认 → 执行 → 结果卡」按字面可跑通 ——
见下方「已知限制（必读）」。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 0 | 代码审计（参考项目可复用资产评估） | ✅ 完成 |
| Phase 1 | 核心数据模型、领域层、项目骨架、API 骨架 | ✅ 完成 |
| Phase 2 | Skill Registry、执行引擎、Task Queue、Worker | ✅ 完成 |
| Phase 3 | 真实 Provider 适配器（OpenAI / Anthropic / Gemini）+ BYOK 配置 | ✅ 完成 |
| Phase 4 | Creative Agent（意图分析 / 上下文 / 规划 / 工具调用） | ✅ 完成 |
| Phase 5A | 后端实时通道（`@svh/realtime` 事件总线 + SSE 端点）与确认链路修复 | ✅ 完成 |
| Phase 5B | Agent UI（项目入口 / 工作台 / Provider 配置页） | ✅ 完成 |
| Phase 6 | Asset System 交互与 `@资产` | ✅ 完成 |
| Phase 7 | Creative Canvas 与 Timeline | ⬜ 待开始 |
| Phase 8 | 四套 Workflow 落地 | ⬜ 待开始 |
| Phase 9 | Task Queue 后台执行 | ⬜ 待开始 |
| Phase 10 | 版本系统交互 | ⬜ 待开始 |

当前测试规模：**873 个单元与集成测试**（`config` 25 / `domain` 66 / `database` 32 /
`workflow` 35 / `skills` 38 / `model` 56 / `queue` 14 / `agent` 58 / `api` 140 /
`worker` 65 / `realtime` 40 / `storage` 16 / `web` 288），四条流水线
（`lint` / `typecheck` / `test` / `build`）52/52 全绿 —— **但存在一条既有抖动用例**
（`apps/api` 的 `events.test.ts`，实测约 17.5% 的概率变红，
机制与建议修法见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9 第 20 条）。
撞到它时请先看那一节，别当成自己改坏了。

**Phase 6 新增 96 个用例**（`web` 204 → 288、`api` 128 → 140），覆盖资产库页面与
三态、创建对话框、详情抽屉、`MetadataForm` 六种控件、`@资产` 链接化。
其中**只有一条是机械护栏**：`asset-form-contract.test.ts`（用编译器 API 断言前端
字段表与 `@svh/domain` 的 asset schema 一致）。`@资产` 那边**没有**机械护栏 ——
`mention-text.test.tsx` 只是一条把前后端口径写下来的**前端行为用例**，
它不比对正则源码，只改后端它照样绿（见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6.11）。

**前后端的类型接缝现在有机械护栏了**：`apps/web/src/lib/api-types.ts` 是手写的
（前端构建不该把 Prisma / Fastify 拉进 bundle），它原本声明的护栏是「跑一遍验收
标准第 1 条的端到端」—— 而那条链路当时因下面登记的缺陷**不可达**，等于没有护栏。
现在由 `apps/api/test/api-contract.test.ts` 承担：打 15 个真实端点，再从
`api-types.ts` 解析出每个接口的必填字段，断言「声明了就必须真的存在」。
补它的时候当场抓到一处真漂移（`TaskProgress.terminal` 被声明在任务列表项上，
服务端只在 `/progress` 端点返回），并删掉了一处照旧接口文档猜出来的字段
（连通性测试的 `{ ok }`，服务端从不返回）。

详细设计决策见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 已知限制（必读）

Phase 5B 的 **UI 交付完成**，Phase 6 的**资产库前端已交付**。
曾卡住「旗舰链路」的两条后端缺陷**都已修复**，
spec §10 第 1 条的字面场景现在可以走通；第 4 条（Mock 回落静默）同样已修复：

1. ~~**技能写出的资产 metadata 不被 schema 接受**~~ —— **已修复**（见下方「已修」）。
   原先登记的说法是「`video.generate` / `video.extend` 两个技能」，
   实际审计下来是 **7 个生成类技能里坏了 5 个**：`video.generate`（`aspectRatio`、
   `shotCount`）、`image.edit`（`generation.editedFrom`）、`video.extend`
   （`generation.extendedFrom` / `extraSeconds`）、`voice.generate`
   （`generation.voiceAssetId`）、`subtitle.generate`（`cues`）。
   它们全都在「登记资产」这一步被 `.strict()` 拒掉，而前面模型调用、进度上报
   一切正常 —— 表现是「跑了 10 秒然后失败」，很难联想到是字段名的问题。
2. ~~**广告计划卡上没有「开始制作」按钮**~~ —— **已修复**（见下方「已修」）。
   按钮原先只在 `requiresApproval` 为真时渲染，而它由「模板里高成本节点 ≥ 3」
   判定，广告模板 13 步里只有 1 个高成本节点 —— 计划消息说着「确认后我就开始制作」，
   卡片上一个按钮都没有。
3. ~~**未配置模型时工作台静默回落 Mock**~~ —— **已修复**（见下方「已修」）。
   没有可用的真实模型时后端改用 Mock，Agent 照常回复、任务照常执行，
   只是产出全是占位数据；界面此前拿不到任何信号，用户会把「示例文本-878」
   当成模型答复（探针实测 `错误提示: []`）。

**至此 spec §10 第 1、4 条都可以按字面重验。**

更完整的前端侧限制见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9 第 14、15 条；
Phase 6 新登记的资产侧限制见同节第 19 条（跨资产引用与自由键值对暂不可编辑、
`character.metadata.appearanceFields` 死字段、无版本历史界面、无全局资产库、
`@` 补全会列出已归档资产）。

Phase 6 的资产库前端结构（数据表 + 渲染器、表单↔schema 的机械契约、
编辑只发 dirty 字段、`@资产` 的口径）见同文件 §6.11。

### 已修：技能 metadata 与 asset schema 的契约

- **schema 收了这些字段**（`packages/domain/src/asset.ts`，`.strict()` 保持不变）：
  顶层 `aspectRatio`（图/视频）、`shotCount`（视频）、`cues`（字幕时间轴，按结构校验）；
  `generation` 子对象新增血缘字段 `editedFrom` / `extendedFrom` / `extraSeconds` /
  `voiceAssetId`。这个 schema 本来就是「跨媒体类型的共享字段袋」
  （`channels` 只对音频、`fps` 只对视频），新增字段符合既有约定。
- **真机端到端复验**：`video.generate` 经「建任务 → 会话确认 → 执行」跑通，
  `success 100%`，产出带视频 URL 的结果卡，资产 metadata 为
  `{duration, aspectRatio, shotCount, generation}`。
- **补了那道缺失的护栏**：`packages/skills/test/skill-execution.test.ts`
  给每个已实现技能喂最小合法输入并**真的执行一遍**，承接写入的内存资产端口
  调用 domain 的真实 schema。`skill-catalog.test.ts` 过去只校验目录元数据、
  从不执行技能体，这正是 5 个技能坏了都没人发现的原因。
  负向验证过：往 `video.generate` 里注入一个未知键，只有那一条用例失败并直接点名该字段。

### 已修：计划卡的操作入口与「要不要审批」解耦

- `requiresApproval` 回答的是「系统要不要先停下来等你」（Agent 轮次据此结束在
  `waiting_user`），而按钮回答的是「界面上有没有动手的入口」—— 这是两件事，
  原先被绑在一起（判据是 `APPROVAL_NODE_THRESHOLD = 3`）。
  现在操作区**始终**渲染，`requiresApproval` 改为只影响一句提示文案
  （「这份计划包含多个高成本步骤，确认后才会开始执行。」）。
- 这不是「阈值调小一点」能解决的：换成任何高成本节点不到 3 个的模板都会中招。
- **真机验证**：广告计划卡（13 步）上「开始制作」「调整方案」都在，
  按钮完全在视口内，`elementFromPoint(按钮中心)` 命中按钮自己，
  派发真实鼠标点击后确实发出了新一轮对话。
- **端到端**：计划卡 → 开始制作 → 确认 → 实时进度 → `success 100%` 已跑通。
- 顺带修掉一条**把缺陷写成预期行为**的测试（「不需要审批时不显示「开始制作」」）。

### 已修：Mock 回落不再静默

两处根因：① `buildModelRuntime` 的回落警告走 `options.logger?.warn`，而 API 侧
**从来不传 logger**，警告被静默丢掉；② `ModelRuntime.usingMock` 一直存在、
注释也写着「供启动日志与就绪探针展示」，却**没有任何出口**。

- `getAgentModelRuntime(logger?)` / `buildAgentDeps(logger?)` 接可选 logger，
  由路由传 `request.log`。实测 API 日志里现在能看到那条 `level:40` 的回落警告。
- 新增 `GET /api/models/providers/runtime`，工作台据此显示常驻警告条
  「当前没有可用的模型配置，Agent 的回复与生成结果都是占位内容」+「去配置模型」链接。

**判据踩过的坑**：第一版用 `runtime.usingMock`，但库里那条 `kind='mock'` 的
Mock Provider 行**自带 5 个模型**，于是「只剩 Mock 可用」时它仍是 `false` ——
实测把唯一一个真实 Provider 禁用后，端点照样报 `usingMock:false`，提示条不会出现。
改成按 Provider 类型算（所有可用模型都来自 mock 类 Provider → `placeholderOnly`）。

真机验证（探针跑在真的禁用了 Provider 的环境上）：只剩 Mock 时提示条出现、
文案说清、链接可点、在视口内；还原后消失（负向断言）。

**选择「强提示但不禁用」**：Mock Provider 本身是开发期合法功能，
硬禁用会让没配 key 的人完全无法试用任何流程；提示条已把「现在看到的是假的」说清楚。

---

## 素材存储（本轮新增）

模型产出的文件此前**从来没有被保存过** —— `filesToStorageRefs` 把 provider 返回的
链接原样写进资产引用（`driver: 'remote'`），于是「媒体能不能看」完全取决于对方那个
链接还没过期。配置里的 `STORAGE_DRIVER` / `STORAGE_LOCAL_DIR` /
`STORAGE_PUBLIC_BASE_URL` 三项只有声明、没有实现（全仓库没有任何代码往磁盘写文件），
`/files` 路由也不存在。

现在：

- **`@svh/storage`** 把产物落盘到 `STORAGE_LOCAL_DIR`（支持 http(s) 与 `data:` 来源，
  有大小上限、下载超时、路径穿越双防线、拒绝链路本地地址），引用指向我们自己的
  `STORAGE_PUBLIC_BASE_URL`。内容哈希命名 ⇒ 同份产物重复落盘幂等。
- **`GET /files/*`** 手写静态服务（不引中间件：路径解析是安全敏感面，必须自己钉死）。
- **`GET /api/assets/:id/media-health`** 回答「这份媒体还在不在我们手里」——
  产物落盘之后这件事查一下磁盘就知道，不需要网络探活、没有 SSRF 面。
- 结果卡的 `media[].url` 也改成指向落盘地址（此前仍用 provider 链接，
  等于把刚修好的根因又绕回去 —— 真机探针里暴露的）。

**配置解析的一处修正**：`STORAGE_LOCAL_DIR` 是相对路径，而相对路径默认按**进程 cwd**
解析 —— API 与 Worker 的 cwd 分别是 `apps/api` 与 `apps/worker`，同一个配置项指向两个
目录。实测直接踩到：Worker 写进 `apps/worker/storage/`，API 去 `apps/api/storage/` 找。
现在由 `@svh/config` 的 `getRepoRoot()` 统一解析成绝对路径（以 `.env` 所在目录为仓库根）。

---

## 后续任务

按优先级：

1. **与真实厂商服务的互通没有自动化覆盖** —— 这是本质上无法在 CI 覆盖的：
   需要真实凭据，且各家实现有偏差。适配器**自身的协议形状**是有覆盖的：
   `packages/model/test/providers.test.ts` 起真实本地 HTTP 服务器，
   `fetch` 走真实网络栈，三个适配器共 21 例报文断言 + 8 例错误映射。
   （我曾把这条写成「适配器在 CI 里从不发 HTTP 请求」，是错的，已更正。）
2. **桩服务的视频字节不是可播放文件**（`/stub/video.mp4` 返回的是一段文本、
   只是标了 `video/mp4`），所以本机看到的每一张视频结果卡都会显示媒体降级提示。

> **已清空**：ARCHITECTURE §9 里的三条「立即（缺陷，不是优化）」、以及第 16、17 条
> （队列隔离、任务级确认出口）与第 15 条的 Mock 回落棘轮，均已完成。

---

## 快速开始

### 前置要求

- Node.js >= 20（开发环境使用 24）
- pnpm >= 9
- PostgreSQL 与 Redis（本项目复用已有的本地实例，未新增容器）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

然后编辑 `.env`，至少确认以下三项：

```bash
# PostgreSQL 连接串
DATABASE_URL="postgresql://<用户>:<密码>@127.0.0.1:5432/svh_dev?schema=public"

# Redis 连接串（有密码时写成 redis://:<密码>@host:port/db）
REDIS_URL="redis://127.0.0.1:6379/3"

# 密钥加密：必须为 32 字符以上的强随机值
# 生成方式： openssl rand -hex 32
SECRET_ENCRYPTION_KEY="<粘贴随机值>"
```

> `SECRET_ENCRYPTION_KEY` 不能是 `change-me`、`dev-only-` 之类的占位值，
> 配置校验会显式拒绝这类弱默认值并拒绝启动。这是刻意设计的。

### 3. 初始化数据库

```bash
# 创建数据库（若尚不存在）
createdb svh_dev        # 或： psql -c "CREATE DATABASE svh_dev;"

# 应用迁移
pnpm db:migrate

# 写入种子数据（技能目录 + 四套工作流模板 + 演示项目）
pnpm db:seed
```

### 4. 启动服务

```bash
pnpm api:dev       # HTTP API（默认 127.0.0.1:3030）
pnpm worker:dev    # 任务消费者（不启动它，任务只会停在 pending）
pnpm web:dev       # Agent UI（默认 5173，/api 代理到 3030）
```

浏览器打开 <http://127.0.0.1:5173> 即可使用：`/projects` 是项目入口，
`/projects/:projectId` 是对话工作台，`/settings/providers` 配置模型服务。

> 前端只请求相对路径 `/api/...`，开发期由 Vite 代理到 3030（见
> `apps/web/vite.config.ts`），因此不需要 CORS，也不需要在前端配置后端地址；
> 部署时把 `apps/web/dist` 的静态产物与 API 放在同一来源即可。

**用隧道 / 反向代理的域名访问开发服务器**（例如把 `test1.kv2ray.cc` 转发到
`127.0.0.1:5173`）需要额外放行 Host：Vite 6 起有 DNS rebinding 防护，
非本机名字的 Host 会被直接挡掉，页面只有一句
`Blocked request. This host ("…") is not allowed.` —— 它挡的是页面本身，
看起来像服务没起来。在 `.env` 里加一行即可（逗号分隔，换域名不用改代码）：

```bash
VITE_ALLOWED_HOSTS=test1.kv2ray.cc
```

`localhost` / `127.0.0.1` 始终放行，未列出的域名仍然会被挡。

> **HMR 不需要额外配置**（已用真实浏览器实测，别再加 `server.hmr` 了）。
> Vite 客户端拼 socket 地址用的是 `${__HMR_HOSTNAME__ || location.hostname}:${hmrPort || location.port}` ——
> `hmrPort` 没配时会**回退到页面自己的端口**。隧道下页面是
> `https://test1.kv2ray.cc`（不带端口）→ 端口为空 → 实际连的就是
> `wss://test1.kv2ray.cc/`（443），协议按 `location.protocol` 自动取 `wss`，
> 正好落在隧道上。实测：WebSocket 握手 `101`、收到 `{"type":"connected"}`、
> 控制台打出 `[vite] connected.`；真改一次 `ProjectListPage.tsx` 后
> 浏览器收到了 `{"type":"update","updates":[{"type":"js-update",…}]}`。

验证：

```bash
curl http://127.0.0.1:3030/healthz   # 存活探针
curl http://127.0.0.1:3030/readyz    # 就绪探针（检查数据库与队列）
```

实时通道冒烟（另开终端，`SESSION_ID` 取自 `/api/agent/chat` 的响应）：

```bash
curl -N http://127.0.0.1:3030/api/agent/sessions/$SESSION_ID/events
```

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动全部服务（Turbo） |
| `pnpm api:dev` | 只启动 API |
| `pnpm worker:dev` | 只启动 Worker（任务消费者 + 对账循环） |
| `pnpm web:dev` | 只启动 Agent UI（Vite dev server，5173） |
| `pnpm --filter @svh/web build` | 构建前端静态产物到 `apps/web/dist` |
| `pnpm test` | 运行全仓测试（可与 Worker 同时跑，见下方说明） |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm lint` | 全仓代码检查 |
| `pnpm db:migrate` | 创建并应用迁移 |
| `pnpm db:deploy` | 应用已有迁移（生产） |
| `pnpm db:seed` | 写入种子数据（幂等） |
| `pnpm db:studio` | 打开 Prisma Studio |

> **测试与开发期 Worker 可以同时跑**（曾经不行，现已隔离）。
>
> 两边共用同一个 Redis 库，早先队列前缀都写死成 `svh`，于是正在跑的 Worker 会
> **抢走测试刚建出来的任务**并推到 `running`，表现成一堆看似与改动无关的失败：
>
> ```
> confirmation-loop.test.ts  expected 'running' to be 'pending'
>                            expected '抢占失败：already_leased' to contain '等待用户确认'
> smoke.test.ts              取消任务后…  expected 404 to be 204
> ```
>
> 现在 `QUEUE_PREFIX` 可配，测试在 `setup-env.ts` 里各用自己的前缀
> （`svh-test-api` / `svh-test-worker` / `svh-test-queue`），两边再也看不见对方的作业。
> 实测：Worker 一直开着，`@svh/api` **121/121 全过**、全流水线 **48/48**。
> 护栏在 `apps/api/test/queue-isolation.test.ts`：同一个 jobId 在开发期前缀下
> 必须查不到。

> **测试也不会去打你本机配置的模型服务**。Agent 的模型运行时是从数据库里已配置的
> Provider 装配的，测试若不强制，就会真的调用它 —— 配了付费 API 时，
> 跑一次 `pnpm test` 就是真实计费调用。现在测试由 `AGENT_FORCE_MOCK=true`
> 强制使用内置 Mock（`apps/api/test/setup-env.ts`），护栏在
> `apps/api/test/agent-model-isolation.test.ts`。
> 实测：修复前每轮流水线会在桩服务上打出十几条 `chat/completions`，现在**一条都没有**。

---

## 项目结构

```text
SVH/
├── apps/
│   ├── api/                    Fastify HTTP 服务（一域一插件）
│   │   ├── src/core/           装配、日志、错误处理、校验、事件发布、任务装配
│   │   └── src/routes/         health / projects / contents / assets / skills /
│   │                           workflows / tasks / providers / agent / events(SSE)
│   ├── worker/                 任务消费者 + 对账循环（回收过期租约）
│   └── web/                    Agent UI（React 19 + Vite + CSS Modules）
│       ├── src/components/     通用组件（按钮 / 表单 / 弹层 / 三态 / 进度 / 轻提示 / 图标）
│       ├── src/features/       projects（项目入口）/ agent（工作台）/ settings（模型服务）
│       ├── src/lib/            API 客户端、SSE 客户端、传输契约类型、格式化
│       └── src/styles/         Design Token 与全局样式
├── packages/
│   ├── domain/                 核心领域层（枚举、Schema、类型、图算法、错误体系、传输契约）
│   ├── config/                 环境配置（Zod 校验 + fail-fast + 弱默认值黑名单）
│   ├── database/               Prisma Schema、任务运行时仓储、资产写入入口、种子数据
│   ├── workflow/               四套内置工作流定义（纯数据，零 DB 依赖）
│   ├── skills/                 43 个技能声明 + 15 个实现 + 注册表 + 执行引擎
│   ├── model/                  Model Router + 三个真实 Provider 适配器 + Mock
│   ├── agent/                  Creative Agent（意图 / 上下文 / 规划 / 工具循环）
│   ├── queue/                  BullMQ 资源池封装（确定性 jobId + 领域层重试）
│   ├── realtime/               Redis Stream 事件总线（发布器 + 订阅器，含补发与取消清理）
│   └── storage/                素材落盘：把模型产出的文件收进自己的存储 + 存在性判定
└── docs/
    ├── ARCHITECTURE.md                     架构说明与设计决策
    ├── ARCHITECTURE_AUDIT_REFERENCE.md     参考项目 aiVideo 审计报告
    └── ARCHITECTURE_AUDIT_DRAMAI.md        参考项目 dramai 审计报告
```

> `apps/web` 交付三个页面（项目入口、对话工作台、模型服务配置）与工作台内嵌的
> 实时任务面板。响应式分三档（Desktop / Tablet / Mobile），窄屏时侧区折叠为抽屉。

---

## 核心概念

### Content（内容）

一份具体内容——一条广告、一期短视频、一集短剧、一条数字人口播。
用 `type` + `metadata` + 绑定的 Workflow 表达类型差异，
**核心架构不包含任何特定内容类型的硬编码**。

左侧导航分区由内容类型动态决定：

| 内容类型 | 导航分区 |
| --- | --- |
| 广告 | 创意 / 产品 / 脚本 / 分镜 / 视频 / 成片 |
| 短视频 | 选题 / 脚本 / 镜头 / 视频 / 字幕 / 成片 |
| 短剧 | 剧本 / 角色 / 场景 / 分集 / 分镜 / 视频 |
| 数字人 | 数字人 / 文案 / 声音 / 视频 / 成片 |
| 宣传片 | 大纲 / 解说词 / 镜头 / 视频 / 成片 |
| 视觉内容 | 创意 / 视觉 / 成品 |

### Asset（资产）

统一资产系统：角色 / 产品 / 品牌 / 场景 / 数字人 / 图片 / 视频 / 音频共用一套模型。

- **跨 Content 复用**：同一品牌资产可被广告、短视频、数字人同时引用
- **必须支持版本**：每次变更写快照，可查看历史并恢复
- **可用 `@引用`**：在 Agent 输入框里说「让 `@苏晚` 穿红色衣服」

### Workflow（工作流）

可序列化的 DAG，**独立于 Agent**。Agent 的职责只是规划出这份描述，
执行推进由 Workflow Engine 完成。

V0.1 内置四套：

| 流程 | 节点数 | 拓扑层数 | 并行设计 |
| --- | --- | --- | --- |
| 广告 | 13 | 10 | 产品视觉与创意链路并行 |
| 短视频 | 10 | 7 | 脚本与素材并行 |
| 短剧 | 16 | 11 | 角色与场景并行；剧本 → 分镜 → 画面串行 |
| 数字人 | 10 | 6 | 形象 / 文案 / 声音 / 背景四方并行 |

### Skill（技能）

能力的**声明式定义**，不绑定具体模型：

```text
Creative Agent → Skill Registry → Skill → Model Router → Provider → Model
```

每个 Skill 声明自己需要什么模型能力（`capabilities`）、输入输出契约、
风险等级与权限等级。Model Router 据此挑选合适的模型执行。

### 任务系统

**所有耗时 AI 操作统一 Task 化**，Agent 不阻塞 HTTP 请求。

- 重试由**领域层**控制（BullMQ `attempts` 恒为 1），以便在重试前切换模型
- 幂等三件套：DB 唯一键 + 确定性 `jobId` + CAS 闸门
- 租约 + Fencing 令牌：防止失去租约的 Worker 覆盖新结果
- 按资源池分队列：避免视频长任务饿死文本短任务

---

## API 概览

| 端点 | 说明 |
| --- | --- |
| `GET /healthz` | 存活探针（不检查依赖） |
| `GET /readyz` | 就绪探针（检查数据库与 Redis） |
| `GET/POST /api/projects` | 项目列表 / 创建 |
| `GET/PATCH/DELETE /api/projects/:id` | 项目详情 / 更新（含 Project Memory）/ 归档 |
| `GET/POST /api/projects/:id/contents` | 项目下的内容 |
| `GET /api/contents/:id/sections` | 按内容类型返回导航分区 |
| `GET /api/contents/:id/versions` | 内容版本历史 |
| `GET/POST /api/assets` | 资产列表 / 创建（metadata 按类型校验） |
| `PATCH /api/assets/:id` | 更新资产（深合并 + 生成新版本） |
| `GET /api/assets/:id/versions` | 资产版本历史 |
| `POST /api/assets/:id/versions/:version/restore` | 恢复到历史版本 |
| `POST /api/assets/resolve-mentions` | 解析文本中的 `@引用` |
| `GET /api/skills` | 技能目录（支持按能力 / 类别筛选） |
| `GET /api/skills/by-alias/:alias` | 按中文别名查找（`/写脚本`） |
| `GET /api/workflows` | 工作流列表（含拓扑分层，前端可直接渲染） |
| `GET /api/workflows/builtin` | 四套内置流程模板 |
| `GET /api/tasks/:id` | 任务详情（含进度与子步骤） |
| `GET /api/tasks/:id/progress` | 轻量进度轮询 |
| `POST /api/tasks/:id/cancel` | 取消任务 |
| `GET/POST /api/models/providers` | 模型服务商（API Key 加密存储、掩码返回） |
| `POST /api/models/providers/:id/test` | 连通性测试 |
| `POST /api/agent/chat` | Agent 对话（返回消息 + 结构化载荷 + 工具轨迹） |
| `GET /api/agent/sessions/:id` | 会话详情（含消息与结构化载荷） |
| `GET /api/agent/sessions/:id/events` | **SSE 实时事件流**（支持 `Last-Event-ID` 断点续传） |
| `POST /api/agent/sessions/:id/confirm` | 确认并继续（放行等待确认的任务） |

**响应约定**：成功直接返回资源（用 HTTP 状态码表达语义），
失败返回 `{ error: { code, message, suggestions, retryable }, requestId }`。
不存在 `{code, data, message}` 包装——细节见 `docs/ARCHITECTURE.md` §3.3。

---

## 开发约定

1. **先审计再修改**：改动核心模块前先确认现有实现与约束。
2. **不用统一响应包装**：成功返回资源，失败用 HTTP 状态码 + 错误体。
3. **技术错误进日志，用户文案进响应**：禁止把堆栈、Provider 原始报文暴露给用户。
4. **禁止 `process.env.X ?? '默认值'`**：一律通过 `getEnv()`。
5. **枚举只在 `domain/enums.ts` 定义一次**，Prisma 侧由漂移测试守护。
6. **不把特定内容类型的逻辑写进核心架构**：用 ContentType + Workflow + Skill 表达。
7. **每个包都要有 `build` / `typecheck` / `test` / `lint`**。
8. Commit 使用中文，格式 `type(scope): 描述`。

---

## 文档索引

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 架构说明、关键设计决策及其理由、已知限制
- [`docs/ARCHITECTURE_AUDIT_REFERENCE.md`](docs/ARCHITECTURE_AUDIT_REFERENCE.md) —— 参考项目 aiVideo 审计（可复用资产、应规避的坑）
- [`docs/ARCHITECTURE_AUDIT_DRAMAI.md`](docs/ARCHITECTURE_AUDIT_DRAMAI.md) —— 参考项目 dramai 审计（Prompt 工程、业务建模经验）
