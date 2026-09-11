# aiVideo 代码审计报告（SVH Phase 0 架构参考）

> 审计对象：`/home/yesheng/projects/aiVideo`（AI 图片与短视频平台 Monorepo）
> 审计目的：为 SVH（AI Content Agent 平台）判定可复用模块、可借鉴设计与应规避的坑
> 审计日期：Phase 0
> 报告状态：已完成

---

## 1. 审计范围与方法

### 1.1 范围

| 优先级 | 模块 | 审计深度 |
| --- | --- | --- |
| P0 | `packages/ai` | 全量精读（8 个源文件，约 800 行） |
| P0 | `packages/agent-core` | 全量精读（4 个源文件，约 240 行） |
| P0 | `packages/workflow` | 全量精读（4 个源文件，约 530 行） |
| P0 | `packages/queue` | 全量精读（3 个源文件，约 128 行） |
| P0 | `packages/database` | Schema 结构 + 关键模型精读（925 行 schema，读约 60%） |
| P0 | `packages/shared` | 全量精读（7 个源文件，约 260 行） |
| P1 | `packages/outbox` / `storage` / `media` | 结构 + 核心实现（22 个文件） |
| P1 | `packages/auth` / `ui` | 存在性确认（均为空壳） |
| P1 | `apps/api` / `apps/worker` | 工程组织方式（入口/插件/路由/错误处理/实时推送/生命周期） |
| P1 | 工程配置 | 根 scripts、turbo.json、tsconfig、构建工具链、CI |

### 1.2 方法

1. 先以 `package.json` + `find` 建立文件清单与规模基线，识别真实实现与空壳。
2. 定点读取类型定义文件与核心实现文件，跳过 `node_modules`、`dist`、`.turbo`、测试快照与业务路由逐行实现。
3. 用**交叉引用验证**（grep 全仓引用点）判定「是否真被使用」与「是否存在死代码」，而不是仅凭导出符号推断。
4. 用**运行时验证**确认构建产物与模块互操作的实际行为。

### 1.3 对任务前提的一处重要更正

任务描述称 aiVideo 技术栈为 "Fastify"。**实测不符**：

- `apps/api` 实际为 **NestJS 11 + `@nestjs/platform-express`**（`apps/api/package.json`），编译目标 `module: commonjs`。
- 全仓**没有任何 Fastify 依赖或代码**。
- 前端：`apps/web` 是 **Next.js 15**，`apps/admin` 是 **React 18 + Vite 6 + Ant Design 5**（Vite 才是与 SVH 同构的那个）。

因此：从 `apps/api` 借鉴的任何代码（认证守卫、OutboxService、异常过滤器）**必须重写**为 Fastify hook + Zod；而 `packages/*` 除 `ui`/`auth` 外均为与 HTTP 框架无关的纯库代码，可安全借鉴。

另需说明：`/home/yesheng/projects/SVH` 当前**并非空目录**，已存在 `package.json`（ESM、`type: module`、已配置 eslint 9 + typescript-eslint）、`turbo.json`、`tsconfig.base.json`（`.js` 后缀 NodeNext、`noUncheckedIndexedAccess: true`）与 `packages/database`、`packages/domain` 骨架。本报告的「启示」章节已对齐 SVH 的这些既有约束（尤其是 **ESM-only** 与**更严格的严格模式**）。

---

## 2. aiVideo 项目全景

### 2.1 技术栈实况

| 层 | 选型 | 与 SVH 目标的一致性 |
| --- | --- | --- |
| 包管理 / 构建编排 | pnpm 9.15 workspace + Turborepo 2.5 | ✅ 完全一致 |
| 语言 | TypeScript 5.6~5.9，`strict: true` | ✅ 一致（但 SVH 更严格） |
| 后端框架 | **NestJS 11 + Express**（非 Fastify） | ❌ 不一致，需重写 |
| 数据库 | PostgreSQL 16 + **Prisma 5.22**，单文件 schema | ✅ 一致 |
| 队列 | **BullMQ 5.81** + ioredis | ✅ 一致 |
| 对象存储 | MinIO / S3（`@aws-sdk/client-s3`） | 一致（SVH 可延用模式） |
| 前端 | Next.js 15（web）+ React 18/Vite 6/antd（admin） | ⚠️ 部分一致 |
| 校验 | `class-validator`（NestJS DTO）；**Zod 仅存在于 `agent-core`** | ❌ SVH 要全面 Zod |
| 构建产物 | 各 package 用 **tsup** 双格式（esm+cjs，`dts: true`） | ⚠️ SVH 应只出 ESM |
| Lint | **无 ESLint / 无 Prettier / 无 lint 脚本** | ❌ SVH 已有 eslint 9，应保留 |
| 测试 | Vitest（版本不统一：多数 ^4.1.11，`workflow` 用 ^2.0.0） | ⚠️ |
| CI | GitHub Actions：typecheck → 分包 vitest → build → e2e | ✅ 可借鉴 |

### 2.2 目录结构

```text
aiVideo/
├── apps/
│   ├── api/         NestJS 后端（含 auth / sse / outbox / workflow / project-agent 等 21 个模块）
│   ├── worker/      BullMQ 消费者 + Recovery 对账（task-executor.ts 单文件 59KB）
│   ├── web/         Next.js 15 用户端
│   └── admin/       React 18 + Vite + antd 管理后台
├── packages/
│   ├── ai/          ★ AI Gateway + Provider Adapter（唯一 AI 能力抽象层）
│   ├── agent-core/  ★ Structured Output 运行时 + Creative Agent
│   ├── workflow/    ★ DAG 校验 / 分层 / 运行推进
│   ├── queue/       ★ BullMQ 封装
│   ├── database/    ★ Prisma schema + Client 单例 + 积分/凭据助手
│   ├── shared/      ★ 通用类型、常量、状态机、AES-GCM 加解密
│   ├── outbox/      事务性发件箱（同事务写 + 立即投递 + poll 兜底）
│   ├── storage/     S3/MinIO 对象存储封装（含 presign）
│   ├── media/       ffmpeg/ffprobe/sharp 媒体处理工具
│   ├── auth/        【空壳，2 行】
│   └── ui/          【空壳，2 行】
├── docs/            16 篇设计文档，2347 行（架构设计质量高，见 §7）
├── tools/           mock-provider.mjs / seed-dev-db.sql
└── turbo.json / tsconfig.base.json / docker-compose.dev.yml
```

### 2.3 模块关系图

```text
                        ┌──────────────────────────────┐
                        │ apps/api (NestJS)            │
                        │  ModelRouterService ──┐      │
                        │  ProjectAgentService ─┤      │
                        └───────────────────────┼──────┘
                                                │
        ┌───────────────────────────────────────┼─────────────────────┐
        │                                       ▼                     │
        │                            ┌────────────────────┐           │
        │                            │ packages/ai        │           │
        │                            │  AiGateway         │           │
        │                            │   ├ AdapterFactory │           │
        │                            │   ├ SecretResolver │           │
        │                            │   └ ProviderAdapter│           │
        │                            └─────────┬──────────┘           │
        │                                      │                      │
        │                            ┌─────────▼──────────┐           │
        │                            │ openai-compatible  │           │
        │                            │  adapter/composer/ │           │
        │                            │  normalizer/factory│           │
        │                            └────────────────────┘           │
        │                                                               │
┌───────┴──────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│ packages/        │    │ packages/        │    │ packages/        │  │
│  agent-core      │    │  workflow        │    │  queue           │  │
│  CreativeAgent   │    │  validate/layers │    │  Queue/Worker    │  │
│  parseStructured │    │  kickoff/advance │    │  jobId/backoff   │  │
│  schemaOf(zod)   │    │  （依赖 DB）      │    │  （依赖 Redis）   │  │
└──────────────────┘    └────────┬─────────┘    └────────┬─────────┘  │
                                 │                       │            │
                        ┌────────▼───────────────────────▼─────────┐  │
                        │ packages/database (Prisma 单例 + 类型)    │◄─┘
                        │ packages/shared   (类型/常量/状态机/加密) │
                        │ packages/outbox   (事务性发件箱)          │
                        │ packages/storage  (S3/MinIO)             │
                        └──────────────────────────────────────────┘
                                        ▲
                        ┌───────────────┴──────────────┐
                        │ apps/worker (BullMQ Consumer)│
                        │  TaskExecutor / Reconciler   │
                        └──────────────────────────────┘
```

关键观察：**AI 能力层与业务层解耦得非常干净**——`packages/ai` 不依赖 Prisma、不依赖 HTTP 框架、不依赖队列；模型元数据通过 `ModelBrief` 值对象注入，密钥通过 `SecretResolver` 端口注入。这是全项目最值得继承的架构决策。

---

## 3. 逐模块审计结论

### 3.1 `packages/ai` —— AI Gateway 与 Provider Adapter

**职责**：唯一的 AI 能力抽象层。业务方（API/Worker）只依赖 `AiGateway` 门面，不感知任何 HTTP 细节与第三方协议。规模 8 个源文件约 800 行，测试 526 行。

#### 3.1.1 Provider 抽象契约（`src/providers/types.ts`）

```ts
export type ProviderType = 'OPENAI_COMPATIBLE' | 'CUSTOM'

/** 模型概要（调用方从 DB 读取后传入，避免 packages/ai 依赖 Prisma） */
export interface ModelBrief {
  id: string; providerId: string; name: string
  baseModel?: string; metadata?: Record<string, unknown>
}

export interface ProviderAdapter {
  readonly providerType: ProviderType
  hasCapability(capability: Capability): boolean
  generate(req: GenerateRequest): Promise<GenerateResult>
  cancel?(taskId: string): Promise<void>          // 同步型 Provider 为 no-op
  chat?(req: LLMChatRequest): Promise<LLMChatResult>  // 未实现则抛 UNKNOWN
}

/** 密钥解析端口：隔离「密钥从哪来」，packages/ai 不碰 DB 与解密 */
export interface SecretResolver {
  resolveApiKey(providerId: string, userId: string): Promise<string>
}
```

请求/结果形状（同一文件）：

```ts
export interface GenerateRequest {
  taskId: string; taskType: TaskType
  model: ModelBrief; capability: Capability
  prompt: string; negativePrompt?: string
  parameters: Record<string, unknown>
  inputAssets?: DownloadableAsset[]
  userId: string                 // 用于解析该用户自带的 API Key
  signal?: AbortSignal           // 取消信号，与超时信号合并
}
export interface ProviderOutput { url: string; mimeType?: string; seed?: number }
export interface GenerateResult {
  outputs: ProviderOutput[]
  providerUsage?: { costUsd?: number; durationMs: number }
}

export interface LLMChatRequest {
  model: ModelBrief
  messages: LLMChatMessage[]                 // role: system | user | assistant
  userId: string
  responseSchema?: Record<string, unknown>   // OpenAI json_schema
  temperature?: number; maxTokens?: number
  signal?: AbortSignal
  stream?: boolean
  onDelta?: (d: { channel: 'text' | 'reasoning'; delta: string }) => void
}
export interface LLMChatResult {
  content: string; reasoning?: string
  usage?: { promptTokens?: number; completionTokens?: number }
  durationMs: number
}
```

设计评价：**这是全项目质量最高的类型定义**。`ProviderAdapter` 只有 5 个方法，端口/适配器模式标准；`SecretResolver` 把「密钥来源」与「协议调用」彻底分离，是本项目支持「用户自带 Key」的关键。`chat?` 用可选方法表达「能力可选」，配合网关侧回退，避免了空实现污染。

#### 3.1.2 Provider / Model 的注册与选择

**两段式，职责分离清晰**：

1. **AdapterFactory 注册（代码侧，静态）**——`src/gateway.ts`：

```ts
export interface AdapterFactory {
  readonly providerType: ProviderType
  supports(capability: Capability): boolean
  create(params: { baseUrl: string; apiKey: string; providerId: string }): ProviderAdapter
}

export class AiGateway {
  constructor(private readonly opts: { factories: AdapterFactory[]; secrets: SecretResolver }) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const factory = this.resolveFactory(req)                   // 按能力路由
    const apiKey = await this.opts.secrets.resolveApiKey(req.model.providerId, req.userId)
    const baseUrl = String((req.model.metadata as any)?.baseUrl ?? '')
    if (!baseUrl) throw new ProviderError('VALIDATION', '模型未配置 baseUrl（metadata.baseUrl），无法调用 Provider')
    return factory.create({ baseUrl, apiKey, providerId: req.model.providerId }).generate(req)
  }

  private resolveFactory(req: GenerateRequest): AdapterFactory {
    for (const f of this.opts.factories) if (f.supports(req.capability)) return f
    throw new ProviderError('UNKNOWN', `无可用适配器支持能力 ${req.capability}`)
  }
}
```

2. **Model 选择（数据侧，DB 驱动）**——不在 `packages/ai` 内，而在 `apps/api/src/common/model-router.service.ts`（97 行）：

```ts
@Injectable()
export class ModelRouterService {
  /** 主模型 + 连续回退候选 → 有效路由链（routes 落库到 task.routes） */
  async resolveRoutes(primaryModelId: string, fallbackModelIds?: string[]): Promise<ModelRoute> {
    // 主模型必须 enabled（否则抛 MODEL_NOT_ENABLED=30004）；fallback 逐个校验，失效则静默剔除
    // 返回 routes: string[]（模型 id 链）+ candidates: RouteCandidate[]（含 baseUrl/providerType/capabilities）
  }

  /** Agent 用 LLM 选择：type=LLM + 有启用的 LLM_CHAT 能力，按 sortOrder 排序 */
  async selectLLM(prefs?: { quality?: 'high' | 'balanced' | 'fast' }): Promise<RouteCandidate | null>
}
```

**结论与坑**：

- ✅ 「能力路由（`supports(capability)`）+ 数据驱动模型链（DB `routes`）」的双层设计非常清晰，SVH 的 Model Router 应直接采用这个骨架。
- ⚠️ **`AdapterFactory.providerType` 声明了却从未参与路由**。`resolveFactory` 只按 `capability` 取第一个匹配工厂，从未把 `req.model.providerType` 与 `factory.providerType` 比对。这意味着一旦注册第二个工厂，路由结果就退化为「工厂数组顺序」。**SVH 必须补上 `providerType → factory` 的显式索引（Map 路由表）**。
- ⚠️ **`baseUrl` 传递链路绕**：`AiGateway` 从 `req.model.metadata.baseUrl` 读取，而调用方需要把 `provider.baseUrl` 手工塞进 `metadata.baseUrl`。这是为了不依赖 Prisma 而付出的代价，但应该把 `baseUrl` 提升为 `ModelBrief` 的一等字段。
- ⚠️ `factory.create()` 在**每次请求**执行，无 adapter 复用/连接池；`chat()` 更是在 factory 循环里逐个 `create` 并 `resolveApiKey`。SVH 应加 adapter 缓存（key = providerId + baseUrl）。
- ⚠️ `chat()` 的工厂循环 `catch` 会吞掉密钥解析失败等错误继续尝试下一个工厂，最后抛出的是**误导性的** `VALIDATION: LLM Chat 无可用适配器`，丢失真实原因。

#### 3.1.3 错误体系与重试/降级（`src/error.ts`，68 行）

```ts
export type ProviderErrorCode =
  | 'AUTH' | 'RATE' | 'SERVER' | 'TIMEOUT' | 'NETWORK'
  | 'VALIDATION' | 'MODEL_NOT_FOUND' | 'CANCELLED' | 'UNKNOWN'

export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, message: string,
              public httpStatus?: number, public providerErrorCode?: string) { super(message) }
}

const NON_RETRYABLE: ReadonlySet<ProviderErrorCode> =
  new Set(['AUTH', 'VALIDATION', 'MODEL_NOT_FOUND', 'CANCELLED'])

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return !NON_RETRYABLE.has(err.code)
  return true   // 未知错误默认可重试
}

/** 脱敏：Bearer / Authorization / api_key / access_token / token / secret / password */
export function sanitizeProviderError(message: string): string
```

HTTP 状态映射（`adapter.ts::toProviderError`）：401/403→AUTH，429→RATE，404→MODEL_NOT_FOUND，5xx→SERVER，400→（body 含 "model" 则 MODEL_NOT_FOUND，否则 VALIDATION）。超时与外部取消通过 `AbortSignal.any([AbortSignal.timeout(...), req.signal])` 合并，取消优先判定为 `CANCELLED`。

**`sanitizeProviderError` 是本项目一个被低估的高质量实现**：它用 8 条正则对 Provider 原始错误文本做脱敏，尤其是 `(?<![\w-])(token\s*[:=]\s*)\S+` 的 lookbehind 排除了 `access_token` 被二次污染的复合形态，并要求「字段名: 值」形态才命中以避免误伤普通词。**任何把第三方错误原样入库/入日志的系统都必须有这个**，SVH 应直接移植。

**重试与降级不在 `packages/ai` 内**（设计上刻意如此：Gateway 注释明确「不含重试，重试由 Task 层负责」）。真实实现在 `apps/worker/src/task-executor.ts::handleFailure` + `apps/worker/src/task/retry-transaction.ts`：

```ts
// apps/worker/src/task-executor.ts:1297
const retryable = isRetryable(providerErr)
const maxAttempts = task.maxAttempts ?? 3
if (retryable && attempts < maxAttempts) {
  const next = await this.resolveNextRoute(task, capability)   // ModelRouter 故障切换
  const delayMs = computeRetryDelayMs(attempts)                // 5s 起，翻倍，封顶 20s，+0~1s jitter
  // 单事务：CAS PROCESSING→PENDING（Fencing: status+leaseVersion+workerId）+ 切换模型快照
  //        + 原子写 TASK_FAILED / TASK_QUEUED 两个 Outbox 事件（availableAt = now + delayMs）
  await this.prisma.$transaction((tx) => retryTaskInTransaction(tx, { ...switched: next ? {...} : null }))
  return
}
// 否则 → 终态 FAILED（leaseGuard 带 leaseVersion 的 CAS 转移）
```

降级链（`resolveNextRoute`）：从 `task.routes`（模型 id 有序数组）中按 `metadata.route.currentIdx` 取下一个**同时满足 enabled + 该 capability 启用**的模型，重建 `modelSnapshot` 并写回。

**结论**：
- ✅ 三层重试设计（`ProviderError.code` → `isRetryable` → 领域层 CAS 事务重试）**质量高、边界清楚**：BullMQ `attempts` 恒为 1，重试完全由领域层控制，从而能实现「重试前切换模型」「重试与状态回写原子提交」。这是**对朴素 BullMQ 重试的重大改进**，SVH 应原样继承该设计哲学。
- ⚠️ `isRetryable` 对非 `ProviderError` 一律返回 `true`（默认重试），会把编程错误也重试 3 次。建议 SVH 改为显式白名单。
- ⚠️ 降级快照不一致：初次快照用 `model.displayName` 作 `modelName`，而降级重建时用 `model.name`（`task-executor.ts:581`）。属真实缺陷。
- ⚠️ 降级无熔断/无失败计数：某 Provider 持续 429 时，每个任务都会先撞一次主模型再切换，浪费一次调用。

