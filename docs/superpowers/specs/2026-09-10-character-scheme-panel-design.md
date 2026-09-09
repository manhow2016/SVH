# 角色面板重构：形象方案 + 主形象 + 配音音色 设计文档

> 日期：2026-09-10
> 状态：已与需求方确认（界面入口、方案语义、方案数、音色落地、导入语义均已拍板）
> 目标版本：V0.3 增量（在既有 Production / Provider / Worker 底座上扩展，禁止重写既有系统）

---

## 一、背景与目标

制作中心「角色」页签当前是卡片列表 + 新建/编辑两个文本弹窗：角色创建后无形象图、
无方案选择、音色仅一个 TTS voice 名字符串，不符合真实短剧生产流程（生形象 → 选主形象 →
配音色）。本次把「角色」页签整体重做为目标交互（参考需求方确认图）：

```
┌ 角色切换器： [小明] [小红] ・・・  + 新建角色（横向滚动）
┌ 详情头： 头像(主形象) 小明 · N个形象   [从资产中心导入] [删除角色]
├ 形象卡： 【初始形象】 【主形象】 请选择一张图片 / 已选择主形象
│   方案网格 1~6 张（缩略图 + 右下「方案n」+ 右上 ✓ 选中） + [重新生成]
│   提示行：选择并确认后，可对图片进行编辑和修改
└ 配音音色卡（状态绿点）：
   空态： [已上传] [资产库] [AI智能设计]
   已选： 音色名 + [试听音色]（播放/停止）+ [更换]
```

**目标**：用户能在角色页签内完成「生成形象方案 → 选主形象 → 设置角色音色（三种来源）→ 试听」
的完整闭环，且主形象直接服务于既有【角色一致性 / 参考图注入】链路。

**非目标**（本期不做）：
- 方案图单张删除（重新生成即换批）
- 多代方案回看（历史批次保留但不展示）
- 成片/口播对音色的最终使用（配音链路沿用 `character.voice` 名，音频资产仅用于展示/试听/将来口播）

---

## 二、需求决策记录（已与需求方确认）

| 项 | 决策 |
|---|---|
| 界面接入 | 整个「角色」页签重做（顶部角色切换器 + 当前角色详情），卡片列表与新建/编辑弹窗移除 |
| 方案语义 | 当前批次 + 主形象：重新生成换批；历史批次保留、界面仅展示当前批次 |
| 方案数 | 1~6（用户可选，缺省 3） |
| 主形象 | 选中方案 = `character.referenceAssetId`（零改动复用一致性/参考图链路） |
| 从资产中心导入 | 从全局资产库选一张图，直接作为主形象（不生成方案） |
| 音色落地 | 三种来源统一落为项目 audio 资产；角色新增 `voice_asset_id` 引用；AI 生成回填 `voice`（TTS 名） |
| 编辑入口 | 保留「编辑角色」（现有弹窗：名称/描述/外貌/视觉档案 visualProfile），作为详情头入口 |
| 删除角色 | 同时清理该角色的方案资产（防孤儿） |

---

## 三、数据模型（零新表）

### 3.1 方案图 = 项目 image 资产 + metadata 打标

每次「生成形象方案」为一条 **batch**：

```
batchId = randomId（一次请求一个批次）
每张方案资产 metadata 打标：
  {
    ...(原有 metadata 保留),
    svhRole: "character_scheme",
    characterId: "<character id>",
    batchId: "<batchId>",
    seq: 1..count
  }
```

- **当前批次** = 该角色 `svhRole=character_scheme` 且 `batchId` 等于最新 batchId 的资产集
  （按 batchId 的创建时间取最新；无任何批次 → 空态）
- 重新生成 = 新 batchId；旧批次保留、不展示
- 方案资产类型恒为 `image`

### 3.2 主形象

`character.reference_asset_id`（已有列，语义不变）。UI「选中 ✓」= 把 referenceAssetId
设为所选方案资产 id；一致性/参考图注入链路零改动。

### 3.3 角色音色

`production_characters` 新增列（幂等迁移，与历史 migration 同模式）：

```sql
ALTER TABLE production_characters ADD COLUMN voice_asset_id TEXT;
```

- `voice_asset_id` = 项目 audio 资产 id（已上传 / 资产库引用 / AI 生成 三来源统一）
- 保留既有 `voice`（TTS voice 名；AI 智能设计生成后回填，供配音链路使用；已上传/资产库
  来源不回填，渲染链播报沿用旧语义）
- 删除音色（更换时置空）：`voice_asset_id` 置空 + 保留 `voice` 不变

---

## 四、后端 API

### 4.1 新端点：生成形象方案

```
POST /api/projects/:projectId/characters/:characterId/schemes
Body: { count?: number }            // 1~6，缺省 3；越界 400 INVALID_INPUT
→ 200 { taskIds: string[], batchId: string, total: number }
```

