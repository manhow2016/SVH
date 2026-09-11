# dramai 架构审计报告 —— 面向 SVH（AI Content Agent 平台）的可借鉴资产

| 项目 | 值 |
| --- | --- |
| 审计对象 | `/home/yesheng/projects/dramai` v0.4.1（Apache-2.0，开源无后端 AI 短剧工作台） |
| 审计目标 | 为 SVH（Fastify + PostgreSQL + BullMQ 的 AI Content Agent 平台）提炼**设计经验与可搬迁逻辑** |
| 审计日期 | 2026-05 |
| 审计结论摘要 | dramai 的价值**不在代码复用**，而在三处资产：**分镜 JSON 契约 + Prompt 模板**、**AsyncGenerator 事件流式流水线范式**、**Provider/ApiFlavor 多协议适配层**。其无后端架构留下的坑（无重试、无并发、无审计、无版本）恰好是 SVH 必须解决的问题 |

---

## 1. 审计范围与方法

### 1.1 范围

| 纳入 | 排除 |
| --- | --- |
| `src/core/**`（prompts / pipeline / llm / image / video / storage / composition / export / parsers） | `node_modules/`、`dist/` |
| `src/types/domain.ts` | `docs/**` 长篇多语言文档（仅定向读取 `ARCHITECTURE.md` 第 41–125 行） |
| `src/store/**`、`src/router.tsx`、`src/styles/globals.css` | `CHANGELOG.md`、`package-lock.json`、测试快照 |
| `src/components/**`、`src/pages/**`（UI 层，由子审计员覆盖） | `src/i18n/locales/*.json` 全量词条 |
| `package.json`、`vite.config.ts`、`tsconfig.app.json`、`.github/workflows/*` | |

代码库总量约 **7.5k 行 TS/TSX/CSS**（`find src -type f | xargs wc -l`），属于可全量精读的规模，因此本次审计采取了**「core 层逐文件精读 + UI 层定向精读」**的策略，未做抽样。

### 1.2 方法

1. `find`/`wc -l` 建立文件规模热力图，锁定 15 个高价值文件（占全库约 60% 行数）。
2. `grep` 定位横切关注点：`json_schema|json_object|response_format`、`retry|concurren|Promise.all`、`generations`、`camera|rewrite`、`version|history`，用于验证「文档声称实现」与「代码实际实现」的差距。
3. 精读 `src/core/**` 全部文件（约 2.3k 行），逐条摘录 Prompt 模板与协议适配代码。
4. UI 组件层（约 2.0k 行）交由独立子审计员并行精读，产出第 8 节。

### 1.3 证据约定

报告中所有代码摘录均标注 `文件:行号`。**未读到的内容不做推断**；凡属推断均显式标注「（推断）」。

---

## 2. dramai 项目全景

### 2.1 定位与技术栈

> 一句话：把一段文字 / 一个文档 / 一张图，在**纯浏览器内**变成「结构化分镜 → 分镜图 → 视频片段 → 拼接成片 → 导出剪映草稿」的全流程工具。**没有任何后端**，API Key 由用户自填，请求从浏览器直连各家 OpenAI 兼容服务。

| 维度 | 选型 | 版本 | 备注 |
| --- | --- | --- | --- |
| 框架 | React | ^19.2.5 | 函数组件 + Hooks |
| 构建 | Vite | ^8.0.10 | `@vitejs/plugin-react` |
| 语言 | TypeScript | ~6.0.2 | `strict: true` + `erasableSyntaxOnly` |
| 样式 | Tailwind CSS | ^4.2.4 | **CSS-first，无 `tailwind.config.js`**，用 `@theme` 定义 token |
| 状态 | Zustand | ^5.0.12 | **仅 1 个 store**（`settings.ts`，88 行），带 `persist` |
| 持久化 | Dexie（IndexedDB） | ^4.4.2 | 6 张表；`dexie-react-hooks` 做响应式查询 |
| 路由 | react-router-dom | ^7.14.2 | `createBrowserRouter` + `basename` |
| i18n | i18next + react-i18next | ^26 / ^17 | 仅 `en` / `zh-CN` |
| 图标 | lucide-react | ^1.14.0 | 统一图标库 |
| 样式工具 | clsx + tailwind-merge + CVA | — | 经典 shadcn 风格组合 |
| 媒体处理 | @ffmpeg/ffmpeg + @ffmpeg/util | ^0.12 | **ffmpeg.wasm 浏览器内转码拼接** |
| 压缩/解析 | jszip、mammoth | — | 剪映草稿 ZIP、docx 解析 |

**关键观察**：依赖列表里**没有任何 UI 组件库**（无 Ant Design / MUI / Radix / Headless UI）。`src/components/ui/` 是自建的极简组件层（`modal.tsx` 84 行、`card.tsx` 44 行、`badge.tsx` 27 行、`button-variants.ts` 28 行）——**UI 组件总量不到 200 行**，说明 dramai 把复杂度压在了业务层，而非组件抽象层。

### 2.2 目录结构

```
src/
├── types/domain.ts            ★ 单一域模型文件（158 行）—— 全部实体类型
├── core/                      ★ 与 UI 完全解耦的业务内核（无 React 依赖）
│   ├── prompts/
│   │   ├── storyboard.ts      ★ 分镜拆解 Prompt 构建器（135 行）
│   │   └── style-presets.ts   ★ 20 个风格预设（194 行）
│   ├── pipeline/              ★ 三段式流水线（AsyncGenerator 事件流）
│   │   ├── storyboard.ts        素材 → LLM 流式 → JSON 解析 → 落库（186 行）
│   │   ├── image-shot.ts        单分镜 → 文生图（含角色参考图注入，124 行）
│   │   └── video-shot.ts        单分镜 → 图生视频（提交/轮询/下载，218 行）
│   ├── llm/                   OpenAI 兼容 chat 客户端 + SSE 解析 + 连接测试
│   ├── image/                 文生图（OpenAI Images / Gemini 双协议）
│   ├── video/                 图生视频（OpenAI-compat / Aliyun / Volcengine / Kling 四协议）
│   ├── storage/               Dexie schema + 各实体 CRUD（含级联删除）
│   ├── composition/           ffmpeg.wasm 拼接 + SRT/VTT 字幕 + TTS
│   ├── export/                JSON 备份/恢复 + 剪映草稿 ZIP
│   └── parsers/               docx / txt / md / image 解析与体积校验
├── components/                UI 层（storyboard / character / composition / settings / upload / ui / layout）
├── pages/                     6 个页面（Home / Projects / ProjectDetail / Characters / Settings / About）
├── store/settings.ts          ★ 唯一 Zustand store：Provider 配置 + 激活映射
├── router.tsx                 createBrowserRouter（6 路由）
└── styles/globals.css         ★ Tailwind v4 @theme Design Token（65 行）
```

### 2.3 核心模块关系

```
                    ┌──────────────────────────────┐
                    │  types/domain.ts（唯一真源）  │
                    │  Project/Character/Material/ │
                    │  Storyboard/Asset/Generation │
                    │  Provider/ApiFlavor          │
                    └───────────┬──────────────────┘
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ core/prompts │   │ core/storage │   │store/settings│
   │ Prompt 构建  │   │ Dexie CRUD   │   │ Provider 配置│
   └──────┬───────┘   └──────▲───────┘   └──────┬───────┘
          │                  │                  │
          ▼                  │                  │
   ┌─────────────────────────┴──────────────────┴───────┐
   │              core/pipeline（AsyncGenerator）        │
   │  generateStoryboards → generateShotImage            │
   │                      → generateShotVideo            │
   └───────┬──────────────────────┬──────────────────────┘
           ▼                      ▼
   ┌──────────────┐      ┌──────────────────────────┐
   │  core/llm    │      │ core/image │ core/video   │
   │  streamChat  │      │  factory 按 apiFlavor 分发│
   └──────────────┘      └──────────────────────────┘
           │                      │
           └──────────┬───────────┘
                      ▼
          ┌────────────────────────┐
          │  React UI（for await   │
          │  消费事件流显示进度）   │
          └────────────────────────┘
```

**这张图的三个要点**（对 SVH 最重要）：

1. **`core/` 完全无 React 依赖**——pipeline 模块导出的是 `AsyncGenerator`，不是 hook。同一份逻辑可以被 React 组件 `for await` 消费，也可以被 CLI / Worker 消费。SVH 的 BullMQ Worker 可以**几乎原样搬迁这个模式**（把 `for await` 换成 `job.updateProgress()`）。
2. **`types/domain.ts` 是唯一真源**——文件头注释明确写道：*"这些类型同时被 Zustand store、Dexie schema、AI 客户端协议共享。任何字段变更都意味着一次 IndexedDB 迁移"*（`src/types/domain.ts:1-7`）。这种「一个文件定义全部实体」的做法在 7.5k 行规模下极其高效。
3. **两份 `factory.ts` 是同构的**——`core/image/factory.ts`（20 行）与 `core/video/factory.ts`（24 行）都是「读 `provider.apiFlavor` → switch → 返回对应协议的 client」。这是 dramai 应对「多家模型协议不统一」的核心解耦手段。

---

## 3. 领域数据模型摘录与分析

全部类型定义集中在 **`src/types/domain.ts`（158 行，单个文件）**。以下按实体摘录关键部分。

### 3.1 Provider（模型服务商配置）

```ts
// src/types/domain.ts:9-44
export type ProviderKind = 'llm' | 'text2image' | 'image2video' | 'imageEdit'

/** 协议风格 —— 决定用哪套 HTTP 协议说话，与「厂商」解耦 */
export type ApiFlavor =
  | 'openai-compatible'
  | 'gemini'      // /v1beta/models/{model}:generateContent
  | 'volcengine'  // 火山方舟：异步任务 + 轮询
  | 'aliyun'      // 阿里 DashScope：异步任务 + 轮询
  | 'kling'       // Kling 原生 image2video
  | 'runway'

export interface Provider {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  notes?: string
  /** 默认 'openai-compatible'。仅 image2video provider 上影响行为。 */
  apiFlavor?: ApiFlavor
  /** 仅在测试连接成功后写入。 */
  lastVerifiedAt?: number
}

export type ActiveProviderMap = Partial<Record<ProviderKind, string>>
```

**分析（值得借鉴）**：`ProviderKind`（能力）× `ApiFlavor`（协议）的**二维正交设计**是本文件最有价值的建模决策。dramai 没有为「DeepSeek」「302」「火山方舟」各建一个类型，而是用「能力槽位 + 协议风格」两个维度组合。`ActiveProviderMap = Partial<Record<ProviderKind, string>>` 让「每个能力槽位各选一个激活 Provider」变成一行类型。

**局限**：
- `apiKey` 明文存在 `localStorage`（`zustand/persist`），注释坦承 *"API Key 存在 localStorage（默认）或导出为加密 JSON（v0.3+）"*（`docs/ARCHITECTURE.md:115`）——实际导出的仍是明文。
- `notes` / `lastVerifiedAt` 是「运维元数据塞进业务实体」的味道，SVH 应拆到独立的 provider_health 表。

### 3.2 Project + Character（项目与角色卡）

```ts
// src/types/domain.ts:46-71
export type ProjectStatus = 'draft' | 'storyboarding' | 'generating' | 'done'

export interface Project {
  id: string
  title: string
  summary?: string
  style?: string          // ← 自由文本，靠 matchStylePreset 反查预设
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

export type CharacterRole = 'protagonist' | 'supporting' | 'extra'

export interface Character {
  id: string
  projectId: string
  name: string
  description?: string
  role: CharacterRole
  /** 关联到 assets 表里的参考图。 */
  referenceAssetId?: string
  /** 当为 true 时，分镜里出场会直接使用 referenceAssetId 作为图生图源图。 */
  locked: boolean
  createdAt: number
}
```

**分析（值得借鉴 —— 角色一致性的数据建模精华）**：`Character` 只有 8 个字段，但 `referenceAssetId` + `locked` 这两个字段撑起了整个「角色一致性」能力：

- `referenceAssetId` 指向 `assets` 表的参考图（**资产外键，不内联 Blob**）——一张参考图可被多个分镜复用。
- `locked: boolean` 是**语义开关**：`true` = 该角色形象已锁定，生成分镜图时必须带参考图做图生图；`false` = 允许模型自由发挥。UI 上的勾选框直接映射这个字段（`CharacterEditDialog`）。

这是一个**极简但正确**的一致性方案：不引入 embedding、不引入 LoRA、不做人脸识别，只用「一张参考图 + 一个布尔锁」就把「同一个角色在不同分镜里长得一样」这个需求落地了。SVH 若做角色/主体一致性，**这个二元结构（参考资产引用 + 锁定语义）值得直接继承**，再在其上叠加 SVH 后端才能做的事（多角度参考图组、角色版本历史、参考图特征向量）。

**缺陷**：`Character.locked` 与 `referenceAssetId` **没有约束关系**——`locked: true` 但 `referenceAssetId` 为空是合法状态，此时 `collectReferenceImages` 会静默跳过该角色（`src/core/pipeline/image-shot.ts:114` 的 `c.locked && c.referenceAssetId`）。SVH 应在 DB 层加 `CHECK (NOT locked OR reference_asset_id IS NOT NULL)`。

### 3.3 Storyboard（分镜 / 镜头）—— 最核心的实体

```ts
// src/types/domain.ts:87-131
export type CameraMovement =
  | 'static' | 'pan_left' | 'pan_right' | 'tilt_up' | 'tilt_down'
  | 'zoom_in' | 'zoom_out' | 'orbit_left' | 'orbit_right'
  | 'dolly_in' | 'dolly_out'

export type CameraSpeed = 'slow' | 'normal' | 'fast'

export interface CameraParams {
  movement: CameraMovement
  speed?: CameraSpeed
}

export interface Storyboard {
  id: string
  projectId: string
  sequence: number          // 1-based 序号
  sceneText: string         // 中文画面描述
  narration?: string        // 旁白
  imagePrompt?: string      // 英文文生图 prompt
  characterIds: string[]    // 出场角色 id 列表
  durationSec?: number
  imageAssetId?: string     // ↓ 生成结果用「外键」而非内联
  videoAssetId?: string
  cameraParams?: CameraParams
  /** 异步视频任务句柄，用于刷新页面后恢复轮询。任务结束后清空。 */
  pendingVideoTask?: {
    taskId: string
    apiFlavor: ApiFlavor
    submittedAt: number
  }
  status: 'pending' | 'image-ready' | 'video-ready' | 'failed'
}
```

**分析（强值得借鉴）**——这个 13 字段的 interface 是 dramai 最有价值的数据结构，有四个设计决策值得 SVH 直接继承：

1. **「文本描述」与「图像 prompt」分离**：`sceneText`（中文、给人看、写"看到什么"）与 `imagePrompt`（英文、给模型看、逗号分隔关键词）是**两个独立字段**，不是一个字段两种用途。这让「人改画面描述」与「调图像 prompt」互不干扰，也让 `sceneText` 可以安全地作为旁白/字幕/剪辑依据。
2. **`characterIds: string[]` 而非内联角色数据**：分镜只存角色 id 数组，角色详情去 `characters` 表查。这让「改角色描述后所有分镜自动生效」。注意与 LLM 输出的对齐关系——LLM 吐的是 `character_names: string[]`（中文名），落库时通过 `nameToId` Map 转成 id，**匹配不上的名字静默丢弃**（`src/core/storage/storyboards.ts:15-18`）。这是一个「LLM 幻觉防御」的最小实现。
3. **`pendingVideoTask` —— 断点续跑的持久化句柄**：这是**无后端架构逼出来的、但后端架构同样需要**的设计。视频生成是异步任务（提交后要轮询数分钟），若只把 taskId 放在 React state 里，用户刷新页面就丢失了正在跑的任务。dramai 把 `{taskId, apiFlavor, submittedAt}` 写进 IndexedDB，注释明说 *"用于刷新页面后恢复轮询"*。**SVH 用 BullMQ 时，这个字段的等价物就是 `jobs` 表 + `job_id` 外键**——但设计意图（任务句柄必须持久化，不能只存在于内存）是直接可搬迁的经验。
4. **`status` 是粗粒度状态机**：只有 4 个值 `pending | image-ready | video-ready | failed`，**不区分「正在生成」**。这是一个明显缺陷（见 4.4），因为「生成中」是瞬时状态，dramai 把它放在组件 state 而非实体里，导致刷新后无法区分「还没开始」和「正在跑」。

**缺陷**：
- `sequence: number` 做排序，但**没有唯一约束**，重新生成时靠「先全删再全插」保证不重复（`clearProjectStoryboards`）。
- `status` 单向推进，`failed` 后无法标记「重试中」。
- **没有 `updatedAt` 字段**——分镜是会被频繁编辑的实体，缺这个字段导致无法做增量同步（对 SVH 尤其致命，后端需要它做乐观并发控制）。

### 3.4 Material（素材）与 Asset（资产）

```ts
// src/types/domain.ts:73-85, 133-145
export type MaterialKind = 'doc' | 'txt' | 'md' | 'image'

export interface Material {
  id: string
  projectId: string
  kind: MaterialKind
  name: string
  /** 解析后的文本内容（image 类型为空字符串）。 */
  text: string
  /** 关联到 assets 表的原始文件。 */
  assetId?: string
  createdAt: number
}

export type AssetKind = 'image' | 'video' | 'doc'

export interface Asset {
  id: string
  projectId: string
  kind: AssetKind
  mimeType: string
  blob: Blob            // ← 二进制直接进 IndexedDB
  width?: number
  height?: number
  createdAt: number
}
```

**分析（部分借鉴 —— 结构对，实现错）**：

- **`Material` / `Asset` 的二分是正确的**：`Asset` = 「原始字节 + MIME + 尺寸」（与业务无关的二进制容器），`Material` = 「解析后的文本 + 指向原始文件的 assetId」（业务语义层）。同一张图既是 `Asset(kind=image)`，又可以是 `Material(kind=image, text='')`。SVH 的 Content / Asset 模型应保留这个分层。
- **`Asset` 内联 `Blob` 是 dramai 最大的架构妥协**——它把二进制塞进 IndexedDB。这在浏览器里是唯一选择，但对 SVH 完全不适用：SVH 的 `Asset` 必须是「对象存储 key + mime + size + hash + 宽高 + 时长」的**元数据记录**，字节走 S3/MinIO，DB 只存指针。这一点必须明确**不要照抄**。
- `Asset` 缺少 `size`、`hash`、`duration`（视频时长）字段。dramai 靠 `blob.size` 现算，靠 `Storyboard.durationSec` 记录视频时长——SVH 应在 Asset 上补齐这些字段以支持去重与配额。

### 3.5 Generation（生成审计记录）—— **定义了但从未使用**