#### 3.1.4 `composer.ts` / `task-compiler.ts` / `validator.ts` 各自职责

| 文件 | 行数 | 职责 | 评价 |
| --- | --- | --- | --- |
| `src/composer.ts` | 77 | **参数合并工具**：`mergeParameters`（用户参数 < 能力默认值）、`pickAllowedKeys`（键白名单，防未知参数泄漏给 Provider）、`convertParam`（类型转换）、`validateParameterDefs`（必填/范围/选项校验） | 实现干净、有真实价值。`pickAllowedKeys` 是**安全边界**，必须保留 |
| `src/validator.ts` | 12 | 仅一行转发：`validateParameters = (p, d) => validateParameterDefs(p, d)` | **冗余间接层**，可删 |
| `src/task-compiler.ts` | 93 | **请求编译器**：校验 → 参数合并 → 构造 `ModelSnapshot`（`schemaVersion: 2`）。单一入口，供 CreativeService / WorkflowEngine / Retry-Fallback 共用，杜绝各处手写快照导致漂移 | **设计意图很好**（快照版本化 + 编译单点），但实现只是三个函数的顺序调用，价值在约定而非代码量 |
| `src/providers/openai-compatible/composer.ts` | 138 | **协议装配**：`IMAGE_CAPABILITY_DEFS` / `VIDEO_CAPABILITY_DEFS` 参数字典 + `composePayload` / `composeVideoPayload`（比例→像素映射、图生图转 data URL） | 能力参数字典即「能力的单一声明源」，同时驱动前端表单与后端校验，**这个模式很有价值** |
| `src/providers/openai-compatible/normalizer.ts` | 42 | 响应归一化：兼容 `data[].url` / `data[].b64_json` / `error` | 简洁；`b64_json` 直接抛错不支持属功能缺口 |
| `src/providers/openai-compatible/factory.ts` | 23 | 内置工厂：`createOpenAiCompatibleFactory()` 注册 `TEXT_TO_IMAGE/IMAGE_TO_IMAGE/VIDEO_GENERATE/LLM_CHAT` | 干净 |

⚠️ **命名冲突**：根目录 `composer.ts`（参数合并）与 `providers/openai-compatible/composer.ts`（协议装配）同名不同职责，易误导。SVH 应重命名为 `parameters.ts` / `payload-builder.ts`。

#### 3.1.5 用户自带 API Key（BYOK）支持情况

**支持，且是端到端完整闭环**：

| 环节 | 实现位置 |
| --- | --- |
| 存储模型 | `UserProviderCredential { userId, providerId, keyEncrypted, @@unique([userId, providerId]) }`（`schema.prisma:894`） |
| 加密 | `packages/shared/src/crypto.ts`：AES-256-GCM，`key = sha256(PROVIDER_KEY_SECRET)`，密文格式 `<iv>.<data>.<tag>` 三段 base64 |
| 读取/解密 | `packages/database/src/user-credential.ts`：`getDecryptedProviderKey(db, userId, providerId)`（未配置返回 null，解密失败抛错不吞） |
| 注入 | 网关构造时注入 `secrets: { resolveApiKey }`，`AiGateway.generate/chat` 用 `(providerId, userId)` 解析 |
| Worker 侧实现 | `apps/worker/src/index.ts:28`：`resolveApiKey = (providerId, userId) => getDecryptedProviderKey(...)`，缺失则抛 `ProviderError('AUTH', '用户未配置 Provider X 的 API Key...')` |
| 掩码展示 | `maskKey(raw)`：前 4 位 + `****` |

**结论**：BYOK 的**凭据层完全可复用**（表结构 + AES-GCM + SecretResolver 端口，三者组合即为标准答案）。

⚠️ **但协议层只支持 OpenAI Compatible 一种**：`packages/ai/src/providers/` 下**只有 `openai-compatible/` 一个目录**，`ProviderType` 只有 `'OPENAI_COMPATIBLE' | 'CUSTOM'`（`CUSTOM` 是预留值，**无任何实现**）。`chat()` 硬编码 `POST {baseUrl}/v1/chat/completions` 与 `response_format.json_schema`。**Anthropic Messages API、Gemini generateContent 均无适配器**。对 SVH 的直接含义：BYOK 的「Key 管理」可直接复用，但「多厂商协议」必须新增 `anthropic/`、`gemini/` 目录，并补上 §3.1.2 中缺失的 `providerType → factory` 路由表。

#### 3.1.6 复用结论

> **结论：借鉴设计后重写（其中 `error.ts`、`providers/types.ts`、`composer.ts` 可直接复用）**
>
> 理由：架构分层（门面 / 适配器 / 装配器 / 归一化器 / 密钥端口）是标准且正确的，类型定义质量高，脱敏与参数白名单是必须继承的安全资产。但：① 只覆盖 OpenAI 协议，SVH 需要 Anthropic/Gemini 原生适配器；② `providerType` 路由缺失、adapter 无缓存、`validator.ts` 冗余、两处 `composer.ts` 命名冲突，都需要在重写时修正；③ 整体仅 800 行，重写成本低于适配成本。

---

### 3.2 `packages/agent-core` —— Structured Output 运行时 + 创意 Agent

**职责**：用 Zod 定义结构化输出 Schema，保证 LLM 输出可被严格解析；并以两段式编排实现 Creative Agent。**规模极小：4 个源文件约 240 行**（`runtime.ts` 118 + `agents/creative.agent.ts` 96 + `schema.ts` 20 + `index.ts` 5）。这是全项目**代码量最小、但设计意图最值得借鉴的包**。

#### 3.2.1 `schema.ts` —— Schema 定义方式（zod + zod-to-json-schema）

```ts
// zod → 单根 JSON Schema：OpenAI strict json_schema 不接受顶层 $ref/definitions 结构
export function schemaOf(schema: z.ZodType, name = 'agent_output'): Record<string, unknown> {
  const base = zodToJsonSchema(schema, { name, target: 'openAi' }) as Record<string, unknown>
  const defs = (base.definitions ?? base.$defs ?? {}) as Record<string, unknown>
  const ref = base.$ref
  if (typeof ref === 'string') {
    const rootName = ref.replace(/^#\/(?:definitions|\$defs)\//, '')
    const root = defs[rootName]
    if (root && typeof root === 'object' && !Array.isArray(root)) return root as Record<string, unknown>
  }
  return base
}
```

用 **Zod v3（`zod ^3.24.1`）+ `zod-to-json-schema` ^3.25.2，`target: 'openAi'`**。源码注释记录了两个**非显然的坑**，价值很高：

1. OpenAI strict 模式**不接受顶层 `$ref`**，必须把 `definitions` 中的根定义展开到顶层；
2. `target: 'openAi'` 会把**所有字段纳入 `required`**，可选字段被建模为 `type: ['T','null']`——否则 strict 模式会 400 或**静默丢弃字段**。

**对 SVH 的提示**：SVH 计划用 Zod，若用 **Zod v4**，应改用内置的 `z.toJSONSchema()`（v4 原生支持 JSON Schema 导出），但**上述两个 OpenAI strict 的坑依然存在且必须自行处理**——这是本包最值得抄的一条经验。

#### 3.2.2 `runtime.ts` —— Structured Output 如何保证与校验

Schema 定义（业务 Schema 直接硬编码在运行时文件里）：

```ts
export const ShotPlanSchema = z.object({
  order: z.number().min(1).max(60), duration: z.number().min(1).max(30),
  camera: z.string().max(100), movement: z.string().max(100),
  description: z.string().max(2000), action: z.string().max(2000).optional(),
  dialogue: z.string().max(2000).optional(), prompt: z.string().max(4000),
  negativePrompt: z.string().max(4000).optional(),
})
export const ScenePlanSchema = z.object({ name, description?, environment?, time?, weather?, lighting?, prompt? })
export const CharacterPlanSchema = z.object({ name, description?, appearance?, personality?, clothing?, prompt? })
export const CreativePlanSchema = z.object({
  logline: z.string().max(2000),
  script: z.object({ title: z.string().max(255), summary: z.string().max(4000), content: z.string().max(20000) }),
  characters: z.array(CharacterPlanSchema).min(1).max(8),
  scenes: z.array(ScenePlanSchema).min(1).max(6),
  shots: z.array(ShotPlanSchema).min(1).max(16),
})
export const CreativeDraftSchema = /* logline + script + characters + scenes（无 shots，两段式第一阶段） */
export const StoryboardSchema = z.object({ shots: z.array(ShotPlanSchema).min(1).max(16) })
```

**端口（Port）—— 注意这里没有依赖 `packages/ai`**：

```ts
export interface LLMChatPort {
  chat(input: { system: string; user: string; schema: Record<string, unknown> }):
    Promise<{ content: string }>
}
```

解析与校验（**保证 Structured Output 的核心**）：

```ts
export function parseStructured<T>(content: string, schema: z.ZodType<T>): T {
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, '')     // 剥离 Markdown 围栏
    .replace(/\s*```$/, '').trim()
  let raw: unknown
  try { raw = JSON.parse(cleaned) }
  catch { throw new AgentOutputError(`LLM 输出不是合法 JSON：${content.slice(0, 120)}`) }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AgentOutputError(`LLM 输出不符合 Schema：${issue?.path?.join('.')} ${issue?.message}`)
  }
  return parsed.data
}

export class AgentOutputError extends Error { /* name = 'AgentOutputError' */ }
```

**保证机制是「三保险」**：① Provider 侧 `response_format.json_schema(strict: true)` 服务端约束；② 客户端剥离围栏 + `JSON.parse`；③ Zod `safeParse` 全量校验。任一层失败抛出可识别的 `AgentOutputError`。

#### 3.2.3 `agents/` —— 有哪些 Agent、如何定义

**只有一个 Agent**：`agents/creative.agent.ts` 的 `CreativeAgent`（96 行）。

```ts
export class CreativeAgent {
  constructor(private readonly llm: LLMChatPort) {}

  /** 两段式编排：Draft Agent → Storyboard Agent */
  async plan(input: CreativeAgentInput): Promise<CreativePlan> {
    const draft = await this.runDraft(input)            // 阶段 1：logline + script + characters + scenes
    const storyboard = await this.runStoryboard(draft)  // 阶段 2：shots（依赖阶段 1 上下文）
    return { ...draft, shots: storyboard.shots }
  }

  private async runDraft(input: CreativeAgentInput): Promise<CreativeDraft> {
    const brief = [input.brief.trim(), input.ratio ? `画幅：${input.ratio}` : '',
                   input.style ? `风格：${input.style}` : '',
                   `输出语言：${input.language ?? '中文'}`].filter(Boolean).join('\n')
    return this.withRetry(() => this.llm.chat({ system: DRAFT_SYSTEM_PROMPT, user: brief,
                                                schema: schemaOf(CreativeDraftSchema) }),
                          CreativeDraftSchema, 'Draft Agent')
  }

  private async withRetry<T>(call, schema, label): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call()                          // 注意：call() 在 try 之外
      try { return parseStructured(res.content, schema) }
      catch { if (attempt === 1) throw new AgentOutputError(`${label} 结构化输出连续两次不符合 Schema`) }
    }
    throw new AgentOutputError('unreachable')
  }
}
```

上下文装配方式：`runStoryboard` 用 `JSON.stringify({ logline, script, characters: [...投影], scenes: [...投影] })` 作为 user 消息——**手工挑选字段投影后序列化**，不是全量透传。这是简单有效但不可扩展的做法。

#### 3.2.4 能力清单与缺口清单

**具备的能力**：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Structured Output 保证 | ✅ 完整 | json_schema(strict) + 剥围栏 + JSON.parse + Zod safeParse |
| 输出校验失败重试 | ✅ 有，但仅 1 次 | 最多 2 次尝试 |
| 多步编排 | ⚠️ 硬编码 2 步 | `plan()` 里写死 Draft → Storyboard |
| 上下文装配 | ⚠️ 手工 | `JSON.stringify` + 字段投影，无 token 预算 |
| 端口隔离 | ✅ 优秀 | `LLMChatPort` 使 agent-core 不依赖 `packages/ai` |
| 与 LLM 网关的接线 | ✅ 干净 | `apps/api/src/project-agent/project-agent.service.ts:261` 的 `chatPort(userId)` 把 `LLMChatPort` 适配到 `AiGateway.chat` |
| 流式输出 | ⚠️ 底层支持但 Agent 未用 | `packages/ai` 有 `onDelta` SSE 解析，`CreativeAgent` 未接 |
| 单元测试 | ✅ 2 文件 139 行（schema + agent） | 但**未纳入 CI**（见 §3.12） |

**缺口清单（对比 SVH 需要但此处缺失）**：

| 缺口 | 严重度 | 说明 |
| --- | --- | --- |
| **无 Tool Calling** | 🔴 高 | 全包无 tool/function 概念，`LLMChatRequest` 也无 `tools` 字段。SVH 的 Agent 若要调工具（检索/生图/数据库），必须新增 |
| **无 ReAct / 循环编排** | 🔴 高 | 只有单向 2 步流水线，无「思考→行动→观察→再思考」循环，无最大轮次控制 |
| **无 Agent 注册表 / 抽象基类** | 🟠 中 | `CreativeAgent` 是具体类，无 `Agent` 接口、无注册表、无统一 `run()` 契约。新增 Agent 只能复制粘贴 |
| **无对话记忆 / 会话状态** | 🟠 中 | 只有单次 `system + user`，无多轮 messages 累积，无会话持久化 |
| **重试不反馈错误** | 🟠 中 | 第二次调用**原样重发同样的 prompt**，未把 Zod 校验错误回喂给模型。这是 Structured Output 重试的常见反模式，成功率提升有限 |
| **Schema 与业务耦合** | 🟠 中 | `ShotPlanSchema`/`ScenePlanSchema` 等影视领域 Schema 硬编码在 `runtime.ts`。SVH 是多类型内容平台，必须外置为可注册的 Schema 目录 |
| **无 token 预算 / 上下文裁剪** | 🟡 低 | 长剧本直接 `JSON.stringify` 全塞，无截断与摘要策略 |
| **`withRetry` 静默吞掉原始错误** | 🟡 低 | 只抛「连续两次不符合 Schema」，丢失两次 Zod 的具体 issue |
| **无成本/用量累计** | 🟡 低 | `LLMChatResult.usage` 未在 Agent 层汇总 |
| **Zod v3** | 🟡 低 | SVH 建议直接上 Zod v4 + `z.toJSONSchema()` |

#### 3.2.5 复用结论

> **结论：借鉴设计后重写**
>
> 理由：`parseStructured` + `schemaOf` + `LLMChatPort` 这三件套（约 60 行）**浓缩了 Structured Output 的全部关键知识**（含两个 OpenAI strict 的非显然坑），是 SVH Creative Agent 运行时最值得抄的部分，可直接移植（建议改用 Zod v4）。但 `CreativeAgent` 本身只有 96 行硬编码两段式编排，**不具备 Tool Calling、多步循环、Agent 注册与上下文装配能力**——SVH 需要的 Agent 运行时比它大一个数量级，「重写」远优于「扩展」。

---

### 3.3 `packages/workflow` —— DAG 校验、分层计算、运行推进

**职责**：定义工作流 DAG、校验其合法性、计算拓扑分层，并在 Worker 任务终态后推进运行。规模 4 源文件约 530 行（`advance.ts` 369 + `types.ts` 116 + `state.ts` 43 + `index.ts` 4），测试 1 文件。**依赖 Prisma**（`@aivideo/database`）与 `@aivideo/outbox`、`@aivideo/queue`，不是纯函数库。

#### 3.3.1 数据结构（`src/types.ts`）

```ts
export type WorkflowNodeType = 'INPUT' | 'AI_GENERATE' | 'AGENT' | 'LLM' | 'HUMAN_INPUT'

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  name?: string
  config?: {
    modelId?: string; providerId?: string; providerName?: string
    modelSnapshot?: Record<string, unknown>
    promptTemplate?: string; negativePrompt?: string
    parameters?: Record<string, unknown>
    /** ModelRouter：质量模型回退链（运行时常被解析为 routes 落在 config 中） */
    fallbackModelIds?: string[]
    taskType?: string; capability?: string
    // LLM 节点专有（透传 worker runLlmTask）
    system?: string
    responseSchema?: Record<string, unknown>
    temperature?: number; maxTokens?: number
  }
}

export interface WorkflowEdge { from: string; to: string }

export interface WorkflowDefinition { nodes: WorkflowNode[]; edges: WorkflowEdge[] }

/** 校验：id 非空且 ≤64、id 不重复、至少 1 节点、边端点存在、无自环 */
export function validateDefinition(def: WorkflowDefinition): void

/** Kahn 拓扑排序：检测环并返回各节点层号（level 从 0 起） */
export function computeLayers(def: WorkflowDefinition): Map<string, number>
```

持久化侧（`schema.prisma:802-873`）：

```prisma
model Workflow   { id, userId, name, description, definition Json, isEnabled, ... }
model WorkflowRun { id, userId, workflowId, status WorkflowRunStatus, inputAssets Json,
                    errorCode, errorMessage, startedAt, completedAt, ... }
