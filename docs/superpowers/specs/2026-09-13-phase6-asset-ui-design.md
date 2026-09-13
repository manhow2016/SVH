# Phase 6 设计：Asset System 交互与 `@资产`

> 状态：设计已确认，待实施
> 前置阶段：Phase 0 ~ Phase 5B（已完成并提交）
> 对应技术文档：第 18 条（Asset System 统一模型）、第 48 条（局部修改语义）、
> 第 56 条（Design Token / 视觉一致性）、第 66 条（不静默失败）、第 71、72 条（前端结构）

## 1. 背景与目标

后端资产能力**已经完备**：列表（含 `q` 搜索、`type` 筛选、`slug` 精确查询）、创建、
详情、更新（深合并 + 版本）、归档、版本历史、版本恢复、引用查询、`@引用`解析、
媒体体检，共 10 个端点。而前端**几乎什么都没有**：

- `Composer` 的 `@` 补全（调 `/api/assets` 与 `resolve-mentions`）
- 结果卡上的 `assetId`（只作为数据存在，不可点）

用户因此**看不到也管不了**自己的资产：Agent 生成的角色、场景、品牌散落在数据库里，
只能通过对话间接影响它们；用户自己知道的品牌调性、产品卖点**没有任何录入入口**。

本阶段交付：

1. 项目内资产库页面（浏览 / 搜索 / 按类型筛选 / 加载更多）
2. 资产的创建与编辑（7 类「创作实体」走中文表单）
3. `@资产` 成为一等交互：消息与结果卡里的资产可点开、补全带类型与封面、
   引用了不存在的资产时当场提示并可一键新建

本阶段**不做**：

| 不做的事 | 归属 |
| --- | --- |
| 版本历史与恢复的界面（后端端点已就绪） | Phase 10 |
| Creative Canvas / Timeline | Phase 7 |
| 媒体类型（图片/视频/音频/音色/音乐/Logo/字体）的 metadata 手填 | 不由用户手填，见 §5.2 |
| 跨项目的全局资产库 | 资产的创建必须带 `projectId`，跨项目不是本产品的复用主场景 |

## 2. 现状核对（设计前实测，不是推断）

| 事实 | 证据 |
| --- | --- |
| 创建资产**必须**带 `projectId` | `createAssetSchema` 里 `projectId: idSchema`（必填） |
| 列表**可以**不传 `projectId` | `listAssetsQuerySchema` 里 `projectId` 是 optional |
| 列表已支持搜索与筛选 | `q`（≤200 字）、`type`、`slug`、`status` + 分页 |
| 更新是**先深合并再整体校验** | `routes/assets.ts` 的 PATCH：`deepMerge(existing.metadata, input.metadata)` → `buildAssetData` |
| 深合并对数组是**整体替换**、对 `null` 是**显式清除** | `deepMerge` 实现 + `domain-contracts.test.ts` 的既有断言 |
| 删除是**软删除**（归档），被引用时拒绝 | `DELETE /api/assets/:id` 的注释与实现 |
| `character.metadata.appearanceFields` **没有任何代码读它** | 全仓 grep：只出现在 domain schema 与编译产物里 |

最后一条是本阶段发现的一个**死字段**：「中文键名外观，便于直接拼 Prompt」——
显然有人打算预计算一份中文键的 prompt 片段，但从未接线。
`api` / `worker` / `skills` / `agent` 读的一律是结构化的 `metadata.appearance`。
本阶段**不动 schema**（删字段会改到 `.strict()` 契约，历史资产若带它会突然不合法），
表单只编辑 `appearance`，死字段登记为后续任务。

## 3. 页面结构与入口

### 3.1 路由归属

```
/projects/:projectId/assets   →  AssetLibraryPage
```

**套 `AppShell`**（顶部主导航 + 内容区），与 `/projects`、`/settings/providers` 一致，
而**不**套工作台那种 100dvh 沉浸式布局：资产库是「查阅与维护」型页面，
用户在这里会想要直接回项目列表或去配置页。

### 3.2 入口

| 入口 | 位置 |
| --- | --- |
| 工作台头部「资产」按钮 | 与现有「任务」按钮并列 |
| 结果卡的 `assetId` | 深链 `/projects/:id/assets?asset=<id>`，落地直接打开抽屉 |
| 消息文本里的 `@名字` | 同上（匹配到才链接化，见 §6.2） |

### 3.3 深链

`?asset=<id>` 打开对应抽屉；关闭抽屉时**清掉查询参数**，使用户可以正常后退。
参数指向不存在或不属于本项目的资产时，退回列表并用 toast 提示一次（不常驻）——
不静默忽略：那会让人以为链接坏了却说不出为什么。

## 4. 文件结构