实现：`GenerationService.enqueueImage` 新增可选入参
`characterMeta?: { characterId: string; batchId: string; seq: number }`：

- prompt 由上层（路由/service）用「角色视觉档案 + 描述」组合（复用 V0.3
  `toCharacterPromptSnippets` / `deriveCharacterPromptAnchor`；无档案时回退 description）
- 每次入队写入 `TaskPayload.characterMeta`（server ↔ worker 手写字面量同步）
- 路由按 `count` 逐张入队，共享同一 `batchId`（randomId）
- `assertProjectOwned` 归属校验（越权/不存在一律 404）

### 4.2 Worker：transferMeta 落资产 metadata

`apps/worker/src/queue.ts` TaskPayload 新增：

```ts
transferMeta?: Record<string, unknown>;   // 字符标记（characterMeta 扁平化），入资产 metadata
```

`runImageTask` 创建资产时：

```ts
metadata: { ...(first.b64Json ? { b64Json } : {}), ...(p.transferMeta ?? {}) }
```

- 只对 `image` 任务生效；失败不阻断（metadata 打标失败 = 方案可能不可见，可接受，
  由列表端点对账兜底——见 4.6）
- server 端 `generation-service.ts` TaskPayload 同步该字段（JSON 契约注释更新）

### 4.3 列表：方案资产查询

```
GET /api/projects/:projectId/characters/:characterId/schemes
→ 200 { batchId: string | null, schemes: Array<{ id, assetId, name, seq, url?, localSrc? 前置元数据 }> }
```

实现：`listAssets(projectId, "image")` + 内存过滤 `metadata.svhRole === "character_scheme"
&& characterId === id`，按最新 batchId 分组取当前批次，seq 排序。
（规模小，不做 SQL JSON 查询。）

### 4.4 主形象 / 音色设置

复用 `PATCH /api/characters/:id`（已有 updateCharacter），body 新增可选 `voiceAssetId`：
- `referenceAssetId`：已支持（主形象 = 选中的方案资产）
- `voiceAssetId`：service 校验目标资产存在且 `asset.projectId === character.projectId`
  且 `type === "audio"`，否则 400 VALIDATION

### 4.5 新端点：音色二进制上传

```
POST /api/projects/:projectId/assets/audio-upload?name=<urlencoded>&mimeType=<audio/...>
Body: raw binary（audio/mpeg | audio/wav | audio/mp4 白名单；>50MB 拒绝 413）
→ 200 { asset: ProductionAssetView }
```

实现（apps/server routes/production.ts 或新文件）：
- Fastify raw body 解析（新增 contentTypeParser 覆盖三种 audio 类型，限长）
- 落盘：`<workspaceRoot>/<workspaceId>/media/audio/<assetId>.<ext by mime>`（与 localize
  前缀语义一致；`LOCALIZE_DIR_PREFIX` 复用——目录字面量单一事实源）
- `production.createAsset({ type: "audio", workspacePath, mimeType, metadata: { [LOCALIZE_METADATA_KEY]: { state: "ready", ... } } })`
- 覆盖同名会随机 id，不存在覆盖问题；权限一律 `assertProjectOwned`

### 4.6 对账兜底（本期不做，标注限制）

若最新 batch 存在但某 task 的资产 metadata 未打标（worker 异常退出窗口），由「重新生成」
自愈（新批重打标）。**本期不做读时补标**，已知限制见「§九」。

### 4.7 音色资产库 / AI 智能设计（全复用，无新端点）

- 资产库：`POST /api/projects/:projectId/assets` body `{ type:"audio", name, assetLibPath }`
  （已有；metadata.libraryPath + 引用行）
- AI 智能设计：`POST /api/projects/:projectId/assets/generate-audio`（已有 TTS 入队）
- 试听：前端复用 `assetLocalSrc` / `assetLibrarySrc`（本地优先，远程回退）

### 4.8 删除角色清理

`DELETE /api/characters/:id`（已有）扩展：删除角色后删除其全部
`svhRole=character_scheme && characterId=id` 的资产（顺序：先查后删，尽量用已有
deleteAsset 语义；失败不阻断角色删除，残留由下次清理/列表对账兜底——本期接受）。

---

## 五、前端（apps/web 角色页签重做）

### 5.1 组件结构