model WorkflowStepRun {
  id, runId, stepId VarChar(64), nodeType WorkflowNodeType, name, config Json,
  status WorkflowStepStatus @default(RUNNING),
  taskId String?,                     // ← 推进器的幂等闸门
  inputAssetIds Json?, outputAssetIds Json?,
  errorCode, errorMessage, outputText Json?, outputReasoning Json?, startedAt, completedAt
  @@index([runId, status]) @@index([taskId])
}
```

**设计要点**：节点配置全部塞进 `config Json`（无编译期约束，靠 `as` 断言取用）；步骤运行态与业务 `Task` **一对一复用**（`WorkflowStepRun.taskId`），而不是另建执行引擎——这是很务实的决策，避免了两套任务生命周期。

⚠️ **`WorkflowEdge` 没有 `condition`、没有 `label`、没有分支/汇合语义**。所谓 "DAG" 实际是**无条件依赖图**：一个节点的所有前驱成功才就绪（AND 语义），不支持 OR/条件跳转/映射-归约。

#### 3.3.2 运行推进算法（`src/advance.ts`）

核心是两个函数：`kickoffReadySteps`（释放就绪层）与 `advanceWorkflowRun`（单步终态回调）。

**就绪判定（AND 语义 + 无前驱即就绪）**：

```ts
export function isStepReady(edges, steps, step): boolean {
  const preds = edges.filter((e) => e.to === step.stepId).map((e) => e.from)
  if (preds.length === 0) return true
  return preds.map((p) => steps.find((s) => s.stepId === p))
              .every((s) => s && s.status === 'SUCCEEDED')
}
```

**推进主流程**（`kickoffReadySteps`）：

```ts
export async function kickoffReadySteps(deps, runId) {
  const ctx = await loadRunContext(prisma, runId)          // run 必须 status=RUNNING
  if (!ctx) return { startedSteps: [], runStatus: 'RUNNING' }
  const steps = await prisma.workflowStepRun.findMany({ where: { runId } })

  const RUNNABLE_NODE = new Set(['AI_GENERATE', 'LLM'])     // INPUT / AGENT / HUMAN_INPUT 不产生任务
  for (const s of steps) {
    if (TERMINAL.has(s.status) || s.taskId || !RUNNABLE_NODE.has(s.nodeType)) continue   // ← 幂等闸门
    if (!isStepReady(definition.edges, steps, s)) continue
    // 收集候选：解析 cfg（s.config ?? node.config）、渲染 {{prevAssets}} 模板、
    //           汇总前驱产物 upstreamOutputIds(...).slice(0, 5)、组装 inputJson
    candidates.push({ step: s, cfg, inputJson, taskType, taskId: '', started: false })
  }

  // 单事务：为所有候选批量建 Task + step.taskId 的 CAS 绑定
  await prisma.$transaction(async (tx) => {
    for (const c of candidates) {
      const task = await tx.task.create({ data: { ...,
        idempotencyKey: `wf:${runId}:${s.stepId}`,        // 确定性幂等键
        workflowRunId: runId, workflowStepRunId: s.id, metadata: { source: 'workflow' } } })
      const gate = await tx.workflowStepRun.updateMany({  // ← CAS：只有 taskId 仍为 null 才绑定
        where: { id: s.id, taskId: null }, data: { taskId: task.id, config: {...} } })
      if (gate.count === 0) { await tx.task.delete({ where: { id: task.id } }); continue }  // 竞争失败即止损
      if (deps.reserveCredit) {                          // 建 Task 同事务原子预留积分
        const ok = await deps.reserveCredit({ userId, taskId: task.id, taskType, tx })
        if (!ok) throw new Error('CREDIT_INSUFFICIENT')  // → 整事务回滚 → run 转 FAILED
      }
      c.taskId = task.id; c.started = true
    }
  })

  // 全部步骤终态 → run SUCCEEDED
}
```

**处理并行 / 串行 / 失败**：

| 场景 | 机制 |
| --- | --- |
| **串行** | 前驱未全部 SUCCEEDED → `isStepReady` 为 false → 不释放 |
| **并行** | 同一层内多个节点同时满足就绪 → 在**同一个事务**里批量建 Task，天然并行下发（`computeLayers` 的层号仅用于前端展示，推进算法本身不依赖层号，而是每轮重新全量扫描就绪集合） |
| **失败** | `advanceWorkflowRun` 收到 `status='FAILED'` → run 置 FAILED + 其余 RUNNING 步骤批量置 SKIPPED（无补偿、无回滚已产出资产） |
| **取消** | run 置 CANCELLED + 其余 RUNNING 步骤置 CANCELLED |
| **完成** | 所有步骤终态且无 FAILED/SKIPPED/CANCELLED → run SUCCEEDED |
| **幂等** | 三重闸门：`step.taskId` 非空跳过、`updateMany where taskId: null` 的 CAS、Task 的 `idempotencyKey = wf:{runId}:{stepId}` |
| **并发安全** | 步骤终态回写用 `updateMany where { id, status: 'RUNNING' }`，返回 `count === 0` 即认为已被他人处理并直接返回 |

**数据传递**：`upstreamOutputIds()` 合并所有前驱的 `outputAssetIds`，再经 `renderPromptTemplate(template, prevAssetIds)` 把 `{{prevAssets}}` 占位符替换为 JSON 数组字符串，同时写入 Task 的 `input.inputAssetIds`（**截断为前 5 个**）。

#### 3.3.3 状态机（`src/state.ts`）—— 整文件为死代码

```ts
export type StepState = 'notStarted' | 'ready' | 'blocked' | 'failed' | 'skipped' | 'cancelled'
export function stepState(def, steps, t): StepState
export function readySteps(def, steps): StepLike[]
export function isRunTerminal(def, steps): boolean
```

**这三个导出在全仓库（含测试）中被引用的次数均为 0**（已用 grep 逐符号验证）。真正生效的是 `advance.ts` 中重复实现的 `isStepReady` / `runShouldFinish`——**同一语义两套实现，其中一套从未被执行**。这是明确的代码腐化信号。

#### 3.3.4 代码质量评估与缺陷

| 缺陷 | 严重度 | 位置与说明 |
| --- | --- | --- |
| **`state.ts` 整文件死代码** | 🟠 中 | 3 个导出零引用，与 `advance.ts` 逻辑重复且语义不完全一致（`stepState` 把 FAILED 前驱判为 `failed`，`isStepReady` 判为未就绪） |
| **错误被静默吞掉** | 🔴 高 | `kickoffReadySteps` 与 `advanceWorkflowRun` 的**最外层都是 `catch { return {...} }`**（`advance.ts:279`、`advance.ts:366`）。任何异常（DB 宕机、写事件失败、代码 bug）都退化为「无进展」，调用方拿到的是「RUNNING」而非错误。虽然注释称「不抛异常拍死调用方」，但**完全无日志、无事件、无告警**，故障会表现为「工作流无故卡住」且不可诊断 |
| **`computeLayers` 层号非严格最优** | 🟡 低 | `level.set(next, (level.get(id) ?? 0) + 1)` 只在入度归零时按**最后一个处理的前驱**定级，而非对所有前驱取 max。Kahn 队列的 FIFO 顺序通常使其「碰巧正确」，但并非算法保证 |
| **失败即全图终止，无补偿** | 🟠 中 | 任一步 FAILED → run FAILED、其余 SKIPPED。已生成的上游资产不回滚、不清理；无节点级 `retry` / `continueOnError` / 补偿节点 |
| **无分支与条件** | 🟠 中 | 边无 condition，无法表达 if/else、循环、map-reduce。`AGENT` / `HUMAN_INPUT` 节点类型已声明但**推进器完全忽略**（`RUNNABLE_NODE` 只含 `AI_GENERATE`/`LLM`），即人工介入节点会在 DAG 里永久阻塞 |
| **前驱产物硬截断 5 个** | 🟡 低 | `upstreamOutputIds(...).slice(0, 5)` 是魔法数字，无配置 |
| **数据传递仅靠字符串模板** | 🟠 中 | `{{prevAssets}}` 单一占位符 + JSON 字符串替换，不支持引用具名前驱输出、不支持结构化传参 |
| **类型安全弱** | 🟡 低 | `config` 全靠 `as` 断言读取；`steps as unknown as StepRow[]` 双重断言 |
| **`advance.ts` 一个文件 369 行** | 🟡 低 | 事务、模型解析、模板渲染、状态判定混在一起 |

#### 3.3.5 复用结论

> **结论：借鉴设计后重写**
>
> 理由：**算法思想正确且有实战价值**——「每轮全量扫描就绪集合 + 单事务批量建 Task + `taskId` CAS 幂等闸门 + `idempotencyKey = wf:{runId}:{stepId}`」这套组合，用很小的代码量同时解决了并行释放、重复推进与并发竞争三个问题，SVH 应当继承。但：① `state.ts` 是死代码；② 两处最外层 `catch {}` 静默吞错是**生产环境不可接受**的（必须至少落结构化日志 + 失败事件）；③ 不支持条件分支、循环、人工节点、节点级重试；④ 依赖 Prisma 与 `@aivideo/outbox`，不是可移植的纯逻辑。**建议 SVH 把「DAG 校验 + 分层 + 就绪计算」抽成不依赖 DB 的纯函数核心（便于单测与复用），把「事务推进 + 幂等闸门」保留在服务层**。

---

### 3.4 `packages/queue` —— BullMQ 封装

**职责**：队列/Worker 生命周期与 Redis 连接的最小封装。**规模极小：3 个源文件仅 128 行**（`queue.ts` 75 + `worker.ts` 33 + `index.ts` 20），是全项目最接近「可直接复用」的包。

#### 3.4.1 完整公共 API（可直接复用的清单）

```ts
// ============ queue.ts ============
/** 队列名：单一队列，任务类型经 jobData.taskType 路由 */
export const AI_TASK_QUEUE = 'ai_tasks'

/** Job 载荷：只携带任务标识与路由信息，业务参数以 DB 为准（避免 payload 与 DB 漂移） */
export interface TaskJobData {
  taskId: string          // 数据库 tasks.id
  taskType: TaskType      // worker 内部路由
  attempt: number         // 本次执行序号（1 起）
  lastDurationMs?: number
}

/** Redis URL → RedisOptions（BullMQ 不接受 string） */
export function parseRedisUrl(url: string): RedisOptions

/** 默认连接：process.env.REDIS_URL ?? 'redis://localhost:6379' */
export function defaultConnection(): ConnectionOptions

export function createAiTaskQueue(conn?: ConnectionOptions, opts?: QueueOptions): Queue<TaskJobData>

/** 确定性 JobId：同 taskId+attempt 幂等（防 Outbox 重放重复入队） */
export function taskJobId(taskId: string, attempt: number): string   // `task-${taskId}-attempt-${n}`

/** 入队：attempts 恒为 1（重试由领域层触发），支持 delay 与 jobId */
export function enqueueTask(queue, data: TaskJobData,
                            opts?: { delayMs?: number; jobId?: string }): Promise<Job<TaskJobData>>

/** 重试退避：5s 起步，每次翻倍，封顶 20s，外加 0~1000ms jitter */
export function computeRetryDelayMs(attempt: number): number
// 实现：Math.min(2 ** (n - 1) * 5000, 20_000) + Math.floor(Math.random() * 1000)

// ============ worker.ts ============
export type TaskProcessor = (job: Job<TaskJobData>) => Promise<void>

export interface AiTaskWorkerOptions {
  concurrency?: number                                    // 默认 4
  onCompleted?: (job: Job<TaskJobData>) => Promise<void> | void
  onFailed?: (job: Job<TaskJobData> | undefined, err: Error) => Promise<void> | void
}

export function createAiTaskWorker(processor: TaskProcessor,
                                   conn?: ConnectionOptions,
                                   opts: AiTaskWorkerOptions = {}): Worker<TaskJobData>
```

#### 3.4.2 关键设计决策

| 决策 | 实现 | 评价 |
| --- | --- | --- |
| **`attempts` 恒为 1** | `enqueueTask` 硬编码 `jobOptions = { attempts: 1 }`，注释明确「重试由领域层 RetryPolicy 全权控制」 | ✅ **本项目最重要的队列决策**。它把重试从「BullMQ 黑盒」搬到「领域层事务」里，才有可能实现「重试前切换模型」「重试与状态回写原子提交」「指数退避写进 Outbox 的 availableAt」。SVH 应原样继承 |
| **Job payload 只放标识** | `TaskJobData = { taskId, taskType, attempt, lastDurationMs? }`，业务参数一律从 DB 读 | ✅ 避免「队列里是旧参数、DB 里是新参数」的漂移；也让 job 可安全重放 |
| **确定性 JobId** | `task-{taskId}-attempt-{attempt}` | ✅ 与 Outbox 重放天然幂等：BullMQ 对同 jobId 去重，重复投递不会重复执行 |
| **Redis 连接只解析 URL** | `parseRedisUrl` 手工拆 host/port/username/password/db | ⚠️ 只支持 `redis://`，**不支持 `rediss://`（TLS）**，也无 sentinel/cluster。生产用托管 Redis 需补 |
| **单队列** | `AI_TASK_QUEUE = 'ai_tasks'` 一个队列，靠 `jobData.taskType` 在 worker 内分发 | ⚠️ 优点：简单。缺点：**无法按任务类型设置不同并发/限流**（如 LLM 任务需要低并发，图片任务可以高并发）。SVH 若有多类 Agent，建议按「资源池」拆成 2~3 个队列 |
| **进度上报** | ❌ **完全没有** | `TaskProcessor` 只有一个 `Promise<void>`，无 `job.updateProgress()`、无进度回调。进度只能靠 DB 的 `Task.progress` 字段旁路 |
| **超时** | ❌ 队列层无 `job.timeout` | 超时全靠 `packages/ai` 的 `AbortSignal.timeout(120s)`，即**只有 AI 调用有超时，其他环节（下载、上传、DB）无超时** |
| **Worker 事件** | 只有 `completed` / `failed` 两个钩子 | 无 `stalled`、`error`、`drained` 钩子；`onFailed` 内部 `void onFailed(...)` 丢弃 Promise 拒绝 |
| **`..rest` 透传** | `createAiTaskWorker` 用 `...rest` 把未知选项透传给 BullMQ | ⚠️ 会连同 `onCompleted`/`onFailed` 之外的任意键一起透传，类型断言为 `as WorkerOptions` 掩盖了它 |
| **优雅关闭** | ❌ 包内无 | `createAiTaskWorker` 返回裸 `Worker`，`close()` 由调用方（apps/worker）负责 |

#### 3.4.3 复用结论

> **结论：可直接复用（128 行，建议直接拷贝并做 3 处增强）**
>
> 理由：这是全项目**投入产出比最高的可复用资产**——代码量极小、职责单一、零业务耦合（只依赖 `bullmq` 与 `shared` 的 `TaskType` 类型）、设计决策（attempts=1、payload 只放 id、确定性 jobId、指数退避 + jitter）都是经过实战验证的正确选择。
>
> **SVH 落地时的 3 处增强**：① `parseRedisUrl` 增加 `rediss://` / sentinel 支持；② `TaskProcessor` 签名从 `Promise<void>` 改为接受 `(job, ctx: { reportProgress, signal })`，补齐进度上报与协作式取消；③ 在包内提供 `closeAiTaskWorker(worker, { drainTimeoutMs })` 封装优雅关闭，避免每个 app 各写一遍。

---

### 3.5 `packages/database` —— Prisma 数据层

**职责**：Prisma Schema（925 行，29 个 model）、Client 单例、类型再导出，外加两个业务助手（凭据解密、积分预留）。`src` 仅 155 行。

#### 3.5.1 Schema 建模风格

**基本参数**（`prisma/schema.prisma:1-13`）：

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
```

**单文件、单 schema**（无 multi-schema / multi-file），**Prisma 5.22**。

**主键策略**：

| 策略 | 使用范围 | 数量 |
| --- | --- | --- |
| `@id @default(cuid())` | **业务实体默认**（User/Task/Workflow/Provider/Model/Asset/…） | 29 处 |
| `@id @default(uuid())` | 仅 `OutboxEvent` | 1 处 |

**评价**：cuid 作为默认主键是合理选择（单调、无中心、适合分页）。但 `OutboxEvent` 单独用 uuid 与全局风格不一致；更关键的是它同时有 `seq BigInt @default(autoincrement())` 作为**排序/游标列**——这个「uuid 主键 + 自增 seq 排序」的组合其实是**正确设计**（避免 cuid 在多实例下的排序歧义），只是缺少注释说明为何例外。

**命名规范**：

- 模型名 PascalCase 单数（`User`、`Task`、`WorkflowRun`、`WorkflowStepRun`）；
- 字段 camelCase；
- **每张表都用 `@@map("snake_case_plural")`**（`users`、`tasks`、`task_logs`、`workflow_step_runs`、`outbox_events`）——数据库侧 snake_case + 应用侧 camelCase，规范且一致，**值得直接继承**；
- 枚举用 SCREAMING_SNAKE（`TEXT_TO_IMAGE`、`PROCESSING`）。

**索引策略**（54 个 `@@index`）：

```prisma
model Task {
  @@unique([userId, idempotencyKey])   // 业务幂等键
  @@index([status, createdAt])         // 队列扫描：按状态取最老
  @@index([status])                    // 对账/统计
  @@index([userId, createdAt])         // 用户列表分页
  @@index([creativeId]) @@index([projectId])
  @@index([workflowRunId]) @@index([workflowStepRunId])
}
model TaskLog { @@index([taskId]) @@index([taskId, createdAt]) }
model IdempotencyRecord { @@unique([userId, key]) @@index([expiresAt]) }
```

**评价**：索引策略是**本项目最扎实的部分之一**，模式高度一致：
- 组合索引一律「**过滤列在前、排序列在后**」（`[status, createdAt]`、`[userId, createdAt]`、`[status, availableAt]`），直接对应查询模式；
- 每个外键都有独立索引；
- TTL 类表（`IdempotencyRecord.expiresAt`）有专门的清理索引；
- 唯一约束用业务语义（`@@unique([userId, idempotencyKey])`、`@@unique([providerId, name])`、`@@unique([modelId, capability])`、`@@unique([userId, providerId])`），**而非只依赖 id**。

**其他值得注意的建模范式**：

```prisma
// 1) 软删除：deletedAt 而非 isDeleted，且查询侧统一 where: { deletedAt: null }
deletedAt DateTime?

// 2) 快照固化：任务提交即冻结 Provider/Model 配置，历史任务不受配置漂移影响
modelSnapshot      Json?      // { schemaVersion, modelId, providerName, baseUrl, capabilities }
providerName       String?    // 冗余可读字段（避免 join 已删除的 Provider）
modelName          String?

// 3) 租约 + Fencing（分布式任务的关键）
leaseUntil     DateTime?      // worker 持有；崩溃后过期由 Recovery 回收
leaseVersion   Int @default(0) // 每轮执行递增；所有写入必须带该版本，防失去租约的旧 Worker 续写
workerId       String?  @db.VarChar(100)
heartbeatAt    DateTime?

// 4) 金宇字段用 Decimal 而非 Float
credits    Decimal @default(20) @db.Decimal(12, 2)
costAmount Decimal? @db.Decimal(12, 6)