```ts
// src/types/domain.ts:147-158
export interface Generation {
  id: string
  projectId: string
  stageName: 'rewrite' | 'storyboard' | 'image' | 'camera' | 'video'
  status: 'pending' | 'running' | 'success' | 'failed'
  input: unknown
  output?: unknown
  error?: string
  retry: number
  createdAt: number
  finishedAt?: number
}
```

**这是一个极其重要的发现——`generations` 表是死代码**。`grep -rn "generations.add|generations.put|db.generations.update" src` **无任何结果**；该表只在 `db.ts`（schema 声明）、`projects.ts`（删项目时级联删除）、`export/json.ts`（备份/恢复）三处被引用，**从未被写入过一条记录**。

也就是说：dramai **设计了一个完整的生成审计模型**（stageName 五阶段 + status 四态 + input/output 快照 + `retry` 计数 + 起止时间戳），代表了作者对「AI 生成必须可追溯」的正确直觉，但**在无后端架构下没有动力也没有能力去落地它**——浏览器里没人查询历史生成记录，失败了用户直接再点一次按钮。

**对 SVH 的启示（高价值）**：这个 interface 几乎就是 SVH `generations` 表的字段清单草案，尤其三点：
1. **`input` / `output` 存完整快照**（`unknown` 类型，实际是 JSON）——这解决了「三天后用户问为什么这次生成的图不一样」的问题：Prompt、模型、参数全在快照里。
2. **`retry: number` 而非 `retryCount` 的语义**——它是「这是第几次尝试」，天然支持「同一逻辑步骤的多次尝试」归组。
3. **`stageName` 是字符串枚举而非外键**——简单，但 SVH 若要做「按 pipeline 阶段统计成本/失败率」，应把它规范化为 `pipeline_stage` 表或至少加 CHECK 约束。

SVH 应当**把这个表真正写起来**，并补充 dramai 缺失的字段：`provider_id`（成本归属）、`model`、`token_usage` / `cost`、`latency_ms`、`idempotency_key`。

### 3.6 数据模型小结与对 SVH 的建模建议

| dramai 决策 | 评价 | SVH 应如何做 |
| --- | --- | --- |
| 单一 `domain.ts` 定义全部实体 | ✅ 值得借鉴 | 7.5k 行规模下极高效；SVH 可用 `packages/shared/src/domain/` 按实体拆文件但保持单一导出入口 |
| `ProviderKind` × `ApiFlavor` 二维正交 | ✅ 值得借鉴 | 直接继承，并在 DB 层用 CHECK 约束合法组合 |
| `Character` 的「参考图 + locked 布尔」一致性方案 | ✅ 值得借鉴 | 继承二元结构，扩展为参考图组 + 角色版本 |
| `Storyboard` 的 sceneText / imagePrompt 分离 | ✅ 强值得借鉴 | 直接继承，并可扩展 `videoPrompt` 第三个字段 |
| 生成结果用 `*AssetId` 外键而非内联 | ✅ 值得借鉴 | 继承为 `image_asset_id UUID REFERENCES assets(id)` |
| `pendingVideoTask` 持久化任务句柄 | ✅ 值得借鉴 | 换为 `job_id` 外键指向 BullMQ 任务记录表 |
| `Material` / `Asset` 二分 | ⚠️ 部分借鉴 | 保留分层，但 Asset 必须改为「对象存储指针 + 元数据」 |
| `Asset.blob` 内联二进制 | ❌ 不适用 | SVH 必须走对象存储，DB 只存 key/hash/size |
| `Storyboard.status` 无「生成中」态 | ❌ 应避免 | SVH 状态机需含 `queued / running / succeeded / failed / cancelled` |
| 实体缺 `updatedAt` | ❌ 应避免 | SVH 所有可变实体加 `updated_at` + 乐观锁 `version` |
| `Generation` 表定义了却不写入 | ❌ 应避免 | SVH 必须落地生成审计，并补齐 provider/model/cost/latency |

---

## 4. 创作流水线机制分析

### 4.1 编排方式：**硬编码的三段式，不是可配置 DAG**

`src/core/pipeline/` 下只有三个文件，每个文件导出一个 `AsyncGenerator`：

| 文件 | 导出函数 | 职责 |
| --- | --- | --- |
| `storyboard.ts` | `generateStoryboards(input): AsyncGenerator<StoryboardEvent>` | 素材 → LLM 流式 → 解析 JSON → 落库 |
| `image-shot.ts` | `generateShotImage(opts): AsyncGenerator<ShotImageEvent>` | 单分镜 → 文生图 → 落库 → 回写 assetId |
| `video-shot.ts` | `generateShotVideo(opts): AsyncGenerator<VideoShotEvent>` | 单分镜 → 图生视频 → 轮询 → 下载 → 落库 |

**结论：没有任何 DAG、没有步骤注册表、没有依赖声明、没有可配置性**。三个阶段是三个独立函数，「storyboard 之后做 image，image 之后做 video」这个顺序**只存在于 UI 按钮的排列顺序里**（`ProjectDetail.tsx` 依次渲染 `StoryboardGenerator` → `BatchImageButton` → `BatchVideoButton`）。

`docs/ARCHITECTURE.md:77-92` 声称存在六阶段流水线 `parse → rewrite → storyboard → image → camera → video`，并配了输入/输出表格。但**实际上 `rewrite` 与 `camera` 两个阶段从未实现**：

```
$ grep -rni "rewrite" src --include=*.ts --include=*.tsx
src/types/domain.ts:150:  stageName: 'rewrite' | 'storyboard' | 'image' | 'camera' | 'video'

$ grep -rn "camera|Camera" src/core --include=*.ts   # 排除 video-shot.ts
（仅命中 video/* 客户端里把 cameraInstruction 拼进 prompt 的代码，无生成运镜的 LLM 调用）
```

- `rewrite`（把素材改写成故事文案）——**只有类型定义，无实现**。素材直接被塞进分镜 Prompt。
- `camera`（LLM 生成运镜参数）——**无 LLM 实现**，实际是 UI 上用户手动下拉选择 `CameraMovement`（`CameraMovementSelect.tsx`），再映射为英文短语拼接进视频 prompt。

这是本次审计发现的**文档与实现最大的背离**：架构文档描述的「责任链 Pipeline」实际上只有三个阶段，且被砍掉的两个阶段恰好是需要 LLM 智能的部分。

### 4.2 事件流契约：AsyncGenerator + Tagged Union（**最有价值的编排范式**）

虽然编排是硬编码的，但**每个阶段的「对外契约」设计得非常干净**，这是最值得 SVH 继承的部分。

```ts
// src/core/pipeline/storyboard.ts:8-14
export type StoryboardEvent =
  | { phase: 'starting' }
  | { phase: 'streaming'; accumulated: string }
  | { phase: 'parsing'; accumulated: string }
  | { phase: 'persisting'; shotCount: number }
  | { phase: 'done'; shotCount: number }
  | { phase: 'error'; message: string; raw?: string }
```

```ts
// src/core/pipeline/image-shot.ts:8-13
export interface ShotImageEvent {
  shotId: string
  phase: 'pending' | 'requesting' | 'persisting' | 'done' | 'error'
  message?: string
  imageAssetId?: string
}
```

```ts
// src/core/pipeline/video-shot.ts:7-12
export interface VideoShotEvent {
  shotId: string
  phase: 'submitting' | 'queued' | 'processing' | 'downloading' | 'persisting' | 'done' | 'error'
  message?: string
  progress?: number
}
```

**为什么这个范式值得搬到 SVH**：

1. **`phase` 是细粒度的过程状态**——`video-shot` 的 7 个 phase（`submitting → queued → processing → downloading → persisting → done`）精确对应了图生视频的真实生命周期。UI 可以直接把 phase 映射成进度文案，**不需要额外的状态机**。
2. **`AsyncGenerator` 天然支持背压与取消**：消费端 `for await` 循环里可以随时 `break`，`signal: AbortSignal` 贯穿所有网络调用。
3. **生成器是「可暂停的纯逻辑」**——它不依赖 React、不依赖 DB 之外的任何全局状态，只依赖入参 `opts`（provider + storyboard）。**SVH 的 BullMQ Worker 可以把这个生成器原样包一层**：

```ts
// SVH 的 BullMQ worker 可直接复用这个模式（示意）
for await (const ev of generateShotVideo({ provider, storyboard, signal })) {
  await job.updateProgress({ phase: ev.phase, progress: ev.progress })
  await redis.publish(`job:${job.id}`, JSON.stringify(ev))  // → WebSocket 推给前端
}
```

这是「无后端代码」与「有后端架构」之间**最平滑的一座桥**。

### 4.3 状态推进与持久化时机

以 `generateStoryboards` 为例（`src/core/pipeline/storyboard.ts:33-94`），完整的状态流转是：

```ts
// src/core/pipeline/storyboard.ts:46-83（精简）
let accumulated = ''
try {
  await updateProject(input.project.id, { status: 'storyboarding' })   // ① 先置状态

  for await (const chunk of streamChat(input.provider, {
    model: input.provider.model,
    messages,
    jsonMode: true,
    temperature: 0.7,
    signal: input.signal,
  })) {
    accumulated = chunk.accumulated
    yield { phase: 'streaming', accumulated }                          // ② 流式吐给 UI
  }

  yield { phase: 'parsing', accumulated }
  const shots = parseShots(accumulated)
  if (shots.length === 0) {
    yield { phase: 'error', message: 'LLM 没有产出可用的分镜（解析后为空）', raw: accumulated }
    await updateProject(input.project.id, { status: 'draft' })         // ③ 失败回滚状态
    return
  }

  yield { phase: 'persisting', shotCount: shots.length }
  await clearProjectStoryboards(input.project.id)                      // ④ 先清空旧分镜
  for (const draft of shots) {
    await appendStoryboardFromDraft(input.project.id, draft, input.characters)  // ⑤ 逐条插入
  }

  await updateProject(input.project.id, { status: 'storyboarding' })
  yield { phase: 'done', shotCount: shots.length }
} catch (err) {
  await updateProject(input.project.id, { status: 'draft' })           // ⑥ 异常也回滚
  yield { phase: 'error', message: msg, raw: accumulated || undefined }
}
```

**分析**：
- **状态先置后做**（①）——避免「正在跑但 UI 显示 draft」；失败时回滚（③⑥）。
- **全量替换而非增量合并**（④）——重新生成会**先删光该项目所有分镜及其关联图/视频 asset**。这是一个**破坏性设计缺陷**：用户手改了 8 个分镜的 prompt，只想重新生成剩下的 4 个，一点「重新生成」全部心血没了。SVH 必须改为「版本化 + 局部重生成」。
- **逐条串行插入**（⑤）——`for...of` + `await`，没有事务包裹。若第 5 条插入时崩溃，前 4 条已落库，产生半成品状态。SVH 应用单个 DB 事务 + `sequence` 唯一约束。

### 4.4 断点续跑：**只有视频阶段做了，且不完整**

`video-shot.ts` 的续跑设计（`src/core/pipeline/video-shot.ts:96-103`）：

```ts
// 把 task handle 持久化，方便刷新页面恢复
await updateStoryboard(shot.id, {
  pendingVideoTask: {
    taskId: handle.taskId,
    apiFlavor: handle.apiFlavor,
    submittedAt: Date.now(),
  },
})
```

任务结束（成功/失败/超时/取消）时清空该字段。**设计意图正确**：异步外部任务句柄必须落库。

**但实际不完整**：
- 注释说「用于刷新页面后恢复轮询」，但 `grep` 未发现任何**主动恢复**逻辑——没有在应用启动或页面加载时扫描 `pendingVideoTask` 并重启轮询的代码。字段被写入和清空，**但没有消费者**。刷新页面后任务句柄还在 DB 里，却没有任何代码去接管它。
- `submittedAt` 仅作记录，**没有用它做超时判定**（超时用的是本次运行内的 `deadline = Date.now() + timeoutSec*1000`，`video-shot.ts:106`）。
- 分镜级别没有「这一步成功了，下一步不用重做」的依赖检查——`image-shot` 无论如何都会重新调 API，即使 `imageAssetId` 已存在（由 UI 层的 `targets = shots.filter(s => s.imageAssetId && !s.videoAssetId)` 来间接规避，见 `BatchVideoButton.tsx:40`）。

**SVH 的启示**：状态机与幂等性**不能靠 UI 层的 filter 来兜底**，必须落在 Worker 里。BullMQ 的 `jobId` + 业务幂等键（`projectId + shotId + stage + attempt`）应替代 `pendingVideoTask` 的手工管理。

### 4.5 并发：**完全串行，无并发、无限流、无重试**

```ts
// src/components/storyboard/BatchVideoButton.tsx:54-88（批量生视频的核心循环）
let done = 0
let failed = 0
for (let i = 0; i < targets.length; i++) {          // ← 串行 for 循环
  if (abortRef.current.signal.aborted) break
  const shot = targets[i]
  setProgress({ total: targets.length, done, failed, current: shot.sequence, phase: 'submitting' })
  try {
    let lastError: string | undefined
    for await (const ev of generateShotVideo({ provider, storyboard: shot, signal: abortRef.current.signal })) {
      setProgress({ total: targets.length, done, failed, current: shot.sequence, phase: ev.phase })
      if (ev.phase === 'error') lastError = ev.message
    }
    if (lastError) failed++
    else done++
  } catch (err) {
    failed++
    if (err instanceof Error && err.name === 'AbortError') break
  }
}
```

横切验证结果：

```
$ grep -rn "retry|Retry|concurren|Promise.all|p-limit|semaphore" src
src/components/storyboard/BatchVideoButton.tsx  ← 无
src/core/composition/concat.ts:30   Promise.all  ← 只是并行加载 ffmpeg 与 util 模块
src/core/export/json.ts:125         Promise.all  ← 只是并行 clear 六张表
src/core/image/client.ts:38         Promise.all  ← 只是并行把参考图转 dataURL
src/types/domain.ts:155             retry: number ← Generation 的死字段
```

**结论：dramai 全库没有任何重试逻辑、没有并发控制、没有速率限制、没有指数退避。**

- 批量生成 12 个分镜 = **12 次串行 API 调用**，每次视频生成要轮询数分钟。README 自己承认 *"Step 6 · 批量生视频（10-20 分钟，最慢的一步）"*。
- 无重试：视频轮询超时（默认 600 秒）后直接 `yield { phase: 'error', message: '轮询超时' }`，任务句柄被清空，**用户只能手动重来，且会再次扣费**。
- 无并发：明明 `image-shot` 之间完全独立（各自的分镜、各自的参考图），却只能一个一个跑。
- 无速率限制：用户点「批量生图」会在短时间内连打 12 个请求，README 与代码注释多次提到因 CORS / 限流被扣冤枉钱（`PROVIDER_PRESETS.ts:16-19`、`volcengine-client.ts:76-84`）。

**这是 SVH 用 BullMQ 替代浏览器编排的最大理由**——把「串行 for 循环」换成「带并发度的队列 + 指数退避重试 + 死信队列」。

### 4.6 Pipeline 小结

| 维度 | dramai 实现 | 评价 | SVH 应如何做 |
| --- | --- | --- | --- |
| 编排 | 硬编码 3 个函数，顺序靠 UI 按钮排列 | ❌ 不适用 | BullMQ Flow / DAG，步骤显式声明依赖 |
| 文档 vs 实现 | 文档称 6 阶段，实现只有 3 个（`rewrite`/`camera` 未实现） | ⚠️ 警示 | 架构文档必须与代码同源或加验证 |
| 阶段对外契约 | `AsyncGenerator<PhaseEvent>` + Tagged Union | ✅ **强值得借鉴** | 直接继承，Worker 内 `for await` + `updateProgress` |
| 状态推进 | 先置状态 → 失败回滚 → 逐条落库 | ⚠️ 部分借鉴 | 保留「先置状态」思想，但落库必须事务化 |
| 重新生成 | 全量删除旧分镜 + 级联删图/视频 | ❌ 应避免 | 版本化，支持局部重生成与回滚 |
| 断点续跑 | 持久化 `pendingVideoTask`，但**无恢复消费者** | ⚠️ 部分借鉴 | 意图正确；SVH 用 job_id 外键 + Worker 自动恢复 |
| 并发 | 无（纯串行 for 循环） | ❌ 应避免 | 队列并发度 + 令牌桶限流 |
| 重试 | 无（`Generation.retry` 是死字段） | ❌ 应避免 | 指数退避 + 最大次数 + 死信队列 |
| 取消 | `AbortController` 贯穿全部网络调用 | ✅ 值得借鉴 | 继承；后端映射为 job cancel + provider 侧任务终止 |

---

## 5. Prompt 工程资产（重点章节）

dramai 的 Prompt 代码集中在两个文件：`src/core/prompts/storyboard.ts`（135 行）和 `src/core/prompts/style-presets.ts`（194 行）。**外加散落在 `video-shot.ts` 的运镜短语表**。三者合计不到 400 行，但构成了一个完整的 Prompt 工程体系。

### 5.1 分镜拆解 Prompt —— 完整模板（`src/core/prompts/storyboard.ts:32-58`）

这是 dramai 最核心的 Prompt 资产。以下为**逐字完整摘录**（保留 TS 模板字符串原貌，`\`` 为源码中转义的反引号）：

```ts
const BASE_SYSTEM_PROMPT = `你是一个**短剧 / 漫剧分镜师**——你的产出会驱动后续的文生图 / 图生视频管线。请把用户提供的故事素材和指令转化成一份**结构化分镜脚本**。

