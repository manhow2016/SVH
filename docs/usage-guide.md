# SVH 系统使用帮助

> SVH（AI 短剧智能生产系统）：从剧本 → 分镜 → 生成 → 审核 → 成片的一体化短剧生产工作台。
> 本文档面向系统使用者（制作人 / 导演 / 运营），介绍界面操作、生产流程与常见问题。

---

## 目录

1. [快速开始](#快速开始)
2. [核心概念](#核心概念)
3. [界面引导](#界面引导)
4. [标准生产流程](#标准生产流程)
5. [时间轴与成片渲染（V0.3）](#时间轴与成片渲染v03)
6. [运行与运维](#运行与运维)
7. [常见问题 FAQ](#常见问题-faq)
8. [附录：常用接口索引](#附录常用接口索引)

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动系统（一次性启动三个进程）

```bash
pnpm dev
```

- `server`（API 服务，默认 `http://localhost:3000`）
- `worker`（异步任务执行：AI 生成、配音、成片渲染）
- `web`（前端界面，默认 `http://localhost:5173`）

也可以单独启动：

```bash
pnpm --filter @svh/server dev   # 后端 API
pnpm --filter @svh/worker dev   # 异步任务 worker
pnpm --filter @svh/web dev      # 前端界面
```

> ⚠️ 三者必须同时运行：浏览器只管界面，AI 生成与成片渲染都由 worker 完成。

### 3. 登录

打开 `http://localhost:5173` → 注册账号（或使用管理员账号 `admin / admin123456`）→ 登录进入**工作台**。

### 4. 配置模型（首次必做）

「设置」→ 模型配置中启用所需供应商模型（图像 / 视频 / 语音），填入对应 API Key。未配置模型时，生成类操作会提示「未配置可用的图片模型」。

---

## 核心概念

| 概念 | 说明 |
|---|---|
| **工作区** | 生产数据的隔离单元（个人默认一个；文件与资产按工作区存放） |
| **项目** | 一部短剧（类型 short_drama），包含剧本、角色、场景、分镜、镜头、资产、时间轴 |
| **剧本** | 项目故事文本（有版本号，改动版本 +1） |
| **角色** | 剧本人物，支持外观/性格/形象方案（选**主形象**，可作为一致性参考图）/配音音色/视觉风格 |
| **场景** | 剧本中的地点段落（有出场角色） |
| **分镜** | 场景下的镜头规划（时长、景别、画面/视频提示词） |
| **镜头** | 最小拍摄单元；一个分镜可拆多个镜头；镜头有状态（pending → generating → ready / failed） |
| **资产** | 所有媒体统一管理：图片 / 视频 / 音频 / 字幕 / 文档。本地化后可离线使用 |
| **生成记录** | 一次生成的完整账本（提示词/供应商/版本/审核状态/产出资产），同镜头支持多版本 |
| **时间轴** | 成片组织的正式模型：项目 → 时间轴 → 轨道 → 剪辑；状态：草稿→编辑→就绪→渲染中→完成/失败 |
| **任务** | 异步工作单元（生成 / 配音 / 渲染），由 worker 认领执行，可查询与取消 |
| **工作流** | 一键编排：剧本生成 → 角色抽取 → 分镜生成 → 图片/视频批量生成 → 审核节点（等待用户裁定后自动续跑） |

---

## 界面引导

### 工作台（Workbench）

- 左侧：**工作区导航 + 文件树**（生成资产自动转存到工作区，可直接预览/下载）
- 右侧：**Agent 对话**——用自然语言指挥 Agent 操作生产数据（Agent 可通过内置工具创建项目、剧本、角色、分镜、镜头、时间轴等）

### 制作中心（Production）

- **项目列表**：查看/创建项目（「新建项目」按钮）
- **项目详情页**（制作中心）：按标签组织

| 面板 | 功能 |
|---|---|
| 剧本 / 角色 / 场景 / 分镜 | 增删改查；空态时点「新建」即可创建；「角色」页签内含**形象方案 / 主形象 / 配音音色**工作台（见「标准生产流程」第 3 步） |
| 镜头（ShotDetailPanel） | 按分镜展示镜头，设置时长/动作/对白；查看/触发生成 |
| 资产 | 统一媒体库：手动录入外部素材、本地化转存、查看生成来源 |
| **Prompt Inspector** | 查看每条生成任务的最终提示词与组合来源（模板/项目/角色/供应商），**可编辑后重新发起生成** |
| **待审核（ReviewQueuePanel）** | 按分镜分组的待审队列：逐条或**整组**通过（approve）/ 拒绝（reject）/ 替换（replace），自动续跑等待中的工作流 |
| **工作流（WorkflowPanel）** | 创建/运行/暂停/恢复/取消/重试；生成节点与审核节点状态可视化 |

### 设置

- 模型配置（供应商 / 模型 / API Key / 备用模型）
- 账号与会员信息

### 管理端（admin）

- 用户 / 订阅 / 配置管理（管理员账号可见）

---

## 标准生产流程

### 第 1 步：创建项目

制作中心 → 新建项目（选择工作区、填写名称）。

### 第 2 步：编写剧本与角色

- 方式 A：Agent 对话「帮我写一个仙侠短剧剧本并建项目」——Agent 会自动调用工具创建剧本、角色、场景
- 方式 B：面板手动创建（剧本需标题+内容；角色含外观/人物小传；场景需名称+描述）

### 第 3 步：配置角色形象与音色（角色页签）

制作中心 → 项目详情 →「角色」页签（顶部为角色切换器，可新建/切换角色）：

1. **生成形象方案**：空态点「生成形象」，选数量（1~6，默认 3）→ 提交 → 任务进度（队列/生成中/失败原因见提示）→ 完成后展示方案网格。
2. **选中主形象**：点某张方案 →「已设为主形象」；主形象同时是该角色的**一致性参考图**，后续生成自动带参考（参见第 5 步），刷新后保持选中。
3. **重新生成换批**：点「重新生成」重选数量并确认 → 新批次生成完成后**替换展示**；旧批次保留在资产中但不展示（每次只呈现最新一批方案）。
4. **从资产中心导入**：详情头「从资产中心导入」可选任意图片直接设为主形象（不生成新方案）。
5. **配音音色**（音色卡；三来源统一保存为项目音频资产）：
   - **已上传**：上传 mp3 / wav / m4a（单个 ≤50MB），上传后立即设为该角色音色；
   - **资产库**：从「我的资产库」选择音频文件，导入为项目音色并设为该角色音色；
   - **AI 智能设计**：输入试听文本 + 选择风格 →「生成并试听」→ 任务完成后自动设为音色（并记录该风格为 TTS 名）。
   - 选定后可点「试听音色」播放/暂停；「更换」可重新从三来源中选择。
6. **编辑 / 删除**：详情头「编辑角色」保留视觉档案等编辑（含 TTS voice 名）；「删除角色」会一并清理该角色的全部形象方案图片（含历史批次），删除前有确认提示。

> 说明：配音/成片任务仍按角色编辑弹窗中的「配音音色（TTS voice 名）」执行，音色卡的音频资产用于角色页签展示与试听。

### 第 4 步：编排分镜与镜头

- 场景 → 分镜（时长/景别/提示词）→ 镜头（时长、动作、对白；同一分镜下镜头时长之和不得超过分镜时长）
- 一个分镜可拆多个镜头（多机位/多段）

### 第 5 步：生成

- **单张生成**：镜头详情触发（文生图 / 图生视频 / 配音；自动注入角色 Prompt Anchor、项目视觉风格、参考图）
- **批量生成**：按范围（项目/场景/分镜/指定镜头）一键批量入队（`generations/batch`），自动关联首帧图后追加视频项
- 生成过程中可查看任务状态；**提示词可在 Prompt Inspector 查看、编辑、重新生成**

### 第 6 步：审核与版本

- 生成的每个版本都保留（v1/v2/v3…），审核状态：待审核 → 通过 / 拒绝 / 替换
- **通过** = 该镜头选中此资产（记入 `shot.imageAssetId / videoAssetId`），后续工作流自动放行
- 参考图（角色一致性）：角色配置参考资产后，生成自动带上参考图；供应商不支持时自动降级为纯文本提示词

### 第 7 步：成片（时间轴渲染）

见下一节。

---

## 时间轴与成片渲染（V0.3）

> 时间轴 UI 面板还在路上，当前通过 **接口** 或 **Agent 工具** 完成全部操作；以下是使用路径与规则。

### 概念

```
项目 Project
 └── 时间轴 Timeline（名称/帧率/分辨率/状态/版本/总时长）
      ├── 轨道 Track（video 视频 / audio 音频 / subtitle 字幕 / overlay 预留）
      │    └── 剪辑 Clip（引用现有资产 + 来源镜头 + 起点/时长/源裁剪区间）
```

- **剪辑引用既有资产，不重复上传**；video 轨道必须绑定 video 资产，audio 轨道必须绑定 audio 资产
- 派生列：`总时长 = 所有剪辑最晚终点`；任何内容变更自动 `版本 +1`
- 状态机：`草稿 draft → 编辑 editing → 就绪 ready → 渲染中 rendering → 完成 completed / 失败 failed`（完成后可回退再编辑或重渲染）

### Agent 工具路径（推荐）

Agent 对话即可完成（底层 7 个时间轴工具）：

1. `create_timeline` — 建时间轴
2. `add_timeline_track` — 建视频/音频轨道
3. `add_timeline_clip` — 往轨道放剪辑（必须给出资产与时间）
4. `update_timeline_clip` / `delete_timeline_clip` — 调整剪辑
5. `get_timeline` — 查看详情（含总时长/版本/剪辑列表）
6. `auto_create_timeline` — **一键成片**：按「场景 → 分镜 → 镜头」顺序自动排轨，每镜头优先用已选中（审核通过）的视频素材，否则用该镜头最新完成的生成视频；没有素材的镜头自动跳过并说明

示例对话：

```
「为项目 XXX 自动创建时间轴并置为就绪」
```

Agent 会依次调用工具完成：auto_create_timeline →（如有缺素材镜头，提示补生成）→ 更新状态 ready。

### 接口路径（批量/自动化）

| 操作 | 接口 |
|---|---|
| 创建/列出时间轴 | `POST / GET /api/projects/:projectId/timelines` |
| 自动生成时间轴 | `POST /api/projects/:projectId/timelines/auto` |
| 详情/改名/改状态 | `GET / PATCH / DELETE /api/timelines/:id` |
| 添加轨道 | `POST /api/timelines/:timelineId/tracks` |
| 添加剪辑 | `POST /api/timeline-tracks/:trackId/clips` |
| 更新/删除剪辑 | `PATCH / DELETE /api/timeline-clips/:id` |
| **发起渲染** | `POST /api/timelines/:id/render` |
| 查询任务 | `GET /api/tasks/:id`（渲染任务 kind=`timeline_render`） |

### 渲染与成片

1. 时间轴置为 **ready**（状态非 ready 时渲染返回 409，且明示当前状态）
2. `POST /api/timelines/:id/render` → 任务入队（`queued`），时间轴进入 `rendering`
3. worker 认领后执行 FFmpeg 渲染：
   - **画面**：视频轨剪辑按时间顺序拼接；剪辑间空白自动补黑场；每段自动统一到时间轴分辨率/帧率（黑边自动 pad）
   - **音频**：音频轨剪辑按各自时间点对齐混音
   - **字幕**：字幕资产（SRT 文本）按时间轴平移后烧录（libass；滤镜不可用时跳过烧录，不影响成片）
4. 完成后：产出 **成片视频资产**（在「资产」面板可见，已本地化可预览/下载），时间轴状态 → `completed`；失败 → `failed`（可从失败回退再编辑重试）

> ⚠️ 渲染依赖：
> - worker 进程正在运行
> - 本机有 ffmpeg（仓库已附 `@ffmpeg-installer` 静态二进制；也可用 `SVH_FFMPEG_PATH` 指向系统 ffmpeg）
> - 所有剪辑素材已本地化（生成类资产完成后自动转存；远程 URL 素材渲染时会自动临时下载兜底）

### 常见校验规则（违反报 400/409）

| 规则 | 说明 |
|---|---|
| 视频/音频轨剪辑必须绑资产 | 不绑 → 400 |
| 类型匹配 | video 轨只能放 video 资产 → 否则 400 |
| 同项目 | 剪辑引用的资产/镜头必须属于同一项目 → 否则 400 |
| 剪辑起点 | 不得超过时间轴当前总时长（终点可延伸） → 否则 400 |
| 状态机 | 非 ready 渲染 / rendering 重复提交 → 409 |
| 无可用素材 | 自动生成时项目无已就绪视频素材 → 400 并提示 |

---

## 运行与运维

### 常用命令

```bash
pnpm dev                        # server + worker + web 一键启动
pnpm --filter @svh/server dev   # 仅后端
pnpm --filter @svh/worker dev   # 仅任务 worker
pnpm --filter @svh/web dev      # 仅前端
pnpm build                      # 全部构建
pnpm typecheck / pnpm lint      # 类型检查 / 代码检查
```

### 数据位置

| 项 | 路径 |
|---|---|
| 数据库 | `data/svh.db`（SQLite） |
| 工作区文件（转存资产/成片） | `data/workspaces/*/media/*` |
| 日志 | 进程 stdout（dev 模式热更新） |

### 关键环境变量

| 变量 | 说明 |
|---|---|
| `SVH_DATABASE_URL` | 数据库路径（默认 `./data/svh.db`） |
| `SVH_WORKSPACE_ROOT` | 工作区根目录（server 与 worker 必须一致） |
| `SVH_FFMPEG_PATH` | 自定义 ffmpeg 路径（默认用仓库内置二进制） |
| `SVH_WORKER_CONCURRENCY` | worker 并行任务数（默认 2） |
| `SVH_WORKER_PROVIDER_BUDGET` / `SVH_WORKER_PROJECT_BUDGET` | 按供应商/项目的并发预算（0=不限） |
| `SVH_LOCALIZE_MAX_BYTES` / `SVH_LOCALIZE_TIMEOUT_MS` | 转存下载上限/超时 |

### 任务队列

- 所有 AI 调用都是异步任务：入队（`queued`）→ worker 认领（`running`）→ 终态（`completed / failed / cancelled`）
- 任务可取消（`POST /api/tasks/:id/cancel`）；worker 崩溃遗留的任务由心跳超时自动回收重派
- 列表页可观察任务状态；任务失败原因见 `error` 字段

---

## 常见问题 FAQ

**Q1：点了生成，任务一直 queued 不动？**
worker 未运行或正忙。确认 `pnpm --filter @svh/worker dev` 在跑；提高并发预算或减少任务数。

**Q2：提示「未配置可用的图片模型」？**
「设置」中启用并配置对应供应商模型与 API Key。

**Q3：渲染返回 409「不允许从 draft 变更到 rendering」？**
时间轴还没置为 ready。先 `PATCH /api/timelines/:id` 设 `status: ready` 再渲染。

**Q4：渲染失败「未找到 ffmpeg」？**
安装系统 ffmpeg（`apt install ffmpeg`）或设置 `SVH_FFMPEG_PATH` 指向可执行文件。

**Q5：素材丢失/资产被删，时间轴剪辑还在？**
剪辑引用资产删除后自动解绑（`ON DELETE SET NULL`），渲染前校验会提示具体剪辑缺素材，补绑后重试。

**Q6：自动生成时间轴时某些镜头被跳过了？**
该镜头没有「审核通过的选中视频」也没有「已完成生成的视频」。先为该镜头生成/通过审核，再重新自动生成（每次生成新建一条时间轴，不覆盖旧的）。

**Q7：跨用户/跨工作区看不到对方项目？**
权限隔离：非本人工作区资源一律按「不存在」处理（404），属于设计行为。

**Q8：提示词在哪看？**
制作中心 → Prompt Inspector（任务/历史提示词、组合来源）；生成记录按版本保留，可编辑后重新生成（v+1）。

---

## 附录：常用接口索引

| 能力 | 接口 |
|---|---|
| 注册 / 登录 | `POST /api/auth/register` / `POST /api/auth/login` |
| 项目 | `POST /api/productions`；`GET /api/projects/:projectId/production` 等（同工作区） |
| 剧本 / 角色 | `POST /api/projects/:projectId/scripts`；`POST /api/projects/:projectId/characters` |
| 角色形象方案 / 音色 | `POST / GET /api/projects/:projectId/characters/:characterId/schemes`；`POST /api/projects/:projectId/assets/audio-upload`；`PATCH /api/characters/:id`（referenceAssetId / voiceAssetId） |
| 场景 / 分镜 / 镜头 | `POST /api/projects/:projectId/scenes`；`/storyboards`；`/shots` |
| 资产 | `POST /api/projects/:projectId/assets`；`GET /api/projects/:projectId/assets?type=` |
| 生成 | `POST /api/projects/:projectId/assets/generate-image / generate-video / generate-audio` |
| 批量生成 | `POST /api/projects/:projectId/generations/batch` |
| 生成记录 / 审核 | `POST/GET /api/projects/:projectId/generations`；`POST /api/generations/:id/approve / reject / replace / regenerate` |
| 批量审核 | `POST /api/projects/:projectId/generations/batch-review` |
| 任务 | `GET /api/tasks/:id`；`POST /api/tasks/:id/cancel` |
| 时间轴 | 见上文「时间轴与成片渲染 - 接口路径」表 |
| 本地化转存 | `POST /api/assets/:assetId/localize` |

> 变更提示：本文档对应 **V0.3（含时间轴成片系列 Phase 0–8）与角色面板重构（V0.3.1，形象方案/主形象/配音音色）**。接口与界面以仓库代码为准，建议配合变更记录查看。