// 5) 时间字段语义完整
queuedAt / processingStartedAt / completedAt / cancelledAt / createdAt / updatedAt
```

**⚠️ Schema 层面的问题**：

| 问题 | 说明 |
| --- | --- |
| **中英混杂的注释** | 大部分注释是高质量中文业务说明，但 `TaskAttempt` 有 `outputText` / `outputReasoning` 字段承载 LLM 输出，而 `Task` 表没有——输出多模态内容（图片/视频）走 `Asset` 关联，LLM 文本走 `TaskAttempt`，**同一语义分散两处** |
| **`Task` 表字段过多（35+ 列）** | 状态、租约、成本、进度、路由、工作流关联、幂等键全挤在一张表，是典型的「上帝表」。SVH 建议拆出 `TaskLease` / `TaskBilling` |
| **`OutboxEvent.workflowRunId` 无外键** | 只是普通 `String?` + 索引，无 `@relation`，无引用完整性 |
| **无 `@@index` 覆盖 `Task.maxAttempts`/重试统计类查询** | 若做重试分析需补 |
| **`CreditTransaction.amount` 语义模糊** | 预留与确认共用一行、靠 `status` 字符串区分（`reserved`/`confirmed`/`released`），且 `status` 是 `String @db.VarChar(20)` **而非枚举**——失去类型安全 |
| **缺失支付/套餐域** | `credits` 直接挂在 User 上，无 Subscription/Plan/Invoice，仅够 demo |

#### 3.5.2 Prisma Client 单例导出方式

```ts
// packages/database/src/index.ts
import { PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

/** dev 热重载复用同一实例，避免连接泄漏；prod 单进程即单实例 */
export function getPrismaClient(): PrismaClient {
  if (!globalThis.__prisma) globalThis.__prisma = new PrismaClient()
  return globalThis.__prisma
}

export const prisma = getPrismaClient     // 注意：导出的是「函数」而非实例
export { Prisma, PrismaClient } from '@prisma/client'
export { UserRole, TaskStatus, /* …18 个枚举 */ } from '@prisma/client'
export type { User, Task, WorkflowRun, /* …26 个类型 */ } from '@prisma/client'
export { findProviderKeyEncrypted, getDecryptedProviderKey, maskKey } from './user-credential.js'
export * from './credits.js'
```

**评价**：
- ✅ `globalThis` 单例是 Next.js/热重载场景的标准解法，**可直接复用**。
- ✅「业务模块禁止直接散用 Prisma，统一通过本包访问」的约定很好，且把生成的枚举与类型**逐项再导出**，让业务侧只依赖 `@aivideo/database` 一个包——**这个模式值得继承**（避免每个包都去 import `@prisma/client`，也让将来换 ORM 时收口）。
- ⚠️ `export const prisma = getPrismaClient` 导出的是**函数引用**而非实例，容易误用（有人会写 `prisma.user.findMany()` 直接失败）。SVH 应导出 `getPrisma()` 函数并禁止导出裸名 `prisma`。
- ⚠️ **无优雅关闭**：没有 `disconnectPrisma()`，进程退出时连接不主动释放。
- ⚠️ 无 Prisma middleware/extension 用于软删除或审计——每个查询点手写 `deletedAt: null`，**易漏**。SVH 建议用 Prisma `$extends` 的 query 扩展统一注入软删除过滤。

#### 3.5.3 附带助手（`credits.ts` / `user-credential.ts`）

```ts
// credits.ts —— 价格表 + 原子预留（供 api/worker/workflow 复用）
export const CREDIT_PRICE: Record<string, number>   // 从 env 读取：CREDIT_IMAGE/VIDEO/RENDER/LLM
export function creditPriceOf(taskType: string): number

/** 原子预留：updateMany where credits >= amount 的 CAS 扣减 + 流水；余额不足返回 false */
export async function reserveTaskCredit(db: PrismaClient | Prisma.TransactionClient,
                                        userId: string, taskId: string, taskType: string): Promise<boolean>

// user-credential.ts —— 用户自带 Key 查询（API 与 Worker 共用）
export interface ProviderKeyDb { /* 最小接口，PrismaClient 与 TransactionClient 均兼容 */ }
export async function findProviderKeyEncrypted(db, userId, providerId)
export async function getDecryptedProviderKey(db, userId, providerId): Promise<string | null>
export function maskKey(raw: string): string        // 前 4 位 + ****
```

**亮点**：`reserveTaskCredit` 用 `updateMany({ where: { id, credits: { gte: amount } }, data: { credits: { decrement: amount } } })` 实现**单语句原子预留**（无需显式锁），并接受 `PrismaClient | Prisma.TransactionClient` 从而可嵌入更大事务——**这是正确的「积分扣减不能超卖」写法，SVH 应直接复用**。配合 `CreditTransaction` 的 `reserved → confirmed/released` 三段式，构成完整的预留-确认-释放模型。

⚠️ `ProviderKeyDb` 手工声明最小 DB 接口来解耦 PrismaClient/TransactionClient 是个好技巧，但只对这一个查询做了，其余地方仍是裸 Prisma 类型。

#### 3.5.4 复用结论

> **结论：Schema 借鉴设计后重写；Client 单例与助手函数可直接复用**
>
> 理由：**建模风格与索引策略是高质量资产**——`@@map` 全表 snake_case、组合索引「过滤列+排序列」、业务语义唯一约束、软删除 `deletedAt`、快照固化、`Decimal` 金额、租约 + `leaseVersion` Fencing、时间字段语义分层——这些约定 SVH 应逐条继承。但 925 行 schema 是**为「AI 图片/短视频」领域量身定制**的（Project/Script/Character/Scene/Storyboard/Shot/Clip），SVH 是多类型内容 Agent 平台，实体集合会不同，**照抄表结构没有意义**。
>
> **可直接搬运的具体代码**：`src/index.ts` 的 globalThis 单例与类型再导出（约 80 行）、`src/credits.ts` 的原子预留（36 行）、`src/user-credential.ts` 的凭据解密（38 行）。合计约 155 行中 140 行可用。
>
> **必须改进**：导出 `getPrisma()` 而非裸 `prisma`；补 `disconnectPrisma()`；用 `$extends` 统一软删除过滤；`CreditTransaction.status` 改为 Prisma 枚举。

---

### 3.6 `packages/shared` —— 通用类型与常量

**职责**：与 ORM/框架解耦的共享类型、常量、状态机与加解密。7 个源文件约 260 行。`src/index.ts` 只导出 `task` / `api` / `task-state` / `crypto` / `config` / `appearance-card`——**注意：`config.ts` 用显式具名导出（`assertProductionConfig`）而非 `export *`，说明作者有意控制其暴露面**。

#### 3.6.1 `task.ts`（65 行）—— 可直接搬迁

```ts
/** 任务生命周期状态（与数据库 TaskStatus 枚举一致） */
export const TASK_STATUS = {
  PENDING: 'PENDING', QUEUED: 'QUEUED', PROCESSING: 'PROCESSING',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED', SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED', CANCELLED: 'CANCELLED',
} as const
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]

/** 可重试的 HTTP 状态（429/5xx） */
export const RETRYABLE_STATUS: readonly number[] = [429, 500, 502, 503, 504]

/** 任务可重试的失败错误码（来自 ProviderError.code 或业务错误码） */
export const RETRYABLE_ERROR_CODES: readonly string[] =
  ['RATE', 'SERVER', 'TIMEOUT', 'NETWORK', 'QUEUE_ENQUEUE_FAILED']

export const TASK_TYPE = { IMAGE_GENERATE, IMAGE_TO_IMAGE, IMAGE_EDIT, IMAGE_UPSCALE,
  VIDEO_GENERATE, VIDEO_EXTEND, AUDIO_GENERATE, TTS, LLM_CHAT, RENDER, WORKFLOW } as const
export type TaskType = (typeof TASK_TYPE)[keyof typeof TASK_TYPE]

export const V1_ACTIVE_TASK_TYPES: readonly TaskType[] = [IMAGE_GENERATE, IMAGE_TO_IMAGE]

export const CAPABILITY = { TEXT_TO_IMAGE, IMAGE_TO_IMAGE, IMAGE_EDIT, IMAGE_UPSCALE,
  VIDEO_GENERATE, VIDEO_EXTEND, AUDIO_GENERATE, TTS, LLM_CHAT, WORKFLOW } as const
export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY]
```

**评价与搬迁建议**：
- ✅ **`as const` 对象 + 派生 union type** 的写法优于 TS `enum`（可 tree-shake、可 JSON 序列化、与 Prisma 生成的枚举字符串天然对齐），**这个模式应直接继承**。
- ⚠️ **同一语义三处重复**：`TASK_STATUS`/`TASK_TYPE`/`CAPABILITY` 在 `shared`、Prisma schema（`enum TaskStatus` 等）、以及注释中「与数据库一致」三处各定义一次，**无编译期一致性校验**。一旦 schema 改了 `shared` 不改，TypeScript 不会报错。**SVH 应改为「Schema 为唯一真源，`shared` 从 Prisma 生成的类型 re-export」，或在 `shared` 加类型级断言**（`type _Assert = Expect<Equal<TaskStatus, PrismaTaskStatus>>`）。
- ⚠️ `CAPABILITY` 里同时有 `IMAGE_UPSCALE`/`AUDIO_GENERATE`/`TTS`/`WORKFLOW` 等**无任何适配器实现的能力**，属「预留即负债」。
- ⚠️ `V1_ACTIVE_TASK_TYPES` 是典型的**过期临时常量**（当前早已是 V3），无人引用或引用处语义已失效。搬迁时应丢弃。

#### 3.6.2 `task-state.ts`（27 行）—— **强烈建议直接搬迁**

```ts
/** 允许的状态转移表（白名单：不在此表内的转移一律拒绝） */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED'],
  CANCEL_REQUESTED: ['CANCELLED'],
  SUCCEEDED: [],
  FAILED: ['PENDING'],          // 仅领域层 RetryPolicy 可回退重新入队
  CANCELLED: [],
}

export const TASK_TERMINAL: TaskStatus[] = ['SUCCEEDED', 'CANCELLED']
export function canTransition(from: TaskStatus, to: TaskStatus): boolean
export function isTerminal(status: TaskStatus): boolean
```

**评价**：**全项目性价比最高的 27 行**。`Record<TaskStatus, TaskStatus[]>` 让「新增状态却忘记补转移规则」变成编译错误；`FAILED: ['PENDING']` 的注释精确表达了「重试是唯一允许从终态回退的路径」这一业务规则。**SVH 应原样搬迁并扩展**。

⚠️ 唯一缺陷：**`canTransition` 的实际调用点很少**（状态转移大量直接写在 SQL CAS 的 `where` 子句里，如 `where: { status: 'RUNNING' }`），导致状态机是「文档」而非「强制」。SVH 应把它接进 Prisma `$extends` 的 update 钩子，或至少在 service 层强制收口。

#### 3.6.3 `api.ts`（46 行）—— 部分可搬迁

```ts
/** 统一响应包装：{ code, data, message } */
export interface ApiResponse<T = unknown> { code: number; data: T | null; message: string }