# 输出契约（**必须严格遵守**）
- 只输出 **一个 JSON 对象**；不要包含任何解释文字、不要 Markdown 代码围栏。
- JSON 顶层必须是 \`{"shots": [...]}\`，shots 为分镜数组。
- 每个分镜对象的字段：
  - \`sequence\` (number): 1 起的序号
  - \`scene_text\` (string): 中文，1-3 句完整画面描述
  - \`narration\` (string, 可省略): 中文旁白，简短一句
  - \`image_prompt\` (string, 可省略): 英文文生图提示词，描述视觉细节、风格、氛围
  - \`character_names\` (string[], 可省略): 出场角色的中文名（必须来自下方 \`已登记的角色\` 列表，否则会被忽略）
  - \`duration_sec\` (number, 可省略): 该镜头建议时长，整数秒，默认 5

# 风格判断（不要预设单一画风）
- **完全由用户决定**。短剧、漫剧、写实、动漫、水墨、CG、cyberpunk……都是合法选项。
- 判断顺序：
  1. 如果用户在「风格基调」里指定了具体风格 → 严格遵循。
  2. 如果用户没指定 → **从文字素材的气质里推断**（古风小说 → 古风、cyberpunk 设定 → 赛博朋克、儿童读物 → 童话/可爱、新闻稿 → 写实纪录片风等）。
  3. 整个项目的所有分镜风格保持**一致**——一个项目就一种风格，不要中途切换。
- \`image_prompt\` 里要明确写出风格关键词（如 \`anime style\`、\`photorealistic\`、\`ink wash painting\`、\`cyberpunk neon\` 等），由你根据上一条判断结果选择，不要遗漏。

# 构思要点
- 每个分镜要能**独立出图、独立成片**——不要依赖"前一镜的延续"，人物一致性后续靠参考图保证。
- \`scene_text\` 写"看到什么"，不是"发生什么"。
- \`image_prompt\` 用英文，逗号分隔关键词；描写构图（wide shot / close-up / over-the-shoulder）+ 光照 + 风格 + 服饰；**不要写中文人名**，用 \`a young swordsman in red robe\` 之类的英文描述代替。
- 推荐分镜数：6 个（除非用户指定）。
`
```

**技巧归纳（这一节是 SVH Prompt 工程的直接教材）**：

| # | 技巧 | 原文依据 | 为什么有效 |
| --- | --- | --- | --- |
| 1 | **角色定位前置** | 首句「你是一个**短剧/漫剧分镜师**——你的产出会驱动后续的文生图/图生视频管线」 | 不仅给身份，还**说明下游消费者是谁**，让模型理解「可执行性」重于「文学性」 |
| 2 | **输出契约独立成节并加粗「必须严格遵守」** | `# 输出契约（**必须严格遵守**）` | 把格式约束提到与内容约束同级，而非埋在末尾 |
| 3 | **字段级逐个声明类型 + 语言 + 长度 + 可省略性** | `- sequence (number): 1 起的序号` / `narration (string, 可省略): 中文旁白，简短一句` | 用「伪 JSON Schema 的自然语言版」实现结构化输出，**在 Prompt 层做类型约束** |
| 4 | **显式声明「不要 Markdown 代码围栏」** | 第 2 条 | 直接对治 LLM 最爱犯的格式错误（但仍有概率发生，故代码层还需 `stripCodeFence` 兜底——见 6.4） |
| 5 | **给出默认值** | `duration_sec ... 默认 5` / `推荐分镜数：6 个（除非用户指定）` | 减少模型在无约束维度的随机性 |
| 6 | **三级降级的风格判断顺序** | 「1. 用户指定 → 2. 从素材气质推断 → 3. 全项目一致」 | 把「未指定时怎么办」写成明确的决策树，而非留给模型自由发挥 |
| 7 | **用「反向示例 + 替代方案」纠偏** | `不要写中文人名，用 \`a young swordsman in red robe\` 之类的英文描述代替` | 不只说「不要什么」，还给出「应该怎样」，比单纯禁令有效得多 |
| 8 | **`scene_text` 的语义辨析** | `scene_text 写"看到什么"，不是"发生什么"` | 一句话解决「画面描述写成剧情流水账」这个图像生成领域的经典问题 |
| 9 | **「独立出图、独立成片」的架构级约束** | `每个分镜要能独立出图、独立成片——不要依赖"前一镜的延续"` | **把系统架构约束写进 Prompt**：因为分镜图是并行独立生成的，模型必须知道「不能依赖上下文」 |
| 10 | **显式说明一致性方案由外部保证** | `人物一致性后续靠参考图保证` | 主动告诉模型「这件事不用你操心」，避免模型在 prompt 里重复描述外貌，浪费 token 且干扰构图 |

### 5.2 风格注入：System Prompt 的动态拼装（`storyboard.ts:60-68`）

```ts
function buildSystemPrompt(stylePresetKeywords: string | null): string {
  if (!stylePresetKeywords) return BASE_SYSTEM_PROMPT
  return `${BASE_SYSTEM_PROMPT}
# 用户为本项目选定的视觉基底关键词
- 用户已经选了一个明确的风格预设。**每个 \`image_prompt\` 都应当包含下面这串关键词作为基底**，再结合分镜内容补充画面细节：
- \`${stylePresetKeywords}\`
- 项目内分镜风格保持一致，不要中途切换。
`
}
```

**技巧**：**追加而非替换**。风格预设不重写 System Prompt，只在末尾追加一节，并强调「每个 image_prompt 都应当包含这串关键词作为基底」。这样「基础契约」与「项目风格」解耦：风格可以随时换，输出契约始终稳定。

### 5.3 上下文装配：User Message 的四个区块（`storyboard.ts:70-134`）

```ts
function buildMaterialsBlock(materials: Material[]): string {
  if (materials.length === 0) return '（无文档素材，仅按用户指令创作）'
  return materials
    .filter((m) => m.kind !== 'image' && m.text.trim().length > 0)
    .map((m, idx) => {
      const tag = `《${m.name}》`
      const body = m.text.length > 4000 ? `${m.text.slice(0, 4000)}……(已截断)` : m.text
      return `### 素材${idx + 1} ${tag}\n${body}`
    })
    .join('\n\n')
}

function buildCharactersBlock(characters: Character[]): string {
  if (characters.length === 0)
    return '（暂无角色卡 —— 你可以自由命名出场人物，但请在 character_names 里写下你新建的角色名，便于后续拆分）'
  return characters
    .map((c) => {
      const role = c.role === 'protagonist' ? '主角' : c.role === 'supporting' ? '配角' : '群演'
      const desc = c.description ? ` · ${c.description}` : ''
      const lock = c.locked && c.referenceAssetId ? '（已绑定参考图）' : ''
      return `- **${c.name}**（${role}${lock}）${desc}`
    })
    .join('\n')
}

function buildImageMaterialsHint(materials: Material[]): string {
  const images = materials.filter((m) => m.kind === 'image')
  if (images.length === 0) return ''
  const list = images.map((m, idx) => `${idx + 1}. ${m.name}`).join('\n')
  return `\n\n## 用户提供的参考图\n${list}\n（这些图会作为视觉风格参考；请在 image_prompt 里融入相符的画风、配色、镜头语言。）`
}

export function buildStoryboardMessages(opts: BuildOptions) {
  const { project, materials, characters, userPrompt, targetShotCount } = opts
  const shotCount = Math.min(12, Math.max(3, targetShotCount ?? 6))

  const preset = matchStylePreset(project.style)
  const styleLine = preset
    ? `${project.style ?? preset.description}（已识别为预设：${preset.label}）`
    : (project.style ?? '（未指定，请按动漫通用风格自行判断）')

  const userBlock = `# 项目
- 标题：${project.title}
- 风格基调：${styleLine}
- 一句话简介：${project.summary ?? '（无）'}
- 期望分镜数：${shotCount}

# 已登记的角色
${buildCharactersBlock(characters)}

# 文字素材
${buildMaterialsBlock(materials)}${buildImageMaterialsHint(materials)}

# 用户本次指令
${userPrompt.trim() || '（用户未提供额外指令，按素材创作即可）'}

请按系统提示输出 \`{"shots": [...]}\` JSON。`

  return [
    { role: 'system' as const, content: buildSystemPrompt(preset?.imageKeywords ?? null) },
    { role: 'user' as const, content: userBlock },
  ]
}
```

**技巧归纳**：

| # | 技巧 | 说明 |
| --- | --- | --- |
| 11 | **User Message 用 Markdown 标题分区** | `# 项目` / `# 已登记的角色` / `# 文字素材` / `# 用户本次指令`——四个区块结构固定，模型易于定位 |
| 12 | **每个区块都有「空态兜底文案」** | 无素材 → `（无文档素材，仅按用户指令创作）`；无角色 → 不但说没有，还**指示模型「自由命名但请写进 character_names，便于后续拆分」**（把空态变成可利用的能力）；无用户指令 → `（用户未提供额外指令，按素材创作即可）` |
| 13 | **素材截断策略写在 Prompt 层** | 单个素材 > 4000 字符截断并追加 `……(已截断)`，**明确告知模型内容不完整**，避免模型基于残缺文本编造结局 |
| 14 | **素材带文件名标签** | `### 素材1 《文件名》`——让模型能引用来源 |
| 15 | **角色块携带「锁定状态」** | `**角色名**（主角）（已绑定参考图） · 描述`——**把「该角色有参考图」这个系统状态告知 LLM**，模型就知道不必在 image_prompt 里重复描述该角色外貌 |
| 16 | **参数在 Prompt 层做 clamp** | `Math.min(12, Math.max(3, targetShotCount ?? 6))`——分镜数硬性限制在 3–12，防止用户填 100 导致超长输出与成本爆炸 |
| 17 | **结尾重复输出契约** | 最后一行 `请按系统提示输出 \`{"shots": [...]}\` JSON.`——**首尾呼应**，对抗长上下文中的指令衰减 |
| 18 | **无角色时允许模型「创造」角色名** | 让首次生成即可用，用户之后再补角色卡（`nameToId` 匹配不上的会丢弃，但名字已存在 scene_text 中可供用户参考） |

### 5.4 角色一致性方案：**参考图锁 + Prompt 层「不描述」策略**

这是 dramai 处理 character consistency 的完整方案，由三部分协同：

**（1）数据层**：`Character.referenceAssetId` + `Character.locked`（见 3.2）。

**（2）Prompt 层——「不要描述外貌」**

```
- 每个分镜要能**独立出图、独立成片**——不要依赖"前一镜的延续"，人物一致性后续靠参考图保证。
- \`image_prompt\` 用英文...**不要写中文人名**，用 \`a young swordsman in red robe\` 之类的英文描述代替。
```

以及在角色块里标注 `（已绑定参考图）`。

**（3）推理层——注入参考图做图生图**

```ts
// src/core/pipeline/image-shot.ts:98-124（完整函数）
/**
 * 拉一个项目下"角色 → 参考图 Blob"的映射。
 * 返回的 Blob 可以作为图生图源图传给模型，保持角色一致性。
 *
 * 当前简化实现：把所有锁定且有参考图的角色 blob 都返回（最多 4 张），
 * 让客户端 reference_images 里都带上。后续可以根据 storyboard.characterIds
 * 精确筛选。
 */
export async function collectReferenceImages(
  projectId: string,
  characterIds: string[] | undefined,
  maxImages = 4,
): Promise<Blob[]> {
  if (!characterIds || characterIds.length === 0) return []
  const characters = await db.characters.where('id').anyOf(characterIds).toArray()
  const lockedWithRef = characters.filter(
    (c) => c.locked && c.referenceAssetId && c.projectId === projectId,
  )
  const slice = lockedWithRef.slice(0, maxImages)
  const blobs: Blob[] = []
  for (const c of slice) {
    if (!c.referenceAssetId) continue
    const asset = await db.assets.get(c.referenceAssetId)
    if (asset) blobs.push(asset.blob)
  }
  return blobs
}
```

**评价（部分借鉴，思路对但实现粗糙）**：

- ✅ **「参考图 + 图生图」是当前技术条件下最可靠的角色一致性手段**，比在 prompt 里堆砌外貌描述有效得多。dramai 在 Prompt 层主动「不描述外貌」，把一致性职责**单一化**给参考图，避免两套机制打架。
- ✅ **`maxImages = 4` 的限制**是务实的——多参考图会显著提升成本且部分模型不支持。
- ❌ **实现与注释矛盾**：注释说「后续可以根据 storyboard.characterIds 精确筛选」，但**代码已经接收了 `characterIds` 并做了 `anyOf` 查询**——只是最终仍把「所有 locked 且有参考图的角色」都返回了，`characterIds` 只起到「有没有传」的判断作用。**这是一个未完成的实现**：只要传了任意一个角色 id，就会把项目里所有锁定的角色参考图都塞进去，可能把不该出场的角色形象带进画面。
- ❌ **无参考图质量校验**：用户可以上传任意图片作为参考图，没有尺寸、人脸清晰度、主体占比的检查。
- ❌ **无多角度参考**：一个角色只能绑一张参考图，侧面/背面镜头容易崩。
- ❌ **`locked` 语义未在 Prompt 中传递给图像模型**：只传了图，没说明「这是角色 X 的参考图」，模型无法把图与 prompt 中的 `a young swordsman in red robe` 对应起来。**SVH 应该在多图输入时明确标注每张图的身份**（如 Gemini 的 part 顺序 + 文本说明，或 OpenAI 的 `image[]` 顺序约定）。

**SVH 的改进方向**：参考图组（正面/侧面/全身/表情）+ 每个角色独立的「一致性强度」参数 + 在 prompt 中显式标注参考图与角色的对应关系 + 生成后的一致性校验（人脸/CLIP 相似度打分，低于阈值自动重试）。

### 5.5 风格预设库：20 个预设 × 双语双字段（`style-presets.ts`）

预设的核心结构：

```ts
// src/core/prompts/style-presets.ts:14-19
export interface StylePreset {
  id: string
  label: string            // 中文短名，给用户看
  description: string      // 中文描述，写进 project.style
  imageKeywords: string    // 英文关键词串，注入 System Prompt
}
```

**关键设计：每条预设承担两个角色**——给用户看的中文 label/description，和给 LLM 看的英文 `imageKeywords`。原文注释（`style-presets.ts:7-9`）：

> 每条预设承担两个角色：
> 1) 给用户看的中文 label / description（写进 project.style）
> 2) 给 LLM 看的英文 imageKeywords（在 system prompt 里作为视觉基底关键词）

四个分组共 20 个预设（`style-presets.ts:178-183`）：

```ts
export const STYLE_PRESET_GROUPS: StylePresetGroup[] = [
  { label: '漫剧 / 动画', presets: ANIME },      // shonen / iyashikei / xianxia / school / kawaii
  { label: '写实短剧',   presets: REALISTIC },   // modern_drama / mystery_realistic / lyrical / documentary / vlog
  { label: '美术风格',   presets: ART_STYLE },   // ink_wash / oil_painting / cg_3d / pixel_art / low_poly
  { label: '特殊主题',   presets: THEMATIC },    // cyberpunk / steampunk / fairy_tale / horror / retro_80s
]
```

每个预设的 `imageKeywords` 都是**同一套五要素结构**。以「悬疑写实」为例：

```ts
// src/core/prompts/style-presets.ts:73-78
{
  id: 'mystery_realistic',
  label: '悬疑写实',
  description: '悬疑写实，冷色调，戏剧性阴影，电影感',
  imageKeywords:
    'cinematic photo, dark mystery thriller, cool color grading, low-key dramatic shadows, film grain',
},
```

拆解其要素构成（**这是图像 Prompt 拼接的规范模板**）：

| 要素 | 该预设取值 | 作用 |
| --- | --- | --- |
| 媒介/质感 | `cinematic photo` | 决定成像风格（照片 vs 插画 vs 3D） |
| 题材/类型 | `dark mystery thriller` | 决定内容倾向 |
| 色调/调色 | `cool color grading` | 决定色彩情绪 |
| 光照 | `low-key dramatic shadows` | 决定明暗结构 |
| 胶片/后期 | `film grain` | 决定质感细节 |

再看「古风仙侠漫」（`style-presets.ts:42-47`）填补了另一类要素（服饰、环境、美学传统）：

```ts
imageKeywords:
  'wuxia anime, ink wash painting style, flowing hanfu robes, misty mountains, traditional Chinese aesthetic',
```

**这套「媒介 + 题材 + 色调 + 光照 + 质感/美学」的五要素模板，是 SVH 图像 Prompt 拼接层应当直接继承的结构**。

**匹配机制（朴素但有隐患）**：

```ts
// src/core/prompts/style-presets.ts:187-194
/** 用 label 或 id 在 project.style 里粗略匹配一个 preset；未命中返回 undefined。 */
export function matchStylePreset(text?: string): StylePreset | undefined {
  if (!text) return undefined
  const t = text.trim()
  if (!t) return undefined
  const tLower = t.toLowerCase()
  return STYLE_PRESETS.find((p) => t.includes(p.label) || tLower.includes(p.id))
}
```

`Project.style` 是**自由文本**，靠 `substring` 反查预设。缺陷：用户手写「赛博朋克风格，霓虹」不会命中 `cyberpunk` 预设（因为 label 是 `Cyberpunk 赛博朋克`，需要完整子串），此时**风格关键词不会注入 System Prompt**，退化为「模型自行判断」。SVH 应把 `style_preset_id` 做成外键而非字符串匹配。

### 5.6 运镜 Prompt：枚举 → 英文短语的硬编码映射（`video-shot.ts:29-47`）

```ts
// src/core/pipeline/video-shot.ts:29-47
const CAMERA_PHRASES: Record<CameraMovement, string> = {
  static: 'static camera, locked-off framing',
  pan_left: 'slow camera pan to the left',
  pan_right: 'slow camera pan to the right',
  tilt_up: 'camera tilts upward',
  tilt_down: 'camera tilts downward',
  zoom_in: 'gentle zoom in',
  zoom_out: 'gentle zoom out',
  orbit_left: 'orbiting camera moves to the left around subject',
  orbit_right: 'orbiting camera moves to the right around subject',
  dolly_in: 'dolly push forward',
  dolly_out: 'dolly pull back',
}

function buildCameraInstruction(cam?: { movement: CameraMovement; speed?: CameraSpeed }): string {
  if (!cam || cam.movement === 'static') return 'static camera, no movement'
  const speedAdj = cam.speed === 'slow' ? 'very slowly, ' : cam.speed === 'fast' ? 'quickly, ' : ''
  return `${speedAdj}${CAMERA_PHRASES[cam.movement]}`
}
```

**技巧**：
- **枚举到自然语言的映射表**（`Record<CameraMovement, string>`）保证类型完备性——新增 `CameraMovement` 值时 TS 会强制补全短语。
- **`speed` 作为副词前缀拼接**（`very slowly, ` / `quickly, `），而非为每个速度×运动组合建 33 个条目。**组合优于枚举**，这是一个小巧但正确的 Prompt 组装技巧。
- `static` 走特判分支（`static camera, no movement`），比走映射表更明确。

### 5.7 图像/视频 Prompt 的实际拼接逻辑

**图像 Prompt 拼接（`image-shot.ts:35`）**：

```ts
const promptParts = [shot.imagePrompt?.trim(), shot.sceneText?.trim()].filter(Boolean).join('. ')
```

即：**英文 image_prompt（主）+ 中文 scene_text（兜底/补充）**，英文在前。注释解释了兜底意图——若 LLM 没给 `image_prompt`，至少还能用 `sceneText` 出一张图（`image-shot.ts:36-43` 会在两者都为空时报错）。

**视频 Prompt 拼接（`video-shot.ts:73` + 各 client）**：

```ts
// video-shot.ts:73
const promptParts = [shot.imagePrompt, shot.sceneText].filter(Boolean).join('. ')
// ...
// 各 client 内部（如 volcengine-client.ts:44-46）
const promptText = [req.prompt, req.cameraInstruction].filter((s): s is string => Boolean(s && s.trim())).join('. ')
```

