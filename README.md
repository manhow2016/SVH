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

本仓库处于 **V0.1 · Phase 0 ~ Phase 5B 已完成** 状态。
其中 Phase 5B 的 **UI 已交付**，但旗舰链路（视频成片）被两个后端既有缺陷卡住、
**目前跑不通** —— 见下方「已知限制（必读）」。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 0 | 代码审计（参考项目可复用资产评估） | ✅ 完成 |
| Phase 1 | 核心数据模型、领域层、项目骨架、API 骨架 | ✅ 完成 |
| Phase 2 | Skill Registry、执行引擎、Task Queue、Worker | ✅ 完成 |
| Phase 3 | 真实 Provider 适配器（OpenAI / Anthropic / Gemini）+ BYOK 配置 | ✅ 完成 |
| Phase 4 | Creative Agent（意图分析 / 上下文 / 规划 / 工具调用） | ✅ 完成 |
| Phase 5A | 后端实时通道（`@svh/realtime` 事件总线 + SSE 端点）与确认链路修复 | ✅ 完成 |
| Phase 5B | Agent UI（项目入口 / 工作台 / Provider 配置页） | ✅ UI 交付完成；**旗舰链路的两个后端缺陷待修**（见下） |
| Phase 6 | Asset System 交互与 `@资产` | ⬜ 待开始 |
| Phase 7 | Creative Canvas 与 Timeline | ⬜ 待开始 |
| Phase 8 | 四套 Workflow 落地 | ⬜ 待开始 |
| Phase 9 | Task Queue 后台执行 | ⬜ 待开始 |
| Phase 10 | 版本系统交互 | ⬜ 待开始 |

当前测试规模：**699 个单元与集成测试**（`config` 25 / `domain` 58 / `database` 23 /
`workflow` 35 / `skills` 20 / `model` 56 / `queue` 14 / `agent` 58 / `api` 118 /
`worker` 63 / `realtime` 40 / `web` 189），四条流水线
（`lint` / `typecheck` / `test` / `build`）全绿。

**前后端的类型接缝现在有机械护栏了**：`apps/web/src/lib/api-types.ts` 是手写的
（前端构建不该把 Prisma / Fastify 拉进 bundle），它原本声明的护栏是「跑一遍验收
标准第 1 条的端到端」—— 而那条链路因下面的缺陷**不可达**，等于没有护栏。
现在由 `apps/api/test/api-contract.test.ts` 承担：打 15 个真实端点，再从
`api-types.ts` 解析出每个接口的必填字段，断言「声明了就必须真的存在」。
补它的时候当场抓到一处真漂移（`TaskProgress.terminal` 被声明在任务列表项上，
服务端只在 `/progress` 端点返回），并删掉了一处照旧接口文档猜出来的字段
（连通性测试的 `{ ok }`，服务端从不返回）。

详细设计决策见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 已知限制（必读）

Phase 5B 的 **UI 交付完成**，但下面两条后端既有缺陷让「旗舰链路」目前**跑不通**，
它们不是可选的优化项，而是已登记的后续任务（见本节末尾）：

1. **旗舰链路（视频成片）拿不到结果卡** —— `video.generate` 把 `shotCount` /
   `aspectRatio` 写进资产 metadata，而 `mediaMetadataSchema`（`packages/domain/src/asset.ts`）
   是 `.strict()` 且没有这两个键，任务在「登记资产」这一步**必定**
   `VALIDATION_FAILED`；`video.extend` 同理。加上「30 秒护肤品广告」的计划卡上
   **没有「开始制作」按钮**（该按钮要求模板里高成本节点 ≥ 3，而广告模板只有 1 个），
   spec §10 第 1 条的字面场景（计划卡 → 开始制作 → 确认 → 实时进度 → 结果卡）
   **目前不可达**。图片链路（`image.generate`）是通的。
2. **未配置模型时工作台静默回落 Mock** —— 没有 Provider 时后端用 Mock 顶替，
   界面把占位文本当模型答复呈现（探针实测 `错误提示: []`），
   与 spec §10 第 4 条「不要报错或**静默失败**」不符。目前只有 `/settings/providers`
   在列表为空时给出「配置模型后才能开始生成内容」的提示条与空状态。

更完整的前端侧限制见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9 第 14、15 条。

**后续任务（缺陷修复，非可选优化）**：① 修 asset metadata schema 与
`video.generate` / `video.extend` 的字段契约（或让技能只写 schema 认识的键）；
② 让广告模板这类「只有 1 个高成本节点」的计划也有「开始制作」入口（或改判据口径）；
③ 未配置模型时在工作台给出显式提示（禁用「开始制作」并引导去 `/settings/providers`），
同时让 API 侧把 `buildModelRuntime` 的 Mock 回落警告真正打出来
（`apps/api/src/core/agent-deps.ts:80` 调用时没传 `logger`）。
这三点修完，spec §10 第 1、4 条才能按字面重验。

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
| `pnpm test` | 运行全仓测试 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm lint` | 全仓代码检查 |
| `pnpm db:migrate` | 创建并应用迁移 |
| `pnpm db:deploy` | 应用已有迁移（生产） |
| `pnpm db:seed` | 写入种子数据（幂等） |
| `pnpm db:studio` | 打开 Prisma Studio |

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
│   └── realtime/               Redis Stream 事件总线（发布器 + 订阅器，含补发与取消清理）
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