```
apps/web/src/features/assets/
├── AssetLibraryPage.tsx        列表 + 工具栏（搜索 / 类型筛选）+ 抽屉宿主
├── AssetLibraryPage.module.css
├── AssetDetailDrawer.tsx       详情：只读态（媒体类型）+ 编辑态（创作实体）
├── AssetCreateDialog.tsx       新建：先选类型 → 再填表单
├── assetLabels.ts              类型与枚举的中文标签（唯一出处）
└── metadata/
    ├── specs.ts                METADATA_SPECS —— 7 个类型的字段描述（**数据**）
    ├── MetadataForm.tsx        通用渲染器（**一个**）
    └── MetadataForm.module.css
```

**为什么是「数据表 + 一个渲染器」而不是 7 个手写表单**：字段描述是数据，
渲染器只认 6 种控件。新增类型或字段 = 往表里加一行；测试可以分别打
（表的完备性 vs 渲染器的行为），而 7 份手写表单只能逐个测，且改一处控件行为要改 7 遍。

## 5. metadata 表单

### 5.1 字段描述的形状

```ts
type FieldSpec =
  | { kind: 'text' | 'textarea'; key: string; label: string; help?: string }
  | { kind: 'number'; key: string; label: string; help?: string }
  | { kind: 'select'; key: string; label: string; options: ReadonlyArray<{ value: string; label: string }> }
  | { kind: 'tags'; key: string; label: string; help?: string }        // string[]
  | { kind: 'group'; key: string; label: string; fields: FieldSpec[] } // 嵌套对象

export const METADATA_SPECS: Record<AssetType, readonly FieldSpec[]>
```

`group` 这个控件正好解决「**同一个键在不同类型下形状不同**」：
`character.appearance` 是对象（用 `group`），`prop.appearance` 是字符串（用 `text`）——
同一份渲染器，两张表。

### 5.2 哪些类型可创建

| 类型 | 创建 | 编辑 | 理由 |
| --- | --- | --- | --- |
| `character` `scene` `prop` `costume` `brand` `product` `digital_human` | ✅ 表单 | ✅ 表单 | 用户才知道的信息（品牌调性、产品卖点、角色外观） |
| `image` `video` `audio` `voice` `music` `logo` `font` | ❌ | 只改 `name`/`description`/`tags` | 它们的 metadata 是**生成结果**（`width`/`format`/`duration`/`generation`），让用户手填只会填出与实际文件不符的数据 |

媒体类型的详情抽屉照常展示 metadata（只读），因为那正是排查「这份媒体为什么是这样」要看的东西。

### 5.3 通用字段

不走 `METADATA_SPECS`，所有类型都有：`name`（必填）、`slug`、`description`、
`tags`、`coverUrl`。

`slug` 在列表里要**显式展示**：`@slug` 才是用户实际会打的东西，
看不到 slug 就没法判断该 @ 什么。

## 6. 数据流与交互

### 6.1 列表 / 创建 / 编辑

**列表**

- `GET /api/assets?projectId=…&pageSize=50&page=1`，可叠加 `q` 与 `type`

  两个列表端点里选这一个，理由是实测出来的：`/api/assets` 在**不传 `status` 时
  自动排除 `archived`**（`{ status: { not: 'archived' } }`），正是资产库要的默认行为；
  而 `/api/projects/:id/assets`（Composer 补全用的那个）**没有状态过滤**，
  归档的资产会混进列表。另外前者的 `q` 还多搜一个 `description`。
- 搜索 **debounce 300ms**；类型筛选是即时按钮组（14 类 + 全部）
- 翻页用「加载更多」（响应里的 `hasMore` 已够用），与工作台会话列表同一风格
- 列表项：封面（无封面用类型图标）+ 名称 + 类型标签 + `slug`

**创建**：Dialog 两步 —— 先选类型（只列 §5.2 里 7 个可创建的）→ 再填通用字段 + 表单。
提交失败时保留已填内容，并把后端的文案显示出来：`buildAssetData` 已经把**字段路径**
拼进了 message（形如 `appearance.hair: …`），前端按 `字段.子字段:` 前缀尽量把错误
落到具体输入框；匹配不上就只在顶部显示原文。

**编辑**：只提交 **dirty 字段**，不提交整份 metadata。

理由是硬约束：表单只覆盖 7 个类型的一部分字段，而 Agent 会往 metadata 里写表单没有的
东西（`generation`、`reference_images`、`appearanceFields`）。提交整份 = 把那些字段
悄悄抹掉。服务端是「深合并之后再整体校验」，因此部分提交安全。

两个必须写对的细节：

- **清空一个可选字段发 `null`**（`deepMerge` 的显式清除语义），不是空串 ——
  否则会留下一个「有键但是空」的字段
- **数组整体替换**（如 `colors`、`sellingPoints`）：提交时必须给完整数组，
  不能只给新增项

### 6.2 `@资产`