即最终的视频 prompt = `imagePrompt . sceneText . cameraInstruction`。

**评价（可借鉴，但明显粗糙）**：
- ✅ **「主 prompt + 兜底 + 结构化附加维度」的三段式拼接**是正确方向，且每个 client 自行决定如何拼装（协议适配层负责 prompt 组装，pipeline 层只管传递结构化字段）。
- ✅ **风格关键词不在拼接层出现**——它们已经在 LLM 生成 `image_prompt` 时被要求写进去了（见 5.2）。**风格通过 LLM 内化，而非拼接时硬塞**，这是比「style 字符串 + 逗号 + prompt」更高级的做法，因为 LLM 会把风格自然地融入句子。
- ❌ **没有 negative prompt 的实际使用**：`T2IRequest.negativePrompt` 字段存在（`image/types.ts:14`）且会被发送（`image/client.ts:33`），但**没有任何调用方传入过它**（grep 无命中）。
- ❌ **没有镜头类型（景别）字段**：System Prompt 里要求模型在 image_prompt 里写 `wide shot / close-up / over-the-shoulder`，但**没有像 `cameraParams` 那样的结构化字段**。导致景别不可枚举、不可统计、不可在 UI 中批量调整。SVH 应把「景别」提升为与「运镜」平级的结构化字段。
- ❌ **`aspectRatio` 全链路未打通**：`video-shot.ts` 有 `opts.aspectRatio`，但默认 `undefined`，最终各 client 回落到 `'adaptive'`（volcengine）/ 不传（openai-compat）。竖屏短剧的核心参数竟然没有入口。

### 5.8 是否使用 Structured Output / JSON Schema？

**结论：没有。dramai 只用了最弱的 JSON 模式，靠 Prompt 约束 + 代码容错兜底。**

全库 grep 证据：

```
$ grep -rni "json_schema|response_format|json_object|jsonMode|structured" src
src/core/llm/types.ts:35   /** 强制 JSON 输出。OpenAI 协议字段名 response_format。 */
src/core/llm/types.ts:36   jsonMode?: boolean
src/core/llm/client.ts:35  if (request.jsonMode) body.response_format = { type: 'json_object' }
src/core/pipeline/storyboard.ts:53   jsonMode: true,
src/core/image/client.ts:35          body.response_format = 'b64_json'   ← 图像接口，非结构化输出
src/core/composition/tts.ts:32       response_format: req.format ?? 'mp3' ← TTS 音频格式
```

也就是说：**唯一的结构化输出手段是 `response_format: { type: 'json_object' }`**，仅保证「输出是合法 JSON」，**不保证 schema**。字段名、类型、必填性全部靠 5.1 的 Prompt 契约 + 6.4 的代码容错。

**对 SVH 的启示（高价值改进点）**：
- SVH 应使用 **`response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`**，把 `StoryboardDraft` 直接写成 JSON Schema（字段名、类型、enum、required 全部约束到协议层）。
- 收益：① 消除「模型编造字段名」的整类失败；② 消除 `stripCodeFence` / `matchOutermostBraces` 这类正则兜底；③ 可以把 `sequence` 约束为整数、`duration_sec` 约束为 3–15、`character_names` 约束为 enum（**直接把已登记角色名做成 enum，从根上消除角色名幻觉**）。
- 代价与缓解：并非所有 OpenAI 兼容服务都支持 `json_schema`，SVH 的 Provider 适配层应做**能力声明 + 降级**（支持则用 strict schema，不支持则回落 json_object + Prompt 契约 + 现有容错）。

### 5.9 Prompt 工程资产小结

| 资产 | 位置 | 价值 | SVH 处置 |
| --- | --- | --- | --- |
| 分镜拆解 System Prompt（完整 10 条技巧） | `prompts/storyboard.ts:32-58` | ★★★ 最高 | **逐字迁移**，改造为 JSON Schema 严格模式 + 增加景别字段 |
| 风格注入的「追加而非替换」模式 | `prompts/storyboard.ts:60-68` | ★★★ | 直接继承 |
| User Message 四区块装配 + 空态兜底 | `prompts/storyboard.ts:70-134` | ★★★ | 直接继承，区块可扩展（如加「前情提要」「禁用元素」） |
| 20 个风格预设（双语双字段 + 五要素结构） | `prompts/style-presets.ts` 全文 | ★★★ | 迁移并扩充到图像/视频/配音全链路 |
| 参考图锁 + Prompt 层「不描述外貌」策略 | `storyboard.ts:54-56` + `image-shot.ts:106` | ★★☆ | 继承思路，实现层重做（多参考图、身份标注、质量校验） |
| 运镜枚举→英文短语映射 + 速度副词组合 | `video-shot.ts:29-47` | ★★☆ | 直接继承并扩充（景别、镜头焦段、灯光） |
| Structured Output | **未使用**（仅 `json_object`） | — | **SVH 必须升级到 JSON Schema strict** |

---

## 6. 模型接入层分析

### 6.1 分层结构

```
pipeline（业务）
    │  只依赖 T2IRequest / I2VRequest 等「协议无关」的请求对象
    ▼
factory（分发）  ← 读 provider.apiFlavor
    │
    ├─ image/factory.ts  → openai-compat | gemini
    └─ video/factory.ts  → openai-compat | aliyun | volcengine | kling
    │
    ▼
client（协议实现）  每个文件一个协议，互不感知
    │
    ▼
fetch（直连用户填写的 baseUrl）
```

**核心解耦手段**：pipeline 层调用 `generateImage(opts.provider, {...})` 或 `createVideoClient(provider)`，**完全不感知底层是哪家协议**。请求/响应对象由 `image/types.ts` / `video/types.ts` 定义为「最小公约数」抽象。

### 6.2 协议无关的请求/响应抽象（值得借鉴）

```ts
// src/core/image/types.ts:1-39（节选，含原文注释）
/**
 * 文生图 / 图生图协议。
 *
 * 我们以 OpenAI Images API 为最小公约数（POST /v1/images/generations，
 * 返回 { data: [{ url? | b64_json? }] }），同时容忍以下扩展：
 *   - 部分聚合平台用 `image` / `image_url` / `reference_images` 字段
 *     传"参考图"以做图生图；它们都会被以 base64 dataURL 形式发出去。
 *   - 部分平台返回 `data[0].b64_json`，部分返回 `data[0].url`。
 */
export interface T2IRequest {
  model: string
  prompt: string
  negativePrompt?: string
  n?: number
  size?: string
  quality?: 'standard' | 'hd'
  referenceImages?: Blob[]
  signal?: AbortSignal
}
export interface T2IGeneratedImage { blob: Blob; mimeType: string; width?: number; height?: number }
export interface T2IResult { images: T2IGeneratedImage[]; raw?: unknown }
```

```ts
// src/core/video/types.ts:3-33 —— 异步任务的抽象（★ 最值得借鉴）
export interface I2VRequest {
  model: string
  prompt: string
  imageBlob: Blob          // 起始帧
  durationSec?: number
  aspectRatio?: string
  /** 让 client 把它翻译成各家协议自己的运镜字段。 */
  cameraInstruction?: string
  signal?: AbortSignal
}

export interface I2VTaskHandle { taskId: string; apiFlavor: ApiFlavor }

export type I2VStatus =
  | { kind: 'queued' }
  | { kind: 'processing'; progress?: number; message?: string }
  | { kind: 'succeeded'; videoUrl: string; durationSec?: number }
  | { kind: 'failed'; message: string }

export interface I2VClient {
  /** 提交一个图生视频任务，立刻返回 task handle。不在这里下载视频。 */
  submit(req: I2VRequest): Promise<I2VTaskHandle>
  /** 轮询任务状态。succeeded 时返回视频 URL，调用方负责下载。 */
  poll(handle: I2VTaskHandle, signal?: AbortSignal): Promise<I2VStatus>
}
```

**这组抽象的三个优点**：
1. **`submit` / `poll` 二分**精确映射了所有视频生成 API 的真实形态（全是异步任务制）。`submit` **不下载视频**——下载被留给调用方（pipeline 层），职责边界干净。
2. **`I2VStatus` 是 Tagged Union**，四态覆盖完整生命周期，`progress` 可选（有的厂商给，有的不给）。
3. **`cameraInstruction?: string` 是「已翻译好的自然语言」**，而非枚举——**协议适配层负责把统一抽象翻译成各家能懂的字段**。这样 OpenAI-compat 拼进 prompt、Kling 映射到 `camera_control`、Runway 映射到自己的字段，而 pipeline 层无需知道差异。

**缺陷**：`I2VTaskHandle` 只带 `taskId + apiFlavor`，**没有携带「恢复轮询所需的全部上下文」**（如 baseUrl、model）。若 provider 配置在任务运行期间被用户修改，「恢复轮询」就会打到错误的端点。SVH 应让任务句柄**自包含**（含 provider 快照）。

### 6.3 多 Provider 切换与「能力槽位」机制

`store/settings.ts` 是整个 Provider 体系的唯一状态源（88 行）：

```ts
// src/store/settings.ts:6-15, 82-88
interface SettingsState {
  providers: Provider[]
  activeProviderIds: ActiveProviderMap
  addProvider: (input: Omit<Provider, 'id'>) => Provider
  updateProvider: (id: string, patch: Partial<Omit<Provider, 'id'>>) => void
  removeProvider: (id: string) => void
  setActiveProvider: (kind: ProviderKind, id: string | undefined) => void
  resetAll: () => void
}

/** 取出某个 kind 当前激活的 provider；没有就 undefined。 */
export function useActiveProvider(kind: ProviderKind): Provider | undefined {
  return useSettingsStore((s) => {
    const id = s.activeProviderIds[kind]
    if (!id) return undefined
    return s.providers.find((p) => p.id === id)
  })
}
```

**设计要点**：
- **Provider 列表与激活映射分离**：用户可以配置 5 个 Provider，但每个能力槽位只用其中一个。切换模型 = 改一个 id，不动其他配置。
- **`addProvider` 自动激活空缺槽位**（`settings.ts:26-30`）：*"该 kind 下还没有激活项时，新建的自动激活"*——降低首次配置摩擦。
- **`removeProvider` 级联清理激活映射**（`settings.ts:46-51`）：防止悬空 id。
- **配置持久化在 `localStorage`**（key `dramai-settings`），**不与业务数据同库**——因为 Provider 是「应用级配置」而非「项目级数据」，导出备份时不应包含 API Key。

**评价（值得借鉴）**：这套「能力槽位 + 激活映射 + 自动激活 + 级联清理」的 CRUD 状态机只有 88 行，但完整覆盖了多 Provider 管理。**SVH 可以直接把这个状态机的语义搬到 PostgreSQL**：`providers` 表 + `active_providers` 表（或 `kind` 上的唯一部分索引 + `is_active` 布尔）。

**SVH 必须改进的地方**：`apiKey` 明文存 `localStorage` 且随 `persist` 中间件写入——任何 XSS 都能直接读取。SVH 后端架构下 API Key **必须服务端加密存储（KMS/密文列），永不回传前端**，前端只看到 `hasKey: boolean` 与掩码。

### 6.4 SSE 流式解析与 JSON 容错（★ 值得借鉴的两段实现）

**（1）手写 SSE 解析器**（`src/core/llm/sse.ts:1-97`，138 行）——不依赖任何 SDK，直接解析 `ReadableStream<Uint8Array>`：

```ts
// src/core/llm/sse.ts:19-72（精简，保留关键分支）
export async function* parseOpenAISseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let eventBoundary: number
      while ((eventBoundary = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, eventBoundary)
        buffer = buffer.slice(eventBoundary).replace(/^(\r?\n){1,2}/, '')
        const dataPayload = collectDataField(rawEvent)
        if (dataPayload === null) continue
        if (dataPayload === '[DONE]') return
        try { yield { data: JSON.parse(dataPayload) } } catch { /* 非 JSON，跳过 */ }
      }
    }
    // 残留 buffer 可能是最后一个未以空行结尾的事件
    const tail = buffer.trim()
    // ...
  } finally {
    // 消费者提前 break / abort 时也要主动取消，避免 underlying response body
    // 一直挂着不被 GC（Chromium 上会持续吃 socket 与内存）。
    try { await reader.cancel() } catch { /* already released or cancelled */ }
    reader.releaseLock()
  }
}
```

**值得借鉴的四个细节**：
1. **跨 chunk 边界的 buffer 累积**——`decoder.decode(value, { stream: true })` 保留多字节字符的半个码点，`buffer` 保留不完整的 SSE 事件。这是手写流式解析最容易出错的地方。
2. **`findEventBoundary` 同时处理 LF 与 CRLF**（`sse.ts:74-80`）。
3. **`finally` 里主动 `reader.cancel()`**——原文注释点明了真实动机：*"消费者提前 break / abort 时也要主动取消，避免 underlying response body 一直挂着不被 GC（Chromium 上会持续吃 socket 与内存）"*。**这是只有踩过坑的人才会写的代码**，SVH 若在前端做流式渲染应直接继承。
4. **`[DONE]` 终止 + 非法 JSON 静默跳过**——中转代理常在流里混入调试输出。

**（2）字段差异容忍**（`sse.ts:99-138`）：`extractContentDelta` 同时容忍 `choices[0].delta.content` 与 `choices[0].message.content`，且 `content` 可以是 string 或 `[{type:'text', text}]` 数组（multimodal 风格）——注释明说为了兼容 *"OpenAI 标准与一些常见兼容服务（Anthropic 风格、Gemini OpenAI-compat）的字段差异"*。

**（3）JSON 解析三级容错**（`src/core/pipeline/storyboard.ts:96-181`）：

```ts
/** 把 LLM 文本输出尝试解析成 StoryboardDraft 数组。容忍代码围栏与多余文本。 */
export function parseShots(raw: string): StoryboardDraft[] {
  const candidate = stripCodeFence(raw).trim()
  if (!candidate) return []
  const direct = tryParseShots(candidate)          // ① 直接 parse
  if (direct) return direct
  const objMatch = matchOutermostBraces(candidate) // ② 抽取首个 { ... } 大对象
  if (objMatch) {
    const parsed = tryParseShots(objMatch)
    if (parsed) return parsed
  }
  return []                                        // ③ 失败返回空数组，由调用方报错
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)   // 剥 ```json 围栏
  return fenced ? fenced[1] : text
}

function matchOutermostBraces(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {      // 手写括号配平，正确处理嵌套与字符串
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}
```

**字段级归一化同样宽容**（`storyboard.ts:129-160`）：`normalizeShot` 同时接受 `scene_text` 与 `sceneText`、`image_prompt` 与 `imagePrompt`；`sequence` 非数字则回落 `idx + 1`；`scene_text` 为空的条目**整条丢弃**（`if (!sceneText.trim()) return null`）。

**评价（值得借鉴，但在 SVH 中应作为「降级路径」而非主路径）**：
- ✅ 三级容错（剥围栏 → 直接 parse → 括号配平抽取）覆盖了 LLM 输出的绝大多数畸形情况。
- ✅ **「必填字段为空则丢弃该条，而非整批失败」**是重要的健壮性决策——12 个分镜里有 1 个畸形，不应该让另外 11 个白生成。
- ✅ **失败时把原始输出带回 UI**（`{ phase: 'error', raw: accumulated }`）——用户能看到模型到底吐了什么，这是极好的可调试性设计。
- ❌ 但这整套容错**本可以通过 JSON Schema strict 模式在源头消除**（见 5.8）。SVH 应「先 schema，schema 不支持再降级到这套容错」，而不是从头就靠容错。

### 6.5 错误处理与「CORS 扣费」的真实教训

dramai 在错误信息上做了**超出常规的投入**，源于真实的经济损失。`volcengine-client.ts:75-85`：

```ts
} catch (err) {
  // fetch 在 CORS 拦截或网络层失败时直接 throw TypeError "Failed to fetch"。
  // 重要：这种情况下请求**已经送达服务端**并触发任务（火山方舟会扣 token），
  // 只是浏览器拒收响应。务必告诉用户去后台看账单。
  if (err instanceof Error && err.name === 'AbortError') throw err
  const msg = err instanceof Error ? err.message : String(err)
  throw new Error(
    `${msg} · 可能是 CORS 拦截：请求大概率已送达 302 并扣 token，但浏览器拿不到响应。建议：(1) 切 base URL 到 https://api.302ai.cn 国内中转；(2) 去 302 后台对账，必要时申诉退款；(3) 暂停继续点击，避免再次扣费`,
    { cause: err },
  )
}
```

同类逻辑在 `aliyun-client.ts:92-99` 重复出现。`PROVIDER_PRESETS.ts:15-30` 的注释更是直言：

> **只保留经过端到端实测可用的组合**——未实测的预设不要放进来，否则用户会以为"预设 = 推荐 = 一定能用"，一次 CORS 或协议问题就会扣冤枉钱（曾经因为 Seedance .ai 域名 CORS 一次扣了 ~8 PTC，惨痛教训）。
>
> 加预设前请：(1) 真实跑过；(2) 价格用过；(3) base URL + apiFlavor + model id 都验证；(4) 写进 notes 里何时验证、价格档。

**这是本次审计中「最有价值的失败经验」**，对 SVH 的启示极为具体：

1. **「请求可能已扣费但客户端不知道」是 AI 生成类系统的本质风险**——网络层失败 ≠ 业务未执行。**SVH 的 BullMQ 必须把这类调用视为 at-least-once**，用**幂等键**（`idempotency_key`）传到 provider（若支持）或至少在 DB 记录「疑似已提交」状态，避免重试造成重复扣费。
2. **错误信息必须包含「用户下一步该做什么」**——上述错误给了三条具体行动（切域名 / 对账 / 暂停点击）。这正符合「错误信息要说明发生了什么、可能原因、下一步怎么办」的规范。
3. **Provider 预设必须带「验证时间 + 价格 + 已知坑」**——`ProviderPreset.notes` 字段承载了这些信息（如 `'约 0.035 PTC/张。验证 2026-05。注意：locked character 参考图当前不通——doubao 期望参考图是 URL 不是 base64'`）。**SVH 的 Provider 配置表应包含 `verified_at` / `known_issues` / `price_note` 字段**。
4. **CORS 问题的根源是浏览器直连**——SVH 有后端，所有模型调用经服务端转发，**从架构上根除这类问题**。这是「有后端」相对 dramai 最直接的收益之一。

### 6.6 连接测试的按协议分发（`core/llm/test-connection.ts:20-43`）

```ts
export async function testProvider(
  provider: Pick<Provider, 'baseUrl' | 'apiKey' | 'apiFlavor'>,
  options: { signal?: AbortSignal } = {},
): Promise<TestConnectionResult> {
  if (!provider.baseUrl) return { ok: false, error: 'Base URL 不能为空' }
  const flavor = provider.apiFlavor ?? 'openai-compatible'

  if (flavor === 'kling' || flavor === 'runway') {
    return {
      ok: true,
      warning: '该协议没有标准的模型列表端点，无法在测试连接里验证；请直接在分镜上点「生视频」实测。',
    }
  }
  if (flavor === 'gemini') return testGemini(provider, options)
  return testOpenAICompat(provider, options)
}
```

**值得借鉴**：
- **「测试连接」按协议走不同端点**：OpenAI-compat → `GET /models`；Gemini → `GET /v1beta/models`（且**同时发 `Authorization: Bearer` 与 `x-goog-api-key`**，`test-connection.ts:85-89`，覆盖官方与聚合平台两种鉴权）。
- **`warning` 与 `error` 分离**：协议不支持探测不是失败，返回 `ok: true` + `warning` 引导用户实测。**不要因为测不了就报错**——这个细节体现对用户意图的理解。
- **模型列表解析容忍两种结构**：`data[]`（OpenAI）与 `models[]`（Gemini），元素可为 string 或 `{id}` / `{name}`（`test-connection.ts:132-147`）。

**SVH 应把它做成后台定时健康检查任务**（cron + 记录 `provider_health` 表），而非用户手动点击的按钮。

### 6.7 模型接入层小结

| 维度 | dramai 实现 | 评价 |
| --- | --- | --- |
| 协议抽象 | `T2IRequest` / `I2VRequest` + `I2VClient.submit/poll` | ✅ 强值得借鉴 |
| 多协议分发 | `factory.ts` 按 `apiFlavor` switch | ✅ 直接继承 |
| 能力槽位激活 | `ActiveProviderMap` + `useActiveProvider` | ✅ 语义可搬到 PG |
| SSE 流式 | 手写解析器 + `finally` 中 `reader.cancel()` | ✅ 前端流式渲染可直接继承 |
| JSON 容错 | 三级解析 + 字段归一化 + 单条丢弃 | ⚠️ 应降级为 fallback，主路径用 JSON Schema |
| 重试 | **完全缺失** | ❌ SVH 必须补 |
| 并发/限流 | **完全缺失** | ❌ SVH 必须补 |
| API Key 安全 | 明文 `localStorage` | ❌ SVH 必须服务端加密 |
| 成本可观测 | **缺失**（无 token / 价格记录） | ❌ SVH 必须补（`Generation` 表落地） |
| 错误信息质量 | 说明原因 + 给出下一步 + 提示扣费风险 | ✅ 值得借鉴 |

---

## 7. 持久化、版本与导入导出

### 7.1 IndexedDB 表结构（Dexie v1，6 张表）

```ts
// src/core/storage/db.ts:4-33
/**
 * IndexedDB 模式定义。
 *
 * 任何字段或表的变更都需要 `version(N+1).stores({...}).upgrade(...)` 形式
 * 增加新版本号；不要原地修改现有版本。
 */