/** 业务错误码约定：1xxxx 通用/认证 · 2xxxx 资源 · 3xxxx 任务 · 4xxxx 创作域 · 5xxxx 计费 */
export const ERROR_CODE = {
  OK: 0,
  VALIDATION_FAILED: 10001, UNAUTHORIZED: 10002, FORBIDDEN: 10003, NOT_FOUND: 10004,
  RATE_LIMITED: 10005, THROTTLED: 10006,
  RESOURCE_EXISTS: 20001, USER_RESOURCE_NOT_FOUND: 20002, ASSET_TYPE_NOT_ALLOWED: 20003,
  FILE_TOO_LARGE: 20004, USER_API_KEY_NOT_CONFIGURED: 20005,
  TASK_NOT_FOUND: 30001, TASK_STATUS_INVALID: 30002, IDEMPOTENCY_CONFLICT: 30003,
  MODEL_NOT_ENABLED: 30004, CAPABILITY_NOT_SUPPORTED: 30005, PROVIDER_NOT_ENABLED: 30006,
  PROJECT_NOT_FOUND: 40001, /* … 40002-40006 */
  CREDIT_INSUFFICIENT: 50001, INTERNAL_ERROR: 50000,
} as const
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]
```

**评价**：
- ✅ **业务错误码与 HTTP 状态码分离**是对的（同一业务码可在不同端点映射不同 HTTP 状态）。
- ✅ 分段编号（1xxxx 通用 / 2xxxx 资源 / 3xxxx 任务 / 4xxxx 领域 / 5xxxx 计费）清晰，**值得继承这套编号约定**。
- ⚠️ **`ApiResponse<T>` 的 `{ code, data, message }` 是「HTTP 200 包打天下」的国内常见风格**，与 RESTful 语义冲突，也让 SSE / 流式响应无法统一。SVH 若要做标准 REST + SSE，建议改为「HTTP 状态码表达结果 + `{ error: { code, message, details } }` 表达错误」。**这一点必须由 SVH 明确决策，不宜盲目继承**。
- ⚠️ `OK: 0` 与 `INTERNAL_ERROR: 50000` 的排序在文件里是颠倒的（50000 在 50001 之后列出），属笔误级瑕疵。
- ⚠️ 错误码是**平铺的大对象**，无「错误码 → 默认 HTTP 状态 / 默认中文消息」的映射表，导致每个抛出点都要手写 message（如 `'主模型不存在或未启用'`）。

#### 3.6.4 `crypto.ts`（39 行）—— **强烈建议直接搬迁**

```ts
// 密钥加解密（AES-256-GCM）：格式 <iv>.<data>.<tag>（三段 base64），key = sha256(secretKey)
function deriveKey(secretKey: string): Buffer {
  return createHash('sha256').update(secretKey, 'utf8').digest()   // 派生 32 字节
}
export function encryptSecret(plain: string, secretKey: string): string {
  const iv = randomBytes(12)                                       // GCM 推荐 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${encrypted.toString('base64')}.${cipher.getAuthTag().toString('base64')}`
}
export function decryptSecret(payload: string, secretKey: string): string {
  const parts = payload.split('.')
  if (parts.length !== 3) throw new Error('非法的密文格式（期望 iv.data.tag）')
  const [ivB64, dataB64, tagB64] = parts
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
export function getProviderKeySecret(): string {
  return process.env.PROVIDER_KEY_SECRET ?? 'DEV_PROVIDER_SECRET_CHANGE_ME'
}
```

**评价**：**密码学实现正确**——AES-256-GCM（认证加密）、每次随机 12 字节 IV、`sha256(secret)` 派生定长密钥（避免弱口令直接当 key）、三段式密文自带完整性校验、篡改会因 `final()` 抛错。39 行、零依赖、零框架耦合。**可直接搬运**。

⚠️ 三点改进建议（不影响可搬运性）：① 密钥派生用 `scrypt`/`hkdf` 替代裸 `sha256` 更规范（当前 `sha256` 无 salt，但作为「应用主密钥 → 数据密钥」的确定性派生是可接受的权衡）；② 密文格式无版本号前缀，将来换算法无法平滑迁移，建议 `<v1>.<iv>.<data>.<tag>`；③ `getProviderKeySecret()` 的 dev 默认值是安全隐患，虽然 `assertProductionConfig` 会拦截（见下），但**更安全的做法是「未配置即抛错」，不给默认值**。

#### 3.6.5 `config.ts`（59 行）—— **强烈建议直接搬迁**

```ts
const INSECURE_DEFAULTS: Record<string, string[]> = {
  JWT_SECRET: ['dev-jwt-secret-change-me'],
  PROVIDER_KEY_SECRET: ['DEV_PROVIDER_SECRET_CHANGE_ME'],
  MINIO_SECRET_KEY: ['minioadmin'],
}
const REQUIRED_KEYS = ['DATABASE_URL','REDIS_URL','JWT_SECRET','PROVIDER_KEY_SECRET',
                       'MINIO_ACCESS_KEY','MINIO_SECRET_KEY'] as const
const MIN_SECRET_LENGTH = 16

/** 生产配置断言：不安全或缺省配置 → 抛出含全部冲突项的错误；开发环境直接通过 */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true
  const problems: string[] = []
  // 必填检查 + 密钥长度检查 + 弱默认值黑名单检查
  if (problems.length > 0) throw new Error(`生产环境配置不安全，启动被拒绝：\n- ${problems.join('\n- ')}`)
  return true
}
```

**评价**：**这是全项目工程素养最高的一个文件**。三个设计点值得逐条继承：① 「**dev 默认值黑名单**」而非只检查空值——杜绝了「带着 `minioadmin` 上生产」；② **一次性收集全部问题再抛出**（而非 fail-fast 只报第一个），部署排障效率高；③ 显式接受 `env` 参数便于单测。

⚠️ **但它不是真正的 env 校验**：`REQUIRED_KEYS` 硬编码 6 个 key，**没有出现在这里的 env（如 `LLM_TIMEOUT`、MinIO endpoint）不受校验**；无类型转换；无 schema。SVH 用 Zod 时应升级为 `const EnvSchema = z.object({...}); EnvSchema.parse(process.env)`，并**把 `assertProductionConfig` 的「弱默认值黑名单」思想并入 Zod 的 `refine`**——不要丢掉这条经验。

#### 3.6.6 `appearance-card.ts`（24 行）

从 `index.ts` 被 `export *` 导出。属 AI 图片领域专用（角色外观卡片），**对 SVH 不适用**。

#### 3.6.7 复用结论

> **结论：`task-state.ts` / `crypto.ts` / `config.ts` 直接复用；`task.ts` 借鉴模式后按 SVH 领域重写；`api.ts` 需先决策响应契约**
>
> 理由：这四个文件共约 200 行，**都不依赖 ORM、不依赖 HTTP 框架、不依赖任何业务实体**，是全项目耦合度最低的资产。`TASK_TRANSITIONS` 状态机、AES-256-GCM 加解密、生产配置断言三者可直接拷贝。`task.ts` 的「`as const` + 派生 union」模式必须继承，但常量集合要按 SVH 的 Agent/内容类型重新定义，且**必须解决「三处重复定义、无一致性校验」的问题**。`api.ts` 的 `{code,data,message}` 包裹是否继承，取决于 SVH 对 REST/SSE 契约的决策。

---

### 3.7 次要包：`outbox` / `storage` / `media` / `auth` / `ui`

#### 3.7.1 `packages/outbox`（4 文件 295 行，测试 209 行）—— 生产级，但领域强耦合

**职责**：事务性发件箱。解决「DB 事务提交了，但队列投递失败了」的一致性缺口。

**机制（端到端已验证闭合）**：

| 环节 | 实现 |
| --- | --- |
| **写入** | `OutboxService.writeInTx(tx, kind, payload, availableAt?)` → **与业务数据同事务**插入 `outbox_events`；另有非事务版 `writeEvent` |
| **立即投递** | `dispatchNow(ids)` best-effort，失败仅记日志（留 PENDING 给 poll 兜底）；`QUEUE_DISABLED=1` 时直接跳过 |
| **消费** | `handleTaskQueued`：**CAS 幂等**（`task.status` 必须 PENDING → `updateMany` 置 QUEUED）+ **确定性 jobId**（`taskJobId(taskId, attempt)` 交 BullMQ 去重）+ **入队失败回滚 QUEUED→PENDING 并抛错**（基础设施错误绝不落 FAILED，Redis 恢复后自动继续） |
| **多实例 claim** | `claimOutboxEvents`：先回退超时 60s 的 CLAIMED，再在事务内 `SELECT ... WHERE status='PENDING' AND availableAt<=now ORDER BY createdAt LIMIT n FOR UPDATE SKIP LOCKED` → 置 CLAIMED(`claimedAt`/`claimedBy`) |
| **失败退避** | 成功 → SENT；失败 → `attempts+1` + `lastError`（截 900）+ `availableAt = now + backoff`；阶梯 `[1s,2s,5s,10s,30s,60s,120s,300s]` cap 5min；`attempts >= 10 → DEAD` |
| **兜底** | worker 内 `setInterval(runOutboxPoll, OUTBOX_POLL_INTERVAL_MS ?? 3000)`，batch 默认 100 |

**语义澄清**：这是 **at-least-once + 消费侧幂等**，**不存在 exactly-once**。

**必须知道的 4 个局限**：

1. **不是通用 outbox**：分发是硬编码 `if (kind === TASK_QUEUED)`（`poll.ts:52`），**无 handler 注册表**，且直接依赖 `Task.status`/`queuedAt` 与 `@aivideo/queue` 的 `enqueueTask`/`taskJobId`；
2. 🔴 **除 `TASK_QUEUED` 外的 9 种 kind 无消费者却被标记 SENT**（`poll.ts:56` 注释自承「其余事件当前无消费者：处理完成即视为送达」）——**会静默丢事件**。若 SVH 为 SSE/通知事件而照搬，会出现「事件已送达但前端从未收到」；
3. raw SQL **硬编码表名 `outbox_events` 与列名 `availableAt`/`createdAt`**（Prisma `@@map` 耦合）；
4. `DispatchResult` 返回值被忽略（「skipped」与「送达」在数据上不可区分）；**DEAD 无告警无重投**；`CLAIM_TIMEOUT` 60s 硬编码；成功更新用 `status in (PENDING, CLAIMED)` 未校验 `claimedBy`。

> **结论：借鉴设计后重写（迁移成本中）**。模式本身（同事务写入 + 立即投递 + poll 兜底 + `SKIP LOCKED` claim + 确定性 jobId + 退避至 DEAD）正是 SVH 需要的，但 295 行照搬会把 aiVideo 的领域概念一起带进来。SVH 改写清单：**加 kind→handler 注册表**；**未注册 kind 禁止静默 SENT**；表名/列名参数化；DEAD 加告警 + 重投；SENT 归档；**payload 用 Zod 按 kind 校验**（现为裸 TS interface，正好补上）。

#### 3.7.2 `packages/storage`（2 文件 258 行，测试 65 行）—— 约 90% 可抄

**职责**：S3/MinIO 对象存储封装（具体类 + 模块级单例，**无 `IObjectStorage` 接口**）。

**API 清单**：`put` / `putStream` / `uploadFromUrl` / `downloadToLocal` / `downloadUrlToLocal` / `presignGetUrl`（默认 1h，支持 `ResponseContentDisposition`）/ `presignPutUrl`（默认 15min，CT 必须一致）/ `stat` / `deleteObject` / `ensureBucket`。

**两个非显然的 presign 坑（本包最高价值）**：

1. **双 `S3Client`**——`presignClient` 用 `config.publicEndpoint` 构造。原因：**签名 URL 的 host 在签名内，必须与真实请求一致**，否则 MinIO 校验 host header 失败返回 403（容器内 `minio:9000` vs 浏览器 `127.0.0.1:9000`）。
2. **`requestChecksumCalculation` / `responseChecksumValidation: 'WHEN_REQUIRED'`**——否则 presign 会给 URL 附加 `x-amz-checksum-mode`，导致浏览器 / HEAD 请求 403。

**缺陷（实测）**：

- **只支持 S3 协议，无本地文件系统后端**（本地开发靠 MinIO 容器）；`forcePathStyle: true` 硬编码；
- `putObjectStream` 未传 `contentLength` 时 **size 恒 0 且 checksum 为 ''**；
- **两个返回值失效**：`downloadToLocal` 返回 `body.readableLength`（流已消费，恒 ≈0）、`downloadUrlToLocal` 恒返回 0；
- `ensureBucket` **吞掉所有异常**（403 也会去建桶）；
- 无 multipart（>5GB）、无重试、key 无校验；**没有 `getObjectBuffer`**（小文件需落盘或 presign）；
- env 名硬编码 `MINIO_*`（建议改 `S3_*`）。

> **结论：借鉴设计后重写（迁移成本低）**。无 Prisma / 无框架 / 无厂商专有特性，仅 `@aws-sdk/client-s3` + `s3-request-presigner`，**两个 presign 坑必须保留**。

#### 3.7.3 `packages/media`（7 文件 324 行，测试 149 行）—— 工具级

`ffprobe` 解析（`parseFps` 支持 `'30000/1001'`）、`validateVideoInfo` 纯函数校验（默认 30s / 100MB / ≤60fps / ≤8192px / ≤67MP，属 aiVideo 产品阈值需重定）、`magic.ts` **magic bytes 图片识别**（不信任 `Content-Type`，含通配字节与 `escapeXml` 防 SVG 注入）、`poster.ts` 单条 ffmpeg 抽首帧、`burn-name-bar.ts` sharp 烧名字条（**硬编码品牌蓝 + 只支持 bottom-left + 恒输出 JPEG q92 丢 alpha + 用 `name.length` 估算宽（CJK 偏窄）→ 对 SVH 无复用价值，丢弃**）。

运行时仅依赖 `sharp`（原生二进制），ffmpeg/ffprobe 靠 `FFMPEG_PATH`/`FFPROBE_PATH` 环境变量（部署镜像必须自带；包内 `STATIC_FALLBACKS = ['/tmp/opencode/ffmpeg-static']` 是**从未被引用的死代码**）。`validateVideo` 依赖 `stat(filePath)` → **只支持本地文件**，流式/对象存储直传场景不适用。

> **结论：借鉴设计后重写（迁移成本低）**。「纯函数核心 + IO 外壳」的分层值得抄。

#### 3.7.4 `packages/auth` 与 `packages/ui` —— **均为空壳**

```ts
// packages/auth/src/index.ts（全文 2 行）
// 占位包：后续渐进式实现
export {}
// packages/ui/src/index.ts 内容完全相同
```

- 两者全仓零引用；`packages/ui/package.json` **连 `react` 依赖都没有**，`description` 都是模板化的「AI Creative 平台组件包」，`main` 直接指向 `./src/index.ts`；
- **注意**：认证能力并未缺失，真实实现在 `apps/api/src/auth/*`（301 行）+ `apps/api/src/common/guards/auth.guard.ts`（73 行）——见 §3.8.4。

> **结论：不适用**。这形成了一种**「占位包 + app 内真实实现」的双轨结构**，是有害的组织模式（详见 §6.2⑦）。

---

### 3.8 `apps/api` —— 工程组织方式

**⚠️ 前提更正**：`apps/api` 是 **NestJS 11 + `@nestjs/platform-express`（Express 5）**，`apps/api/package.json` **无任何 fastify 依赖**。因此**不存在** Fastify 插件注册、**不存在** `src/routes/index.ts` 路由注册入口，请求校验用 **class-validator + class-transformer DTO**（非 JSON Schema / zod / typebox）。以下记录的是 **Nest 等价物**。

#### 3.8.1 目录结构与入口

```text
apps/api/src/
├── main.ts（28 行）/ app.module.ts / app.controller.ts
├── common/    decorators · filters · guards · interceptors · business.exception.ts
│              prisma.service.ts · common.module.ts · auth.constants.ts · model-router.service.ts
├── sse/ rate-limit/ auth/ user/ user-key/ credit/ usage/ outbox/ workflow/ admin/
└── asset/ task/ creative/ prompt/ project/ script/ character/ storyboard/ project-agent/ timeline/
```

`main.ts` 全文仅 28 行：`assertProductionConfig()` → `NestFactory.create(AppModule)` → `setGlobalPrefix('api/v1', { exclude: ['health'] })` → `enableCors` → `listen(PORT ?? 4000)`。

🔴 **完全无优雅关闭**：已 grep 验证 `apps/api/src` 内**无 `enableShutdownHooks` / `onApplicationShutdown` / `beforeApplicationShutdown`**，也无 `uncaughtException` / `unhandledRejection` 处理。后果：SIGTERM 直接终止，`PrismaService.onModuleDestroy()` 永不执行、PG 连接不释放、在途请求与 **SSE 长连接被硬断**。

#### 3.8.2 环境变量加载与校验

| 事实 | 说明 |
| --- | --- |
| **无任何 env 加载机制** | 全仓 grep 无 `dotenv`、无 `--env-file`、无 `process.loadEnvFile()`。根目录存在 `.env`，README 声称用它，但**代码里没有任何东西读它** |
| **dev 静默回落硬编码默认值** | `redis://localhost:6379`、`minioadmin`、`dev-secret-change-me` |
| **校验只覆盖生产** | `assertProductionConfig()` 在 `NODE_ENV !== 'production'` 时 `return true`（等于不校验）；是命令式断言**不是 schema**，**无类型导出** |
| **配置散落 6+ 文件** | 且 `auth.constants.ts` 的 `JWT_SECRET`/`JWT_TTL_SECONDS` **在 import 时求值固化**，运行期不可覆盖 |

🔴 **确切的安全漏洞 —— JWT 默认值两处不一致致黑名单失效**：

```ts
// packages/shared/src/config.ts:6
JWT_SECRET: ['dev-jwt-secret-change-me']
// apps/api/src/common/auth.constants.ts:6
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'   // ← 少了 "jwt-"
```

`INSECURE_DEFAULTS` 的比对**永不命中**；且长度检查也拦不住（`'dev-secret-change-me'` 长 20 > `MIN_SECRET_LENGTH` 16）。**显式把该 dev 值带进生产即可绕过启动校验**。

#### 3.8.3 全局注册清单与顺序（Nest 无插件体系，靠 `APP_*` token）

| 能力 | 注册方式 | 位置 |
| --- | --- | --- |
| CORS | `app.enableCors()` | `main.ts` |
| **全局认证守卫** | `APP_GUARD useClass AuthGuard` | `auth.module.ts:32` |
| **全局限流守卫** | `APP_GUARD useClass RateLimitGuard` | `rate-limit.module.ts:8` |
| 响应包装 | `APP_INTERCEPTOR ResponseInterceptor` | `common.module.ts:17` |
| 异常过滤 | `APP_FILTER HttpExceptionFilter` | `common.module.ts:18` |
| DTO 校验 | `APP_PIPE ValidationPipe` | `app.module.ts:32-40` |
| Prisma | `@Global` 模块导出 `PrismaService` | `common.module.ts` |
| JWT | `JwtModule.register({ global: true })` | `auth.module.ts` |

**❌ 缺失**：无 `helmet`、无 `@nestjs/swagger`、无 `@nestjs/config`（依赖层面已验证不存在）。

⚠️ **顺序陷阱**：`RateLimitGuard` 的用户维度限流**依赖 `AuthGuard` 先写入 `req.user`**，顺序由 `app.module.ts:28` 的 imports 数组顺序决定（AuthModule 恰好在前）——**无注释、无测试保护的隐式契约**。重排 imports 会静默退化为「按 IP 限流」。

#### 3.8.4 路由组织与鉴权

- **21 个模块挤在 `app.module.ts:28` 一行 imports**；全局单版本前缀 `api/v1`，无 `@Version`、无 per-module 路由；
- **鉴权模型是「全局守卫 + 元数据装饰器 + 默认拒绝」**（值得继承）：

```ts
@Public()                  // 显式放行（默认全部需要认证）
@Roles('ADMIN')            // 角色校验
@CurrentUser() user        // 注入 req.user = { userId, role, email }
```

- ✅ **亮点：SSE 短时 scope token**（TTL 90s，`scope='SSE'`，限定只能访问 stream 路径）——解决 **EventSource 无法携带 Header** 的经典问题，**设计正确、值得照搬**；
- ⚠️ scope 校验用 `path.includes('sse/stream')` **子串匹配**（应改精确匹配）；
- ⚠️ **每个请求都打一次 Redis 查 jti 黑名单**，无本地缓存。

#### 3.8.5 错误处理

响应体 `{ code, data, message }`，`code: 0` 成功。**业务错误码与 HTTP 状态码双轨分离**（`BusinessException(code, message, httpStatus)` + 全局 `@Catch()` 过滤器）——**这是好设计**，错误码集中在 `packages/shared/src/api.ts`、分段编号并导出 `type ErrorCode`，**可直接作为 SVH 起点**。

**劣质实现（直言）**：

| 问题 | 说明 |
| --- | --- |
| 🔴 `httpToErrorCode()` 是 switch 白名单 | 只覆盖 400/401/403/404/429，**其余（409/413/422/503）全部折叠成 `INTERNAL_ERROR` 50000**，语义严重失真（如健康检查 503 的 code 变成 50000） |
| 🔴 413 靠字符串匹配 | `message.toLowerCase().includes('file too large')` 识别 Multer 超限，**改文案即失效** |
| ⚠️ 无 `traceId`/`requestId` | 响应体与错误日志都没有，生产排障靠人工对时间 |
| ⚠️ `ResponseInterceptor` 无 skip 机制 | 原生响应只能靠 `@Res()` 绕过，约定不完整 |

#### 3.8.6 请求校验

class-validator DTO + 全局 `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`。

⚠️ 坑：开启了 **`enableImplicitConversion: true`**（隐式类型转换是公认坑，会让 `"1"` 与 `1` 的边界模糊）；另 `APP_PIPE` 注册在 `AppModule` 而 `APP_FILTER`/`APP_INTERCEPTOR` 在 `CommonModule`，**位置分散**。

#### 3.8.7 🔴 实时推送（SSE）—— 本报告最严重的部分

**选型 SSE（无 WebSocket）**，实现于 `apps/api/src/sse/`（controller / service / poller / module）。**事件源是 DB 的 outbox 表，不是 Redis pub/sub**。

**缺陷 A（硬 bug）：replay 之后不订阅、不关流** —— `sse.controller.ts:46-66`
当 `pending.length > 0` 时，写完 replay 帧后**直接 `return`**：既不调用 `this.sse.subscribe()`，也不装 heartbeat，也不 `res.end()`。客户端拿不到实时事件，且响应未结束（TCP 悬挂，EventSource 认为连接健康、**不触发重连**）。而 `Last-Event-ID` 正是 EventSource 重连必发头 → **任何一次真实断线重连，只要窗口内有事件，该用户的实时推送就永久静默**。这是主流程，不是边界情况。

**缺陷 B（越权）：跨用户事件泄漏** —— `sse.controller.ts:42-45`
Replay 的 SQL **不按用户过滤**（`where: { seq: { gt: lastId }, kind: { notIn: ['TASK_QUEUED'] } }`），过滤在 JS 层且条件是 `p.userId === user.userId || !p.userId`——**无 userId 的事件发给所有人**（注释自承「旧事件无 userId：放过」）。而 `sse.poller.ts:30-57` 的 `resolveUserId()` 有 **5 级 fallback**（taskId/assetId/creativeId/workflowRunId 反查），恰说明大量事件不带 userId。**任意登录用户发 `Last-Event-ID: 0` 即可拉取最多 1000 条他人事件载荷**——可单请求触发的越权信息泄露。

**缺陷 C：多实例「广播」实为轮询 + 内存游标** —— `sse.poller.ts:11-25`
`private cursor = 0` 是**进程内变量且初值为 0**，每次重启/滚动发布都从 `seq=0` 重放整张 outbox（发布惊群 + 每条做 `resolveUserId` 的 DB 反查 N+1）；无 Redis pub/sub，每实例独立全表轮询（`take: 200`），DB 压力随实例数 × 500ms 线性放大；`SseService.clients` 是裸 `Map<string, Set<Response>>`，**无每用户连接上限**，`broadcast` 只 try/catch 吞 write 异常、不检查 `writableEnded`。

✅ **实现正确的部分**：心跳（30s `: ping` + `req.on('close')` 清理）、鉴权（`?token=` + 90s 短时令牌）。

**公允评价**：「**outbox 作唯一事件源 + `Last-Event-ID` 游标**」方向是对的（DB 即真相、不丢、可重放），**问题全在实现细节**。

#### 3.8.8 其他发现

- 🔴 **7 处各自 `new Redis`**（api：`app.controller.ts:22` / `token.service.ts:25` / `creative.service.ts:45` / `admin-system-config.service.ts:38` / `rate-limit.guard.ts:50`；worker：`index.ts:367` / `task-executor.ts:75`），无统一连接管理；
- ⚠️ `app.controller.ts`（141 行）**职责过载**：健康检查 + Prometheus + 队列计数 + SSE 连接数；构造函数里为 `getJobCounts()` 又开一条 Redis 连接；指标是进程内状态，**多实例不可聚合**；
- 🔴 **`/metrics` 是 `@Public()` 无鉴权**，暴露任务量与队列积压；
- ⚠️ **模块定义塞进 controller 文件**：`app.module.ts:18-23` 从 `script.controller` / `credit.controller` / `timeline.controller` / `project-agent.controller` 导入 Module——这 4 个域**无独立 `*.module.ts`**，与其余域规范自相矛盾；
- ⚠️ `RateLimitGuard`：`cfgWarned` 字段声明在使用点之后（113 vs 105）；全局兜底 `hit()` **不传 `def`**，故障策略静默走默认 `'open'`；
- ✅ **限流本身设计好，值得照搬**：写接口 fail-closed(503) / 读接口 fail-open；限额从 `system:config` 热读 + 60s 缓存；路由级 `@RateLimit` + 全局兜底。

#### 3.8.9 OpenAPI

**没有。** 依赖无 `@nestjs/swagger`，也无手写 `openapi.json`，前后端无契约自动化。

---

### 3.9 `apps/worker` —— 工程组织方式

#### 3.9.1 结构、入口与生命周期

```text
apps/worker/src/
├── index.ts（370 行巨型 main）    task-executor.ts（1451 行）
├── metrics.ts   common/{json-log, worker-error, event-run-id}
├── task/{lease-heartbeat, retry-transaction, task-lease-guard}
├── recovery/{task-reconciler, workflow-reconciler}
└── generation/ media/ render/ asset/ credit/ usage/
```

**单进程 + 单 BullMQ Worker + 6 个 `setInterval` 定时任务**。并发 `WORKER_CONCURRENCY`（默认 4，**做了 `Number.isFinite` 校验**）。

✅ **优雅关闭存在且比 API 完整**（`index.ts:297-313`）：`clearInterval` ×5 → `healthServer.close()` → `await worker.close()` → `outboxQueue.close()` → `storage.close()` → `prisma.$disconnect()` → `exit(0)`，绑 SIGINT/SIGTERM。

⚠️ 不足：`worker.close()` **无限期等长任务**（视频渲染数分钟）无宽限期兜底；`process.exit(0)` 硬退可能截断日志；**无 `uncaughtException`/`unhandledRejection` 兜底**；**`startHealthServer()` 无 `'error'` 监听 → 端口占用即崩进程**。

#### 3.9.2 队列与处理器

**只有一个队列** `AI_TASK_QUEUE = 'ai_tasks'`，全类型混跑，靠 `task.type` 分支分发（`task-executor.ts:763-790`）：`RENDER → runRenderTask`(:810)、`LLM_CHAT → runLlmTask`、其余 → `runGeneration`(:960)。

另有 6 个**非 BullMQ 周期任务**：cleanup、outbox 兜底投递、recovery（租约过期回收 PROCESSING）、task reconciler、workflow reconciler、orphan asset cleanup。

🔴 **架构级问题：单队列混跑 + 全局 concurrency 一刀切** → 耗时数分钟的 RENDER/VIDEO **占满槽位、饿死**秒级 IMAGE/LLM；无法按类型扩缩容或设优先级。（与 §3.4.2 的判断一致，SVH 必须拆队列。）

#### 3.9.3 任务执行流程（全项目工程质量最高的部分）

`execute()`（`task-executor.ts:675-790`）：

1. **幂等校验**：`status !== QUEUED` 直接跳过；
2. **`$transaction` 内 CAS `QUEUED→PROCESSING` + `attempts+1` + `leaseVersion+1` + 创建 `TaskAttempt`**（四件事原子提交）；
3. 启动 lease heartbeat（续租 CAS 需 `id + PROCESSING + leaseVersion + workerId` 全匹配，失配即用 `AbortController` 中止在途执行，且不写状态、不释放并发计数）；
4. 按 `type` 分发到 `runGeneration` / `runLlmTask` / `runRenderTask`。

**已落地的关键机制**：① CAS 状态机乐观并发；② **租约 + 心跳 + Fencing**；③ **重试全由领域层控制**（`attempts: 1`、`taskJobId(taskId, attempt)` 确定性 JobId、`computeRetryDelayMs` 指数退避 + jitter）；④ 重试走 `retryTaskInTransaction` **单事务**写 PENDING + 事件 + 可选模型切换；⑤ **崩溃兜底双保险**（recovery + reconciler + outbox 兜底投递）实现「先落库后入队 + 最终一致」；⑥ `sanitizeProviderError().slice(0, 900)` 错误脱敏。

🔴 **代价（直言）**：`processTask` **全量吞异常**（`index.ts:45-54`，注释「永不向 BullMQ 抛错」）→ BullMQ 的重试 / 退避 / failed 事件 / 失败队列 / Bull Board 可观测性**整体放弃**，`onFailed` 钩子形同虚设。一旦自研重试路径有 bug，任务会**静默卡在 PENDING/QUEUED**，只能靠 30s reconciler 捞。**照搬必须连 reconciler + 告警一起搬。**

#### 3.9.4 进度上报

**写 DB + 写 outbox 事件，不用 `job.progress`、不直接推 SSE**：

```ts
// task-executor.ts:501-514
writeProgress() = leaseGuard.writeProgress(...)          // 带 fencing CAS 的进度写
               + writeEvent('TASK_PROGRESS', { taskId, userId, progress })
// → API 的 SsePoller 轮询 outbox → SSE 下发
```

- ✅ 优点：可查询、事件带 `userId`（免 N+1 反查）、fencing 防被回收的 worker 污染进度；
- ⚠️ 缺点：**非实时**（最坏 500ms+）、失败只记日志不重试、**完全不用 BullMQ 原生 `updateProgress()`**。

#### 3.9.5 与 api 的共享与边界（干净，可放心照搬）

两边只通过 `workspace:*` 依赖 `packages/*`。**已验证**：无跨 app 引用（api ↛ worker、worker ↛ api，grep 零命中）、**packages 无反向越界**（无 `../../apps` 引用）、无循环依赖。进程隔离明确：API 走 `PrismaService extends PrismaClient`（Nest 生命周期），worker 走 `getPrismaClient()`，各自独立连接池。

⚠️ 唯一隐性共享是**约定式 Redis key**：`ACTIVE_TASKS_PREFIX` 的语义在 `index.ts:249-255` **被重新实现一遍**，靠注释与 task-executor 对齐——应下沉到 `packages`。

---

### 3.10 工程配置

#### 3.10.1 根脚本与 Turbo

```json
// package.json（根）
"scripts": {
  "dev": "turbo run dev", "build": "turbo run build", "generate": "turbo run generate",
  "db:generate": "pnpm --filter @aivideo/database generate",
  "db:migrate:dev": "pnpm --filter @aivideo/database migrate:dev",
  "db:migrate:deploy": "pnpm --filter @aivideo/database migrate:deploy"
}
// turbo.json
"build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] }
"dev":       { "cache": false, "persistent": true, "envMode": "loose" }
"generate":  { "cache": false }
"typecheck": { "dependsOn": ["^build"], "outputs": [] }
```

✅ `dependsOn: ["^build"]` 保证拓扑顺序（依赖包先构建，避免消费陈旧 `dist`）；`dev.persistent` 正确。
⚠️ **无 `test` / `lint` / `clean` 任务**（SVH 的 `turbo.json` 已有，是改进）。
🔴 **`outputs` 里混入 `.next/**`**——这是从 Next.js 模板复制的残留，但根 `build` 会跑 `apps/web` 的 `next build`，尚算合理；只是 `packages/*` 的 `dist/**` 与 Next 的构建缓存混在同一任务定义里，语义不纯。

#### 3.10.2 tsconfig 与模块系统（三方并存）

| 位置 | module / moduleResolution | 备注 |
| --- | --- | --- |
| 根 `tsconfig.base.json` | **未指定** `module`/`moduleResolution` | ES2022 + strict + `declaration`/`declarationMap`/`sourceMap`；**`noUncheckedIndexedAccess: false`、`strictPropertyInitialization: false`** |
| `packages/*` | `ESNext` + `Bundler` | 消费方是 tsup |
| `apps/api` | **`commonjs` + `node`** | Nest 装饰器元数据必需 |
| `apps/worker` | **`NodeNext` + `NodeNext`** | 但 `packages/*` 产物是 `.js`（ESM）——能跑通靠 `skipLibCheck` 与 Node 的 `require(esm)` |

⚠️ **三方模块系统并存**，根 base 偏 ESM、api 是 CJS、worker 是 ESM，靠 `skipLibCheck` 掩盖不一致。**SVH 已统一为 `NodeNext` + `type: module`，务必守住。**

#### 3.10.3 构建产物与构建工具（已验证）

| 位置 | 构建工具 | 产物 |
| --- | --- | --- |
| `packages/*`（ai/agent-core/workflow/queue/shared/database/outbox/storage/media） | **tsup** | `format: ['esm','cjs']` + `dts: true` + `clean` + `sourcemap`，实测产出 `index.js` + `index.cjs` + `index.d.ts` + `index.d.cts` |
| `packages/auth`、`packages/ui` | — | **无 `build` script，无 `dist/`**（空壳，见 §3.7.4） |
| `apps/api`、`apps/worker` | **纯 `tsc`** | `tsc -p tsconfig.build.json` → `dist/`，**未用 tsup/esbuild 打包** |

tsup 的 `external` 配置逐包手工维护（如 `packages/ai` external `@aivideo/shared`、`packages/workflow` external 4 个 workspace 包、`packages/database` external `@prisma/client`）。

🔴 **`main`/`module` 字段不一致（任务描述中的疑点已确认属实，且比预期更乱）**：

| 包 | `main` | `module` | `exports` |
| --- | --- | --- | --- |
| `ai` / `queue` / `shared` / `database` | `./dist/index.cjs` | `./dist/index.js` | 有（types/import/require） |
| `workflow` | **`dist/index.js`** | `dist/index.js` | 有（types/import/require → `index.cjs`） |
| **`agent-core`** | **`./dist/index.js`** | **无** | **无 `exports` 字段** |

后果分析：
1. **`types` 一律只指向 `dist/index.d.ts`**（ESM 风格声明），CJS 消费方拿不到 `.d.cts`——虽有 `index.d.cts` 产物却未在 `exports` 中引用；
2. **`agent-core` 事实上是 ESM-only**（`main` 指向 ESM 产物 + `"type": "module"`），却被 CJS 的 `apps/api` 引用。审计中在 **Node v24 实测 `require('@aivideo/agent-core')` 成功**（v24 支持 `require(esm)`），但项目 `engines` 声明 `node >= 20`、CI 用 node 20——**这依赖 Node ≥20.19 / ≥22.12 的 `require(esm)` 支持，在更早的 Node 20 上直接 `ERR_REQUIRE_ESM`**。这是**版本依赖的隐性脆弱**，不是设计正确。

#### 3.10.4 ESLint / Prettier

🔴 **完全不存在**：全仓无 `.eslintrc*` / `eslint.config.*` / `.prettierrc*` / `.editorconfig`，**根与所有子包的 `package.json` 都没有 eslint/prettier 依赖**，**没有任何 `lint` 脚本**。CI 只跑 `tsc --noEmit`。

（SVH 已在根 `package.json` 配好 `eslint@9` + `typescript-eslint@8` 与 `lint` 脚本、`turbo.json` 有 `lint` 任务——**这是对 aiVideo 的实质性改进，必须保留**。）

#### 3.10.5 CI（`.github/workflows/ci.yml`）

三段式：

```
unit-build job:
  1. pnpm install --frozen-lockfile
  2. pnpm --filter @aivideo/database generate
  3. pnpm turbo typecheck
  4. 逐个 pnpm --filter X exec vitest run（8 个包）
  5. pnpm turbo build

e2e job (needs: unit-build):
  6. docker compose -f docker-compose.dev.yml up -d（PG/Redis/MinIO）+ 等 MinIO 就绪
  7. prisma migrate deploy
  8. 注入 tools/seed-dev-db.sql
  9. 构建 api/worker 产物（E2E 直接跑 dist）
 10. pnpm --filter @aivideo/api exec vitest run test/e2e
```

🔴 **CI 的两个实际漏洞**（SVH 应避免）：

1. **`packages/database` 与 `packages/shared` 没有 `typecheck` script**（其余包有），因此 `turbo run typecheck` **会跳过它们**——这两个包的类型**从未在 CI 中被检查**；
2. **CI 的 vitest 列表漏掉了 `packages/agent-core`**（以及 `apps/api` 的单元测试，只跑了 e2e）——**agent-core 的 139 行测试在 CI 中永不执行**。

根因是各包 `scripts` 不一致（`ai`/`queue` 甚至没有 `test` script，`database`/`shared` 没有 `typecheck`），CI 只能用 `pnpm --filter X exec vitest run` **逐个硬编码绕过**。另：`workflow` 用 `vitest ^2.0.0` 而其余用 `^4.1.11`，**版本不统一**。

| 包 | scripts |
| --- | --- |
| `agent-core` | build, typecheck, test |
| `ai` | build, typecheck（**无 test**） |
| `database` | generate, validate, migrate:dev, migrate:deploy, build（**无 typecheck**） |
| `queue` | build, typecheck（**无 test**） |
| `shared` | build, test（**无 typecheck**） |
| `auth`、`ui` | **无任何 script** |

#### 3.10.6 部署与本地基础设施

`docker-compose.dev.yml`：Postgres 16 / Redis 7 / MinIO，**三个服务都配了 healthcheck**（`pg_isready` / `redis-cli ping` / `mc ready local`），可直接复用。

**Dockerfile（两 app 各一份多阶段，结构相同）的 4 个问题**：

1. 🔴 **`COPY --from=builder /app /app` 全量拷贝**——把 `apps/web`/`apps/admin` 源码 + 全部 devDeps 带进后端生产镜像（体积巨大、供应链面扩大；注释自承「单机部署，简化链路」）；
2. 🔴 **硬编码构建代理 `http://127.0.0.1:10808`**（含 `npm config set proxy`）→ 无代理环境无法构建，应改 `--build-arg`；
3. 🔴 **`CMD ["pnpm","--filter",...,"start"]` 让 pnpm 作 PID 1**，信号转发不确定，叠加 **API 无 shutdown hooks** → 容器停止**不可能优雅关闭**；
4. ⚠️ 无 `HEALTHCHECK`（尽管端点齐备）、以 root 运行。

#### 3.10.7 开发脚本与工具链统一性

| app | dev | build | start |
| --- | --- | --- | --- |
| `api` | `node --watch -r ts-node/register/transpile-only src/main.ts`（**开发态无类型检查**） | `tsc -p tsconfig.build.json` | `node dist/main.js` |
| `worker` | `tsx watch src/index.ts` | `tsc -p tsconfig.build.json` | `node dist/index.js` |

⚠️ **两 app dev 工具链不统一**（ts-node transpile-only vs tsx）；**api 装了 `tsx` 却从不使用**（冗余依赖）。

---

## 4. 可直接复用的资产清单

> 迁移成本口径：**低** = 拷贝后改 import 路径与领域名词即可（<0.5 天）；**中** = 需改造接口/补依赖（0.5~2 天）；**高** = 需重新设计（>2 天）。

| 模块 / 文件 | 复用方式 | 迁移成本 | 注意事项 |
| --- | --- | --- | --- |
| `packages/queue/src/*`（128 行） | **直接复用** | 低 | 需补 `rediss://` TLS 支持、进度上报、包内优雅关闭；单队列→按资源池拆分（避免长任务饿死短任务） |
| `packages/shared/src/task-state.ts`（27 行） | **直接复用** | 低 | 扩展 SVH 状态；必须接进 Prisma `$extends` 才真正强制 |
| `packages/shared/src/crypto.ts`（39 行） | **直接复用** | 低 | 建议加算法版本前缀；dev 默认密钥改为「未配置即抛错」 |
| `packages/shared/src/config.ts`（59 行） | **直接复用** | 低 | 升级为 Zod EnvSchema，但**保留「弱默认值黑名单 + 全量收集报错」两条经验**；**务必消除 aiVideo 那处 JWT 默认值不一致** |
| `packages/ai/src/error.ts`（68 行） | **直接复用** | 低 | `isRetryable` 改为显式白名单；`sanitizeProviderError` 必须原样保留 |
| `packages/ai/src/providers/types.ts`（126 行） | **直接复用** | 低 | 把 `baseUrl` 提升为 `ModelBrief` 一等字段；补 `tools` 字段 |
| `packages/ai/src/composer.ts`（77 行） | **直接复用** | 低 | `pickAllowedKeys` 是安全边界，不可省 |
| `packages/database/src/index.ts`（81 行） | **直接复用** | 低 | 改为导出 `getPrisma()`；补 `disconnectPrisma()`；用 `$extends` 统一软删除 |
| `packages/database/src/credits.ts`（36 行） | **直接复用** | 低 | 原子预留写法（`updateMany where gte` + `decrement`）必须保留 |
| `packages/database/src/user-credential.ts`（38 行） | **直接复用** | 低 | 与 `crypto.ts` + `SecretResolver` 配套使用 |
| **worker 任务运行时**（CAS 状态机 + 租约/Fencing + `TaskAttempt` 审计 + `retryTaskInTransaction` + 双 reconciler + 确定性 JobId） | 借鉴设计后重写 | 中 | **本次审计发现的最高价值资产**（把「AI 长任务 + 进程崩溃 + 重复投递」三个真问题都解掉了，带 13 个单测）。建议整包抽为独立模块；**必须连 reconciler + 告警一起搬**，否则失败会静默化 |
| `packages/agent-core`：`parseStructured` + `schemaOf`（约 60 行） | 借鉴设计后重写 | 低 | 改用 Zod v4 `z.toJSONSchema()`；**但 OpenAI strict 的两个坑必须自己处理** |
| `packages/ai` 整体架构（门面/适配器/装配/归一化/密钥端口） | 借鉴设计后重写 | 中 | 补 `providerType → factory` 路由表、adapter 缓存、Anthropic/Gemini 适配器 |
| `packages/workflow` 推进算法（就绪扫描 + CAS 幂等闸门 + `wf:{runId}:{stepId}`） | 借鉴设计后重写 | 中 | 拆分纯函数核心与 DB 服务层；**必须补日志/事件，禁止静默 catch** |
| `packages/outbox` 一致性模式 | 借鉴设计后重写 | 中 | 加 kind→handler 注册表；**未注册 kind 禁止标记 SENT**；payload 用 Zod 按 kind 校验 |
| `packages/storage` S3/presign（258 行） | 借鉴设计后重写 | 低 | 约 90% 可抄；**双 S3Client 解决 presign host 403** 与 `WHEN_REQUIRED` checksum 两个坑必须保留；修 3 处失效返回值 |
| `packages/database/prisma/schema.prisma` 建模约定 | 借鉴设计后重写 | 中 | 继承约定（`@@map`/组合索引/软删除/快照/租约 Fencing/Decimal）；**不要照抄表结构** |
| `packages/media`（324 行） | 借鉴设计后重写 | 低 | 只取「纯函数核心 + IO 外壳」分层与 magic bytes 识别；产品阈值需重定；丢弃 `burn-name-bar` |
| **`{code,data,message}` + 业务码/HTTP 码双轨分离 + `ERROR_CODE` 分段编号** | **直接复用（约定）** | 低 | `packages/shared/src/api.ts` 可直接作起点；但需先决策是否改用标准 REST 错误体（见 §6.2⑤） |
| **全局默认拒绝鉴权模型**（`AuthGuard` + `@Public()`/`@Roles()`/`@CurrentUser()` + Redis jti 黑名单） | 借鉴设计后重写 | 中 | 语义可继承，实现必须改 `@fastify/jwt` + `onRequest` hook + Zod |
| **SSE 短时 scope token**（90s，限定路径） | 借鉴设计后重写 | 低 | 解决 EventSource 无法带 Header 的经典问题；**路径校验改精确匹配**，勿用 `includes` |
| **分层限流 + Redis 故障分级降级**（写 fail-closed 503 / 读 fail-open / 限额热读 + 60s 缓存） | 借鉴设计后重写 | 中 | 设计好，值得照搬 |
| **可观测三件套**：`/health/live`、`/health/ready`（深查 PG/Redis/MinIO/ffmpeg）、`/metrics` | 借鉴设计后重写 | 低 | worker 独立 metrics 端口（默认 9081）的设计可继承；**`/metrics` 必须加鉴权** |
| **启动 fail-fast 自检**（`assertProductionConfig()` + worker 校验 ffmpeg/ffprobe 缺失即 `exit(1)`） | 借鉴设计后重写 | 低 | 与 Zod EnvSchema 合并实现 |
| **Monorepo 边界纪律**（apps 只依赖 packages、app 间零引用、packages 不反向依赖 apps、`dependsOn:["^build"]`、各进程独立 Prisma 连接池） | **直接复用（纪律）** | — | 已实测验证干净，**照搬到 SVH 的 lint/CI 规则中** |
| `docs/*.md`（16 篇 2347 行） | **直接参考** | — | 设计文档质量高于代码，是本次审计最大的隐性资产 |
| `docker-compose.dev.yml` | **直接复用** | 低 | 三服务均有 healthcheck；改库名/容器名即可 |
| `tools/mock-provider.mjs`、`tools/seed-dev-db.sql` | 借鉴设计后重写 | 低 | mock Provider 便于无 Key 开发，思路可留，内容需重写 |
| `packages/auth`、`packages/ui` | **不适用** | — | **空壳（各 2 行）**，零复用价值 |
| `apps/api`（NestJS）、`apps/web`（Next.js） | **不适用** | — | 框架与 SVH 的 Fastify/Vite 不兼容 |

---

## 5. 不建议复用的部分及原因

### 5.1 明确空壳 / 零价值

| 对象 | 事实 | 结论 |
| --- | --- | --- |
| `packages/auth` | `src/index.ts` 仅 2 行：`// 占位包：后续渐进式实现` + `export {}`。全仓零引用。**注意**：认证能力并未缺失，真实实现在 `apps/api/src/auth/*`（301 行）+ `apps/api/src/common/guards/auth.guard.ts`（73 行），是 NestJS + `@nestjs/jwt` 的 Bearer JWT + jti 黑名单 + SSE 90s 短时令牌 | **不适用**。包本身 0 成本；设计思路（jti 吊销、SSE 短时令牌、`@Public()`/`@Roles()`）可借鉴，实现必须用 `@fastify/jwt` + `onRequest` hook + Zod 重写 |
| `packages/ui` | 同样 2 行空壳，`package.json` 连 `react` 依赖都没有，全仓零引用 | **不适用**。SVH 的 UI 层需从零建设 |
| `packages/shared/src/appearance-card.ts` | 角色外观卡片类型，AI 图片领域专用 | **不适用** |
| `packages/workflow/src/state.ts` | 3 个导出（`stepState`/`readySteps`/`isRunTerminal`）**全仓零引用**，逻辑与 `advance.ts` 重复 | **删除，不迁移** |

### 5.2 与 SVH 技术栈不兼容

| 对象 | 原因 |
| --- | --- |
| `apps/api` 全部业务代码 | **NestJS 11 + Express**，依赖装饰器、DI 容器、`class-validator` DTO、`Reflect` 元数据。SVH 是 Fastify + Zod，**运行时模型根本不同**，无部分复用可能 |
| `apps/web` | **Next.js 15**（App Router / RSC / `next/*`）。SVH 是 React + Vite，不可复用 |
| `apps/api` 的认证守卫 | 与 NestJS `ExecutionContext` / `CanActivate` 强耦合 |

### 5.3 实现质量不足，不应照搬

| 对象 | 问题 |
| --- | --- |
| `packages/ai/src/validator.ts` | 12 行纯转发，无独立价值。合并进 `composer.ts` 即可 |
| `packages/agent-core/src/agents/creative.agent.ts` | 96 行硬编码两段式编排，无 Agent 抽象、无工具调用、无循环、重试不回喂错误。**作为「示例」有参考价值，作为「框架」不合格** |
| `packages/workflow` 的错误处理 | `kickoffReadySteps` 与 `advanceWorkflowRun` 的**最外层 `catch { return {...} }` 完全吞错**，无日志无事件。故障表现为「工作流静默卡死」，生产不可接受 |
| `packages/database/prisma/schema.prisma` 表结构 | 为「AI 图片/短视频」定制的实体集（Project/Script/Character/Scene/Storyboard/Shot/Clip），且 `Task` 表 35+ 列已成「上帝表」 |
| 全仓 ESLint / Prettier | **完全不存在**（无配置、无依赖、无 lint 脚本）。CI 只跑 `tsc --noEmit`。SVH 已在根 `package.json` 配好 eslint 9 + typescript-eslint，**务必保留** |
| 全局 `main: dist/index.cjs` + `module: dist/index.js` 双格式 | 见 §6.1，是 SVH 应当**主动规避**的历史包袱 |

### 5.4 数据一致性风险

`packages/outbox` 的模式本身正确，但有**两个必须规避的坑**（详见 §3 与下方 §6.2）：

1. **分发逻辑硬编码 `if (kind === TASK_QUEUED)`，无 handler 注册表**；
2. **除 `TASK_QUEUED` 外的 9 种事件在无消费者的情况下被标记为 `SENT`**（源码注释自认「其余事件当前无消费者：处理完成即视为送达」）——**这会静默丢事件**。若 SVH 为 SSE/通知而照搬，将出现「事件显示已送达但前端从未收到」的诡异故障。

### 5.5 `apps/api` / `apps/worker` 中实测到的严重缺陷（照搬即埋雷）

以下均为**静态阅读代码原文得出的事实性缺陷**，按严重度排序：

| # | 级别 | 缺陷 | 位置 |
| --- | --- | --- | --- |
| 1 | 🔴 P0 | **SSE replay 后不订阅、不关流** → 任何一次真实断线重连后，该用户实时推送**永久静默**（TCP 悬挂、EventSource 不触发重连）。这是主流程而非边界情况 | `apps/api/src/sse/sse.controller.ts:46-66` |
| 2 | 🔴 P0 | **SSE 跨用户事件泄漏** → replay SQL 不按用户过滤 + JS 层 `p.userId === me \|\| !p.userId` 放过无 userId 事件。任意登录用户发 `Last-Event-ID: 0` 可拉取最多 1000 条他人事件载荷 | `apps/api/src/sse/sse.controller.ts:42-45` |
| 3 | 🔴 P0 | **全仓无任何 env 加载机制**（无 dotenv / `--env-file` / `loadEnvFile`），`.env` 存在但无人读；dev 静默回落硬编码默认值 | 全仓 |
| 4 | 🔴 P0 | **JWT 默认值两处不一致致生产安全校验失效**（`'dev-jwt-secret-change-me'` vs `'dev-secret-change-me'`），显式带入 dev 值即可绕过启动校验 | `packages/shared/src/config.ts:6` vs `apps/api/src/common/auth.constants.ts:6` |
| 5 | 🔴 P0 | **API 完全无优雅关闭**（无 `enableShutdownHooks`/`onApplicationShutdown`），叠加 Dockerfile `CMD pnpm` 的 PID 1 信号问题 → 容器停止**不可能优雅**，在途请求与 SSE 长连接被硬断、PG 连接不释放 | `apps/api/src/main.ts` |
| 6 | 🟠 P1 | **单队列混跑所有任务类型 + 全局 concurrency 一刀切** → 耗时数分钟的 RENDER/VIDEO 饿死秒级 IMAGE/LLM 任务 | `apps/worker/src/index.ts` + `packages/queue` |
| 7 | 🟠 P1 | **多实例「广播」靠每实例全表轮询 + 内存游标初值 0** → 每次重启/滚动发布从 `seq=0` 重放整张 outbox；DB 压力随实例数线性放大 | `apps/api/src/sse/sse.poller.ts:11-25` |
| 8 | 🟠 P1 | **错误处理偷懒**：非白名单状态码（409/413/422/503）全折叠成 `INTERNAL_ERROR`；413 靠 `message.includes('file too large')` 字符串匹配 | `apps/api/src/common/filters/*` |
| 9 | 🟠 P1 | **`processTask` 全量吞异常** → BullMQ 重试/退避/failed 事件/失败队列/Bull Board 可观测性整体放弃，`onFailed` 形同虚设；自研重试一旦有 bug，任务静默卡在 PENDING/QUEUED | `apps/worker/src/index.ts:45-54` |
| 10 | 🟠 P1 | **定时器 env 数值无校验**：`Number(x ?? 默认)` → `NaN` → `setInterval(fn, NaN)` ≈ 0ms 忙轮询全表 `deleteMany`。对比 concurrency 做了 `Number.isFinite` 校验，说明知道要校验却未贯彻 | `apps/worker/src/index.ts` |
| 11 | 🟠 P1 | **7 处各自 `new Redis`**，无统一连接管理（api 5 处 + worker 2 处） | 见 §3.8.8 |
| 12 | 🟠 P1 | **隐式 imports 顺序契约**：限流守卫依赖认证守卫先写入 `req.user`，顺序由 `app.module.ts:28` 数组顺序决定，无注释无测试保护 | `apps/api/src/app.module.ts:28` |
| 13 | 🟡 P2 | **`/metrics` 是 `@Public()` 无鉴权**，暴露任务量与队列积压 | `apps/api/src/app.controller.ts` |
| 14 | 🟡 P2 | 无 OpenAPI/Swagger、无 helmet、无 `traceId`/`requestId` | 全仓 |
| 15 | 🟡 P2 | Dockerfile `COPY --from=builder /app /app` 全量拷贝（带进 web/admin 源码与全部 devDeps）+ 硬编码代理 `127.0.0.1:10808` + 无 `HEALTHCHECK` + root 运行 | `apps/{api,worker}/Dockerfile` |
| 16 | 🟡 P2 | worker `index.ts` 370 行巨型 main；`import http` / `import { metricsRegistry }` 写在**文件底部**（322-323 行）；`outboxQueue` 定义在 `void main()` 之后侥幸靠顺序；health server 无 `'error'` 监听（端口占用即崩进程） | `apps/worker/src/index.ts` |
| 17 | 🟡 P2 | 模块定义塞进 controller 文件：4 个域（script/credit/timeline/project-agent）**无独立 `*.module.ts`**，与其余域规范自相矛盾 | `apps/api/src/app.module.ts:18-23` |

**综合判断**：aiVideo 的形态很典型——**核心难点（AI 长任务可靠执行）被认真解决了，工程基础设施（配置、优雅关闭、SSE 正确性、容器化、接口契约）停留在「能跑就行」**。SVH 应继承前者设计、把后者当反面清单逐条规避。**其中 #1/#2 两个 SSE 缺陷与 #3/#5 这组基础设施缺失，直接决定上线后的稳定性与安全基线。**

---

## 6. 对 SVH 新架构的启示

### 6.1 应当继承的设计（10 条）

**① 「领域层重试」而非「队列层重试」**
BullMQ `attempts` 恒为 1，重试完全由领域层控制，退避时间写进 Outbox 事件的 `availableAt`。这样重试才能与状态回写原子提交、才能在重试前切换模型。这是 `packages/queue` + `apps/worker` 联手给出的最重要经验。

**② 「能力参数定义」作为单一真源**
`CapabilityParameterDef[]`（`key/label/type/required/default/min/max/options/unit`）同时驱动：Zod 校验、参数合并默认值、键白名单过滤、前端表单渲染。**一份声明，四处复用**，杜绝了前后端参数漂移。

**③ 「端口/适配器」隔离所有外部依赖**
- AI 能力：`ProviderAdapter` + `SecretResolver`（`packages/ai` 不依赖 Prisma、不依赖 HTTP）
- Agent 与 LLM：`LLMChatPort`（`agent-core` 不依赖 `packages/ai`）
- 存储：`ObjectStorage` 具体类（略弱，见 §6.2）

**④ 快照固化 + 版本号**
任务提交即冻结 `modelSnapshot`（含 `schemaVersion: 2`、`baseUrl`、`providerName`），Provider 配置漂移不影响历史任务，也让 fallback 重建有依据。

**⑤ 状态机白名单作为代码**
`TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]>`（27 行）让「新增状态忘补转移规则」成为编译错误。**注意要真正接进执行路径**，否则只是文档（aiVideo 就没接）。

**⑥ 幂等三件套**
`@@unique([userId, idempotencyKey])`（DB 层）+ `task-{taskId}-attempt-{n}` 确定性 JobId（队列层）+ `updateMany where { taskId: null }` CAS 闸门（并发层）。三层叠加才能同时防「用户重复点击」「Outbox 重放」「多 Worker 竞争」。

**⑦ 「弱默认值黑名单」的配置校验**
不只检查空值，还显式拒绝 `minioadmin` / `dev-jwt-secret-change-me` 这类 dev 默认值；一次性收集全部问题再抛错。**这是最容易在生产环境出事、也最容易预防的一类问题**。

**⑧ 密钥脱敏**
`sanitizeProviderError` 用 8 条正则（含 lookbehind 排除复合形态）清理 Provider 原始错误中的 `Bearer`/`api_key`/`token`/`secret`/`password`。**任何把第三方错误入库的系统都必须有**。

**⑨ 租约 + Fencing + 执行尝试审计 + 对账回收**
`Task` 上的 `leaseUntil` / `leaseVersion` / `workerId` / `heartbeatAt` 四件套，配合「所有终态写入必须带 `leaseVersion` + `workerId` 的 CAS」的 Fencing 规则，解决了「失去租约的旧 Worker 继续写状态」这一分布式经典问题；`TaskAttempt` 表按 `@@unique([taskId, attempt])` 记录每次执行的模型、耗时、错误、token，是**成本归因与失败分析的数据基础**；两个 reconciler（task / workflow）周期扫描租约过期与「有 step 无 task」的悬挂状态，兜住进程崩溃。**这是 aiVideo 最值得整体继承的一块**（建议抽为独立的 task-runtime 模块，连告警一起搬）。

**⑩ 默认拒绝的鉴权 + 短时 scope 令牌**
`APP_GUARD AuthGuard` 全局生效 + `@Public()` 显式放行（**默认拒绝，白名单开放**）的模型比「逐个路由加保护」安全得多；配套的 **SSE 90s 短时 scope 令牌**（`scope='SSE'`，限定只能访问 stream 路径）优雅解决了 EventSource 无法携带 Header 的经典问题。二者语义都应继承（实现改为 Fastify hook + `@fastify/jwt`）。

### 6.2 应当规避的坑（16 条）

**① 不要做双格式（ESM+CJS）构建**
aiVideo 每个包都用 tsup 出 `esm + cjs`，package.json 写成 `main: dist/index.cjs` + `module: dist/index.js` + `types: dist/index.d.ts`。后果：
- **`types` 只指向 ESM 的 `.d.ts`**，CJS 消费方拿到的是 ESM 风格声明（应为 `.d.cts`）；
- **字段声明不一致**：`ai`/`queue`/`shared`/`database` 用 `main: dist/index.cjs`，而 `workflow` 用 `main: dist/index.js`、`agent-core` **完全没有 `exports` 字段且 `main` 指向 ESM 产物**；
- `agent-core` 因此变成「事实上的 ESM-only 包」，被 CJS 的 NestJS `apps/api` 引用时依赖 Node 的 `require(esm)` 支持——在 Node 20.19 以下（或 Node 20.0~20.18）**直接报 `ERR_REQUIRE_ESM`**。审计中在 Node v24 上实测可加载，属**版本依赖的隐性脆弱**，不是设计正确。
- **SVH 已有 `"type": "module"` + `NodeNext` + `.js` 后缀导入，应坚持纯 ESM**：`exports` 只给 `import` + `types`，构建产物只出 ESM（或干脆用 `tsc` 出 `.js`）。这一条能省掉大量互操作调试时间。

**② 不要让 DAG 引擎静默吞错**
`packages/workflow` 两处最外层 `catch {}`（`advance.ts:279`、`advance.ts:366`）会把 DB 故障、代码 bug 全部伪装成「本轮无进展」。SVH 必须：至少写结构化日志 + 落一条 `WORKFLOW_ADVANCE_FAILED` 事件 + 暴露计数器指标；并区分「可重试的瞬时故障」与「不可重试的定义错误」。

**③ 不要留死代码与重复实现**
`packages/workflow/src/state.ts` 整文件零引用、与 `advance.ts` 逻辑重复。审计与维护成本高于它的价值。SVH 应把「DAG 校验 + 分层 + 就绪计算」收敛为**一份**不依赖 DB 的纯函数核心。

**④ 不要让同一语义在三处重复定义**
`TaskStatus`/`TaskType`/`Capability` 在 Prisma schema、`packages/shared`、以及文档注释中各有一份，**无编译期一致性校验**。SVH 应让 Prisma 生成的类型成为唯一真源，`shared` 只做 re-export，并加类型级断言（`Expect<Equal<A, B>>`）。

**⑤ 不要用「HTTP 200 + `{code,data,message}`」包打天下**
`ApiResponse<T>` 会让 SSE、流式响应、RESTful 语义三者无法统一。SVH 应明确：错误用 HTTP 状态码 + `{ error: { code, message, details } }`，成功直接返回资源；SSE 用独立的事件协议。**这一条需 SVH 主动决策，不宜盲目继承。**

**⑥ 不要让 Task 表变成上帝表**
35+ 列（状态 + 租约 + 成本 + 进度 + 路由 + 工作流关联 + 幂等键）挤在一张表。SVH 建议拆 `TaskLease`（`leaseUntil`/`leaseVersion`/`workerId`/`heartbeatAt`）与 `TaskBilling`（`costCurrency`/`costAmount`）。

**⑦ 不要把「预留字段/预留包」当资产**
`packages/auth`、`packages/ui` 是 2 行空壳；`ProviderType = 'CUSTOM'` 无实现；`WorkflowNodeType` 的 `AGENT`/`HUMAN_INPUT` 被推进器完全忽略；`CAPABILITY` 里 4 个能力无适配器。**「占位包 + app 内真实实现」的双轨结构尤其有害**（认证最终跑到了 `apps/api/src/auth`，`packages/auth` 永远空着）。SVH 应「需要时再建包」，或建包即落实现。

**⑧ 不要用 `.slice(0, 5)` 这类魔法数字传数据**
`upstreamOutputIds(...).slice(0, 5)` 静默截断前驱产物，无配置无日志。SVH 应配置化并记录截断事件。

**⑨ 不要让 adapter 每请求重建**
`AiGateway` 每次 `generate`/`chat` 都 `factory.create(...)`，无缓存。高频调用下有可观的分配与 TLS 握手开销。SVH 应加 adapter 缓存（key = `providerId + baseUrl`）。

**⑩ 不要省略 lint**
aiVideo 全仓无 ESLint、无 Prettier、无 lint 脚本，`noUncheckedIndexedAccess` 被显式关闭，代码中大量 `!` 与 `as unknown as`。SVH 已有 eslint 9 + `noUncheckedIndexedAccess: true`，**这是对 aiVideo 的实质性改进，必须守住**——它会在迁移 aiVideo 代码时暴露大量潜在的越界访问（例如 `advance.ts` 中的 `queue.shift()!`、`adjacency.get(edge.from)!`）。

**⑪ 不要在没有 env schema 的情况下启动服务**
aiVideo 全仓无 env 加载机制、无 schema 校验、无类型导出、dev 静默回落硬编码默认值，并因此产生了一处**真实的安全漏洞**（JWT 默认值两处不一致致校验失效）。SVH 必须：用 Zod 定义 EnvSchema 并在**任何模块被 import 之前** `parse`（fail-fast）；导出 `type Env = z.infer<typeof EnvSchema>`；**禁止散落 `process.env.X ?? '默认值'`**（这正是 aiVideo 出事的根因）。

**⑫ 不要把「实时推送」建在轮询 + 内存游标上**
aiVideo 的 SSE 用「每实例独立轮询 outbox + 进程内 cursor」实现多实例广播，导致：重启从 `seq=0` 全表重放、DB 压力随实例数线性放大、`Last-Event-ID` replay 路径存在**两个 P0 缺陷**（replay 后不订阅导致推送永久静默；跨用户事件泄漏）。SVH 应：**用 Redis Pub/Sub（或 Streams）做实例间扇出**，DB/outbox 只作为「可重放的历史」，且 **replay 与 subscribe 必须在同一临界区内完成**（先订阅、再 replay，或 replay 后无条件继续订阅），**SQL 层就必须按 userId 过滤**而不是拿到 JS 里过滤。

**⑬ 不要省略进程优雅关闭**
API 侧完全没有 shutdown hooks、worker 侧 `worker.close()` 无宽限期、Dockerfile 让 pnpm 作 PID 1。SVH 必须三件套齐全：`process.on('SIGTERM'/'SIGINT')` → 停止接收新请求 → 等待在途任务（带超时）→ 依次关闭 BullMQ Worker/Queue、SSE 连接、Prisma、Redis → `exit(0)`；容器 `CMD` 用 `exec` 形式让应用进程直接作 PID 1。

**⑭ 不要让长任务饿死短任务**
单队列 `ai_tasks` 混跑所有类型 + 全局 `concurrency` 一刀切，数分钟级的 RENDER/VIDEO 会占满槽位。SVH 应按「资源池」拆队列（如 `ai.llm` / `ai.image` / `ai.video` / `ai.render`），各自独立 concurrency 与限流；跨队列的长任务要有优先级或抢占策略。

**⑮ 不要把模块定义塞进 controller、把 import 写到文件底部**
aiVideo 有 4 个域没有独立 `*.module.ts`（从 controller 文件导出 Module），两个 app 的 `index.ts` 都是 370~1451 行的巨型 main，worker 的 `import` 甚至写在文件底部靠执行顺序侥幸生效。SVH 的 Fastify 侧应对应建立「一个域一个 plugin 文件」的硬约定，入口只做装配。

**⑯ 不要让 CI 跳过类型检查与测试**
aiVideo 因各包 `scripts` 不一致（2 个包无 `typecheck`、2 个包无 `test`），导致 `packages/database`/`packages/shared` 的类型从未被检查、`packages/agent-core` 的测试从未执行，CI 只能逐个 `exec vitest run` 硬编码。SVH 必须**每个包都具备 `build`/`typecheck`/`test`/`lint` 四个 script**，让 `turbo run typecheck test lint` 一次覆盖全仓，CI 里不出现任何逐包硬编码。

### 6.3 对 SVH 模块划分的建议

基于本次审计，建议 SVH 的包边界如下（★ 为本次审计得出的新增/调整建议）：

```text
packages/
├── shared/        常量、状态机、加解密、配置校验（对齐 aiVideo shared，去掉 api.ts 争议项）
├── database/      Prisma Schema + getPrisma() 单例 + 领域助手
├── domain/        ★ SVH 已有：纯领域类型与规则（不依赖 Prisma/HTTP）
├── ai/            AI Gateway + Provider Adapter（OpenAI / Anthropic / Gemini 三适配器）
├── agent/         ★ 新增：Structured Output 运行时 + Tool Calling + Agent 注册表 + 多步循环
├── workflow/      DAG 纯函数核心（零 DB 依赖） + 服务层推进器（事务/幂等）
├── queue/         BullMQ 封装（+ 进度上报 + 优雅关闭 + TLS）
├── outbox/        事务性发件箱（+ handler 注册表 + 未注册 kind 拒绝 SENT）
└── storage/       对象存储（S3 协议；接口化以便将来支持本地后端）
apps/
├── api/           Fastify + Zod + SSE
├── worker/        BullMQ 消费者 + Recovery 对账
└── web/           React + Vite
```

**与 aiVideo 的关键差异**：`agent` 包必须显著重于 `agent-core`（工具调用、循环编排、Agent 注册表、上下文装配、token 预算），这是 SVH 作为「AI Content **Agent** 平台」与 aiVideo 作为「AI 图片/短视频生成平台」的本质分野——**aiVideo 在这方面几乎没有可复用资产**。

---

## 7. 参考代码路径索引

### 7.1 最高优先级（建议逐一精读）

| 文件 | 行数 | 为什么值得读 |
| --- | --- | --- |
| `packages/ai/src/providers/types.ts` | 126 | 端口/适配器契约的范例：`ProviderAdapter`、`SecretResolver`、`ModelBrief` 如何做到零 DB 依赖 |
| `packages/ai/src/error.ts` | 68 | 错误码体系 + 重试判定 + **`sanitizeProviderError` 脱敏**（8 条正则含 lookbehind） |
| `packages/ai/src/gateway.ts` | 87 | 门面模式：能力校验 → 适配器路由 → 装配 → 调用。**同时是反例**（`providerType` 未参与路由、adapter 无缓存） |
| `packages/ai/src/composer.ts` | 77 | `pickAllowedKeys` 键白名单（安全边界）、参数合并与类型转换 |
| `packages/ai/src/task-compiler.ts` | 93 | `compileTaskRequest` 单点编译 + `ModelSnapshot`（`schemaVersion` 版本化） |
| `packages/ai/src/providers/openai-compatible/adapter.ts` | 286 | 完整适配器实现：HTTP 错误映射、`AbortSignal.any` 超时+取消合并、**SSE 流式 delta 解析**（text/reasoning 双通道归一化） |
| `packages/ai/src/providers/openai-compatible/composer.ts` | 138 | `IMAGE_CAPABILITY_DEFS`/`VIDEO_CAPABILITY_DEFS`：能力参数字典作为单一真源 |
| `packages/agent-core/src/schema.ts` | 20 | **20 行浓缩 OpenAI strict json_schema 的两个非显然坑**（顶层 `$ref` 必须展开；可选字段必须 `type:[T,null]` 且纳入 required） |
| `packages/agent-core/src/runtime.ts` | 118 | `parseStructured`（剥围栏 → JSON.parse → Zod safeParse）+ `LLMChatPort` 端口设计 |
| `packages/agent-core/src/agents/creative.agent.ts` | 96 | 两段式编排的最小可用示例（同时也是需要被超越的基线） |
| `packages/workflow/src/advance.ts` | 369 | **幂等推进的核心**：就绪扫描 + 单事务批量建 Task + `taskId` CAS 闸门 + `idempotencyKey`；**也是「静默吞错」的反面教材（279/366 行）** |
| `packages/workflow/src/types.ts` | 116 | `WorkflowDefinition` 结构 + `validateDefinition` + `computeLayers`（Kahn） |
| `packages/queue/src/queue.ts` | 75 | **75 行的正确队列设计**：`attempts: 1`、payload 只放 id、确定性 jobId、指数退避 + jitter |
| `packages/queue/src/worker.ts` | 33 | Worker 生命周期包装与 `concurrency` 默认值 |
| `packages/shared/src/task-state.ts` | 27 | 状态机白名单（`Record<TaskStatus, TaskStatus[]>`） |
| `packages/shared/src/crypto.ts` | 39 | AES-256-GCM 正确实现（随机 IV、sha256 派生密钥、认证标签） |
| `packages/shared/src/config.ts` | 59 | **生产配置断言**：弱默认值黑名单 + 全量收集报错 |
| `packages/database/src/index.ts` | 81 | globalThis Prisma 单例 + 枚举/类型集中再导出（收口 `@prisma/client` 依赖） |
| `packages/database/src/credits.ts` | 36 | `updateMany({ where: { credits: { gte: amount } }, data: { decrement } })` 原子预留，防超卖 |
| `packages/database/src/user-credential.ts` | 38 | BYOK 凭据读取与解密 + `maskKey` |
| `packages/database/prisma/schema.prisma` | 925 | 建模约定参考：`@@map` snake_case、组合索引「过滤列+排序列」、软删除、快照固化、租约 + `leaseVersion` Fencing、`Decimal` 金额 |

### 7.2 高优先级（模式参考，需重写）

| 文件 | 行数 | 参考点 |
| --- | --- | --- |
| `apps/worker/src/task-executor.ts` | ~1500 | `handleFailure` 的重试/降级决策树（`isRetryable` → `maxAttempts` → `resolveNextRoute` → 单事务重试 → 终态）；`resolveNextRoute`（560 行）模型容灾切换 |
| `apps/worker/src/task/retry-transaction.ts` | 97 | **重试事务契约**：CAS `PROCESSING→PENDING`（带 `status+leaseVersion+workerId` Fencing）+ 原子写 `TASK_FAILED`/`TASK_QUEUED` 两事件 |
| `apps/worker/src/task/task-lease-guard.ts` | 61 | 租约守卫：所有写入必须带 `leaseVersion`，防失去租约的旧 Worker 续写 |
| `apps/worker/src/task/lease-heartbeat.ts` | 66 | 租约心跳续期 |
| `apps/worker/src/recovery/task-reconciler.ts` | 183 | 崩溃回收：租约过期 → CAS 回 `PENDING` → 重新产生 `TASK_QUEUED` 事件（`attempt+1`，jobId 递增） |
| `apps/worker/src/recovery/workflow-reconciler.ts` | 123 | 工作流对账四种情形的处理（含「step RUNNING 但无 taskId」→ `kickoffReadySteps`） |
| `apps/api/src/common/model-router.service.ts` | 97 | Model Router：`resolveRoutes`（主模型 + 静默剔除失效 fallback）+ `selectLLM`（按 quality 偏好） |
| `apps/api/src/project-agent/project-agent.service.ts` | — | `chatPort(userId)`（261 行）：把 `LLMChatPort` 适配到 `AiGateway.chat` 的接线示例 |
| `apps/api/src/auth/*` + `apps/api/src/common/guards/auth.guard.ts` | 374 | JWT + jti 黑名单吊销 + **SSE 90s 短时令牌**（`scope='SSE'`，守卫校验路径含 sse/stream）——设计可借鉴，实现须用 Fastify 重写 |
| `apps/api/src/sse/*` | — | SSE 实时推送机制（多实例广播/心跳/鉴权） |
| `packages/outbox/src/*` | 295 | 事务性发件箱：`writeInTx` 同事务写入、`dispatchNow` 立即投递、`claimOutboxEvents` 用 `FOR UPDATE SKIP LOCKED` + 60s CLAIM 超时回退、退避阶梯 `[1s,2s,5s,10s,30s,60s,120s,300s]` cap 5min、`attempts>=10 → DEAD` |
| `packages/storage/src/*` | 258 | **presign 的两个非显然坑**：① 双 `S3Client`（`presignClient` 用 `publicEndpoint` 构造，否则 MinIO 校验 host header 失败 403）；② `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'`（否则 presign 附加 `x-amz-checksum-mode` 导致 403） |
| `packages/media/src/*` | 324 | 「纯函数核心 + IO 外壳」分层；`magic.ts` 用 magic bytes 识别图片类型（不信任 Content-Type，含 escapeXml 防 SVG 注入） |
| `apps/api/src/sse/sse.controller.ts` | — | **一面双面镜**：42-45 行的跨用户泄漏与 46-66 行的「replay 后不订阅不关流」是本报告最严重的两个 P0 缺陷，**必读的反面教材**；同时 30s 心跳 + `req.on('close')` 清理 + `?token=` 短时令牌鉴权是正面实现 |
| `apps/api/src/sse/sse.poller.ts` | — | `outbox → Last-Event-ID 游标 → SSE` 的完整链路；`resolveUserId()` 的 5 级 fallback（taskId/assetId/creativeId/workflowRunId 反查）暴露了「事件不带 userId」的设计债；`private cursor = 0` 的进程内游标是反面教材 |
| `apps/api/src/main.ts` + `app.module.ts` | 28 + — | ⚠️ **反面清单**：无 shutdown hooks、21 个模块挤在一行 imports、限流依赖认证的隐式顺序契约 |
| `apps/api/src/common/auth.constants.ts` | — | ⚠️ JWT 默认值与 `shared/config.ts` 不一致致生产校验失效的确切位置（安全漏洞样本） |
| `apps/api/src/common/guards/auth.guard.ts` + `apps/api/src/auth/*` | 73 + 301 | 默认拒绝 + `@Public()`/`@Roles()`/`@CurrentUser()` + jti 黑名单吊销 + SSE 短时令牌的完整实现（**语义可继承，代码须重写**） |
| `apps/api/src/rate-limit/*` | — | 分层限流：路由级 `@RateLimit` + 全局兜底；写 fail-closed(503) / 读 fail-open；限额从 `system:config` 热读 + 60s 缓存 |
| `apps/worker/src/index.ts` | 370 | ✅ 297-313 行的优雅关闭顺序（`clearInterval` → health server → worker → queue → storage → prisma → exit）**可直接照搬**；⚠️ 45-54 行 `processTask` 全量吞异常、322-323 行 import 写文件底部是反面教材 |
| `apps/{api,worker}/Dockerfile` | — | ⚠️ 反面清单：全量 `COPY --from=builder /app /app`、硬编码构建代理 `127.0.0.1:10808`、`CMD pnpm` 作 PID 1、无 `HEALTHCHECK`、root 运行 |

### 7.3 文档资产（本次审计的隐性收获）

`docs/` 下 16 篇设计文档共 2347 行，**质量高于代码实现本身**，建议 SVH 在动手前通读：

| 文档 | 行数 | 内容 |
| --- | --- | --- |
| `docs/ai-gateway-design.md` | 241 | AI Gateway 分层架构图、接口抽象、路由规则（含设计演进：`resolveApiKey(providerId)` → `(providerId, userId)` 以支持 BYOK） |
| `docs/database-design.md` | 512 | 完整数据模型设计 |
| `docs/api-design.md` | 298 | API 契约设计 |
| `docs/domain-model.md` | 286 | 领域模型 |
| `docs/queue-design.md` | 147 | 队列设计（含「为何 attempts=1」的论证） |
| `docs/v2-phase3.md` | 153 | Workflow DAG 的 `definition` 约定 |
| `docs/task-createflow.md` | 77 | 任务创建流程 |
| `docs/v2-1-p1-security.md` | 49 | 安全加固清单（Provider 错误脱敏等问题的来源） |
| `docs/v2-phase1/2/4.md` | 284 | 各阶段设计决策与踩坑记录 |

### 7.4 工程配置参考

| 文件 | 参考点 |
| --- | --- |
| `turbo.json` | `build.dependsOn: ["^build"]`、`typecheck.dependsOn: ["^build"]`、`dev.persistent + cache:false` |
| `tsconfig.base.json` | ES2022 + strict + `declaration`/`declarationMap`/`sourceMap`（**注意**：`noUncheckedIndexedAccess: false`、`strictPropertyInitialization: false` 是 SVH 不应继承的放宽项） |
| `.github/workflows/ci.yml` | 三段式 CI：`typecheck` → 分包 `vitest run` → `build` → e2e（含 `docker compose` 起 Postgres/Redis/MinIO + `prisma migrate deploy` + 种子注入） |
| `docker-compose.dev.yml` | Postgres 16 / Redis 7 / MinIO，**每个服务都配了 healthcheck**，可直接复用 |
| `tools/mock-provider.mjs` | 本地 mock AI Provider，便于无 Key 开发 |
| `tools/seed-dev-db.sql` | Provider/Model/Capability/用户的种子数据 |

**⚠️ CI 的两个实际漏洞**（SVH 应避免）：
1. `packages/database` 与 `packages/shared` **没有 `typecheck` script**，因此 `turbo run typecheck` 会跳过它们——**这两个包的类型从未在 CI 中被检查**；
2. CI 的 vitest 列表漏掉了 `packages/agent-core`（以及 `apps/api` 的单元测试，只跑了 e2e）——**agent-core 的 139 行测试在 CI 中永不执行**。根因是各包 `scripts` 不一致（`ai`/`queue` 甚至没有 `test` script），CI 只能用 `pnpm --filter X exec vitest run` 逐个硬编码绕过。**SVH 应统一每个包的 `test`/`typecheck`/`lint` script，让 `turbo run test` 一次跑全**。

---

## 附：审计方法与可信度声明

### 已实测验证（非推测）

- `agent-core` 的 CJS 互操作：在 Node v24 上 `require('@aivideo/agent-core')` 成功，据此判定其为「事实 ESM-only、依赖 Node `require(esm)` 支持」；
- `packages/workflow/src/state.ts` 三个导出（`stepState`/`readySteps`/`isRunTerminal`）**零引用**——逐符号 grep 全仓（含测试）验证；
- `packages/auth`、`packages/ui` 为空壳（2 行）——读取文件内容确认，且验证 `dist/` 不存在、全仓零引用；
- **全仓无 ESLint/Prettier**——配置文件、`package.json` 依赖、`scripts` 三个方向交叉检查；
- 各包构建工具与产物：逐一读取 9 个 `tsup.config.ts` + 列出各包 `dist/` 文件名，确认 esm+cjs 双格式与 `main`/`module`/`exports` 字段不一致；
- `apps/api` 是 NestJS 而非 Fastify：`package.json` 依赖层面确认无 fastify、有 `@nestjs/platform-express`；
- 全仓无 env 加载机制：grep `dotenv` / `--env-file` / `loadEnvFile` 零命中；
- worker 优雅关闭存在、API 侧不存在：grep `enableShutdownHooks` / `onApplicationShutdown` / `beforeApplicationShutdown` 分别验证；
- 跨 app 零引用、packages 不反向依赖 apps：grep 验证。

### 未实测（已在报告中标注为「静态阅读结论」）

- `apps/api` 与 `apps/worker` 的**运行时行为**——本次为静态代码阅读，**未启动服务、未发起请求、未复现 SSE 缺陷**。§3.8.7 的两个 P0 SSE 缺陷与 §5.5 的其余条目均为**代码原文推断**，置信度高（逻辑缺陷是确定的），但建议 SVH 在决策前用 30 分钟做一次最小复现验证；
- `packages/outbox` 的并发 claim 在真实高并发下的表现（仅阅读实现，未压测 `FOR UPDATE SKIP LOCKED` 路径）；
- 现有 e2e 测试是否真实通过（未执行测试套件）。

### 阅读量控制

未读取 `node_modules`、`dist`（**仅列出文件名**以确认构建产物格式）、`.turbo`、测试快照；`apps/api` 的业务路由仅读工程组织相关文件（入口、模块装配、守卫、过滤器、SSE），**未逐行阅读业务实现**。

### 结论可信度

- 报告中的**每一处「缺陷」判断均基于代码原文**并给出文件路径，未作无依据推测；
- 涉及设计意图的解释均引用了源码注释或 `docs/` 设计文档；
- 对「空壳 / 死代码 / 未使用」类结论，均经过**全仓交叉引用验证**，而非仅凭导出符号推断；
- 对无法直接验证的部分（如运行时行为），已在文中显式标注。