- **结果卡的 `assetId`** → 深链 `/projects/:id/assets?asset=<id>`
- **消息文本里的 `@苏晚`** → 按项目资产清单的 `slug` 匹配后渲染成链接。
  匹配不上就保持纯文本 —— 宁可不可点，也不要链错。

  **清单要新拉一次**（自查时更正过一处写错的判断）：`Composer` 的资产清单是在
  用户敲 `@` 时才拉的（在 `loadSuggestions` 回调里），而消息渲染发生在页面加载时，
  两者时机不同，复用它拿不到数据。因此工作台加载时拉一次
  `GET /api/assets?projectId=…&pageSize=200` 建 `slug → id` 映射。
  上限 200 与「回捞结果卡」的 50 条是同一类取舍：**超出窗口的引用保持纯文本**，
  而不是猜。服务端在消息里带上 `mentions` 的 id 会更干净，但那要改消息协议，
  留到确实需要时再说。
- **`missing`（文本里出现但项目里没有的引用）** → 输入区上方提示
  「项目里还没有 @X、@Y」+「现在新建」按钮，打开创建对话框并**预填名称**。
  **不阻止发送**：改成阻塞会把一个提示变成一种新的失败

### 6.3 归档

`DELETE /api/assets/:id` 是软删除（`status → archived`），且**被引用时拒绝**。
界面走二次确认，把后端的拒绝理由原样显示（它已经说清了哪些内容在引用它）。

## 7. 状态设计

| 状态 | 形态 |
| --- | --- |
| Loading | `SkeletonLines`（列表）+ 抽屉内骨架 |
| 空（项目里没有资产） | 标题 + 说明 + 主操作「新建资产」 |
| **空（筛选后无结果）** | 另一套：「没有匹配的资产」+ 当前条件 + 「清除筛选」 |
| Error | 复用 `ErrorState`（带后端 `suggestions` 与重试） |
| 提交中 | 按钮 `loading`，**输入内容保留** |

两种「空」必须分开：混成一个会让人以为项目里真的没有资产，而实际上只是筛选条件没清。

## 8. 顺带修一处既有缺口

`Drawer` 目前**没有焦点管理**（§9.14 登记过）：打开时焦点不进入、`Esc` 不关闭、
关闭后焦点不回触发元素。本阶段要在它上面建新页面，属「改到哪修到哪」，
一并补上：打开进焦点、`Esc` 关闭、关闭后焦点回到触发元素。

## 9. 测试计划

### 9.1 新增测试

| 测试 | 位置 | 守什么 |
| --- | --- | --- |
| **表单 ↔ schema 机械对齐** | `apps/api/test/asset-form-contract.test.ts` | 用 TS 编译器 API 解析前端 `metadata/specs.ts`（与 `api-contract.test.ts` 同一手法），对每个类型的每个叶子 key 断言它在 `assetSchema` 对应分支里存在 |
| MetadataForm 行为 | `apps/web/test/metadata-form.test.tsx` | 6 种控件渲染、`group` 的读写、dirty 计算、清空发 `null` |
| 资产库页面 | `apps/web/test/asset-library.test.tsx` | 加载 / 两种空态 / 错误态 / 搜索与筛选 / 创建失败保留输入 |
| 编辑只发 dirty | `apps/web/test/asset-library.test.tsx` | 请求体里只有改动过的键（这条最容易被写回整份覆盖） |
| `@资产` 接线 | `apps/web/test/agent-workspace-wiring.test.tsx` | `@名字` 匹配成链接、匹配不上保持纯文本、`missing` 提示与预填 |

表单 ↔ schema 的机械对齐是其中最重要的一条：表单写了一个 schema 不认的字段，
**提交必然 400，而所有组件测试都会是绿的** —— 这正是本轮之前 `video.generate`
那类缺陷的形状。

### 9.2 真机验证

沿用本会话的做法，布局与命中必须有浏览器证据（jsdom 不做布局，已被这条咬过两次）：

- 三档视口（1440 / 1024 / 390）：无横向溢出、主操作在视口内、
  `elementFromPoint` 命中测试通过
- 抽屉打开后的层叠关系（`z-index` 那类缺陷 jsdom 永远看不见）
- `@资产` 在真实消息里的链接化（需要在真机上确认它没有把普通文本误链）

## 10. 验收标准

1. 能浏览、按**中文名**搜索、按 14 类筛选、加载更多
2. 能创建 7 类创作实体，metadata 通过后端 schema 校验并落库
3. **编辑只改动过的字段**；Agent 写入但表单未暴露的字段（`generation` 等）在编辑后仍在
4. 结果卡与消息里的资产可点开详情
5. 引用了不存在的资产时当场提示，并可一键新建（预填名称）
6. 三档视口无横向溢出、核心操作在视口内

## 11. 后续任务（本阶段登记，不实施）

- **`character.metadata.appearanceFields` 死字段**：声明了但无人读。
  要么接线（让 prompt 编译真正用它），要么从 schema 里删（属于契约变更，需单独评估
  历史数据）。见 §2。
- **版本历史与恢复的界面**：后端端点已就绪，按阶段表属 Phase 10。
- **全局资产库**：若将来确认存在跨项目复用场景再评估。
- **`Composer` 的 `@` 补全会列出已归档的资产**：它用的是
  `/api/projects/:id/assets`，那个端点没有状态过滤。影响很小（用户仍可 @ 到一个
  归档资产），但语义上不该。改起来是一行的事，登记着以免忘掉。