class DramaiDB extends Dexie {
  projects!: Table<Project, string>
  characters!: Table<Character, string>
  materials!: Table<Material, string>
  storyboards!: Table<Storyboard, string>
  assets!: Table<Asset, string>
  generations!: Table<Generation, string>

  constructor() {
    super('dramai')
    this.version(1).stores({
      // 第一个字段是主键，后续逗号分隔的是次级索引
      projects: 'id, status, createdAt, updatedAt',
      characters: 'id, projectId, role, locked, createdAt',
      materials: 'id, projectId, kind, createdAt',
      storyboards: 'id, projectId, status, [projectId+sequence]',
      assets: 'id, projectId, kind, createdAt',
      generations: 'id, projectId, stageName, status, createdAt',
    })
  }
}
```

**索引设计分析（对 SVH 的 PostgreSQL 建索引有直接参考价值）**：

| 表 | 索引 | 评价 |
| --- | --- | --- |
| `projects` | `id` + `status` + `createdAt` + `updatedAt` | 合理 |
| `characters` | `id` + `projectId` + `role` + `locked` + `createdAt` | `projectId` 是必备外键索引；`locked` 单列索引**用处不大**（选择度低），但对 7.5k 行规模无所谓 |
| `storyboards` | `id` + `projectId` + `status` + **`[projectId+sequence]` 复合索引** | ★ **这个复合索引是关键**——`BatchVideoButton` 与 `buildJianyingPackage` 都用 `where('[projectId+sequence]').between([pid, -Infinity], [pid, Infinity])` 一次性取出有序分镜。**SVH 的 `shots` 表必须有 `(project_id, sequence)` 复合索引**，这是最高频查询 |
| `assets` | `id` + `projectId` + `kind` + `createdAt` | 合理 |
| `generations` | 索引齐全但**表从未写入** | 死 schema |

**迁移策略**：注释明确了「只增版本号，不改旧版本」的规则（`db.ts:6-8`），但**项目只有一个 version(1)**，从未真正执行过迁移——所以这套迁移机制**未经实战检验**。SVH 用 PostgreSQL 时对应的是 migration 文件，务必从第一天就建立（比如用 Drizzle / Prisma migrate / node-pg-migrate）。

### 7.2 级联删除（应用层手写，不是 DB 约束）

```ts
// src/core/storage/characters.ts:36-50 —— 删除角色时的三方清理
/** 删除角色：清掉它绑定的参考图 asset，并把所有引用它的 storyboard.characterIds 解除。 */
export async function deleteCharacter(id: string): Promise<void> {
  await db.transaction('rw', [db.characters, db.assets, db.storyboards], async () => {
    const c = await db.characters.get(id)
    if (!c) return
    if (c.referenceAssetId) await db.assets.delete(c.referenceAssetId)
    const linkedShots = await db.storyboards.filter((s) => s.characterIds.includes(id)).toArray()
    for (const shot of linkedShots) {
      await db.storyboards.update(shot.id, {
        characterIds: shot.characterIds.filter((cid) => cid !== id),
      })
    }
    await db.characters.delete(id)
  })
}
```

**分析**：
- ✅ **用 IndexedDB 事务包裹**，保证原子性。
- ✅ **解除引用而不删分镜**——删角色不会连带删掉分镜，只把该角色从 `characterIds` 里摘掉。**这是正确的业务语义**（分镜还有场景、旁白、图，不该因角色删除而消失）。
- ❌ **`db.storyboards.filter(s => s.characterIds.includes(id))` 是 O(n) 全表扫描**——因为 `characterIds` 是内联数组，无法建索引。这正是**内联数组 vs 关联表**的经典代价。SVH 必须用 `shot_characters` 关联表，靠外键 `ON DELETE CASCADE` 处理。
- ❌ **项目删除同样全表扫描**（`projects.ts:35-48`，6 张表逐个 `where('projectId').equals(id).delete()`）。SVH 靠 `ON DELETE CASCADE` 一条 SQL 解决。

### 7.3 导入导出格式（★ 值得借鉴）

```ts
// src/core/export/json.ts:4-30
const FORMAT_TAG = 'dramai-backup'
const FORMAT_VERSION = 1

interface SerializedAsset extends Omit<Asset, 'blob'> {
  blobBase64: string
}