```
CharacterWorkspacePanel (替换 CharactersPanel)
├─ CharacterSwitcher      顶部：角色标签（横向滚动）+ "+ 新建角色"（弹窗沿用现有创建表单）
├─ CharacterDetail
│  ├─ Header              avatar(主形象缩略) + 名称 + "N个形象" + [从资产中心导入] [编辑角色] [删除角色]
│  ├─ SchemeCard          【初始形象】【主形象】标签 / 引导文案 / 方案网格 / [重新生成] / 数量选择器
│  └─ VoiceCard           配音音色 · 状态点 / 三来源按钮 / 试听播放 / 更换
│     ├─ VoiceUploadModal 已上传（文件选择 mp3/wav/m4a，<=50MB）
│     ├─ VoiceLibraryModal 资产库（cascader：文件夹→音色→文件，复用 assetsApi.list）
│     └─ VoiceAIModal      AI 智能设计（试听文本 + 风格 VOICE_OPTS + 生成数=1 → TTS 任务）
└─ EditCharacterModal     保留现有编辑弹窗（视觉档案/描述/参考资产），加"当前音色"只读展示
```

### 5.2 交互细节

- **方案状态机**：空态（无批次）→ 显示「生成形象」+ 数量选择器；有批次未选 → 显示当前批
  方案 + 「请选择一张图片」；已选 → 主形象卡 ✓ + 显示「已选择主形象」
- 选中方案 → `updateCharacter(referenceAssetId=scheme.assetId)` → 刷新列表；✓ 落在当前
  批次的参考资产 id 匹配项上
- 「重新生成」：确认后新批入队，旧批隐藏；任务轮询复用「生成进度」组件（进度徽标 + 完成提示）
- 「从资产中心导入」：选择资产库任意图片 → createAsset(assetLibPath, type=image) → 自动设为
  主形象（referenceAssetId）→ 方案区显示为「导入形象（非方案批次）」
- 音色三种来源：选定后保存为角色音色（voiceAssetId + 名称）；AI 生成成功后把 asset.id
  设为主形象式选择；试听 = audio 播放（本地优先）
- **移动端**：切换器横滚、方案网格 2 列、弹窗宽度 100%（min(560, 100vw)）
- 删除角色：Modal.confirm（提示将删除角色及其方案图）→ DELETE → 回列表

### 5.3 状态与反馈

- 方案生成中：任务进度行（排队/生成中%/完成/失败详情）复用 AssetsPanel 模式；全部终态
  后自动刷新方案网格
- 主形象/音色保存中：按钮 loading；失败 message.error（显示后端错误）
- 空态/错误态按 UI 规范（Empty 有主操作；Error 说明原因）

---

## 六、安全与边界

- 新端点全部 `assertProjectOwned`（跨用户/不存在 = 404 隐藏存在性，与现有一致）
- audio 上传：mime 白名单 + 大小上限（413）+ `resolveSafeWorkspacePath` + randomId 文件名
- 方案生成 prompt 无用户自由注入路径（只读角色档案 + 描述拼接）
- 一致性链路零改动：主形象 = referenceAssetId（已存在的注入/Anchor 行为不变）
- 服务端 ↔ worker 新增字段走既有 JSON 契约（手写字面量 + 注释同步）

---

## 七、测试矩阵

| 层 | 用例 |
|---|---|
| packages/production | voiceAssetId 更新校验（非本项目资产 400 / 非 audio 类型 400）、schemes 批次分组（最新批 / seq 排序 / 无批次空） |
| apps/server routes | schemes 端点：count 越界 400、越权 404、成功 taskIds+batchId 且 payload.characterMeta 落库；audio-upload：白名单外 400、无权限 404、成功 200 + asset.workspacePath ready、超大 413；PATCH voiceAssetId 成功/校验失败 |
| apps/worker | transferMeta 合并进资产 metadata（image 任务）；无 transferMeta 行为不变 |
| apps/web | typecheck / lint；交互冒烟（见实施计划验证节） |
| 回归 | 既有角色相关测试（tools.test / generation.test）全绿 |

---

## 八、实施顺序

1. database 迁移：`voice_asset_id` 列（幂等）
2. production service：updateCharacter 支持 voiceAssetId + 校验；listCharacterSchemes 助手
3. worker：TaskPayload.transferMeta + runImageTask 合并
4. server：generation-service 入参 characterMeta + payload；schemes 路由（生成/列表）；
   audio-upload 路由（raw body）
5. server：删除角色扩展清理方案资产
6. web：CharacterWorkspacePanel 重做（切换器/详情/形象卡/音色卡/三来源弹窗/编辑弹窗保留）
7. 测试与验证：typecheck/lint/单测 + 浏览器冒烟（新建角色 → 生成方案 → 选主形象 →
   重新生成 → 音色三来源 → 试听 → 删除）

---

## 九、已知限制（验收时明示）

1. 方案批次 metadata 缺失时不做自动补标（worker 崩溃窗口极小；重新生成即可自愈）
2. 旧批次方案图保留但不可回看（需求决策）
3. 已上传/资产库音色不影响配音链路（仍按 `voice` TTS 名；后续口播需求再接线）