interface BackupPayload {
  format: typeof FORMAT_TAG       // 'dramai-backup'
  version: number                 // 1
  exportedAt: number
  /** 应用版本，便于将来排查不兼容的导出文件。 */
  appVersion: string
  projects: Project[]
  characters: Character[]
  materials: Material[]
  storyboards: Storyboard[]
  assets: SerializedAsset[]
  generations: Generation[]
}
```

**值得借鉴的设计点**：
1. **`format` 魔数 + `version` 版本号 + `appVersion` 应用版本三元组**——导入时校验：
   ```ts
   // json.ts:102-109
   if (payload.format !== FORMAT_TAG) throw new Error('文件不是 dramai 备份（缺少 format=dramai-backup）')
   if (typeof payload.version !== 'number' || payload.version > FORMAT_VERSION) {
     throw new Error(`备份版本 ${payload.version} 高于当前应用支持的最高版本 ${FORMAT_VERSION}，请升级 dramai 后再导入`)
   }
   ```
   **拒绝导入高版本文件**而不是尝试解析，这是正确的保守策略。
2. **`SerializedAsset` 显式 `Omit<Asset, 'blob'>` + `blobBase64`**——类型层面就保证 Blob 不会被误序列化（`json.ts:53-54` 还显式解构丢弃 `blob`）。
3. **merge / replace 双模式导入**（`json.ts:88-91, 124-140`）：`replace` 先清空所有表；`merge` 用 `bulkPut`（id 冲突时覆盖）。
4. **支持按项目导出**（`ExportOptions.projectId`）——用户可以只导出一部短剧分享给他人。
5. **`makeBackupFilename` 保留中文字符**：`title.replace(/[^\w一-龥]+/g, '-')`（`json.ts:156`）——细节到位。

**缺陷**：
- **base64 内联二进制导致备份文件巨大**：一个 5 秒 720p 视频约 1–3 MB，base64 后膨胀 33%，6 个分镜的视频备份可轻松超过 20 MB，**全部在浏览器内存里拼接字符串**（`blobToBase64` 分块 0x8000 处理，`json.ts:174-184`），大项目会 OOM。
- **`JSON.stringify(payload, null, 0)` 一次性序列化整个 payload**（`json.ts:75`）——无流式写入，无进度反馈。
- **导入无事务回滚保障**：虽然用了 `db.transaction`，但 `JSON.parse(text)` 在事务外（`json.ts:100-101`），且 base64 解码在事务外（`json.ts:111-118`）——若解码中途失败，事务还没开始，用户得到的是「导入失败但部分内存已消耗」。
- **`BackupRestore.tsx:24` 硬编码 `appVersion: '0.1.0'`**——而实际版本是 0.4.1。**这是明显的 bug**：备份文件里的应用版本号是错的，将来排查兼容性问题会被误导。

**SVH 的启示**：导出格式的「魔数 + 双版本号 + merge/replace + 按项目导出」四件套**直接继承**。但二进制必须外置：导出包应为 ZIP（manifest.json + 资源文件），或干脆只导出「引用清单」由后端按需打包。SVH 有对象存储，最优雅的方案是**导出为异步任务**（BullMQ），生成 ZIP 后给下载链接。

### 7.4 版本历史：**完全没有**

```
$ grep -rni "version|history|undo|snapshot" src/core src/store
src/core/export/jianying.ts:36      version: 1            ← ZIP manifest 格式版本
src/core/export/json.ts:13          version: number       ← 备份格式版本
src/core/storage/db.ts:21           this.version(1)       ← IndexedDB schema 版本
src/store/settings.ts:76            version: 1            ← zustand persist 版本
```

**结论：dramai 没有任何业务数据的版本历史、撤销、快照机制。** 所有 `version` 命中都是「格式/schema 版本」，与「内容版本」无关。

具体表现：
- 重新生成分镜 = **直接删除旧数据**（`clearProjectStoryboards`，`storyboards.ts:42-55`，且级联删除关联的图/视频 asset）。
- 重新生成单张分镜图 = **先删旧 asset 再写新 asset**（`image-shot.ts:62-69`）——**旧图不可恢复**。
- 用户在 UI 上编辑分镜 prompt 后，**没有任何「还原」能力**。
- 唯一的安全网是**手动导出 JSON 备份**。

**这是 SVH 必须解决的头号问题**。AI 生成类产品的核心用户痛点正是「这次生成的不如上次」——没有版本历史意味着用户不敢重试。SVH 应在数据模型层就内建：

- `generations` 表记录每一次尝试的完整快照（input/output/参数），**永不物理删除 asset**。
- `shot_versions` 或统一的 `content_versions` 表，支持「回滚到第 N 版」。
- 前端 UI 上每个分镜提供「历史版本」抽屉，可对比、可回滚。
- Asset 采用**内容寻址**（hash）与引用计数，删除分镜不再级联删除 asset，改为「解除引用 + 延迟 GC」。

### 7.5 持久化小结

| 维度 | dramai | 评价 | SVH |
| --- | --- | --- | --- |
| 表结构 | 6 表，`storyboards` 有 `[projectId+sequence]` 复合索引 | ✅ 索引设计可借鉴 | PG 建 `(project_id, sequence)` 复合索引 |
| Schema 迁移 | 有版本号规则但只有 v1，未实战 | ⚠️ | 从第一天用 migration 工具 |
| 级联删除 | 应用层手写 + IDB 事务；角色删除「解除引用不删分镜」 | ⚠️ 语义对但 O(n) | PG 外键 CASCADE + 关联表 |
| 导入导出 | 魔数 + 双版本 + merge/replace + 按项目导出 | ✅ 值得借鉴 | 继承格式设计，二进制改 ZIP/对象存储 |
| 备份体积 | base64 内联，大项目 OOM | ❌ | 流式 + 外置资源 |
| 版本历史 | **完全没有**，重生成即删旧数据 | ❌ **头号问题** | 必须内建版本与回滚 |
| 成本/审计 | `generations` 表定义但从未写入 | ❌ | 必须落地 |

---

## 8. UI 交互模式与可借鉴决策

> 本节由独立子审计员对 `src/components/**`（9 子目录 / 33 文件）、`src/pages/**`（7 文件）、`src/styles/globals.css` 精读产出，所有结论均标注 `文件:行号`。

### 8.1 组件树与页面结构

**路由共 7 条**，全部挂在同一个 `AppLayout` 下（`src/router.tsx:15-36`）：`/`（首页）、`/projects`、`/projects/:projectId`、`/projects/:projectId/characters`、`/settings`、`/about`、`*`。布局骨架是 `AppHeader`（sticky）+ `<main class="flex-1"><Outlet/></main>` + `AppFooter`，**没有侧边栏**（`src/components/layout/AppLayout.tsx:5-15`）。

```
AppLayout
├─ AppHeader (BrandMark / NavLink×4 / LocaleSwitcher / GithubIcon)
├─ HomePage            → Card×5（特性 4 卡 + Pipeline 卡）
├─ ProjectsPage        → ProjectCard×N + ProjectCreateDialog(Modal)
├─ ProjectDetailPage   → Card[素材: MaterialUploadArea + MaterialList]
│                        Card[分镜生成: StoryboardGenerator
│                              + BatchImageButton + BatchVideoButton + StoryboardList]
│                        CompositionCard（独立 Card）
│                        Card[角色卡 → 链接到 CharactersPage]
│                        ProjectEditModal
├─ CharactersPage      → CharacterCard×N + CharacterEditDialog×2
└─ SettingsPage        → ProviderCard×N + ProviderForm(Modal) + BackupRestore + 危险操作 Modal
```

**★ 值得借鉴的决策（最高价值的一条 UI 经验）**：`ProjectDetailPage` 的**纵向分段顺序 = 真实生产流程**：素材 → 分镜 → 合成 → 角色（`src/pages/ProjectDetail.tsx:123-183`）。用户不需要理解导航层级，页面结构本身就是任务流程。这正符合「AI 创作类页面应按任务流程设计」的原则，且比常见的「左侧表单 + 右侧大 Card」高级得多。**SVH 的工作台页面应直接继承这个「纵向流水线分段」骨架。**

`src/components/ui/` 只有 9 个文件（`badge / button / button-variants / card / input / label / modal / select / textarea`），全是对原生元素的薄封装（`input.tsx` / `select.tsx` / `textarea.tsx` / `label.tsx` 各仅 11–19 行）。

### 8.2 分镜/镜头编辑器：有序列表 + 横向卡片

**形态结论：`ol > li` 有序列表 + 横向卡片，既不是表格、也不是看板、也不是画布。**

```tsx
// src/components/storyboard/StoryboardList.tsx:78-90
<ol className="flex flex-col gap-3">
  {shots.map((s) => (
    <li key={s.id}
      className="flex flex-col gap-3 rounded-lg border border-border bg-background-soft p-4 sm:flex-row">
      <div className="relative h-32 w-full shrink-0 overflow-hidden rounded-md bg-background-soft-2 sm:w-44">
```

**单张镜头卡的字段布局**（`StoryboardList.tsx:91-162`）：

| 区域 | 内容 | 行号 |
| --- | --- | --- |
| 左预览 | 有视频 → `<video controls>`；否则有图 → `<img loading="lazy">`；否则占位 `ImageIcon` | 92-110 |
| 左上角标 | 「视频」角标（黑底半透明） | 111-116 |
| 元信息行 | `#01` 序号（等宽字体）/ `status` Badge / `durationSec` / 角色 Badge | 121-134 |
| 右上 | 删除 icon 按钮 | 135-149 |
| 正文 | `sceneText` | 151 |
| 附加行 | `narration`（斜体）、`imagePrompt`（等宽 + `img·` 前缀） | 152-157 |
| 操作行 | `CameraMovementSelect` + `ShotImageButton` + `ShotVideoButton` | 158-162 |

**★ 编辑方式：字段级 inline 直写，无分镜编辑弹窗。** 唯一可写字段是运镜/速度，下拉即写库、**无保存按钮**：

```tsx
// src/components/storyboard/CameraMovementSelect.tsx:33-42
const onMovement = (m: CameraMovement) => {
  void updateStoryboard(shot.id, {
    cameraParams: m === 'static' ? { movement: 'static' } : { movement: m, speed },
  })
}
const onSpeed = (s: CameraSpeed) => {
  void updateStoryboard(shot.id, { cameraParams: { movement, speed: s } })
}
```

**★ 值得借鉴的三条交互决策**：

1. **每个镜头卡内置生成动作**（生图 / 生视频 / 运镜），避免「列表 → 详情 → 返回」的往返（`StoryboardList.tsx:158-162`）。
2. **AI 输入当一等公民展示**：`imagePrompt` 用等宽字体 + `img·` 前缀单独成行（`StoryboardList.tsx:153-157`）——用户在排查「为什么这张图不对」时，第一眼要看的就是实际发出的 prompt。**这是 AI 产品区别于普通 CRUD 列表的关键细节**。
3. **高成本动作就地可用**，不需要进入编辑模式。

**★ 但也暴露了最严重的功能缺口（SVH 必须修复）**：`sceneText / narration / imagePrompt` **全部只读**——全仓 `updateStoryboard` 仅被 `CameraMovementSelect` 调用两处（grep 确认）。也就是说 **dramai 的用户无法在 UI 上修改分镜文本与图像 prompt**。对于「AI 生成 + 人工精修」的工作流，这是致命缺陷：用户只能「接受」或「整批重新生成」（后者会删除所有旧数据，见 4.3）。SVH 的分镜编辑器必须把 `sceneText` / `imagePrompt` / `narration` 做成可编辑字段。

其他细节：删除用原生 `window.confirm`（`StoryboardList.tsx:140-144`）；空态只有一行文字（`:74-76`），无插图无 CTA。

### 8.3 画布 / 时间线 / 合成预览：**三者都不存在**

**明确结论：无 timeline、无 canvas、无第三方合成或拖拽库。**

```
$ grep -rn "timeline|canvas|konva|fabric|dnd|reactflow|wavesurfer|slider|scrub" src/components src/pages src/styles
（0 命中；唯一 drag 命中是 MaterialUploadArea 的文件拖拽上传）
```

**合成实现是 FFmpeg.wasm 线性拼接**，由 `core/composition/concat` 暴露 `concatVideos`，UI 侧仅消费进度事件：

```tsx
// src/components/composition/CompositionCard.tsx:87-90
const merged = await concatVideos(inputs, {
  onProgress: setProgress,
  signal: abortRef.current.signal,
})
```

FFmpeg.wasm 的存在由 UI 文案自证：`CompositionCard.tsx:193`「FFmpeg.wasm 单线程对编码差异较敏感」、`:245`「加载 FFmpeg.wasm 中（首次需下载 ~30MB）」。

**合成交互流程**（`CompositionCard.tsx`）：
1. 主按钮「合成成片（N 段）」→ 已有产物则变「重新合成」（`:158-171`）；
2. 运行中同位置换成 destructive 的「中止」（`:153-156`）；
3. **阶段式进度文案，无进度条、无帧级 scrub**：

```tsx
// src/components/composition/CompositionCard.tsx:242-253
function progressLabel(p: ConcatProgress): string {
  switch (p.phase) {
    case 'loading':       return '加载 FFmpeg.wasm 中（首次需下载 ~30MB）…'
    case 'transcoding':   return p.totalClips ? `转码中… ${p.currentClip}/${p.totalClips}` : '转码中…'
    case 'concatenating': return '拼接中…'
    case 'done':          return '完成'
  }
}
```

4. 成片作为新 asset 落 IndexedDB，靠「未被任何 storyboard 引用的最新 video asset」反查成品（`:39-55`）——**没有显式 `kind: 'composed'` 字段，属隐式约定，是脆弱设计**；
5. 另有 SRT / VTT / 剪映 ZIP 导出按钮（`:203-231`）。

**预览**只有原生 `<video controls preload="metadata">`（`StoryboardList.tsx:92-98`），**没有自研播放器或时间轴**。

**对 SVH 的启示**：
- ⚠️ **「无 timeline」意味着 dramai 并未真正解决「短剧」的核心编辑需求**——它只是一个「生成流水线 + 素材清单」，最终剪辑被推给了剪映（导出 ZIP 让用户手动拖）。SVH 若定位为 Content Agent 平台，**时间线/多轨编辑是需要从零设计的新增能力**，dramai 在这块提供不了参考（唯一可用的是 `durationSec` 顺序累加生成 SRT 的时间轴算法，见 `subtitles.ts:7-25`）。
- ✅ **但「阶段式进度文案」的写法值得继承**：把 FFmpeg 的 `transcoding / concatenating` 翻译成带**数量与预估代价**的业务语言（`转码中… 3/6`、「首次需下载 ~30MB」）。
- ✅ 导出多格式（成片 / SRT / VTT / 剪映 ZIP）的**并列按钮组**设计合理。

### 8.4 生成状态与批量并发交互（重点）

#### 8.4.1 三套并行的状态机，互不复用

**（a）LLM 分镜生成 —— 事件流驱动的阶段 banner**（`StoryboardGenerator.tsx:33-36 + 144-154`）：

```tsx
const [running, setRunning] = useState(false)
const [event, setEvent] = useState<StoryboardEvent | null>(null)
const abortRef = useRef<AbortController | null>(null)
// ...
const label = event.phase === 'starting' ? '正在准备…'
  : event.phase === 'streaming' ? '正在接收 LLM 输出…'
  : event.phase === 'parsing' ? '正在解析 JSON…' : '正在落库…'
const accumulated = event.phase === 'streaming' || event.phase === 'parsing' ? event.accumulated : ''
```

消费方式是 **async generator + 单层 `for await`**（`:46-56`）；失败时提供「可展开 LLM 原文 + 原因」（`:120-133`），成功给绿色汇总（`:136-142`）。

**（b）单镜头生视频 —— 7 态 phase 字典**（`ShotVideoButton.tsx:13-21`）：

```tsx
const PHASE_LABEL: Record<VideoShotEvent['phase'], string> = {
  submitting: '提交中…', queued: '排队…', processing: '生成中…',
  downloading: '下载中…', persisting: '保存中…', done: '完成', error: '失败',
}
```

运行中同位置换「中止」按钮 + 行内 spinner + phase 文本（`:70-81`）。

**（c）批量 —— 组件内自建 `Progress` 结构（图片/视频各写一份，字段几乎相同）**：

```tsx
// BatchVideoButton.tsx:14-20
interface Progress { total: number; done: number; failed: number; current?: number; phase?: VideoShotEvent['phase'] }
// BatchImageButton.tsx:16-22 —— 同结构，仅把 phase 换成 message?: string
interface Progress { total: number; done: number; failed: number; current?: number; message?: string }
```

#### 8.4.2 状态存放位置（**SVH 必须推翻的设计**）

- **瞬时生成态**：组件 `useState`（`running / progress / event / error`）+ `useRef<AbortController>`。**没有任何生成态进入全局 store 或 IndexedDB。**
- **持久业务态**：IndexedDB，通过 `useLiveQuery` 订阅（11 个文件使用），组件不持有实体副本——这一点是好的。
- **唯一走 zustand 的只有 Provider 激活配置**：`useActiveProvider(...)` 出现在 5 个 storyboard 组件中。

**★ 这是 dramai 与 SVH 架构冲突最尖锐的地方**：所有生成进度都是组件局部状态，**切换路由、刷新页面、关闭标签即丢失**，且任务本身跑在浏览器里（关标签 = 任务死亡）。**没有任何「可离开页面后回来继续看进度」的承载物**：无全局任务中心、无通知、无持久 job 记录引用。

SVH 有 BullMQ，**必须把这一整层重做为「服务端权威状态 + 前端订阅」**：任务状态落 `jobs` 表 → 通过 SSE / WebSocket 推送 → 前端全局任务中心（可跨页面、可跨会话）。

#### 8.4.3 并发、取消、重试

**并发度 = 1，严格串行 for 循环，无并发池、无限流、无退避**（与 4.5 的 core 层结论一致，UI 层是同一模式）：

```tsx
// src/components/storyboard/BatchImageButton.tsx:58-84（BatchVideoButton.tsx:56-88 同构）
for (let i = 0; i < targets.length; i++) {
  if (abortRef.current.signal.aborted) break
  const shot = targets[i]
  setProgress({ total: targets.length, done, failed, current: shot.sequence, message: '生成中…' })
  try {
    const refs = await collectReferenceImages(shot.projectId, shot.characterIds)
    let lastError: string | undefined
    for await (const ev of generateShotImage({ provider, storyboard: shot, referenceImageBlobs: refs, signal: abortRef.current.signal })) {
      if (ev.phase === 'error') lastError = ev.message
    }
    if (lastError) failed++
    else done++
  } catch (err) {
    failed++
    if (err instanceof Error && err.name === 'AbortError') break
  }
}
```

- **取消**：每个组件各自 `abortRef.current?.abort(); setRunning(false)`，**不 await 收尾**（6 处重复：`BatchImageButton.tsx:45-48`、`BatchVideoButton.tsx:43-46`、`StoryboardGenerator.tsx:63-66`、`ShotImageButton.tsx:29-32`、`ShotVideoButton.tsx:45-48`、`CompositionCard.tsx:62-65`）。
- **★ 重试免专门入口（值得借鉴的巧思）**：批量目标集合**每次渲染从「产物缺失」重算**，所以再点一次按钮就自动只补缺失项：

```tsx
// src/components/storyboard/BatchVideoButton.tsx:40-41
const targets = shots.filter((s) => s.imageAssetId && !s.videoAssetId)
const ready = shots.filter((s) => s.imageAssetId).length
```

`BatchImageButton.tsx:42` 同理，并用 `forceAll` prop 提供「重生全部」入口（`:12-13, 107-111`）。**但注意：没有「只重试失败项」的按钮**——失败项与未生成项无法区分（因为失败不写回 `status`，见 8.4.4）。

#### 8.4.4 状态文案与按钮语义（★ 密集的可借鉴点）

**按钮标签内嵌剩余量、运行态复用同一按钮位**：

```tsx
// src/components/storyboard/BatchImageButton.tsx:100-113
{running ? (
  <Button variant="destructive" onClick={stop} className="gap-2">
    <StopCircle className="h-4 w-4" /> 中止
  </Button>
) : (
  <Button onClick={start} disabled={remaining === 0} variant="secondary" className="gap-2">
    <Images className="h-4 w-4" />
    {forceAll ? `重生全部分镜图（${shots.length}）`
      : remaining > 0 ? `批量生图（剩 ${remaining}）` : '所有分镜已有图'}
  </Button>
)}
```

单行紧凑进度（`:114-125`）：`{done}/{total} 完成 · 失败 N · 当前 #03`；视频批量额外带 `(phase)`（`BatchVideoButton.tsx:116-130`）。

**单镜头按钮文案随产物状态切换**：`shot.imageAssetId ? '重生' : '生图'`（`ShotImageButton.tsx:75`）、`shot.videoAssetId ? '重生视频' : '生视频'`（`ShotVideoButton.tsx:90`）——**用文案表达「首次创建 vs 重复操作」，并同步降级视觉权重**。

**★ 值得 SVH 直接继承的四条**：
1. **按钮标签内嵌剩余量**（「批量生图（剩 3）」）——用户点之前就知道工作量。
2. **运行态在原按钮位替换为 destructive「中止」**——保证每个操作区任何时刻只有一个主操作。
3. **单行高信息密度进度**：`done/total 完成 · 失败 N · 当前 #03 (phase)`。
4. **异步阶段用业务语言命名并做字典映射**（提交中 / 排队 / 生成中 / 下载中 / 保存中）——把等待变得可解释。**BullMQ 的 job state 可以直接映射这套枚举**。

**同时暴露三个严重缺陷**：
- **批量终态摘要永远不显示（死代码）**：收尾 `setProgress({total, done, failed})` 后设置了 `setRunning(false)`，而渲染条件是 `running && progress`（`BatchVideoButton.tsx:90-92` vs `:116`；`BatchImageButton.tsx:92-93` vs `:114`）——用户跑完或中止后**看不到「失败 N」汇总**。
- **批量模式吞掉失败原因**：循环内 `lastError` 被丢弃，最终只有一个数字，**无失败清单、无导出、无「仅重试失败」**（`BatchVideoButton.tsx:80-83`）。
- **`status` 枚举里没有 `generating`**：`STATUS_LABEL` 只有 `pending / image-ready / video-ready / failed`（`StoryboardList.tsx:18-23`）。生成中的镜头卡片**没有任何视觉态**（无蒙层、无骨架、无 pulse），且**失败也不写回 `status`**，导致卡片上的「失败」几乎不会出现。这与 3.3 指出的数据模型缺陷互为因果。

### 8.5 素材与角色一致性交互

**上传（拖拽 + 选择，多文件，★ 单文件失败不阻断）**：

```tsx
// src/components/upload/MaterialUploadArea.tsx:19-37
const ingest = async (files: FileList | File[]) => {
  setError(null); setBusy(true)
  try {
    for (const file of Array.from(files)) {
      try { const parsed = await parseFile(file); await saveMaterial(projectId, parsed) }
      catch (err) { setError(err instanceof Error ? err.message : String(err)) } // 单文件失败不阻断其它文件
    }
  } finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
}
```

拖拽态用 `cn()` 切换边框/底色（`:62-67`），有格式与体积提示文案（`:74-76`）。**无逐文件进度、无文件队列视图**，且 `error` 是单个字符串会被后续失败覆盖（`:95`）。

**列表**：`grid sm:grid-cols-2 lg:grid-cols-3` 卡片（`MaterialList.tsx:60`），图片 `aspect-video` 预览 + `kind` Badge + `line-clamp-2` 文本摘要 + `MM-DD HH:mm` + 删除（`window.confirm`，`:108-120`）。

**★ 值得借鉴的资产生命周期抽象**：统一 `getObjectURL / releaseObjectURL` + 组件卸载时批量释放：

```tsx
// src/components/upload/MaterialList.tsx:48-53
// （StoryboardList.tsx:67-72、CharacterCard.tsx:31-34、ReferenceImageUploader.tsx:30-33 同构）
useEffect(() => {
  const ids = assets.map((a) => a.id)
  return () => { for (const id of ids) releaseObjectURL(id) }
}, [assets])
```

**SVH 换成后端签名 URL 后，仍应保留「单一资产访问口 + 生命周期成对释放」这条约束。**

**角色一致性 = 参考图 + `locked` 布尔 + 分镜 `characterIds` 三件套**（与 5.4 的 Prompt 层方案一一对应）：

1. **角色卡展示**：头像（参考图）/ 名字 / `role` Badge / `locked` 成功色 Badge（`CharacterCard.tsx:50-73`）。
2. **★ 锁定入口带前置校验与解释性提示**——这是「软约束优先于报错」的范例：

```tsx
// src/components/character/CharacterCard.tsx:41-47
const toggleLock = () => {
  if (!character.referenceAssetId) { window.alert('要锁定形象，请先上传参考图'); return }
  void updateCharacter(character.id, { locked: !character.locked })
}
```

3. **表单里锁定开关在无参考图时 disabled 并就地给原因**（`CharacterEditDialog.tsx:127-138`），描述文案明确「会拼到分镜的 image_prompt 里」（`:142-150`）。
4. **分镜侧没有角色选择器**——角色由 LLM 分镜结果写入 `characterIds`，列表只做展示（`StoryboardList.tsx:126-134`，locked 用 🔒 前缀）。生图时按 shot 的角色收集参考图：

```tsx
// src/components/storyboard/ShotImageButton.tsx:39-46
const refs = await collectReferenceImages(shot.projectId, shot.characterIds)
for await (const ev of generateShotImage({ provider, storyboard: shot, referenceImageBlobs: refs, size, signal: abortRef.current.signal })) { ... }
```

**★ 值得借鉴的交互决策**：**把「角色一致性」显式化为用户能理解、能开关的一个布尔**——它不再是黑盒魔法（`CharacterCard.tsx:41-47`、`CharacterEditDialog.tsx:127-138`）。无参考图时**软约束优先于报错**：开关 disabled + 就地说明原因与前置步骤。

**缺陷**：
- 分镜侧**没有角色选择器**，用户无法手动修正 LLM 认错的出场角色（只能整批重新生成）。
- **移除参考图立即删库**，无引用检查：`if (value) { await deleteAsset(value) }`（`ReferenceImageUploader.tsx:57-66`）——在编辑弹窗中误点「移除」后再取消，原图已不可恢复。这与 7.4 的「无版本历史」是同一个病根。
- 角色 / 素材 / 分镜 / 项目删除**全部用原生 `window.confirm`**（5 处），而 `Settings.tsx:188-208` 已有规范的 destructive Modal（`dismissOnBackdrop={false}` + footer 双按钮）——**能力存在但未复用**，确认体系分裂。

### 8.6 Design Token 与样式体系

**Tailwind v4 CSS-first：无 `tailwind.config.js`、无 `postcss.config.js`，token 全在 `@theme` 内，颜色用 `oklch`，强制深色，无亮色模式。**

```css
/* src/styles/globals.css:1-32 */
@import 'tailwindcss';
@plugin "tailwindcss-animate";

/* 默认强制深色配色（和落地页风格一致），未来可加切换。 */
:root { color-scheme: dark; }

@theme {
  --font-sans: 'Inter','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,-apple-system,sans-serif;

  --color-background: oklch(0.16 0.01 280);
  --color-background-soft: oklch(0.2 0.013 280);
  --color-background-soft-2: oklch(0.24 0.014 280);
  --color-foreground: oklch(0.95 0.005 280);
  --color-muted: oklch(0.7 0.015 280);
  --color-muted-foreground: oklch(0.78 0.015 280);
  --color-accent: oklch(0.7 0.18 290);
  --color-accent-foreground: oklch(0.97 0.005 280);
  --color-accent-cyan: oklch(0.85 0.13 200);
  --color-border: oklch(0.32 0.014 280 / 50%);
  --color-input: oklch(0.27 0.014 280);
  --color-ring: oklch(0.7 0.18 290);
  --color-destructive: oklch(0.62 0.22 27);

  --radius-sm: 0.5rem;  --radius-md: 0.75rem;  --radius-lg: 1rem;  --radius-xl: 1.25rem;
}
```

**Token 清单与评价**：

| 类别 | 名称 | 值 | 评价 |
| --- | --- | --- | --- |
| 背景 | `background` / `background-soft` / `background-soft-2` | oklch 0.16 / 0.2 / 0.24 | ✅ **三级面板层次**，语义清晰 |
| 文字 | `foreground` | oklch(0.95 …) | ✅ |
| 文字 | `muted` / `muted-foreground` | oklch 0.7 / 0.78 | ❌ **两个 token 语义重叠**（都是「次要文字」，相差仅 0.08 亮度），导致混用：`text-muted` 用了 76 次、`text-muted-foreground` 7 次 |
| 品牌 | `accent` / `accent-foreground` / `accent-cyan` | 紫 290° / — / 青 200° | ⚠️ 紫色 + 青色渐变，接近「AI SaaS 模板」观感 |
| 边框/控件 | `border`(50% alpha) / `input` / `ring` | — | ✅ |
| 语义 | `destructive` | oklch(0.62 0.22 27) | ❌ **无 success / warning token** → 硬编码 `emerald-500/amber-500`（`ui/badge.tsx:12-13`、`StoryboardGenerator.tsx:71,138`、`ProviderCard.tsx:109`、`BackupRestore.tsx:90`） |
| 圆角 | `radius-sm/md/lg/xl` | 0.5 / 0.75 / 1 / 1.25rem | ✅ 四档体系统一 |
| 字体 | `font-sans` | Inter + 中文回退栈 | ✅ 中文回退链完整 |
| **间距** | — | — | ❌ **未定义 spacing token**，直接用 Tailwind 默认 `gap-2/3/4`、`p-4` |
| **字号** | — | — | ❌ **未定义字号/行高 token**，直接用 `text-xs/sm/base/2xl/4xl/5xl` |

**其他**：全仓 `dark:` 变体 **0 命中**，无 `prefers-color-scheme`、无 `prefers-reduced-motion`。全局仅 1 个自定义工具类 `.text-gradient-brand`（`globals.css:60-65`，紫青渐变文字）。

**对 SVH 的启示**：
- ✅ **三级背景色（`background` / `soft` / `soft-2`）** 的分层方式值得继承，比单一 `surface` 更能表达面板嵌套。
- ✅ **四档圆角 + 完整中文字体回退链**直接可用。
- ✅ **用 `oklch` 定义颜色**（感知均匀，便于做主题派生）值得继承。
- ❌ **必须补齐 dramai 缺失的三类 token**：`success` / `warning`（消除硬编码 `emerald`/`amber`）、**spacing 阶梯**、**字号/行高阶梯**。这三项是 AGENTS.md 明确要求的，而 dramai 恰好都没有。
- ⚠️ **`muted` / `muted-foreground` 双 token 重叠是反面教材**——SVH 的 token 命名应遵循 `text-primary / text-secondary / text-tertiary` 这类无歧义的层级命名。
- ⚠️ **强制深色且无 `dark:` 变体**意味着将来加亮色模式要改动全部组件。SVH 应从一开始就让两套主题都由 CSS 变量驱动。

### 8.7 组件库 / 图标 / CVA / 路由 / i18n

**自建 UI 层，零 UI 框架依赖**：`grep "radix|headlessui|antd|mui|chakra|shadcn"` 在 `components`/`pages` **0 命中**。

**★ CVA 用法（两处，可作为 SVH 的基线模板）**：

```ts
// src/components/ui/button-variants.ts:3-27 —— variant × size，基类内嵌 [&_svg]:size-4
// src/components/ui/badge.tsx:5-23        —— cva + VariantProps 导出 BadgeProps
```

```tsx
// src/components/ui/button.tsx:9-12 —— 组件壳保持 3 行
export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
```

`cn = twMerge(clsx(...))`（`src/lib/cn.ts:4-7`）。

**自建 Modal（唯一交互型复合组件，`modal.tsx`）**：`createPortal` 到 body、遮罩点击关闭、Escape 关闭、锁定 body 滚动，有 `role="dialog" aria-modal="true"`：

```tsx
// src/components/ui/modal.tsx:28-48
useEffect(() => {
  if (!open) return
  const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
  window.addEventListener('keydown', handler)
  const prev = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  return () => { window.removeEventListener('keydown', handler); document.body.style.overflow = prev }
}, [open, onClose])
```

**★ 但 a11y 缺口明显（反面教材）**：无 focus trap、无 `aria-labelledby`、无初始聚焦 / 焦点归还。更严重的是 **Escape 直接调 `onClose` 绕过了守卫**——`ProjectCreateDialog.handleClose` 有 `if (submitting) return` 保护（`ProjectCreateDialog.tsx:29-33`），但 `modal.tsx:31` 的 Escape 处理器绕过它，导致**提交中按 Esc 会留下悬挂请求**。

**★ Dialog 表单状态同步（一条正面 + 一条反面）**：
- 正面：`CharacterEditDialog.tsx:40-47` 用 `{open && <EditForm key={initial?.id ?? 'new'} />}` 正确重置表单。
- 反面：`ProjectEditModal` 常驻挂载、state 初值取自 props 且无 key / 无重置（`ProjectDetail.tsx:185-199`）——项目在别处更新后再打开会显示陈旧值。

**图标**：统一 `lucide-react`（+ 自绘 `GithubIcon.tsx` / `BrandMark.tsx`），**但混用 emoji / Unicode 当图标**：`CameraMovementSelect.tsx:5-17`（`'🚫 静态'`、`'⇐ 左横摇'`、`'🔍 推进'` 等 11 个）、`StoryboardList.tsx:131`（🔒）——违反「图标必须统一视觉风格」。

**i18n**：`i18next + react-i18next + LanguageDetector`，2 种语言 `zh-CN | en`，fallback `zh-CN`，持久键 `dramai-locale`（`src/i18n/index.ts:7-32`）。key 组织为**扁平命名空间前缀**（`brand.* / nav.* / home.* / about.* / footer.* / notFound.*`），数组用 `t('home.pipelineStages', { returnObjects: true }) as string[]`（`Home.tsx:25`）。

**★ i18n 覆盖断裂**：仅 `AppHeader / AppFooter / LocaleSwitcher / Home / About / NotFound` 使用 `t()`；**`Projects.tsx / ProjectDetail.tsx / Settings.tsx / Characters.tsx` 的 `t(` 计数为 0**（全硬编码中文）。切到英文后中英混排。另有 `toLocaleString('zh-CN')` 硬编码 3 处。

**路由**：`basename` 取自 `import.meta.env.BASE_URL`（`router.tsx:13`），与 `vite.config.ts` 的 `base` 联动，适配 GitHub Pages 子路径部署（`/dramai/`）。

### 8.8 响应式

断点使用统计（`components` + `pages`）：**`sm:` 27 次、`md:` 2 次、`lg:` 4 次、`xl:`/`2xl:` 0 次、`dark:` 0 次**。策略是「移动优先 + 少量 `sm` 断点」，**未做平板专属布局**。

- 容器：`mx-auto max-w-{3xl,4xl,6xl} px-4 py-12 sm:px-6`（`ProjectDetail.tsx:79` 等）。
- 卡片流转向：`flex flex-col … sm:flex-row`（`StoryboardList.tsx:89`），缩略图 `h-32 w-full … sm:w-44`（`:91`）——**分镜卡在移动端自动从横排变竖排**，处理得当。
- 网格：`sm:grid-cols-2 lg:grid-cols-3`（`MaterialList.tsx:60`、`Projects.tsx:46`）、角色 `sm:grid-cols-2`、首页特性 `sm:grid-cols-2 lg:grid-cols-4`。

**★ 移动端导航实际缺失（严重）**：

```tsx
// src/components/layout/AppHeader.tsx:30 + 50-56
<nav className="ml-2 hidden items-center gap-1 sm:flex">   // <640px 完全隐藏
...
<Link to="/settings" className="sm:hidden">                // 移动端只剩设置图标
```

即 `<640px` 时用户**无法进入「项目 / 关于」**，只能靠 Logo 回首页——**全站最关键的「我的项目」入口在移动端缺失**。

Modal 固定居中 + `max-w-md/lg`，未做移动端底部抽屉（`modal.tsx:46,53`）；遮罩固定 `bg-black/60 backdrop-blur-sm`。

### 8.9 UI 层缺陷清单（完整）

| # | 缺陷 | 位置 | 严重度 |
| --- | --- | --- | --- |
| 1 | **批量终态摘要永不显示（死代码）**：`setRunning(false)` 后渲染条件仍是 `running && progress` | `BatchVideoButton.tsx:90-92` vs `:116`；`BatchImageButton.tsx:92-93` vs `:114` | 🔴 |
| 2 | **生成态不落全局/不落库**：切路由、刷新即丢失；无全局任务中心 | 所有生成组件 | 🔴 |
| 3 | **`sceneText`/`imagePrompt`/`narration` 全只读**，无法人工精修 | `StoryboardList.tsx:151-157` | 🔴 |
| 4 | **`status` 枚举无 `generating`**，生成中无视觉态，失败不写回 status | `StoryboardList.tsx:18-23` | 🔴 |
| 5 | **移动端导航缺失**（`<sm` 隐藏项目/关于入口） | `AppHeader.tsx:30,50-56` | 🔴 |
| 6 | **批量吞掉失败原因**，无失败清单、无「仅重试失败」 | `BatchVideoButton.tsx:80-83` | 🟠 |
| 7 | **不可达的 loading 分支**：`!running` 分支内再判 `running`，spinner 永不渲染 | `ShotImageButton.tsx:64-76` | 🟠 |
| 8 | **删除确认体系分裂**：5 处 `window.confirm/alert` vs 已有的规范 destructive Modal | `ProjectCard.tsx:21`、`MaterialList.tsx:113`、`StoryboardList.tsx:141`、`CharacterCard.tsx:37,43`、`ProjectDetail.tsx:71` | 🟠 |
| 9 | **Modal Escape 绕过提交守卫**，无 focus trap / `aria-labelledby` | `modal.tsx:31` vs `ProjectCreateDialog.tsx:29-33` | 🟠 |
| 10 | **参考图「移除即删库」**，无引用检查、无回收站 | `ReferenceImageUploader.tsx:57-66` | 🟠 |
| 11 | **重复逻辑跨文件复制**：分镜查询 4 处、`STATUS_LABEL` 2 处、`ROLE_LABEL` 2 处（文案还不一致）、`Progress` 2 处、ObjectURL 样板 4 处 | 见 8.2/8.4 | 🟡 |
| 12 | **空态 / Loading 不一致**：仅 `Projects`/`Characters` 有规范空态；全仓 `skeleton` 0 命中；加载态是纯文本 | `ProjectDetail.tsx:48-54`、`StoryboardList.tsx:74-76` | 🟡 |
| 13 | **大文件职责混杂**：`CompositionCard.tsx` 259 行（合成+字幕+导出+文件名工具）、`ProjectDetail.tsx` 246 行（页面+内嵌 Modal）、`Settings.tsx` 211 行（页面+3 Modal） | — | 🟡 |
| 14 | **颜色语义不统一**：`muted`/`muted-foreground` 混用；`emerald`/`amber` 硬编码；无亮色模式 | `globals.css`、`ui/badge.tsx:12-13` | 🟡 |
| 15 | **Emoji / Unicode 当图标**，与 lucide 体系混用 | `CameraMovementSelect.tsx:5-17`、`StoryboardList.tsx:131` | 🟡 |
| 16 | **i18n 断裂**：4 个核心业务页 `t(` = 0，切英文中英混排 | `Projects/ProjectDetail/Settings/Characters` | 🟡 |
| 17 | **上传无逐文件反馈**，`error` 单字符串被覆盖，无队列/进度/重试 | `MaterialUploadArea.tsx:19-37,95` | 🟡 |
| 18 | **`useLiveQuery` 依赖用字符串拼接** `[assetIds.join(',')]`，脆弱且触发全量重查 | `StoryboardList.tsx:58`、`MaterialList.tsx:38`、`CompositionCard.tsx:53` | 🟡 |
| 19 | **Dialog 表单状态同步策略不统一**（`ProjectEditModal` 无 key、无重置） | `ProjectDetail.tsx:185-199` | 🟡 |
| 20 | **无虚拟化 / 分页**：分镜与素材全量渲染，上百条即卡顿 | `StoryboardList`、`MaterialList` | 🟡 |

### 8.10 「值得 SVH 借鉴的 UI 交互决策」清单

| # | 决策 | 依据 | 对 SVH 的价值 |
| --- | --- | --- | --- |
| 1 | **工作台按业务流水线纵向分段**（素材 → 分镜 → 合成 → 角色），页面结构即任务流程 | `ProjectDetail.tsx:123-183` | ★★★ 骨架直接继承 |
| 2 | **镜头卡内置生成动作**，避免列表↔详情往返 | `StoryboardList.tsx:158-162` | ★★★ |
| 3 | **参数类字段 inline 直写、无保存按钮** | `CameraMovementSelect.tsx:33-42` | ★★★ 但 SVH 需扩展到文本字段（dramai 只做了运镜） |
| 4 | **AI 输入当一等公民展示**：`imagePrompt` 等宽字体 + `img·` 前缀单独成行 | `StoryboardList.tsx:153-157` | ★★★ AI 产品必备的可排查性 |
| 5 | **按钮文案随产物状态切换**（生图 → 重生）并降级视觉权重 | `ShotImageButton.tsx:65-76` | ★★☆ |
| 6 | **批量按钮标签内嵌剩余量**「批量生图（剩 3）」 | `BatchImageButton.tsx:107-111` | ★★★ 点之前就知道工作量 |
| 7 | **单行紧凑进度**`done/total 完成 · 失败 N · 当前 #03 (phase)` | `BatchVideoButton.tsx:116-130` | ★★★ |
| 8 | **异步阶段业务语言命名 + 字典映射**（提交中/排队/生成中/下载中/保存中） | `ShotVideoButton.tsx:13-21` | ★★★ **可直接映射 BullMQ job state** |
| 9 | **运行态在原按钮位替换为 destructive「中止」** | `StoryboardGenerator.tsx:92-100`、`CompositionCard.tsx:153-156` | ★★★ |
| 10 | **async generator + discriminated union 事件驱动进度 UI** | `StoryboardGenerator.tsx:46-56` | ★★★ **SVH 用 SSE 推 BullMQ 事件时前端可原样复用这个状态机形状** |
| 11 | **失败信息自带「展开原始输出」+「下一步建议」** | `StoryboardGenerator.tsx:120-133`（`<details>` 展开 LLM 原文）、`CompositionCard.tsx:186-197`（给替代路径） | ★★★ |
| 12 | **整体中止能力贯穿每个长任务**（每组件持 `AbortController`，同位置暴露中止） | 6 处一致实现 | ★★★ 用户永远不会被卡住的按钮困住 |
| 13 | **重试免专门入口**：批量目标集合每次渲染从「产物缺失」重算，再点即自动只补缺失 | `BatchVideoButton.tsx:40` | ★★☆ 对应 SVH「按 job 状态查待重跑集合」 |
| 14 | **角色一致性显式化为「参考图 + locked 开关」**，用户可理解、可开关 | `CharacterCard.tsx:41-47`、`CharacterEditDialog.tsx:127-138` | ★★★ |
| 15 | **软约束优先于报错**：无参考图时开关 disabled + 就地说明原因与前置步骤 | `CharacterEditDialog.tsx:132-137` | ★★★ |
| 16 | **Dialog 用 `{open && <Form key=.../>}` 重置表单**，避免 useEffect 同步 props 的脏状态 | `CharacterEditDialog.tsx:40-47` | ★★☆ 直接照搬 |
| 17 | **统一 asset 访问层 + 显式释放**（`getObjectURL`/`releaseObjectURL` + 卸载批量回收） | `MaterialList.tsx:48-53` 等 4 处 | ★★☆ 换签名 URL 后仍保留「单一入口 + 成对释放」约束 |
| 18 | **CVA 管变体 + 组件壳 3–10 行** | `button.tsx:9-12`、`badge.tsx:5-23` | ★★☆ 但**须补 Radix/Headless UI 处理 focus trap**（dramai 手写 Modal 是反面教材） |
| 19 | **自建薄 UI 层不引重框架**（`ui/` 仅 9 文件） | — | ★★☆ 适合作为 SVH 基线，但须自补 `Skeleton` / `EmptyState` / `ConfirmDialog` / `Toast` 四个 dramai 缺失的原语 |
| 20 | **规范空态模板（图标 + 标题 + 说明 + 主 CTA）** | `Projects.tsx:28-44`、`Characters.tsx:58-75` | ★★☆ 应提升为全局 `EmptyState` 组件而非每页手写 |

### 8.11 UI 层一句话总结

dramai 的 UI 层是「**轻框架 + 卡片流工作台 + 组件内 async-generator 状态机**」的极简形态：分镜用列表卡片 + inline 参数编辑、**无 timeline / 无 canvas**、合成走 FFmpeg.wasm 线性拼接、生成进度全在组件 `useState`、批量严格串行且无终态汇总。

对 SVH 最有迁移价值的是**交互骨架**（分段工作台、卡片内生成动作、阶段化进度文案、中止/重跑语义、角色一致性开关、CVA + 自建薄 UI 层）；**必须彻底重做的是状态承载**——SVH 有 BullMQ，进度与失败必须落库并由 SSE/轮询驱动全局任务中心，而不是像 dramai 一样困在组件局部状态里随页面一起消失。

---

## 9. 工程配置与依赖选型

### 9.1 `vite.config.ts`（全文 32 行）

```ts
// vite.config.ts:1-32
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// GitHub Pages 部署在 https://hyyyyyyz.github.io/dramai/
// 因此默认 base = "/dramai/"。本地或自托管时可用 VITE_BASE 覆盖。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE ?? '/dramai/'

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: 5173,
      open: false,
      // 允许通过自定义域名访问（Vite 默认 Host 白名单仅允许 localhost 等）
      // 形如 ".kv2ray.cc" 允许该域及其所有子域，如 test1.kv2ray.cc
      allowedHosts: ['.kv2ray.cc'],
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  }
})
```

| 配置 | 评价 |
| --- | --- |
| `base` 由 `VITE_BASE` 环境变量覆盖，默认 `/dramai/` | ✅ 部署环境可配置，与 `router.tsx:13` 的 `import.meta.env.BASE_URL` 联动 |
| `resolve.alias` `@` → `./src` | ✅ 与 `tsconfig.app.json` 的 `paths` 保持一致（**两处都配才能类型与运行都生效**，dramai 做到了） |
| `@tailwindcss/vite` 插件 | ✅ Tailwind v4 的官方 Vite 插件，无需 PostCSS 配置 |
| `build.target: 'es2022'` + `sourcemap: true` | ✅ 目标现代浏览器；**生产环境开 sourcemap 需注意源码泄露**（开源项目可接受，SVH 应评估） |
| `server.allowedHosts: ['.kv2ray.cc']` | ⚠️ **硬编码个人域名进仓库**，属配置泄漏到代码的味道。SVH 应用环境变量 |
| 无 `manualChunks` / 无构建体积优化 | ⚠️ `@ffmpeg/ffmpeg`（~30MB wasm）与 `mammoth` 未做动态分包声明——`concat.ts` 里靠 `await import('@ffmpeg/util')` 隐式懒加载 |

**对 SVH 的启示**：`base` 可配 + `@` 别名双处同步 + 构建目标 == es2022，这三条可直接继承。但**不要把环境相关配置（域名白名单）硬编码进仓库**。

### 9.2 TypeScript 配置（`tsconfig.app.json`）

```json
// tsconfig.app.json:1-33（节选）
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client"],
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "paths": { "@/*": ["./src/*"] },
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

**★ 值得注意的严格选项**：
- `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` —— 这套组合解释了为什么 dramai 代码基本没有死变量。
- **`verbatimModuleSyntax: true`** —— 强制 `import type` 显式标注（全库代码确实如此，如 `import type { Provider } from '@/types/domain'`）。**这条对 SVH 的 shared 包尤其有价值**：能避免类型导入被编译成运行时导入，减少打包体积与循环依赖。
- **`erasableSyntaxOnly: true`** —— 禁止 enum / namespace / 参数属性等「无法被擦除」的 TS 语法。这解释了为什么 dramai 全部用 `type` 联合而非 `enum`（如 `ProviderKind`、`CameraMovement`）。**这与 Node.js 原生 TS 支持（type stripping）方向一致，SVH 后端应继承**。

**注意**：`tsconfig.app.json` 与 `tsconfig.node.json` 分离（Vite 标准做法），根 `tsconfig.json` 仅做 references 聚合。

### 9.3 状态管理方案（**关键结论：dramai 几乎不用全局状态**）

| 状态类型 | 方案 | 证据 |
| --- | --- | --- |
| **业务实体数据** | **IndexedDB + `useLiveQuery`**（dexie-react-hooks），11 个文件使用 | 组件不持有实体副本，DB 变更自动触发重渲染 |
| **应用级配置**（Provider / 激活映射） | **Zustand + persist**（唯一 store，88 行） | `src/store/settings.ts` |
| **表单/UI 局部状态** | 组件 `useState` | 所有 Modal、生成进度 |
| **生成任务状态** | **组件 `useState`**（无全局承载） | 见 8.4.2 ❌ |

**★ 这是 dramai 最值得 SVH 借鉴的架构决策之一**：**用「响应式数据库查询」替代「全局状态管理器」**。因为 IndexedDB 本身就是唯一真源，`useLiveQuery` 让组件直接订阅查询结果，**不需要把数据复制进 Redux/Zustand，也就不需要写同步逻辑**。

**为什么这对 SVH 特别重要**：SVH 是「有后端」架构，对应物是 **TanStack Query / SWR 这类服务端状态缓存库**，而不是 Zustand/Redux。dramai 的实践证明：
- **全局状态只应装「配置」**（Provider、主题、用户偏好），不装「数据」。
- **数据由数据源直接驱动 UI**（dramai 是 IndexedDB，SVH 是 HTTP + WebSocket）。

讽刺的是，dramai 唯一放错位置的状态恰恰是「生成进度」——它既不进 Zustand 也不进 DB，困在组件里（8.4.2）。**SVH 应把它作为服务端状态处理**：BullMQ job 状态 + Redis → SSE 推送 → 前端全局任务中心。

### 9.4 UI 组件库与图标库

| 选择 | 结论 |
| --- | --- |
| UI 组件库 | **无**。零 Radix / Headless UI / Ant Design / MUI / shadcn 依赖；自建 `src/components/ui/` 9 个文件 |
| 图标库 | **lucide-react ^1.14.0**，全站统一（+ 2 个自绘 SVG） |
| 样式工具 | `clsx` + `tailwind-merge`（封装为 `cn`）+ `class-variance-authority`（CVA） |
| 动画 | `tailwindcss-animate`（但全仓仅用 `animate-spin`，9 处） |

**评价**：
- ✅ **零框架依赖 = 零升级负担 + 完全样式可控**，适合开源项目与作为新项目基线。
- ✅ **lucide-react 统一图标**是正确选择（风格一致、tree-shakable）。
- ❌ **但手写交互组件的能力边界很明显**：Modal 无 focus trap / 无焦点归还 / Escape 绕过守卫（8.7），没有 Combobox、Tooltip、Popover、Toast、Drawer、虚拟列表。**SVH 若做复杂编辑器（时间线、拖拽、多选、右键菜单），自建成本会远超收益。**
- **建议**：SVH 采用 **Radix UI（无样式行为层）+ Tailwind（样式层）+ CVA（变体层）** 的组合——保留 dramai「样式完全可控 + 组件壳极薄」的优点，同时补齐 a11y 与复杂交互行为。

### 9.5 样式方案

**Tailwind CSS v4，CSS-first 配置**：
- 无 `tailwind.config.js`、无 `postcss.config.js`（已确认文件不存在）。
- Token 全部定义在 `globals.css` 的 `@theme` 块内（见 8.6 完整摘录）。
- 颜色使用 **`oklch()`** 色彩空间（感知均匀，便于程序化派生明暗/主题）。
- 强制深色（`:root { color-scheme: dark }`），无 `dark:` 变体。
- 仅 1 个自定义工具类 `.text-gradient-brand`。

**评价（对 SVH）**：
- ✅ **Tailwind v4 的 CSS-first 配置**（`@theme` 替代 JS config）方向正确——token 与 CSS 同源，避免「JS config 与 CSS 变量两套体系」的经典困境。SVH 应采用。
- ✅ **`oklch` 定义颜色**值得继承。
- ⚠️ **设计 token 覆盖不完整**：只有颜色、圆角、字体三类。**缺 spacing 阶梯、字号阶梯、阴影、z-index 层级**（AGENTS.md 明确要求的 spacing/typography 体系在 dramai 中完全缺失，导致组件里 `gap-2/3/4`、`text-xs/sm/base` 混用无规律）。
- ⚠️ **强制深色不是「主题」而是「硬编码」**——将来加亮色模式需改动全部组件。SVH 应从一开始就用 CSS 变量驱动双主题。

### 9.6 代码质量工具链与 CI

| 工具 | 配置 | 评价 |
| --- | --- | --- |
| ESLint | `eslint.config.js`（flat config，59 行）+ `typescript-eslint` + `eslint-plugin-react-hooks` + `react-refresh` | ✅ 现代 flat config |
| Prettier | `.prettierrc` + `.prettierignore` | ✅ |
| EditorConfig | `.editorconfig` | ✅ |
| 版本约束 | `.nvmrc`（3 字节）+ `engines: { node: ">=20 <25" }` | ✅ 显式约束 Node 版本 |
| `.npmrc` | 355 字节 | 依赖源配置 |
| CI | `.github/workflows/ci.yml`：`lint → typecheck → format:check → build` 四步 | ★ **值得直接继承的 CI 门禁顺序** |
| 部署 | `.github/workflows/deploy.yml`：`build` → `cp dist/index.html dist/404.html`（SPA 路由兜底）→ `touch dist/.nojekyll` | ✅ GitHub Pages SPA 部署的标准做法 |

**CI 顺序值得注意**：`lint → typecheck → format:check → build`，**先便宜的后贵的**，快速反馈。SVH 应继承这个顺序并扩展：`lint → typecheck → unit test → build → e2e`。

### 9.7 工程配置小结

| 维度 | dramai 选择 | SVH 建议 |
| --- | --- | --- |
| 构建 | Vite 8 + React 19 + Tailwind v4 插件 | ✅ 继承（前端部分） |
| 路径别名 | `@` → `src`，tsconfig 与 vite 双处同步 | ✅ 继承 |
| TS 严格性 | `strict` + `noUnused*` + `verbatimModuleSyntax` + `erasableSyntaxOnly` | ✅ **强烈建议继承全部四项**，尤其后两项 |
| 全局状态 | **几乎不用**；IndexedDB + `useLiveQuery` 驱动数据，Zustand 只装配置 | ✅ 继承思想；SVH 用 TanStack Query 承载服务端状态 |
| UI 组件库 | 自建 9 文件薄层，零框架 | ⚠️ 采用 Radix + Tailwind + CVA，保留薄组件壳风格但补齐 a11y |
| 图标 | lucide-react 统一 | ✅ 继承 |
| 样式 | Tailwind v4 CSS-first + `@theme` + oklch | ✅ 继承，但**必须补齐 spacing / typography / shadow token 与双主题** |
| 代码质量 | ESLint flat + Prettier + EditorConfig | ✅ 继承 |
| CI | lint → typecheck → format:check → build | ✅ 继承顺序，扩展单测与 e2e |

---

## 10. 结论

### 10.1 值得借鉴清单

| # | 项目 | 借鉴方式 | 对 SVH 的价值 |
| --- | --- | --- | --- |
| 1 | **分镜拆解 Prompt 全套（`BASE_SYSTEM_PROMPT` + 风格注入 + 四区块装配）** | **逐字迁移**到 SVH 后端 `packages/prompts`，升级为 JSON Schema strict 模式 | ★★★ SVH 最直接可用的核心资产，10 条 Prompt 技巧覆盖「输出契约 / 风格降级 / 空态兜底 / 架构约束传达」 |
| 2 | **`Storyboard` 数据模型**（`sceneText`/`imagePrompt` 分离、`characterIds` 外键数组、`durationSec`、`cameraParams`） | 迁移为 PG `shots` 表，补 `updated_at` / `version` / 显式 state 枚举 | ★★★ 直接决定 SVH Content 模型的信息架构 |
| 3 | **`AsyncGenerator<PhaseEvent>` 流水线契约** | 搬迁到 BullMQ Worker：`for await` + `job.updateProgress()` + Redis pub/sub | ★★★ 无后端代码与有后端架构之间最平滑的桥 |
| 4 | **`ProviderKind` × `ApiFlavor` 二维建模 + `factory` 分发** | 迁移为 PG `providers` 表 + 服务端 adapter registry | ★★★ 多 Provider / 多协议的解耦基石 |
| 5 | **`I2VClient.submit/poll` 异步任务抽象 + `I2VStatus` tagged union** | 直接继承接口形状，扩展任务句柄为自包含快照 | ★★★ 所有视频生成 API 的通用抽象 |
| 6 | **20 个风格预设（双语双字段 + 五要素结构）** | 迁移为 `style_presets` 表，扩充到图像/视频/配音全链路 | ★★★ 立即可用的领域知识资产，省去大量调研 |
| 7 | **SSE 手写解析器（含跨 chunk buffer + `finally` 中 `reader.cancel()`）** | 前端流式渲染直接继承 | ★★★ 包含只有踩过坑才知道的内存泄漏防护 |
| 8 | **JSON 解析三级容错 + 字段归一化 + 单条丢弃** | 作为 JSON Schema 不受支持时的**降级路径** | ★★☆ 健壮性兜底，但不应该是主路径 |
| 9 | **`Generation` 审计模型字段清单**（stageName/status/input/output/retry/时间戳） | **真正落地写入**，并补 provider/model/cost/latency/idempotency_key | ★★★ dramai 设计对了但没实现，SVH 的成本可观测性起点 |
| 10 | **角色一致性 = 参考图外键 + `locked` 布尔** | 继承二元结构，扩展为参考图组 + 角色版本 + 身份标注进 prompt | ★★★ 极简正确的一致性方案，可解释、可开关 |
| 11 | **运镜枚举 → 英文短语映射 + 速度副词组合拼接** | 直接继承并扩充（景别、焦段、灯光） | ★★☆ 类型完备的 Prompt 组装技巧 |
| 12 | **备份格式四件套**（魔数 + 双版本号 + merge/replace + 按项目导出） | 继承格式设计，二进制改 ZIP + 对象存储 + 异步导出任务 | ★★☆ 导入导出设计规范 |
| 13 | **`ui/` 薄组件层 + CVA 变体 + `cn = clsx + twMerge`** | 采用同分层，但换 Radix 做行为层 | ★★☆ 保留「样式可控」优点的同时补齐 a11y |
| 14 | **Tailwind v4 CSS-first `@theme` + oklch 色板 + 三级背景色** | 直接继承，**补齐 spacing / typography / shadow token 与双主题** | ★★☆ 样式体系基线 |
| 15 | **TS 严格选项四项**（`strict` / `noUnused*` / `verbatimModuleSyntax` / `erasableSyntaxOnly`） | 全量继承 | ★★☆ 尤其后两项契合 Node 原生 TS 方向 |
| 16 | **CI 门禁顺序** `lint → typecheck → format:check → build` | 继承并扩展单测与 e2e | ★★☆ 先便宜后贵的快速反馈 |
| 17 | **工作台纵向流水线分段**（素材 → 分镜 → 合成 → 角色） | 直接继承为 SVH 工作台骨架 | ★★★ 页面结构即任务流程 |
| 18 | **镜头卡内置生成动作 + 参数 inline 直写** | 继承，并把可编辑范围扩展到文本字段 | ★★★ 减少往返，AI 产品关键手感 |
| 19 | **批量按钮内嵌剩余量 + 单行进度 + 运行态原位替换为「中止」** | 直接继承 | ★★★ 一组高性价比的交互细节 |
| 20 | **异步阶段业务语言命名**（提交中/排队/生成中/下载中/保存中） | **直接映射 BullMQ job state** | ★★★ 把等待变得可解释 |
| 21 | **失败信息自带「展开原始输出」+「下一步建议」** | 直接继承 | ★★★ 生成类产品的可调试性 |
| 22 | **`{open && <Form key=.../>}` 重置 Dialog 表单** | 直接照搬 | ★★☆ 避免 useEffect 同步 props 的脏状态 |
| 23 | **统一 asset 访问层 + 生命周期成对释放** | 换成服务端签名 URL 后保留约束 | ★★☆ 防止资源泄漏 |
| 24 | **规范空态模板（图标 + 标题 + 说明 + 主 CTA）** | 提升为全局 `EmptyState` 组件 | ★★☆ |
| 25 | **Provider 预设必须带「验证时间 + 价格 + 已知坑」** | 扩展 `providers` 表字段：`verified_at` / `price_note` / `known_issues` | ★★★ 源于真实扣费教训的运维经验 |
| 26 | **「请求可能已扣费但客户端不知道」的失败模式认知** | BullMQ 视为 at-least-once + 幂等键 | ★★★ 直接影响 SVH 的重试策略设计 |

### 10.2 应避免的做法

| # | 反面模式 | 位置 | SVH 对策 |
| --- | --- | --- | --- |
| 1 | **重生成即全量删除旧数据**（级联删图/视频 asset） | `storyboards.ts:42-55`、`image-shot.ts:62-69` | **头号问题**：版本化 + 永不物理删 asset + 引用计数 GC + 「回滚到第 N 版」 |
| 2 | **完全没有版本历史 / 撤销 / 快照** | 全库无相关代码（7.4） | 每个分镜提供历史版本抽屉，可对比可回滚 |
| 3 | **批量生成严格串行，无并发池** | `BatchVideoButton.tsx:56-88` | BullMQ 并发度 + 令牌桶限流 |
| 4 | **零重试、零退避、零死信**（`Generation.retry` 是死字段） | 横切 grep 确认 | 指数退避 + 最大次数 + 死信队列 + 幂等键防重复扣费 |
| 5 | **`generations` 审计表定义了却从未写入** | `db.ts:28` vs 无写入点 | 必须落地，并补 cost / latency / token usage |
| 6 | **生成进度只存组件 `useState`** | 所有生成组件（8.4.2） | 服务端权威状态 + SSE 推送 + 全局任务中心 |
| 7 | **断点续跑只写句柄无恢复消费者** | `video-shot.ts:96-103` 写入 `pendingVideoTask`，无恢复逻辑 | Worker 启动时扫描未完成任务自动接管 |
| 8 | **`Asset.blob` 二进制内联进 DB** | `domain.ts:135-145` | 对象存储 + DB 只存 key/hash/size/metadata |
| 9 | **内联数组导致 O(n) 全表扫描** | `characters.ts:42`（`characterIds.includes`） | 关联表 + `ON DELETE CASCADE` |
| 10 | **API Key 明文存 `localStorage`** | `store/settings.ts` + persist | 服务端加密存储（KMS），前端只见掩码 |
| 11 | **导出备份 base64 内联 + 一次性 `JSON.stringify`** | `json.ts:75,174-184` | 流式 ZIP + 外置资源 + 异步导出任务 |
| 12 | **备份里 `appVersion` 硬编码为 `'0.1.0'`（实际 0.4.1）** | `BackupRestore.tsx:24` | 从构建注入版本号，杜绝手写 |
| 13 | **Structured Output 只用 `json_object` 不用 JSON Schema** | `llm/client.ts:35` | 上 `json_schema` strict 模式，把已登记角色名做成 enum 消除幻觉 |
| 14 | **仅靠 Prompt 约束 + 正则容错兜底格式** | `pipeline/storyboard.ts:162-181` | Schema 为主，容错降级为辅 |
| 15 | **`Project.style` 自由文本 + substring 反查预设** | `prompts/style-presets.ts:188-194` | `style_preset_id` 外键，杜绝匹配失败静默降级 |
| 16 | **分镜文本 / image_prompt 在 UI 上完全只读** | `StoryboardList.tsx:151-157` | SVH 必须支持人工精修（AI 生成 + 人工编辑是核心工作流） |
| 17 | **分镜无角色选择器**，LLM 认错角色无法手动修正 | 8.5 | 提供角色绑定 UI + 参考图身份标注到 prompt |
| 18 | **状态枚举缺「生成中」态**，失败不写回 status | `StoryboardList.tsx:18-23` | 完整状态机 `queued/running/succeeded/failed/cancelled` |
| 19 | **架构文档声称 6 阶段，实际只实现 3 个**（`rewrite`/`camera` 缺失） | `docs/ARCHITECTURE.md:77-92` | 文档与代码同源，或为阶段实现加测试门禁 |
| 20 | **`pendingVideoTask` 句柄不自包含**（缺 baseUrl/model） | `video/types.ts:17-20` | 任务句柄携带 provider 配置快照 |
| 21 | **移动端导航缺失**（`<sm` 隐藏项目入口） | `AppHeader.tsx:30,50-56` | 移动端汉堡菜单 / 底部 Tab |
| 22 | **Modal 无 focus trap，Escape 绕过提交守卫** | `modal.tsx:31` | 用 Radix Dialog，补齐 a11y |
| 23 | **删除确认体系分裂**（5 处原生 `confirm` + 1 处规范 Modal） | 8.9 #8 | 统一 `ConfirmDialog` 组件 |
| 24 | **批量终态摘要死代码**（跑完看不到失败汇总） | `BatchVideoButton.tsx:90-92` vs `:116` | 覆盖测试 + 终态持久展示 |
| 25 | **Design Token 只有颜色/圆角/字体，缺 spacing 与 typography** | `globals.css` | 按 AGENTS.md 补齐完整 token 阶梯 |
| 26 | **Emoji / Unicode 当图标** | `CameraMovementSelect.tsx:5-17` | 统一图标库 |
| 27 | **i18n 覆盖断裂**（4 个核心业务页 0 个 `t()`） | 8.7 | i18n 完整性纳入 CI 检查 |
| 28 | **环境配置硬编码进仓库**（`allowedHosts: ['.kv2ray.cc']`） | `vite.config.ts:25` | 环境变量注入 |

### 10.3 总体判断

**dramai 对 SVH 的价值定位**：它是一个**「业务建模与 Prompt 工程的成熟参考答案」**，而不是**「架构与工程可靠性的参考」**。

具体来说：
- **可以直接拿走的东西（★★★）**：分镜 System Prompt 全文、20 个风格预设、`Storyboard` / `Character` / `Provider` 的数据结构、`AsyncGenerator` 事件流契约、`submit/poll` 异步任务抽象、SSE 解析器、`Generation` 审计字段清单、工作台分段骨架、批量交互细节、异步阶段命名法。
- **需要改造后使用（★★☆）**：JSON 容错（降级为 fallback）、资产生命周期管理（改签名 URL）、UI 薄组件层（补 Radix 行为层）、Design Token（补 spacing/typography/双主题）、备份格式（二进制外置）。
- **必须彻底重做（❌）**：任务编排与状态承载（BullMQ + 全局任务中心）、并发与重试、版本历史与回滚、二进制存储（对象存储）、密钥安全（服务端加密）、成本可观测性。

**一句话**：**dramai 用 7.5k 行证明了「AI 短剧创作」的业务流程该怎么建模、Prompt 该怎么写；它也用满身的架构妥协证明了「无后端」这条路走不远。SVH 要做的，是把前者完整继承下来，把后者用 Fastify + PostgreSQL + BullMQ 逐条解决。**
