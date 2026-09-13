# Phase 6：Asset System 交互与 `@资产` 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后端已经完备的资产能力变成用户看得见、管得了的界面 —— 项目内资产库（浏览 / 搜索 / 筛选）、7 类创作实体的中文表单创建与编辑、以及 `@资产` 在消息与结果卡里成为一等交互。

**Architecture:** 纯前端阶段。后端 10 个资产端点**已经就绪**（列表 / 创建 / 详情 / 更新 / 归档 / 版本 / 引用 / `@引用`解析 / 媒体体检），本阶段**不改任何后端 schema、路由、数据库**。新增 `apps/web/src/features/assets/**`，字段描述用**一张数据表 + 一个渲染器**（而不是 7 份手写表单），并用一个机械契约测试把「前端字段表 ↔ 领域 schema」焊死。编辑只提交 dirty 字段（服务端是「深合并后再整体校验」，部分提交安全）。

**Tech Stack:** React 19.3 / Vite 8.3 / TypeScript（`bundler` 解析）/ CSS Modules / Vitest 5 + @testing-library/react 16 / React Router 7；契约测试用 TypeScript 编译器 API + zod 内省（`apps/api` 侧，Vitest 2）。

**Spec:** `docs/superpowers/specs/2026-09-13-phase6-asset-ui-design.md`

**上游交付：** Phase 5B（`apps/web` 全量可用）+ 「本地存储」提交（`9aaa7cf`）。当前 `HEAD = 79894b8`，工作树干净，777 个测试通过。

## Global Constraints

- 全部代码与注释使用**简体中文**；提交信息格式 `type(scope): 描述`
- 纯 ESM；`apps/web` 内相对导入**带 `.js` 后缀**（`moduleResolution: bundler` 与 Vite 都接受）
- TypeScript 严格模式 + `noUncheckedIndexedAccess`；`noUnusedLocals` / `noUnusedParameters`
- 禁止非空断言 `!`、禁止显式 `any`（测试文件放宽）；禁止浮空 Promise（`void promise` 只允许作**语句**，箭头函数表达式体必须写块体）
- **Design Token 是唯一来源**（`apps/web/src/styles/tokens.css`）：组件 CSS 里**禁止**字面颜色 / 字号 / 圆角；间距只用 `--space-1|2|3|4|5|6|8|10|12`
- **禁止**：大面积渐变、玻璃拟态、emoji 作为图标、大面积阴影、无意义统计卡片、默认 Ant Design / Tailwind 模板感、Card 嵌套 Card
- Card 只用于有独立操作边界的对象。资产库列表用**行**（`Section` + `Divider` 式留白），不套卡片
- 每个列表与抽屉都必须有 **Loading / Empty / Error** 三态；错误必须说明「发生了什么 / 可能原因 / 下一步怎么做」
- 必须支持 Desktop / Tablet / Mobile 三档（1440 / 1024 / 390），不得横向溢出
- **不改动** `apps/api/src/**`、`apps/worker/**`、`packages/**` 的任何实现代码
  （唯一例外：`apps/api/test/api-contract.test.ts` 与新增的 `apps/api/test/asset-form-contract.test.ts` 两个测试文件）
- 依赖下载走代理 `http://192.168.240.1:10808`；**本阶段不新增任何依赖**
- 测试命令：`pnpm --filter @svh/web exec vitest run test/<文件>` / `pnpm --filter @svh/api exec vitest run test/<文件>`
- 全量门禁：`pnpm turbo run lint typecheck test build`（必要时加 `--force`）

## 控制方已做的技术裁定

这 8 条是设计阶段实测出来的结论，实施时**不要重新论证**，直接照做：

1. **列表端点选 `GET /api/assets?projectId=…`，不用 `/api/projects/:id/assets`。**
   实测：前者不传 `status` 时自动排除 `archived`（`{ status: { not: 'archived' } }`），
   后者**没有状态过滤**，归档资产会混进列表；前者的 `q` 还多搜一个 `description`。
   `pageSize` 上限 200（`paginationSchema` 的 `.max(200)`），列表页用 50，`@`索引用 200。

2. **PATCH 是「深合并之后整体校验」，所以部分提交安全。**
   `apps/api/src/routes/assets.ts:282-292`：`deepMerge(existing.metadata, input.metadata)` → `buildAssetData`。
   `deepMerge`（`packages/domain/src/asset.ts:604`）三条语义必须记牢：
   嵌套**对象递归合并**、**数组整体替换**、**`null` 删除该键**。

3. **清空字段发 `null`，新建时不发。**
   zod 的 `.optional()` 只接受 `undefined`，**不接受 `null`**。所以
   「清空一个原本有值的字段」→ 发 `null`（触发删除）；
   「新建时压根没填」→ **不发这个键**（发 `null` 必然 400）。
   这条差异由 `diffMetadata` 一条规则统一处理，见 Task 1。

4. **group 内部清空必须发嵌套 null，绝不能把整个 group 置 null。**
   `{ appearance: null }` 会删掉**整个** `appearance` 对象 ——
   包括 Agent 写入、而表单没有暴露的字段。正确形态是 `{ appearance: { hair: null } }`。

5. **表单不暴露的字段一个都不能提交。**
   表单只覆盖 7 个类型的一部分字段，而 Agent 会往 metadata 里写
   `generation` / `reference_images` / `appearanceFields` / `cues`。
   提交整份 metadata = 把它们悄悄抹掉。Task 1 的 `diffMetadata` 按 `specs` 走，
   天然只会产出 specs 里出现过的键；Task 6 的集成测试要**实测**这一点。

6. **`ASSET_TYPES` 在前端必须手写一份，且必须机械比对。**
   `apps/web` 刻意不依赖 `@svh/domain`（会把 Prisma / Fastify 拉进 bundle，
   见 `apps/web/src/lib/api-types.ts` 头部注释）。所以 14 类清单、7 类可创建清单、
   14 个中文标签在前端各有一份手写副本，全部由 Task 1 的契约测试与 domain 逐字比对。

7. **消息里的 `@名字` 链接化用的是新拉的资产索引，不是 `Composer` 的补全列表。**
   `Composer` 的清单是在用户敲 `@` 时才拉的（`loadSuggestions` 回调里），
   而消息渲染发生在页面加载时，时机不同，复用拿不到数据。
   工作台加载时拉一次 `GET /api/assets?projectId=…&pageSize=200` 建 `slug → id` 映射。
   **上限 200**：超出窗口的引用保持纯文本，不猜。

8. **匹配不上就保持纯文本，宁可不可点也不要链错。**
   前端 tokenizer 用与后端 `parseAssetMentions`
   （`apps/api/src/core/slug.ts:83`）**完全相同**的正则 `/@([\w\u4e00-\u9fa5-]+)/gu`，
   保证「后端认得的引用」与「前端可能链接化的引用」是同一批；
   是否成链只取决于该 slug 在不在索引里。

## File Structure

新增（全部在 `apps/web/src/features/assets/` 下）：

| 文件 | 职责 |
| --- | --- |
| `assetLabels.ts` | 类型 / 状态 / 枚举的中文标签（**唯一出处**） |
| `assetErrors.ts` | 把后端 `suggestions` 里的 `字段.子字段: 说明` 解析成输入框级错误 |
| `metadata/specs.ts` | `METADATA_SPECS` 字段描述表 + `diffMetadata` + `fieldPaths`（**数据 + 纯函数**） |
| `metadata/MetadataForm.tsx` | 通用渲染器（**一个**，认 6 种控件） |
| `metadata/MetadataForm.module.css` | 渲染器样式 |
| `AssetCreateDialog.tsx` | 新建：先选类型 → 再填表单 |
| `AssetCreateDialog.module.css` | |
| `AssetDetailDrawer.tsx` | 详情：媒体类型只读态 / 创作实体编辑态 + 归档 |
| `AssetDetailDrawer.module.css` | |
| `AssetLibraryPage.tsx` | 列表 + 工具栏（搜索 / 类型筛选）+ 抽屉宿主 + 深链 |
| `AssetLibraryPage.module.css` | |
| `MentionText.tsx` | `@名字` → 链接（**匹配不上保持纯文本**） |
| `MentionText.module.css` | 链接样式（正文色 + 下划线，不染主题蓝） |

修改：

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/lib/api-types.ts` | 追加 `ASSET_TYPES` / `AssetType` / `CREATIVE_ASSET_TYPES` / `AssetStatus` / `AssetSummary` / `AssetDetail` / `AssetUpdateResult` / `StorageRefView` |
| `apps/web/src/components/Drawer.tsx` | 补焦点管理（打开进焦点、Esc 关闭、关闭还焦点）+ `width` 档位 —— Spec §8 |
| `apps/web/src/components/Drawer.module.css` | 加一个 `.wide` |
| `apps/api/test/api-contract.test.ts` | `beforeAll` 捕获 `assetId`；追加 `AssetSummary` / `AssetDetail` / `AssetUpdateResult` 三个真实端点断言 |
| `apps/web/src/features/agent/renderers/card.module.css` | 结果卡上「查看资产详情」的样式 |
| `apps/web/src/features/agent/Composer.module.css` | `missing` 提示条样式 |
| `apps/web/src/App.tsx` | 注册 `/projects/:projectId/assets`（在 `AppShell` 分组内） |
| `apps/web/src/features/agent/AgentWorkspace.tsx` | 头部「资产」入口；加载资产索引；把索引与 projectId 透给对话流 |
| `apps/web/src/features/agent/MessageList.tsx` | 透传 `assetIndex` / `projectId` |
| `apps/web/src/features/agent/MessageItem.tsx` | 正文改用 `MentionText`；结果卡透传 `projectId` |
| `apps/web/src/features/agent/renderers/ResultCard.tsx` | `assetId` → 深链「查看资产详情」 |
| `apps/web/src/features/agent/Composer.tsx` | `missing` 引用提示 + 「现在新建」（预填名称）；`onAssetCreated` |
| `apps/web/src/features/agent/AgentWorkspace.module.css` | 头部入口样式 |
| `README.md` | Phase 6 标记完成 |
| `docs/ARCHITECTURE.md` | 前端结构补资产库；登记后续任务 |

新增测试：

| 文件 | 守什么 |
| --- | --- |
| `apps/api/test/asset-form-contract.test.ts` | 表单 ↔ schema 机械对齐（叶子键存在、控件类型匹配、select 选项与枚举一致、类型清单与标签与 domain 一致） |
| `apps/web/test/asset-metadata.test.ts` | `diffMetadata` 的三种语义、`parseFieldErrors`、标签完备性 |
| `apps/web/test/metadata-form.test.tsx` | 6 种控件渲染、group 读写、清空发 `null`（UI 路径） |
| `apps/web/test/asset-create-dialog.test.tsx` | 两步创建、失败保留输入、字段级错误落到输入框 |
| `apps/web/test/asset-detail-drawer.test.tsx` | 只读/编辑两态、归档二次确认、后端拒绝理由原样显示 |
| `apps/web/test/asset-library.test.tsx` | 加载 / 两种空态 / 错误态 / 搜索与筛选 / 加载更多 / 深链 / **编辑只发 dirty** / **创建失败保留输入** |
| `apps/web/test/mention-text.test.tsx` | `@名字` 链接化：命中成链、未命中保持纯文本、渲染不吃字 |
| `apps/web/test/components.test.tsx` | （追加）`Drawer` 焦点管理 + 宽度档位 |
| `apps/web/test/agent-workspace-wiring.test.tsx` | （追加）`@名字` 链接化 / 不误链 / `missing` 提示与预填 |

---

## Task 1: 资产契约类型、中文标签、字段表与脏值纯函数

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`（文件末尾追加）
- Create: `apps/web/src/features/assets/assetLabels.ts`
- Create: `apps/web/src/features/assets/metadata/specs.ts`
- Create: `apps/web/src/features/assets/assetErrors.ts`
- Modify: `apps/api/test/api-contract.test.ts`（`beforeAll` 捕获 `assetId` + 追加 3 个用例）
- Test: `apps/api/test/asset-form-contract.test.ts`
- Test: `apps/web/test/asset-metadata.test.ts`

**Interfaces:**
- Consumes: `@svh/domain` 的 `ASSET_TYPES` / `CREATIVE_ASSET_TYPES` / `ASSET_TYPE_LABELS` / `characterMetadataSchema` / `digitalHumanMetadataSchema` / `productMetadataSchema` / `brandMetadataSchema` / `sceneMetadataSchema` / `propMetadataSchema` / `costumeMetadataSchema`
- Produces:
  - `ASSET_TYPES: readonly AssetType[]`、`type AssetType`、`CREATIVE_ASSET_TYPES: readonly CreativeAssetType[]`、`type CreativeAssetType`
  - `type AssetStatus = 'draft' | 'active' | 'archived'`
  - `interface StorageRefView { driver: string; key: string; url?: string; size?: number; mimeType?: string }`
  - `interface AssetSummary { id: string; type: AssetType; name: string; slug: string; coverUrl: string | null }`
  - `interface AssetDetail extends AssetSummary { projectId: string; description: string; metadata: Record<string, unknown>; tags: string[]; status: AssetStatus; files: StorageRefView[]; updatedAt: string }`
  - `interface AssetUpdateResult extends AssetDetail { version: number }`
  - `ASSET_TYPE_LABELS: Record<AssetType, string>`、`ASSET_STATUS_LABELS: Record<AssetStatus, string>`、`CREATABLE_TYPE_OPTIONS: ReadonlyArray<{ value: CreativeAssetType; label: string }>`
  - `type FieldSpec`（6 种控件）、`METADATA_SPECS: Record<AssetType, readonly FieldSpec[]>`、`isCreativeAssetType(type: AssetType): type is CreativeAssetType`
  - `GENERAL_FIELD_KEYS: readonly ['name','slug','description','tags','coverUrl']`
  - `diffMetadata(specs, initial, current): Record<string, unknown>`
  - `fieldPaths(specs): Set<string>`
  - `parseFieldErrors(suggestions, paths): { fieldErrors: Record<string, string>; unmatched: string[] }`

### 设计要点（实施前先读）

**`specs.ts` 必须是可静态解析的静态结构。** 契约测试用 TypeScript 编译器 API 读它，
所以只能出现对象字面量、数组字面量、字符串字面量、标识符键，以及**指向同文件顶层
`const` 的标识符**（`fields: APPEARANCE_FIELDS` 这种）；**不能**有展开、计算键、
函数调用、跨文件 import 的引用。Task 1 Step 1 的解析器会在遇到其它形状时**直接抛错**。

为什么允许同文件引用、却禁止跨文件引用：角色的外观有 12 个字段，数字人用的是**同一套**
（domain 侧两个类型共用 `appearanceSchema`）。禁止引用等于把同一份描述抄两遍，
而「往表里加一行」正是这张表存在的理由 —— 抄两遍之后漏改一处是**静默**的
（契约测试是单向的「表单 → schema」，不检查 schema 的字段是否都被表单覆盖）。
跨文件引用（`options: GENDER_OPTIONS`）则要解析 import，成本远超收益，
所以那类选项数组直接定义在 `specs.ts` 里。

**未纳入表单的字段（有意为之，不是遗漏）。** 6 种控件表达不了下面三类，
硬塞进去只会产出 schema 不认的数据，因此 `specs.ts` 顶部要写清楚这一段注释：

- 跨资产引用 id：`digital_human.voice.voiceAssetId`、`digital_human.motion.backgroundAssetId`、
  `product.brandId`、`brand.logoAssetId`、`prop.ownerCharacterId`、`costume.forCharacterIds`
  —— 用户看不懂 id；需要的是「资产选择器」，属后续任务
- 自由键值对：`product.specs`、`brand.guidelines.typography`（`z.record(z.string(), z.string())`）
  —— 需要第 7 种控件「键值对编辑器」，本阶段不做
- 对象数组：`scene.elements`（`{name, description}[]`）—— 需要「重复条目编辑器」
- 结构化引用：`character.reference_images` / `digital_human.reference`（`StorageRef[]`）
- 死字段：`character.appearanceFields`（全仓无人读，Spec §2 已登记）

- [ ] **Step 1: 写契约测试（先写、先看它失败）**

创建 `apps/api/test/asset-form-contract.test.ts`：

```ts
/**
 * 资产表单 ↔ 领域 schema 契约测试
 * ==============================
 *
 * ── 为什么需要它 ──
 * 资产库的 metadata 表单是前端**手写的一张字段表**
 * （`apps/web/src/features/assets/metadata/specs.ts`），后端校验用的是
 * `@svh/domain` 的 `characterMetadataSchema` 等 schema。两者之间没有任何
 * 编译期联系：
 *
 *   · 表单写了一个 schema 不认的字段 → 提交必然 400；
 *   · 表单把数字渲染成文本框   → 提交必然 400；
 *   · 下拉框少一个枚举值       → 用户永远选不到那个值。
 *
 * 而**所有组件测试都会是绿的** —— jsdom 里的 fetch 是假的，没有任何东西会去问
 * 后端「这个字段你认不认」。这正是本轮之前 `video.generate` 那类缺陷的形状：
 * 技能写了 schema 不认的 metadata，跑起来才发现。
 *
 * ── 手法 ──
 * 与 `api-contract.test.ts` 同一手法：用 TypeScript 编译器 API 把前端源文件的
 * **静态字面量**读成数据结构，再拿 `@svh/domain` 的真实 schema 比对。
 * 刻意不 import 前端源文件：`apps/api` 的 tsconfig 是 NodeNext + `rootDir: "."`，
 * 跨包 import 一个 .tsx 工程下的文件会同时破坏类型检查与构建。
 *
 * ── 覆盖边界（说清楚，不含糊）──
 * 覆盖：`METADATA_SPECS` 的每一个叶子字段（键存在、控件类型与 zod 类型一致、
 *       select 的选项与枚举完全一致、标签非空），以及 14 类清单 / 可创建清单 /
 *       中文标签与 domain 的逐字一致。
 * **不覆盖**：表单的渲染行为（见 `apps/web/test/metadata-form.test.tsx`），
 *       以及 specs.ts 里**有意未纳入**的字段（那份清单在 specs.ts 的注释里）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  CREATIVE_ASSET_TYPES,
  brandMetadataSchema,
  characterMetadataSchema,
  costumeMetadataSchema,
  digitalHumanMetadataSchema,
  mediaMetadataSchema,
  productMetadataSchema,
  propMetadataSchema,
  sceneMetadataSchema,
} from '@svh/domain';

/* ─────────────────────── 用编译器 API 读前端字面量 ─────────────────────── */

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src');
const SPECS_PATH = resolve(WEB_SRC, 'features/assets/metadata/specs.ts');
const LABELS_PATH = resolve(WEB_SRC, 'features/assets/assetLabels.ts');
const API_TYPES_PATH = resolve(WEB_SRC, 'lib/api-types.ts');

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** 剥掉 `as const` / `satisfies T` / 括号，拿到真正的字面量节点 */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** 取顶层 `const X = …` 的初始化表达式；找不到就抛错，绝不当成空集合放过 */
function topLevelConst(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (declaration.initializer === undefined) {
        throw new Error(`${name} 没有初始化表达式，契约测试无法解析`);
      }
      return unwrap(declaration.initializer);
    }
  }
  throw new Error(`源码里找不到顶层常量 ${name}`);
}

/**
 * 读对象字面量。
 *
 * 遇到展开、计算键、简写、方法等任何非「属性赋值」成员都**直接抛错**：
 * 静默跳过会让这条契约测试在重构之后变成空转绿灯。
 */
function objectEntries(node: ts.Expression, where: string): Map<string, ts.Expression> {
  const literal = unwrap(node);
  if (!ts.isObjectLiteralExpression(literal)) {
    throw new Error(`${where} 必须是对象字面量（实际是 ${ts.SyntaxKind[literal.kind]}）`);
  }
  const entries = new Map<string, ts.Expression>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `${where} 里出现非属性赋值成员（${ts.SyntaxKind[property.kind]}）：契约测试只认静态字面量`,
      );
    }
    const { name } = property;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      throw new Error(`${where} 里有无法解析的键名`);
    }
    entries.set(name.text, unwrap(property.initializer));
  }
  return entries;
}

function stringValue(node: ts.Expression, where: string): string {
  const literal = unwrap(node);
  if (!ts.isStringLiteral(literal)) {
    throw new Error(`${where} 必须是字符串字面量（实际是 ${ts.SyntaxKind[literal.kind]}）`);
  }
  return literal.text;
}

/**
 * 读数组。允许两种形态：
 *   1. 数组字面量；
 *   2. **指向同文件顶层 `const` 的标识符**（如 `fields: APPEARANCE_FIELDS`）。
 *
 * 第二种是必要的：角色的外观有 12 个字段，数字人用的是同一套
 * （domain 侧两个类型共用 `appearanceSchema`）。禁止引用等于把同一份描述抄两遍，
 * 而抄两遍之后漏改一处是**静默**的 —— 契约测试只做「表单 → schema」的单向检查，
 * 不会发现某个类型少了一个可填字段。
 *
 * **刻意不解析跨文件的 import**：那要实现模块解析，成本远超收益。
 * 跨文件共享的选项数组请直接定义在 `specs.ts` 里。
 */
function arrayItems(
  node: ts.Expression,
  where: string,
  source: ts.SourceFile,
  seen: readonly string[] = [],
): ts.Expression[] {
  const value = unwrap(node);

  if (ts.isIdentifier(value)) {
    // 成环会让解析器无限递归：`const A = B; const B = A` 必须显式报错
    if (seen.includes(value.text)) {
      throw new Error(`${where} 的引用成环：${[...seen, value.text].join(' -> ')}`);
    }
    return arrayItems(
      topLevelConst(source, value.text),
      `${value.text}（被 ${where} 引用）`,
      source,
      [...seen, value.text],
    );
  }

  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(
      `${where} 必须是数组字面量或同文件顶层常量（实际是 ${ts.SyntaxKind[value.kind]}）`,
    );
  }
  return [...value.elements].map((element) => unwrap(element));
}

function need(entries: Map<string, ts.Expression>, where: string, key: string): ts.Expression {
  const value = entries.get(key);
  if (value === undefined) throw new Error(`${where} 缺少 ${key}`);
  return value;
}

function stringArray(node: ts.Expression, where: string, source: ts.SourceFile): string[] {
  return arrayItems(node, where, source).map((item, index) =>
    stringValue(item, `${where}[${index}]`),
  );
}

/* ─────────────────────────── 字段表的结构 ─────────────────────────── */

interface FieldNode {
  kind: string;
  /** 完整点分路径，如 `appearance.hair` */
  path: string;
  label: string;
  /** 仅 select 有 */
  options: string[];
  children: FieldNode[];
}

/** 渲染器认得的 6 种控件；多一种少一种都必须在这里显式改 */
const WIDGET_KINDS = new Set(['text', 'textarea', 'number', 'select', 'tags', 'group']);

function readField(
  node: ts.Expression,
  where: string,
  prefix: string,
  source: ts.SourceFile,
): FieldNode {
  const entries = objectEntries(node, where);
  const kind = stringValue(need(entries, where, 'kind'), `${where}.kind`);
  const key = stringValue(need(entries, where, 'key'), `${where}.key`);
  const label = stringValue(need(entries, where, 'label'), `${where}.label`);
  const path = prefix === '' ? key : `${prefix}.${key}`;

  const options =
    kind === 'select'
      ? arrayItems(need(entries, where, 'options'), `${where}.options`, source).map(
          (option, index) => {
            const at = `${where}.options[${index}]`;
            return stringValue(need(objectEntries(option, at), at, 'value'), `${at}.value`);
          },
        )
      : [];

  const children =
    kind === 'group'
      ? arrayItems(need(entries, where, 'fields'), `${where}.fields`, source).map((child, index) =>
          readField(child, `${where}.fields[${index}]`, path, source),
        )
      : [];

  return { kind, path, label, options, children };
}

function readFieldTable(source: ts.SourceFile, constName: string): Map<string, FieldNode[]> {
  const entries = objectEntries(topLevelConst(source, constName), constName);
  const table = new Map<string, FieldNode[]>();
  for (const [type, node] of entries) {
    table.set(
      type,
      arrayItems(node, `${constName}.${type}`, source).map((item, index) =>
        readField(item, `${constName}.${type}[${index}]`, '', source),
      ),
    );
  }
  return table;
}

/** 所有节点（含 group 自身） */
function allNodes(nodes: readonly FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/** 叶子节点（group 不是叶子） */
function leaves(nodes: readonly FieldNode[]): FieldNode[] {
  return nodes.flatMap((node) => (node.children.length > 0 ? leaves(node.children) : [node]));
}

/* ─────────────────────── 拿 domain 的真实 schema 比对 ─────────────────────── */

/**
 * 14 类的 metadata 分支，全部是 asset.ts 的公开导出。
 *
 * 7 类生成产物（图片 / 视频 / 音频 / 音色 / 音乐 / 标识 / 字体）在
 * `METADATA_SPECS` 里是空表，domain 侧统一走 `mediaMetadataSchema`
 * （`asset.ts` 里 `const genericMetadataSchema = mediaMetadataSchema;`）。
 * 这 7 个分支必须显式列上 —— `checkFieldTable` 遍历的是字段表的**每一个**
 * 类型，少一个分支它就报「本测试没有它的 schema 分支」。那条报错是留给
 * 「新增了资产类型却忘了在这里补分支」的，不该被这 7 个已知类型触发；
 * 列全之后，哪天有人往空表里填字段，也一样会被逐个比对。
 */
const SCHEMA_BY_TYPE: Readonly<Record<string, z.ZodTypeAny>> = {
  character: characterMetadataSchema,
  digital_human: digitalHumanMetadataSchema,
  product: productMetadataSchema,
  brand: brandMetadataSchema,
  scene: sceneMetadataSchema,
  prop: propMetadataSchema,
  costume: costumeMetadataSchema,
  image: mediaMetadataSchema,
  video: mediaMetadataSchema,
  audio: mediaMetadataSchema,
  voice: mediaMetadataSchema,
  music: mediaMetadataSchema,
  logo: mediaMetadataSchema,
  font: mediaMetadataSchema,
};

/** 解包 `.optional()` / `.default()`，拿到真正的类型 */
function unwrapModifiers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    return current;
  }
}

/** 按点分路径在 schema 分支里取字段；任何一段不存在都返回 null */
function schemaAtPath(root: z.ZodTypeAny, path: string): z.ZodTypeAny | null {
  let current: z.ZodTypeAny = root;
  for (const segment of path.split('.')) {
    const object = unwrapModifiers(current);
    if (!(object instanceof z.ZodObject)) return null;
    const shape = object.shape as Record<string, z.ZodTypeAny>;
    const next = shape[segment];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/** 控件类型 ↔ zod 类型。返回 null 表示匹配，否则是一句人话的原因 */
function kindMismatch(kind: string, schema: z.ZodTypeAny): string | null {
  const actual = unwrapModifiers(schema);
  switch (kind) {
    case 'text':
    case 'textarea':
      return actual instanceof z.ZodString
        ? null
        : `控件是 ${kind}（字符串），schema 是 ${actual.constructor.name}`;
    case 'number':
      return actual instanceof z.ZodNumber
        ? null
        : `控件是 number，schema 是 ${actual.constructor.name}`;
    case 'select':
      return actual instanceof z.ZodEnum
        ? null
        : `控件是 select，schema 却是 ${actual.constructor.name}（不是枚举）`;
    case 'tags':
      if (!(actual instanceof z.ZodArray)) {
        return `控件是 tags（字符串数组），schema 是 ${actual.constructor.name}`;
      }
      return unwrapModifiers(actual.element) instanceof z.ZodString
        ? null
        : 'tags 的元素在 schema 里不是字符串';
    default:
      return `渲染器不认识的控件类型 ${kind}`;
  }
}

/**
 * 校验一张字段表，返回全部问题（空数组 = 通过）。
 *
 * 抽成纯函数是为了能拿**被污染的副本**再跑一次 —— 见下面的反向验证用例：
 * 一个恒定返回空数组的校验器也能让「真实表」那条用例通过，
 * 只有反向用例能证明它真的在检查。
 */
function checkFieldTable(table: ReadonlyMap<string, readonly FieldNode[]>): string[] {
  const problems: string[] = [];

  for (const [type, nodes] of table) {
    const schema = SCHEMA_BY_TYPE[type];
    if (schema === undefined) {
      problems.push(`${type}: 本测试没有它的 schema 分支（新增类型时请补上）`);
      continue;
    }

    for (const node of allNodes(nodes)) {
      if (!WIDGET_KINDS.has(node.kind)) {
        problems.push(`${type}.${node.path}: 渲染器不认识的控件类型 ${node.kind}`);
      }
      if (node.label.trim() === '') {
        problems.push(`${type}.${node.path}: 没有中文标签`);
      }
    }

    for (const leaf of leaves(nodes)) {
      const target = schemaAtPath(schema, leaf.path);
      if (target === null) {
        problems.push(`${type}.${leaf.path}: schema 里不存在这个字段（提交必然 400）`);
        continue;
      }

      const mismatch = kindMismatch(leaf.kind, target);
      if (mismatch !== null) {
        problems.push(`${type}.${leaf.path}: ${mismatch}`);
        continue;
      }

      if (leaf.kind === 'select') {
        const actual = unwrapModifiers(target);
        if (actual instanceof z.ZodEnum) {
          const declared = [...leaf.options].sort();
          const allowed = [...(actual.options as string[])].sort();
          if (declared.join('\u0000') !== allowed.join('\u0000')) {
            problems.push(
              `${type}.${leaf.path}: 下拉选项与 schema 枚举不一致` +
                `（表单 ${declared.join('/')}，schema ${allowed.join('/')}）`,
            );
          }
        }
      }
    }
  }

  return problems;
}

/* ────────────────────────────── 用例 ────────────────────────────── */

const specs = readFieldTable(parseSource(SPECS_PATH), 'METADATA_SPECS');

describe('解析器自检（防止空转通过）', () => {
  it('读出了真实的字段表，而不是空集合', () => {
    const character = specs.get('character') ?? [];
    expect(character.length).toBeGreaterThan(0);
    expect(character.map((node) => node.path)).toContain('appearance');
    expect(leaves(character).length).toBeGreaterThanOrEqual(15);
  });

  it('读得出 select 的选项值', () => {
    const appearance = (specs.get('character') ?? []).find((node) => node.path === 'appearance');
    const gender = appearance?.children.find((node) => node.path === 'appearance.gender');
    expect(gender?.kind).toBe('select');
    expect(gender?.options).toEqual(['male', 'female', 'other', 'unspecified']);
  });
});

describe('表单 ↔ schema 机械对齐', () => {
  it('每个叶子字段都能在 schema 里找到，且控件类型匹配', () => {
    expect(checkFieldTable(specs)).toEqual([]);
  });

  it('加一个 schema 不认的字段就必然报错（反向验证，防止永远绿灯）', () => {
    const polluted = new Map(specs);
    polluted.set('character', [
      ...(specs.get('character') ?? []),
      {
        kind: 'text',
        path: 'nonexistentField',
        label: '并不存在的字段',
        options: [],
        children: [],
      },
    ]);
    expect(checkFieldTable(polluted)).toEqual([
      'character.nonexistentField: schema 里不存在这个字段（提交必然 400）',
    ]);
  });

  it('把数字字段写成文本框也必然报错（反向验证）', () => {
    const polluted = new Map(specs);
    const appearance = (specs.get('character') ?? []).find((node) => node.path === 'appearance');
    polluted.set(
      'character',
      (specs.get('character') ?? []).map((node) =>
        node.path === 'appearance' && appearance !== undefined
          ? {
              ...node,
              children: node.children.map((child) =>
                child.path === 'appearance.age' ? { ...child, kind: 'text' } : child,
              ),
            }
          : node,
      ),
    );
    expect(checkFieldTable(polluted)).toEqual([
      'character.appearance.age: 控件是 text（字符串），schema 是 ZodNumber',
    ]);
  });
});

describe('字段表的覆盖面', () => {
  it('14 类都有条目：7 类创作实体非空，7 类生成产物为空表', () => {
    expect([...specs.keys()].sort()).toEqual([...ASSET_TYPES].sort());
    for (const type of CREATIVE_ASSET_TYPES) {
      expect(leaves(specs.get(type) ?? []).length, `${type} 的字段表是空的`).toBeGreaterThan(0);
    }
    for (const type of ASSET_TYPES) {
      if ((CREATIVE_ASSET_TYPES as readonly string[]).includes(type)) continue;
      expect(specs.get(type) ?? [], `${type} 是生成产物，metadata 不该由用户手填`).toEqual([]);
    }
  });
});

describe('前端手写副本 ↔ domain', () => {
  it('ASSET_TYPES 与 CREATIVE_ASSET_TYPES 逐字一致', () => {
    const apiTypes = parseSource(API_TYPES_PATH);
    expect(
      stringArray(topLevelConst(apiTypes, 'ASSET_TYPES'), 'ASSET_TYPES', apiTypes),
    ).toEqual([...ASSET_TYPES]);
    expect(
      stringArray(
        topLevelConst(apiTypes, 'CREATIVE_ASSET_TYPES'),
        'CREATIVE_ASSET_TYPES',
        apiTypes,
      ),
    ).toEqual([...CREATIVE_ASSET_TYPES]);
  });

  it('中文标签与 domain 的 ASSET_TYPE_LABELS 完全一致', () => {
    const entries = objectEntries(
      topLevelConst(parseSource(LABELS_PATH), 'ASSET_TYPE_LABELS'),
      'ASSET_TYPE_LABELS',
    );
    const webLabels: Record<string, string> = {};
    for (const [type, node] of entries) {
      webLabels[type] = stringValue(node, `ASSET_TYPE_LABELS.${type}`);
    }
    expect(webLabels).toEqual({ ...ASSET_TYPE_LABELS });
  });
});
```

- [ ] **Step 2: 运行它，确认失败**

```bash
pnpm --filter @svh/api exec vitest run test/asset-form-contract.test.ts
```

Expected: FAIL —— `ENOENT` / `源码里找不到顶层常量 METADATA_SPECS`（`specs.ts` 还不存在）。

- [ ] **Step 3: 在 `api-types.ts` 末尾追加资产契约类型**

在 `apps/web/src/lib/api-types.ts` **文件末尾**追加：

```ts
/* ────────────────────────────── 资产（Phase 6） ────────────────────────────── */

/**
 * 资产类型清单（14 类）。
 *
 * 与 `@svh/domain` 的 `ASSET_TYPES` 是同一份声明，但前端**不能** import 它
 * （会把 Prisma / Fastify 拉进 bundle，见本文件头部）。因此这里手写一份，
 * 由 `apps/api/test/asset-form-contract.test.ts` 机械比对：
 * 少一个、多一个、顺序不同都会失败。
 */
export const ASSET_TYPES = [
  'character',
  'digital_human',
  'product',
  'brand',
  'scene',
  'prop',
  'costume',
  'image',
  'video',
  'audio',
  'voice',
  'music',
  'logo',
  'font',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

/** 可被用户手工创建的 7 类「创作实体」；另外 7 类是生成产物，metadata 由生成链路写入 */
export const CREATIVE_ASSET_TYPES = [
  'character',
  'digital_human',
  'product',
  'brand',
  'scene',
  'prop',
  'costume',
] as const satisfies readonly AssetType[];

export type CreativeAssetType = (typeof CREATIVE_ASSET_TYPES)[number];

/** 与 `@svh/domain` 的 `ASSET_STATUSES` 对齐 */
export type AssetStatus = 'draft' | 'active' | 'archived';

/** 存储引用（`GET /api/assets/:id` 的 `files[]`） */
export interface StorageRefView {
  driver: string;
  key: string;
  url?: string;
  size?: number;
  mimeType?: string;
}

/**
 * `GET /api/assets` 的列表项。
 *
 * 只声明列表真正消费的字段：封面、名称、类型标签、`slug`（`@slug` 才是用户
 * 实际会打的东西，看不到 slug 就没法判断该 @ 什么）。
 */
export interface AssetSummary {
  id: string;
  type: AssetType;
  name: string;
  slug: string;
  /** 无封面时为 `null`：列表用类型标签块占位 */
  coverUrl: string | null;
}

/** `GET /api/assets/:id` 的详情 */
export interface AssetDetail extends AssetSummary {
  projectId: string;
  description: string;
  /** 类型化元数据。可变部分由 `metadata/specs.ts` 的 METADATA_SPECS 描述 */
  metadata: Record<string, unknown>;
  tags: string[];
  status: AssetStatus;
  files: StorageRefView[];
  updatedAt: string;
}

/** `PATCH /api/assets/:id` 的响应：资产本体 + 新版本号 */
export interface AssetUpdateResult extends AssetDetail {
  version: number;
}
```

- [ ] **Step 4: 运行契约测试，确认仍然失败（现在缺 `specs.ts` / `assetLabels.ts`）**

```bash
pnpm --filter @svh/api exec vitest run test/asset-form-contract.test.ts
```

Expected: FAIL —— 找不到 `specs.ts`。注意此时 `ASSET_TYPES` 那一条**已经能过**，
这是好事：说明解析器工作正常，失败是「文件不存在」而不是「解析器坏了」。

- [ ] **Step 5: 创建 `assetLabels.ts`**

```ts
/**
 * 资产相关的中文标签。
 *
 * ── 为什么这里有一份 ASSET_TYPE_LABELS，而 `@svh/domain` 里也有一份 ──
 * `apps/web` 刻意不依赖 `@svh/domain`（会把 Prisma / Fastify 拉进 bundle），
 * 所以标签只能在前端再声明一遍。这份副本**不是**靠自觉维护的：
 * `apps/api/test/asset-form-contract.test.ts` 会把它与 domain 的
 * `ASSET_TYPE_LABELS` 逐字比对，改了一边没改另一边，测试立刻失败。
 */
import {
  ASSET_TYPES,
  CREATIVE_ASSET_TYPES,
  type AssetStatus,
  type AssetType,
  type CreativeAssetType,
} from '../../lib/api-types.js';

/** 资产类型的中文名（列表、筛选、创建对话框、详情抽屉共用） */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  character: '角色',
  digital_human: '数字人',
  product: '产品',
  brand: '品牌',
  scene: '场景',
  prop: '道具',
  costume: '服装',
  image: '图片',
  video: '视频',
  audio: '音频',
  voice: '音色',
  music: '音乐',
  logo: '标识',
  font: '字体',
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  active: '生效中',
  draft: '草稿',
  archived: '已归档',
};

/** 类型筛选按钮的顺序：先创作实体，后生成产物，与 ASSET_TYPES 的声明顺序一致 */
export const ASSET_TYPE_OPTIONS: ReadonlyArray<{ value: AssetType; label: string }> =
  ASSET_TYPES.map((type) => ({ value: type, label: ASSET_TYPE_LABELS[type] }));

/** 创建对话框里可选的类型（只有 7 类创作实体） */
export const CREATABLE_TYPE_OPTIONS: ReadonlyArray<{ value: CreativeAssetType; label: string }> =
  CREATIVE_ASSET_TYPES.map((type) => ({ value: type, label: ASSET_TYPE_LABELS[type] }));

/*
 * 枚举型字段的下拉选项**不在这里**，它们定义在 `metadata/specs.ts` 里。
 * 理由：`specs.ts` 是「可静态解析」的 —— 契约测试只解析同一个文件里的顶层
 * 常量，跨文件 import 的引用解析不了。把选项放在签名旁边，既不产生死导出，
 * 也不用把同一份选项抄两遍。
 */
```

- [ ] **Step 6: 创建 `metadata/specs.ts`**

```ts
/**
 * 资产 metadata 的字段描述表。
 *
 * ── 为什么是「一张数据表 + 一个渲染器」而不是 7 份手写表单 ──
 * 字段描述是**数据**，渲染器只认 6 种控件。新增类型或字段 = 往表里加一行；
 * 测试可以分开打（表的完备性 vs 渲染器的行为），而 7 份手写表单只能逐个测，
 * 且改一处控件行为要改 7 遍。
 *
 * ── 这张表是「可静态解析」的 ──
 * `apps/api/test/asset-form-contract.test.ts` 用 TypeScript 编译器 API 直接读
 * 这个文件。因此这里只能出现对象字面量、数组字面量、字符串字面量、标识符键，
 * 以及**指向本文件顶层 `const` 的标识符**（`fields: APPEARANCE_FIELDS`）——
 * 不能有展开、计算键、函数调用，也不能引用别的文件里的常量。
 *
 * 同文件引用是刻意支持的：角色的外观与数字人的外观是同一套 12 个字段
 * （domain 侧共用 `appearanceSchema`），逼着抄两遍的话，漏改一处是**静默**的。
 * 跨文件引用成本太高（要解析 import），所以枚举选项直接定义在本文件里。
 *
 * ── 有意未纳入表单的字段（不是遗漏）──
 * 6 种控件表达不了下面这几类，硬塞进去只会产出 schema 不认的数据：
 *   · 跨资产引用 id：`digital_human.voice.voiceAssetId`、
 *     `digital_human.motion.backgroundAssetId`、`product.brandId`、
 *     `brand.logoAssetId`、`prop.ownerCharacterId`、`costume.forCharacterIds`
 *     —— 用户看不懂 id，需要的是「资产选择器」（后续任务）
 *   · 自由键值对：`product.specs`、`brand.guidelines.typography`
 *     —— 需要第 7 种控件「键值对编辑器」（后续任务）
 *   · 对象数组：`scene.elements`（`{name, description}[]`）—— 需要「重复条目编辑器」
 *   · 结构化引用：`character.reference_images`、`digital_human.reference`
 *   · 死字段：`character.appearanceFields`（全仓无人读，Spec §2 已登记）
 * 这些字段**不会被提交**（`diffMetadata` 只产出这张表里出现过的键），
 * 因此 Agent 写进去的内容不会因为用户编辑一次就被抹掉。
 */
import {
  CREATIVE_ASSET_TYPES,
  type AssetType,
  type CreativeAssetType,
} from '../../../lib/api-types.js';

/**
 * 枚举型字段的下拉选项。
 *
 * 取值必须与 `packages/domain/src/asset.ts` 里的 `z.enum([...])` **完全一致**，
 * 多一个少一个都会被契约测试抓到（它比对的是 `ZodEnum.options`）。
 * `''` 这个空值不在表里 —— 它由渲染器统一加上，表示「未设置」。
 */
const GENDER_OPTIONS = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'other', label: '其他' },
  { value: 'unspecified', label: '不指定' },
] as const;

/** `digital_human.motion.mode` 的驱动方式 */
const MOTION_MODE_OPTIONS = [
  { value: 'talking_head', label: '口播（只动头肩）' },
  { value: 'half_body', label: '半身动作' },
  { value: 'full_body', label: '全身动作' },
] as const;

/**
 * 字段描述。6 种控件：
 *
 * - `text` / `textarea` → `string`
 * - `number`            → `number`
 * - `select`            → 枚举字符串
 * - `tags`              → `string[]`（提交时**整体替换**，见 diffMetadata）
 * - `group`             → 嵌套对象（同一个键在不同类型下形状不同时就靠它区分：
 *                         `character.appearance` 是对象，`prop.appearance` 是字符串）
 */
export type FieldSpec =
  | { kind: 'text' | 'textarea'; key: string; label: string; help?: string }
  | { kind: 'number'; key: string; label: string; help?: string }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      help?: string;
    }
  | { kind: 'tags'; key: string; label: string; help?: string }
  | { kind: 'group'; key: string; label: string; help?: string; fields: readonly FieldSpec[] };

/** 角色 / 数字人共用的结构化外观（`appearanceSchema`） */
const APPEARANCE_FIELDS: readonly FieldSpec[] = [
  { kind: 'select', key: 'gender', label: '性别气质', options: GENDER_OPTIONS },
  { kind: 'number', key: 'age', label: '年龄', help: '0 ~ 200 的整数' },
  { kind: 'text', key: 'ageRange', label: '年龄段', help: '如「二十出头」，与年龄二选一即可' },
  { kind: 'text', key: 'hair', label: '发型发色', help: '如「黑色长直发」' },
  { kind: 'text', key: 'eyeColor', label: '瞳色' },
  { kind: 'text', key: 'bodyType', label: '身材体型', help: '如「纤细高挑」' },
  { kind: 'number', key: 'heightCm', label: '身高（厘米）', help: '50 ~ 300 的整数' },
  {
    kind: 'textarea',
    key: 'facialFeatures',
    label: '面部特征',
    help: '如「鹅蛋脸、丹凤眼」。这一段会被 Agent 直接用于保持角色一致性',
  },
  { kind: 'text', key: 'vibe', label: '整体气质', help: '如「清冷疏离」' },
  { kind: 'textarea', key: 'costume', label: '服装描述', help: '如「月白色齐胸襦裙」' },
  { kind: 'tags', key: 'distinguishingFeatures', label: '辨识特征', help: '如「左眉尾有一道浅疤」，回车添加' },
  { kind: 'tags', key: 'accessories', label: '配饰', help: '回车添加一项' },
];

/** 品牌视觉规范（`brandGuidelinesSchema` 里能用 6 种控件表达的部分） */
const BRAND_GUIDELINE_FIELDS: readonly FieldSpec[] = [
  { kind: 'tags', key: 'must', label: '必须遵守', help: '回车添加一条规则' },
  { kind: 'tags', key: 'forbidden', label: '禁止出现', help: '回车添加一条禁忌' },
  { kind: 'textarea', key: 'visualStyle', label: '视觉风格', help: '如「低饱和、大量留白、真实质感」' },
  { kind: 'text', key: 'spacing', label: '版式留白规则' },
  { kind: 'textarea', key: 'compliance', label: '版权 / 合规说明' },
];

/**
 * 7 类创作实体 + 7 类生成产物的字段表。
 *
 * 生成产物（图片 / 视频 / 音频 / 音色 / 音乐 / 标识 / 字体）一律是**空表**：
 * 它们的 metadata 是生成结果（`width` / `format` / `duration` / `generation`），
 * 让用户手填只会填出与实际文件不符的数据。详情抽屉照常**只读**展示它们。
 */
export const METADATA_SPECS: Record<AssetType, readonly FieldSpec[]> = {
  character: [
    { kind: 'group', key: 'appearance', label: '外观', fields: APPEARANCE_FIELDS },
    {
      kind: 'group',
      key: 'costume',
      label: '服装 / 造型方案',
      fields: [
        { kind: 'text', key: 'name', label: '造型名称' },
        { kind: 'textarea', key: 'description', label: '造型说明' },
        { kind: 'tags', key: 'colors', label: '配色', help: '回车添加一个颜色' },
      ],
    },
    { kind: 'text', key: 'role', label: '剧情定位', help: '如「女主」「反派」' },
    { kind: 'text', key: 'firstAppearance', label: '首次出场分集' },
    { kind: 'textarea', key: 'personality', label: '性格与人物小传' },
    { kind: 'textarea', key: 'backstory', label: '背景故事' },
  ],
  digital_human: [
    { kind: 'select', key: 'gender', label: '性别气质', options: GENDER_OPTIONS },
    { kind: 'group', key: 'appearance', label: '外观', fields: APPEARANCE_FIELDS },
    {
      kind: 'group',
      key: 'voice',
      label: '声音',
      help: '音色资产的选择需要「资产选择器」，本阶段先开放参数',
      fields: [
        { kind: 'number', key: 'speed', label: '语速', help: '0.5 ~ 2，1.0 为正常' },
        { kind: 'number', key: 'pitch', label: '音调', help: '0.5 ~ 2' },
        { kind: 'number', key: 'volume', label: '音量', help: '0 ~ 2' },
        { kind: 'text', key: 'emotion', label: '情绪', help: '如「亲切」「专业」' },
        { kind: 'text', key: 'language', label: '语言' },
      ],
    },
    {
      kind: 'group',
      key: 'motion',
      label: '动作驱动',
      fields: [
        { kind: 'select', key: 'mode', label: '驱动方式', options: MOTION_MODE_OPTIONS },
        { kind: 'text', key: 'template', label: '动作模板标识' },
      ],
    },
    { kind: 'text', key: 'driverModel', label: '驱动模型', help: '留空则由模型路由自动选择' },
  ],
  product: [
    { kind: 'text', key: 'category', label: '品类', help: '如「护肤品 / 精华」' },
    { kind: 'text', key: 'price', label: '价格文案', help: '如「¥299 / 30ml」' },
    { kind: 'textarea', key: 'targetAudience', label: '目标人群' },
    { kind: 'tags', key: 'sellingPoints', label: '核心卖点', help: '回车添加一条，改动时整体替换' },
    { kind: 'tags', key: 'usageScenarios', label: '使用场景', help: '回车添加一条' },
    { kind: 'textarea', key: 'visualNotes', label: '视觉规范补充' },
  ],
  brand: [
    { kind: 'tags', key: 'colors', label: '品牌色', help: '如 #1F6FEB，回车添加一个' },
    { kind: 'tags', key: 'fonts', label: '指定字体', help: '回车添加一个字体族' },
    { kind: 'textarea', key: 'tone', label: '品牌调性', help: 'Agent 写文案前会读这一段' },
    { kind: 'text', key: 'slogan', label: '品牌口号' },
    { kind: 'text', key: 'industry', label: '行业' },
    { kind: 'textarea', key: 'story', label: '品牌故事' },
    { kind: 'group', key: 'guidelines', label: '品牌规范', fields: BRAND_GUIDELINE_FIELDS },
  ],
  scene: [
    { kind: 'text', key: 'location', label: '地点', help: '如「长安城朱雀大街」' },
    { kind: 'text', key: 'timeOfDay', label: '时间', help: '如「夜」「黄昏」' },
    { kind: 'text', key: 'lighting', label: '光照', help: '如「月光」「暖色台灯」' },
    { kind: 'text', key: 'weather', label: '天气' },
    { kind: 'text', key: 'era', label: '时代背景' },
    { kind: 'textarea', key: 'atmosphere', label: '空间氛围' },
    { kind: 'tags', key: 'colorPalette', label: '主色调', help: '回车添加一个颜色' },
    { kind: 'text', key: 'cameraNotes', label: '镜头运动建议', help: '如「缓慢推近」' },
    { kind: 'text', key: 'ambientSound', label: '默认音效' },
  ],
  prop: [
    { kind: 'text', key: 'category', label: '类别' },
    { kind: 'text', key: 'material', label: '材质' },
    {
      kind: 'textarea',
      key: 'appearance',
      label: '外观描述',
      // 注意：这里刻意是**字符串**而不是 group —— 同一个键在 character 下是对象，
      // 在 prop 下是字符串，group 这个控件正好解决这种形状差异
    },
    { kind: 'textarea', key: 'storyMeaning', label: '剧情意义' },
  ],
  costume: [
    { kind: 'text', key: 'category', label: '类别' },
    { kind: 'text', key: 'primaryColor', label: '主色', help: '如「中国红」' },
    { kind: 'tags', key: 'colors', label: '配色', help: '回车添加一个颜色' },
    { kind: 'text', key: 'material', label: '材质' },
    { kind: 'text', key: 'era', label: '时代' },
    { kind: 'text', key: 'occasion', label: '穿着场合' },
  ],
  image: [],
  video: [],
  audio: [],
  voice: [],
  music: [],
  logo: [],
  font: [],
};

/** 该类型是否走 metadata 表单（可创建 / 可编辑 metadata） */
export function isCreativeAssetType(type: AssetType): type is CreativeAssetType {
  return (CREATIVE_ASSET_TYPES as readonly string[]).includes(type);
}

/**
 * 通用字段的键名（不走 `METADATA_SPECS`，所有类型都有）。
 *
 * 这张表**不是**渲染用的清单，而是给 `parseFieldErrors` 判断命中用的：
 * 后端对 `name` / `slug` 这些字段的报错路径与 metadata 的 `appearance.hair`
 * 是同一形态，两处都要能落到对应输入框。
 * 调用方应当只把自己**真正渲染了**的字段加进路径集合 —— 加进去却没渲染，
 * 那条错误就会被静默丢掉。
 */
export const GENERAL_FIELD_KEYS = ['name', 'slug', 'description', 'tags', 'coverUrl'] as const;

/* ─────────────────────────── 纯函数：脏值与路径 ─────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构相等（数组按元素、对象按键，其余用 `===`） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * 只提交改动过的字段。
 *
 * ── 为什么不能提交整份 metadata ──
 * 硬约束：表单只覆盖 7 个类型的一部分字段，而 Agent 会往 metadata 里写表单
 * 没有的东西（`generation`、`reference_images`、`cues`）。提交整份 = 把它们
 * 悄悄抹掉。服务端是「深合并之后再整体校验」（`routes/assets.ts` 的 PATCH），
 * 因此部分提交是安全的。
 *
 * 三条规则，缺一不可：
 * 1. 值与初始值相同      → 不提交
 * 2. 值被清空且原本有值  → 提交 `null`（服务端 `deepMerge` 的显式清除语义）
 * 3. 值被清空且原本就没有 → **不提交**。新建场景全是这种：zod 的 `.optional()`
 *    只接受 `undefined`，发 `null` 必然 400
 *
 * group **永远只向下递归**，绝不整体置 `null` —— 那会连 Agent 写入、
 * 表单没暴露的同名字段一起删掉。
 */
export function diffMetadata(
  specs: readonly FieldSpec[],
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const spec of specs) {
    const before = initial[spec.key];
    const next = current[spec.key];

    if (spec.kind === 'group') {
      const sub = diffMetadata(
        spec.fields,
        isPlainObject(before) ? before : {},
        isPlainObject(next) ? next : {},
      );
      // 组内没有任何改动就不提交这个组：提交 `{}` 没有意义
      if (Object.keys(sub).length > 0) patch[spec.key] = sub;
      continue;
    }

    if (next === undefined) {
      if (before !== undefined) patch[spec.key] = null;
      continue;
    }
    if (deepEqual(next, before)) continue;
    // 数组整体替换：调用方必须给出完整数组（见任务简报里的裁定 2）
    patch[spec.key] = next;
  }

  return patch;
}

/** 表里出现的全部点分路径（叶子 + group），供 `parseFieldErrors` 判断命中 */
export function fieldPaths(specs: readonly FieldSpec[]): Set<string> {
  const paths = new Set<string>();
  const walk = (nodes: readonly FieldSpec[], prefix: string): void => {
    for (const node of nodes) {
      const path = prefix === '' ? node.key : `${prefix}.${node.key}`;
      paths.add(path);
      if (node.kind === 'group') walk(node.fields, path);
    }
  };
  walk(specs, '');
  return paths;
}
```

- [ ] **Step 7: 再跑契约测试，确认通过**

```bash
pnpm --filter @svh/api exec vitest run test/asset-form-contract.test.ts
```

Expected: PASS（8 个用例）。若报「本测试没有它的 schema 分支」，检查 `SCHEMA_BY_TYPE` 是不是
被删成了只有 7 个分支 —— 字段表遍历的是 14 类，7 类生成产物也要有分支。
若报某字段「schema 里不存在」，**先改 `specs.ts` 的键名**，
不要改 schema —— schema 是既有契约，改动会影响已落库的历史数据。

- [ ] **Step 8: 创建 `assetErrors.ts`**

```ts
/**
 * 把后端返回的字段级错误落到具体输入框。
 *
 * ── 后端给的是什么 ──
 * `buildAssetData`（`apps/api/src/routes/assets.ts`）把 zod 的 issue 拼成
 * `appearance.hair: 字符串长度不能超过 200`，塞进 `suggestions`（最多 3 条）。
 * `parseOrThrow` 对请求体本身的问题也是同一形态。
 *
 * ── 为什么按前缀解析而不是原样显示 ──
 * 规范要求错误必须能指导下一步。把 `appearance.hair: …` 原样摊在页面顶部，
 * 用户还得自己找「appearance 是哪个框」。解析出路径就能把这句话挂到那个输入框
 * 下面，顶部只留没匹配上的部分。
 *
 * 匹配不上的一律进 `unmatched`，由调用方原样显示 —— 宁可显示得笨一点，
 * 也不能把一句看不懂的错误悄悄丢掉。
 */

/**
 * `字段.子字段: 说明`。
 *
 * 路径段限制为普通标识符：后端拼的是 zod 的 `issue.path.join('.')`，
 * 而本项目的 metadata 字段名全是 ASCII 标识符。用宽松的 `.*` 匹配冒号
 * 会把「检查请求体字段名称与类型是否正确」这类不含冒号的通用建议误判。
 */
const FIELD_ISSUE = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*):\s*([\s\S]+)$/;

export interface ParsedFieldErrors {
  /** 键是 `appearance.hair` 这样的点分路径 */
  fieldErrors: Record<string, string>;
  /** 没能匹配到任何输入框的原文（含通用建议），调用方应原样显示 */
  unmatched: string[];
}

export function parseFieldErrors(
  suggestions: readonly string[],
  paths: ReadonlySet<string>,
): ParsedFieldErrors {
  const fieldErrors: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const suggestion of suggestions) {
    const matched = FIELD_ISSUE.exec(suggestion);
    const path = matched?.[1];
    const message = matched?.[2];
    // 只认表里真实存在的路径：后端可能报出一个表单没暴露的字段
    // （例如 appearanceFields.性别），把它挂到不存在的输入框上没有意义
    if (path !== undefined && message !== undefined && paths.has(path)) {
      fieldErrors[path] = message;
      continue;
    }
    unmatched.push(suggestion);
  }

  return { fieldErrors, unmatched };
}
```

- [ ] **Step 9: 写纯函数测试（先写、先看它失败）**

创建 `apps/web/test/asset-metadata.test.ts`：

```ts
/**
 * 字段表相关纯函数的测试。
 *
 * 组件测试（`metadata-form.test.tsx`）证明「界面上点得对」，
 * 这里证明「算得对」—— `diffMetadata` 的三条规则是本阶段最容易写错、
 * 也最难从界面上看出来的一处：写错了不会报错，只会**静默丢字段**。
 */
import { describe, expect, it } from 'vitest';

import { ASSET_TYPE_LABELS, ASSET_TYPE_OPTIONS } from '../src/features/assets/assetLabels.js';
import { parseFieldErrors } from '../src/features/assets/assetErrors.js';
import {
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
  isCreativeAssetType,
  type FieldSpec,
} from '../src/features/assets/metadata/specs.js';
import { ASSET_TYPES } from '../src/lib/api-types.js';

const SPECS: readonly FieldSpec[] = [
  { kind: 'text', key: 'hair', label: '发型' },
  { kind: 'number', key: 'heightCm', label: '身高' },
  { kind: 'tags', key: 'accessories', label: '配饰' },
  { kind: 'group', key: 'appearance', label: '外观', fields: [{ kind: 'text', key: 'hair', label: '发型' }] },
];

describe('diffMetadata：只提交改动过的字段', () => {
  it('没有任何改动时返回空对象（表单没碰过的字段一个都不发）', () => {
    const initial = { hair: '黑色长直发', appearance: { hair: '黑色长直发' } };
    expect(diffMetadata(SPECS, initial, { ...initial })).toEqual({});
  });

  it('改了哪个字段就只发哪个字段，且发的是完整数组', () => {
    const initial = { hair: '黑色长直发', accessories: ['玉佩'] };
    const patch = diffMetadata(SPECS, initial, {
      hair: '红色短发',
      accessories: ['玉佩', '团扇'],
    });
    expect(patch).toEqual({ hair: '红色短发', accessories: ['玉佩', '团扇'] });
  });

  it('清空一个原本有值的字段发 null（服务端 deepMerge 的显式清除语义）', () => {
    expect(diffMetadata(SPECS, { hair: '黑色长直发' }, {})).toEqual({ hair: null });
  });

  it('清空一个原本就没有值的字段什么都不发（发 null 会被 optional() 拒掉）', () => {
    expect(diffMetadata(SPECS, {}, { hair: undefined })).toEqual({});
    expect(diffMetadata(SPECS, {}, {})).toEqual({});
  });

  it('group 内清空发的是嵌套 null，而不是把整个 group 置 null', () => {
    const patch = diffMetadata(SPECS, { appearance: { hair: '黑色长直发' } }, { appearance: {} });
    // `{ appearance: null }` 会连 Agent 写入的 appearance.age / facialFeatures 一起删掉
    expect(patch).toEqual({ appearance: { hair: null } });
    expect(patch.appearance).not.toBeNull();
  });

  it('group 内没有任何改动时不发这个 group', () => {
    const initial = { appearance: { hair: '黑色长直发' } };
    expect(diffMetadata(SPECS, initial, { appearance: { hair: '黑色长直发' } })).toEqual({});
  });

  it('Agent 写入、表单没有暴露的字段不会出现在补丁里', () => {
    // 表单只认 SPECS 里的键；generation 这类键连被检查的机会都没有
    const patch = diffMetadata(SPECS, { generation: { prompt: 'x' } }, { hair: '红色短发' });
    expect(patch).toEqual({ hair: '红色短发' });
    expect(Object.keys(patch)).not.toContain('generation');
  });
});

describe('fieldPaths', () => {
  it('同时给出叶子与 group 的点分路径', () => {
    const paths = fieldPaths(METADATA_SPECS.character);
    expect(paths.has('appearance')).toBe(true);
    expect(paths.has('appearance.hair')).toBe(true);
    expect(paths.has('costume.name')).toBe(true);
  });

  it('生成产物的字段表是空的 → 路径集合也是空的', () => {
    expect(fieldPaths(METADATA_SPECS.image).size).toBe(0);
  });
});

describe('parseFieldErrors', () => {
  const paths = fieldPaths(METADATA_SPECS.character);

  it('把 `字段.子字段: 说明` 解析到对应路径', () => {
    const parsed = parseFieldErrors(
      ['appearance.hair: 字符串长度不能超过 200', 'appearance.age: 应为整数'],
      paths,
    );
    expect(parsed.fieldErrors).toEqual({
      'appearance.hair': '字符串长度不能超过 200',
      'appearance.age': '应为整数',
    });
    expect(parsed.unmatched).toEqual([]);
  });

  it('匹配不上路径的原文进 unmatched，不被丢掉', () => {
    const parsed = parseFieldErrors(
      ['appearanceFields.性别: 类型不匹配', '检查请求体字段名称与类型是否正确'],
      paths,
    );
    expect(parsed.fieldErrors).toEqual({});
    expect(parsed.unmatched).toEqual([
      'appearanceFields.性别: 类型不匹配',
      '检查请求体字段名称与类型是否正确',
    ]);
  });

  it('说明里带冒号也不会被截断', () => {
    const parsed = parseFieldErrors(['appearance.hair: 需要形如「长发：及腰」的描述'], paths);
    expect(parsed.fieldErrors['appearance.hair']).toBe('需要形如「长发：及腰」的描述');
  });
});

describe('标签', () => {
  it('14 类都有中文标签，没有空串', () => {
    for (const type of ASSET_TYPES) {
      expect(ASSET_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ASSET_TYPE_LABELS).sort()).toEqual([...ASSET_TYPES].sort());
  });

  it('类型筛选项覆盖全部 14 类', () => {
    expect(ASSET_TYPE_OPTIONS.map((option) => option.value)).toEqual([...ASSET_TYPES]);
  });

  it('只有 7 类创作实体走表单', () => {
    expect(isCreativeAssetType('character')).toBe(true);
    expect(isCreativeAssetType('image')).toBe(false);
    expect(isCreativeAssetType('video')).toBe(false);
  });
});
```

- [ ] **Step 10: 运行，确认 `parseFieldErrors` 相关用例失败**

```bash
pnpm --filter @svh/web exec vitest run test/asset-metadata.test.ts
```

Expected: FAIL —— `Failed to resolve import "../src/features/assets/assetErrors.js"`。
（`diffMetadata` 那几条此时应当已经是绿的：它在 Step 6 已经实现。）

- [ ] **Step 11: 回到 Step 8 创建 `assetErrors.ts`（若尚未创建）**

- [ ] **Step 12: 运行两个测试文件，确认全部通过**

```bash
pnpm --filter @svh/web exec vitest run test/asset-metadata.test.ts
pnpm --filter @svh/api exec vitest run test/asset-form-contract.test.ts
```

Expected: 两个文件全绿。

- [ ] **Step 13: 把新类型接到真实端点上（`api-contract.test.ts`）**

`AssetSummary` / `AssetDetail` / `AssetUpdateResult` 是**手写**的响应类型，
`asset-form-contract.test.ts` 只守表单那一侧。按 `api-contract.test.ts` 既有的
做法，用真实端点再守一道：

1. `let providerId = '';` 那一行下面加一行 `let assetId: string;`
2. 把 `beforeAll` 里创建「契约角色」的那段 `await app.inject({...})` 改成捕获 id：

```ts
  // 有资产才能断言 @引用 与资产列表项两个契约
  const asset = await app.inject({
    method: 'POST',
    url: '/api/assets',
    payload: {
      projectId,
      type: 'character',
      name: '契约角色',
      metadata: { appearance: { hair: '黑色长直发' } },
    },
  });
  expect(asset.statusCode).toBe(201);
  assetId = (asset.json() as { id: string }).id;
```

3. 在 `it('GET /api/assets 的列表项带齐 AssetOption 的字段', ...)` 之后追加：

```ts
  it('GET /api/assets 的列表项带齐 AssetSummary 的字段', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/assets?projectId=${projectId}` });
    expect(res.statusCode).toBe(200);
    断言键齐全('AssetSummary', 取首项((res.json() as { items: unknown }).items, 'GET /api/assets'));
  });

  it('GET /api/assets/:id 返回 AssetDetail 的字段', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/assets/${assetId}` });
    expect(res.statusCode).toBe(200);
    断言键齐全('AssetDetail', res.json());
  });

  it('PATCH /api/assets/:id 返回 AssetUpdateResult 的字段', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${assetId}`,
      payload: { description: '契约测试更新' },
    });
    expect(res.statusCode).toBe(200);
    断言键齐全('AssetUpdateResult', res.json());
  });
```

- [ ] **Step 14: 运行 api 全套测试**

```bash
pnpm --filter @svh/api test
```

Expected: PASS。这一步会真实读写开发库，属预期行为（该文件本来就这样）。

- [ ] **Step 15: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
pnpm --filter @svh/api typecheck && pnpm --filter @svh/api lint
```

Expected: 0 error。

- [ ] **Step 16: 提交**

```bash
git add apps/web/src/lib/api-types.ts \
        apps/web/src/features/assets/assetLabels.ts \
        apps/web/src/features/assets/assetErrors.ts \
        apps/web/src/features/assets/metadata/specs.ts \
        apps/web/test/asset-metadata.test.ts \
        apps/api/test/asset-form-contract.test.ts \
        apps/api/test/api-contract.test.ts
git commit -m "feat(assets): 资产表单字段表与 schema 的机械契约"
```

---

## Task 2: `MetadataForm` —— 一个渲染器，6 种控件

**Files:**
- Create: `apps/web/src/features/assets/metadata/MetadataForm.tsx`
- Create: `apps/web/src/features/assets/metadata/MetadataForm.module.css`
- Test: `apps/web/test/metadata-form.test.tsx`

**Interfaces:**
- Consumes: `FieldSpec`（Task 1）、`Field` / `Icon`（既有组件）
- Produces:
  ```ts
  interface MetadataFormProps {
    specs: readonly FieldSpec[];
    /** 表单覆盖的 metadata 子树，键与 specs 对齐 */
    value: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
    /** 后端字段级错误，键是 `appearance.hair` 这样的点分路径（来自 parseFieldErrors） */
    errors?: Record<string, string>;
    disabled?: boolean;
    /** 控件 id 前缀，同页出现两个表单时避免 id 冲突 */
    idPrefix: string;
  }
  export function MetadataForm(props: MetadataFormProps): JSX.Element;
  ```
- 另导出（通用字段 `tags` 复用同一个控件）：
  ```ts
  interface TagsFieldProps {
    label: string;
    htmlFor: string;
    id: string;
    value: string[];
    onChange: (next: string[]) => void;
    helper?: string;
    error?: string;
    disabled?: boolean;
  }
  export function TagsField(props: TagsFieldProps): JSX.Element;
  ```

### 设计要点（实施前先读）

**控件样式不要在这里重写。** `Field.module.css` 已经用
`.control :global(input|textarea|select)` 统一了输入框外观，其它表单
（新建项目、Provider 配置）都靠它。本文件的 CSS 只管**布局与 group**，
再写一套输入框样式必然与其它页面漂移。

**tags 控件为什么把 chips 放在 `Field` 外面。**
`Field` 用 `cloneElement` 把 `aria-describedby` / `aria-invalid` 透到
**单个**子元素上。若子元素是一个包着 chips 和 input 的 `<div>`，这两个属性会
落在 div 上，读屏用户聚焦输入框时听不到说明与错误。因此 tags 的结构是
`Field > input`（单元素，透传正确）+ 一个同级的 chips 列表。

**tags 必须「失焦即提交」。** 用户打完一个色值直接点「保存」是常规操作；
只在回车时提交会让这一项**静默丢失**（保存成功、数据却没进去），
而这是最难被发现的一类缺陷。

**`LeafControl` 与 `TagsInput` 都必须把 `Field` 透下来的 aria 属性转发到真实的控件上。**
`Field` 的 children 是**自定义组件**而不是 DOM 节点，`cloneElement` 加的那两个属性
会停在组件这一层。少了转发，`Field` 的无障碍契约就是空的，而**界面看上去完全正常** ——
这条在实现时先漏了 `TagsInput`（生产 specs 里大量 tags 字段带 `help`，
它们的说明文字读屏听不到），补的时候两个一起补。

**文本控件清空时写回的是 `undefined`，不是 `''`。**
`diffMetadata` 只把 `undefined` 认作「清空」；写回 `''` 会被当成「改成了空字符串」，
服务端于是留下一个空串而不是删掉那个键 —— 与下拉的「未设置」行为不一致。

- [ ] **Step 1: 写测试（先写、先看它失败）**

创建 `apps/web/test/metadata-form.test.tsx`：

```tsx
/**
 * MetadataForm 渲染器测试。
 *
 * 这个文件证明「界面上点得对」：6 种控件都渲染出**带标签、可访问**的控件、
 * group 读写正确、清空一个字段在补丁里变成 null。
 * 「算得对」（diffMetadata 的三条规则）在 `asset-metadata.test.ts` 里单独测 ——
 * 纯逻辑与渲染分开，出错时能一眼看出是哪一层。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MetadataForm } from '../src/features/assets/metadata/MetadataForm.js';
import { diffMetadata, type FieldSpec } from '../src/features/assets/metadata/specs.js';

/** 一份小字段表：6 种控件各一个，便于逐个断言 */
const SPECS: readonly FieldSpec[] = [
  { kind: 'text', key: 'slogan', label: '品牌口号' },
  { kind: 'textarea', key: 'tone', label: '品牌调性', help: 'Agent 写文案前会读这一段' },
  { kind: 'number', key: 'heightCm', label: '身高（厘米）' },
  {
    kind: 'select',
    key: 'gender',
    label: '性别气质',
    options: [
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
    ],
  },
  { kind: 'tags', key: 'colors', label: '品牌色', help: '回车添加一项' },
  {
    kind: 'group',
    key: 'appearance',
    label: '外观',
    fields: [{ kind: 'text', key: 'hair', label: '发型发色' }],
  },
];

/**
 * 受控宿主：把 onChange 接起来，并提供一个「保存」按钮把 `diffMetadata`
 * 的结果交出来 —— 与真实调用方（创建对话框 / 详情抽屉）的用法一致。
 */
function Host({
  initial = {},
  onPatch,
}: {
  initial?: Record<string, unknown>;
  onPatch?: (patch: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <MetadataForm specs={SPECS} value={value} onChange={setValue} idPrefix="t" />
      <button
        type="button"
        onClick={() => {
          onPatch?.(diffMetadata(SPECS, initial, value));
        }}
      >
        保存
      </button>
    </>
  );
}

describe('MetadataForm 的 6 种控件', () => {
  it('每种控件都渲染出带中文标签的控件', () => {
    render(<Host />);

    expect(screen.getByLabelText('品牌口号')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('品牌调性').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('身高（厘米）')).toHaveAttribute('type', 'number');

    const gender = screen.getByLabelText('性别气质');
    expect(gender.tagName).toBe('SELECT');
    expect(within(gender).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '未设置',
      '男',
      '女',
    ]);

    // tags 的输入框与其它文本控件同一个外观，但提交语义是数组
    expect(screen.getByLabelText('品牌色')).toHaveAttribute('type', 'text');

    // group 渲染成 fieldset + legend：读屏用户能听到分组名
    expect(screen.getByRole('group', { name: '外观' })).toBeInTheDocument();
  });

  it('说明文字通过 aria-describedby 挂在控件上，而不是只显示在旁边', () => {
    render(<Host />);
    const tone = screen.getByLabelText('品牌调性');
    const describedBy = tone.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(
      'Agent 写文案前会读这一段',
    );
  });

  it('tags 的输入框同样拿到 aria-describedby（它也是 Field 的自定义组件子元素）', () => {
    // tags 是唯一一个「Field 的 children 是自定义组件」的控件；
    // 少了这次转发，它的 helper/error 只显示、不与输入框关联，界面上看不出来
    render(<Host />);
    const colors = screen.getByLabelText('品牌色');
    const describedBy = colors.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent('回车添加一项');
  });

  it('数字控件写回的是 number，不是字符串', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('身高（厘米）'), '168');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ heightCm: 168 });
  });

  it('清空一个原本有值的字段 → 补丁里是 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ slogan: '原来有口号' }} onPatch={onPatch} />);
    await userEvent.clear(screen.getByLabelText('品牌口号'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ slogan: null });
  });

  it('下拉选「未设置」→ 已设过的值被清成 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ gender: 'male' }} onPatch={onPatch} />);
    await userEvent.selectOptions(
      screen.getByLabelText('性别气质'),
      screen.getByRole('option', { name: '未设置' }),
    );
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ gender: null });
  });

  it('group 内清空发嵌套 null，绝不把整个 group 置 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ appearance: { hair: '黑色长直发', age: 22 } }} onPatch={onPatch} />);
    await userEvent.clear(screen.getByLabelText('发型发色'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 发 { appearance: null } 会把 Agent 写入的 age 一起删掉
    expect(onPatch).toHaveBeenCalledWith({ appearance: { hair: null } });
  });

  it('group 内的编辑不会把顶层其它键挤掉（递归渲染必须重新套回 group 键）', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ slogan: '原来有口号', appearance: { age: 22 } }} onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('发型发色'), '黑色长直发');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 写回时若忘了把子对象套回 `appearance` 键，metadata 会被整个替换成
    // `{ hair: … }`，于是这里会看到 { slogan: null } 这种「什么都没改却全丢了」
    expect(onPatch).toHaveBeenCalledWith({ appearance: { hair: '黑色长直发' } });
  });

  it('提交中禁用全部控件，避免改到一半又被提交一次', () => {
    render(
      <MetadataForm specs={SPECS} value={{}} onChange={() => undefined} disabled idPrefix="t" />,
    );
    expect(screen.getByLabelText('品牌口号')).toBeDisabled();
    expect(screen.getByLabelText('品牌调性')).toBeDisabled();
    expect(screen.getByLabelText('性别气质')).toBeDisabled();
    expect(screen.getByLabelText('品牌色')).toBeDisabled();
  });

  it('字段级错误显示在对应输入框下面，而不是只堆在页面顶部', () => {
    render(
      <MetadataForm
        specs={SPECS}
        value={{}}
        onChange={() => undefined}
        errors={{ 'appearance.hair': '字符串长度不能超过 200' }}
        idPrefix="t"
      />,
    );
    const hair = screen.getByLabelText('发型发色');
    expect(hair).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('字符串长度不能超过 200');
  });
});

describe('MetadataForm 的 tags 控件', () => {
  it('回车添加一项，点 × 删除一项', async () => {
    render(<Host />);
    const input = screen.getByLabelText('品牌色');

    await userEvent.type(input, '#1F6FEB{Enter}');
    expect(screen.getByText('#1F6FEB')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '删除 #1F6FEB' }));
    expect(screen.queryByText('#1F6FEB')).not.toBeInTheDocument();
  });

  it('输入后直接点保存（没按回车）也会带上这一项 —— 失焦即提交', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#0B5FFF');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ colors: ['#0B5FFF'] });
  });

  it('逗号也当分隔符（中文输入法下用户会打「，」）', async () => {
    const onPatch = vi.fn();
    render(<Host onPatch={onPatch} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#1F6FEB,#0B5FFF');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onPatch).toHaveBeenCalledWith({ colors: ['#1F6FEB', '#0B5FFF'] });
  });

  it('重复项不会被加第二次', async () => {
    render(<Host initial={{ colors: ['#1F6FEB'] }} />);
    await userEvent.type(screen.getByLabelText('品牌色'), '#1F6FEB{Enter}');
    expect(screen.getAllByText('#1F6FEB')).toHaveLength(1);
  });

  it('加过又删掉 → 提交空数组（明确表达「清空」），而不是 null', async () => {
    const onPatch = vi.fn();
    render(<Host initial={{ colors: ['#1F6FEB'] }} onPatch={onPatch} />);
    await userEvent.click(screen.getByRole('button', { name: '删除 #1F6FEB' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    // 数组是**整体替换**语义：空数组才是「一个都不剩」，null 会被 schema 拒掉
    expect(onPatch).toHaveBeenCalledWith({ colors: [] });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/metadata-form.test.tsx
```

Expected: FAIL —— `Failed to resolve import "../src/features/assets/metadata/MetadataForm.js"`。

- [ ] **Step 3: 创建 `metadata/MetadataForm.module.css`**

```css
/*
 * metadata 表单的布局样式。
 *
 * 输入框外观**不在这里**：`components/Field.module.css` 用
 * `.control :global(input|textarea|select)` 统一了它，其它表单也靠那一份。
 * 这里再写一套必然与它们漂移。
 */

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* group 用 fieldset 而不是 div：分组语义（含分组名）要能被读屏听到 */
.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  border: none;
}

.legend {
  padding: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.groupHelp {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.groupError {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--color-error);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tags {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chipList {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--color-surface-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-secondary);
  color: var(--color-text-primary);
}

.chipRemove {
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.chipRemove:hover {
  color: var(--color-error);
}

.chipRemove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
```

- [ ] **Step 4: 创建 `metadata/MetadataForm.tsx`**

```tsx
/**
 * 资产 metadata 的通用渲染器。
 *
 * ── 一个渲染器，6 种控件 ──
 * 字段描述来自 `specs.ts` 的 `METADATA_SPECS`（**数据**），这里只负责把描述
 * 渲染成控件、把用户的编辑写回一个 `Record<string, unknown>`。
 * 新增类型或字段不需要动这个文件 —— 这正是「数据表 + 一个渲染器」的意义。
 *
 * ── 受控组件，但**不**自己算补丁 ──
 * 这里只维护「当前值」并向上 `onChange`；「哪些字段变了」由 `diffMetadata`
 * 在提交那一刻计算。分开的理由有两条：
 *   1. 补丁的正确性（清空发 `null`、数组整体替换、group 不整体置 null）是纯逻辑，
 *      值得单独测，不该埋在渲染里；
 *   2. 值留在表单内部，提交失败时用户的输入天然保留 —— 不需要额外写「恢复草稿」。
 */
import { useState, type ReactNode } from 'react';

import { Field } from '../../../components/Field.js';
import { Icon } from '../../../components/Icon.js';
import type { FieldSpec } from './specs.js';
import styles from './MetadataForm.module.css';

/** 非 group 的字段（叶子） */
type LeafSpec = Exclude<FieldSpec, { kind: 'group' }>;

/**
 * `Field` 通过 `cloneElement` 透到子元素上的无障碍属性。
 *
 * ── 为什么这里必须显式接住 ──
 * `Field` 的 children 是 `<LeafControl …/>` —— 一个**自定义组件**，不是 DOM
 * 节点。`cloneElement` 把这两个属性作为 **props** 交给它，而不是落到 DOM 上；
 * 组件若不往下传，`aria-describedby` / `aria-invalid` 就停在组件这一层，
 * 读屏用户聚焦输入框时听不到说明与错误，`Field` 的契约也就白写了。
 * （与 `components/Field.tsx` 里那份同名类型是一份口头契约：那边改传什么，
 * 这边就得接什么。）
 */
interface ControlAriaProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export interface MetadataFormProps {
  specs: readonly FieldSpec[];
  /** 表单覆盖的 metadata 子树，键与 specs 对齐 */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** 后端字段级错误，键是 `appearance.hair` 这样的点分路径 */
  errors?: Record<string, string>;
  /** 提交中：控件禁用，避免改到一半又被提交一次 */
  disabled?: boolean;
  /** 控件 id 前缀，同一页面出现两个表单时避免 id 冲突 */
  idPrefix: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 文本控件写回：**空串必须回落到 `undefined`**。
 *
 * `diffMetadata` 只把 `undefined` 认作「清空」（原本有值 → 提交 `null`）；
 * 直接写回 `''` 会被当成「用户把它改成了空字符串」，于是清空一个字段之后
 * 服务端留下一个空串而不是删掉它 —— 与下拉的「未设置」行为不一致。
 *
 * 判据只用 `=== ''`，**不 trim**：受控输入每次按键都要原样回写，
 * 一旦 trim 掉尾部空格，用户就再也打不出「你好 世界」这种中间带空格的句子。
 */
function textOrUndefined(raw: string): string | undefined {
  return raw === '' ? undefined : raw;
}

/**
 * 数字控件的显示值：**从数字反推**。
 *
 * ── 这样反推能不能输入小数 ──
 * 能。真机实测（`~/svh-probe/phase6/number-typing.mjs`，Chromium + CDP 真实按键）：
 * 逐字键入 `1` `.` `5` 最终得到 `1.5`。原因是输入 `1.` 时浏览器把 `.value` 报成
 * **上一次的合法值 `1`**，于是 React 的目标值与 DOM 当前值相等、**跳过写回**，
 * 原始文本 `1.` 留在编辑缓冲里，继续打 `5` 就成了 `1.5`。负数同理。
 *
 * **jsdom 不是这样**：`input.value = '1.'` 在 jsdom 30 里读回 `''`，受控重写
 * 于是会把小数点抹掉 —— 在 jsdom 里输入 `1.5` 会得到 `5`。所以小数输入
 * **在单元测试里测不出来**，它由上面那个真机探针保证。不要因为 jsdom 的症状
 * 去「修」这个实现。
 */
function numberTextOf(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** 空串回落到 `undefined`：diffMetadata 靠它区分「没填」与「填了空」 */
function numberOf(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringListOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 在对象里写一个键。不可变更新：React 靠引用变化决定重渲染 */
function withKey(
  source: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> {
  return { ...source, [key]: next };
}

interface TagsInputProps extends ControlAriaProps {
  id: string;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}

/**
 * 数组型字段的输入框。
 *
 * 输入框本身只承载「待确认的一项」，已确认的项渲染成 chips。
 * **失焦即提交**：用户打完一项直接点「保存」是常规操作，
 * 只在回车时提交会让这一项静默丢失（保存成功、数据却没进去）。
 */
function TagsInput({ id, value, disabled, onChange, ...aria }: TagsInputProps) {
  const [draft, setDraft] = useState('');

  function addTag(raw: string): void {
    const tag = raw.trim();
    setDraft('');
    if (tag === '' || value.includes(tag)) return;
    onChange([...value, tag]);
  }

  return (
    <input
      id={id}
      type="text"
      value={draft}
      disabled={disabled}
      // 与 LeafControl 同理：Field 的 children 是自定义组件，aria 属性必须显式往下传
      {...aria}
      onChange={(event) => {
        const next = event.target.value;
        // 逗号（含中文全角）当分隔符：中文输入法下用户会习惯性打「，」
        if (next.endsWith(',') || next.endsWith('，')) {
          addTag(next.slice(0, -1));
          return;
        }
        setDraft(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          // 回车在表单里默认是提交；标签输入框里它应当是「添加这一项」
          event.preventDefault();
          addTag(draft);
        }
      }}
      onBlur={() => {
        addTag(draft);
      }}
    />
  );
}

export interface TagsFieldProps {
  label: string;
  /** 必须与 `id` 一致 */
  htmlFor: string;
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  helper?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * 数组型字段的完整控件（Label + Input + chips）。
 *
 * 导出它是为了通用字段 `tags`：创建对话框与详情抽屉上也有一个标签输入框，
 * 与 metadata 里的数组字段是**同一种交互**，必须长得一模一样。
 * 让它们各自实现一遍，两处迟早会长歪。
 */
export function TagsField({
  label,
  htmlFor,
  id,
  value,
  onChange,
  helper,
  error,
  disabled = false,
}: TagsFieldProps) {
  return (
    // 结构刻意是 `Field > TagsInput`（单个元素）+ 同级的 chips：
    // Field 用 cloneElement 把 aria-describedby / aria-invalid 透到**单个**子元素上。
    // 若子元素换成包着 chips 的 div，这两个属性会落在 div 上。
    // 注意 `TagsInput` 是**自定义组件**而不是 DOM 节点 —— 所以它必须
    // 继承 `ControlAriaProps` 并把 `{...aria}` 展开到真实的 input 上，
    // 否则属性停在组件这一层，界面上完全看不出来。
    <div className={styles.tags}>
      <Field
        label={label}
        htmlFor={htmlFor}
        {...(helper !== undefined ? { helper } : {})}
        {...(error !== undefined ? { error } : {})}
      >
        <TagsInput id={id} value={value} disabled={disabled} onChange={onChange} />
      </Field>
      {value.length > 0 ? (
        <ul className={styles.chipList}>
          {value.map((tag) => (
            <li className={styles.chip} key={tag}>
              <span>{tag}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`删除 ${tag}`}
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((item) => item !== tag));
                }}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface LeafProps extends ControlAriaProps {
  spec: LeafSpec;
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
}

/** 一个叶子字段的控件。tags 单独处理（要 chips，见 MetadataForm 里的说明） */
function LeafControl({ spec, id, value, disabled, onChange, ...aria }: LeafProps) {
  switch (spec.kind) {
    case 'text':
      return (
        <input
          id={id}
          type="text"
          value={textOf(value)}
          disabled={disabled}
          // Field 透下来的 aria-describedby / aria-invalid 必须落到真实的控件上
          {...aria}
          onChange={(event) => {
            onChange(textOrUndefined(event.target.value));
          }}
        />
      );
    case 'textarea':
      return (
        <textarea
          id={id}
          rows={3}
          value={textOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            onChange(textOrUndefined(event.target.value));
          }}
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          step="any"
          value={numberTextOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            onChange(numberOf(event.target.value));
          }}
        />
      );
    case 'select':
      return (
        <select
          id={id}
          value={textOf(value)}
          disabled={disabled}
          {...aria}
          onChange={(event) => {
            // 空值选项 = 清空：回落到 undefined，由 diffMetadata 决定发不发 null
            onChange(event.target.value === '' ? undefined : event.target.value);
          }}
        >
          <option value="">未设置</option>
          {spec.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case 'tags':
      // 由调用方渲染（要连同 chips 一起），这里不可达
      return null;
  }
}

export function MetadataForm({
  specs,
  value,
  onChange,
  errors = {},
  disabled = false,
  idPrefix,
}: MetadataFormProps) {
  /**
   * 递归渲染一层字段。
   *
   * `emit` 是**这一层**的写回函数：顶层就是 `onChange`，group 内部则是
   * 「把改动重新套回 group 的键」的那一层包装。少了这层包装，group 里的
   * 一次编辑会把整个 metadata 替换成那个子对象 —— 外层的键全丢。
   */
  const renderNodes = (
    nodes: readonly FieldSpec[],
    parent: Record<string, unknown>,
    prefix: string,
    emit: (next: Record<string, unknown>) => void,
  ): ReactNode[] =>
    nodes.map((spec) => {
      const path = prefix === '' ? spec.key : `${prefix}.${spec.key}`;
      const id = `${idPrefix}-${path}`;
      const raw = parent[spec.key];

      if (spec.kind === 'group') {
        return (
          <fieldset className={styles.group} key={spec.key}>
            <legend className={styles.legend}>{spec.label}</legend>
            {spec.help !== undefined ? <p className={styles.groupHelp}>{spec.help}</p> : null}
            {/* group 自身的错误（例如整个对象类型不对）也要有地方显示，不能吞掉 */}
            {errors[path] !== undefined ? (
              <p className={styles.groupError} role="alert">
                {errors[path]}
              </p>
            ) : null}
            <div className={styles.fields}>
              {renderNodes(spec.fields, objectOf(raw), path, (nextSub) => {
                emit(withKey(parent, spec.key, nextSub));
              })}
            </div>
          </fieldset>
        );
      }

      const error = errors[path];

      if (spec.kind === 'tags') {
        return (
          <TagsField
            key={spec.key}
            label={spec.label}
            htmlFor={id}
            id={id}
            value={stringListOf(raw)}
            disabled={disabled}
            {...(spec.help !== undefined ? { helper: spec.help } : {})}
            {...(error !== undefined ? { error } : {})}
            onChange={(next) => {
              emit(withKey(parent, spec.key, next));
            }}
          />
        );
      }

      return (
        <Field
          key={spec.key}
          label={spec.label}
          htmlFor={id}
          {...(spec.help !== undefined ? { helper: spec.help } : {})}
          {...(error !== undefined ? { error } : {})}
        >
          <LeafControl
            spec={spec}
            id={id}
            value={raw}
            disabled={disabled}
            onChange={(next) => {
              emit(withKey(parent, spec.key, next));
            }}
          />
        </Field>
      );
    });

  return <div className={styles.form}>{renderNodes(specs, value, '', onChange)}</div>;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/metadata-form.test.tsx
```

Expected: PASS（15 个用例）。

- [ ] **Step 6: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
```

Expected: 0 error。若 `LeafControl` 的 `switch` 报「缺少返回值」，说明 `tags`
分支被删了 —— 它必须存在（`'tags'` 是联合成员，靠它保证 switch 穷尽）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/assets/metadata/MetadataForm.tsx \
        apps/web/src/features/assets/metadata/MetadataForm.module.css \
        apps/web/test/metadata-form.test.tsx
git commit -m "feat(assets): 通用 metadata 表单渲染器（6 种控件）"
```

---

## Task 3: 让 `Drawer` 撑得起资产详情（焦点管理 + 宽度档位）

**Files:**
- Modify: `apps/web/src/components/Drawer.tsx`
- Modify: `apps/web/src/components/Drawer.module.css`（加一个 `.wide`）
- Test: `apps/web/test/components.test.tsx`（在既有 `describe('Drawer')` 内追加）

**Interfaces:**
- Consumes: 无
- Produces: `Drawer` 新增一个**可选** prop，其余不变
  ```ts
  interface DrawerProps {
    open: boolean;
    title: string;
    onClose: () => void;
    side?: 'left' | 'right';
    /** 宽度档位。`sm`（默认）320px，工作台侧区用；`lg` 560px，资产详情表单用 */
    width?: 'sm' | 'lg';
    children: ReactNode;
  }
  ```
  以及行为：打开时焦点进入面板、`Esc` 关闭（已有）、关闭后焦点回到触发元素

### 设计要点

Spec §8 登记的既有缺口：`Drawer` 只有 `Esc` 关闭，没有焦点管理 ——
打开时焦点不进入、关闭后焦点掉回 `body`。本阶段要在它上面建资产详情抽屉，
属「改到哪修到哪」，一并补上。

焦点实现**直接照 `Dialog` 的写法**（`apps/web/src/components/Dialog.tsx`）：
`useRef` 记住打开前的 `document.activeElement`，打开时 `panel.focus()`，
effect 的 cleanup 里还回去。两处各自维护一套是刻意的取舍 ——
抽一个 `useFocusRestore` hook 会让两个组件的生命周期耦合，而这段逻辑只有 8 行。

宽度档位是同一件事的另一半：面板固定 `min(320px, 88vw)`，那是为工作台侧区定的，
塞进一张 metadata 表单会挤成一条。默认值保持 `sm`，**不影响**工作台现有布局。

- [ ] **Step 1: 追加测试（先写、先看它失败）**

在 `apps/web/test/components.test.tsx` 的 `describe('Drawer')` 里追加：

```tsx
  it('打开时焦点进入抽屉，关闭后还给触发元素', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开导航
          </button>
          <Drawer open={open} title="项目导航" onClose={() => setOpen(false)}>
            <button type="button">抽屉里的按钮</button>
          </Drawer>
        </>
      );
    }

    render(<Host />);
    const trigger = screen.getByRole('button', { name: '打开导航' });
    await userEvent.click(trigger);
    // 焦点不进入面板，键盘用户的 Tab 会从页面开头重新走一遍
    expect(screen.getByRole('dialog')).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    // 关闭后不回触发元素，焦点掉回 body，键盘用户就「迷路」了
    expect(trigger).toHaveFocus();
  });

  it('宽度档位：默认 sm，显式传 lg 时用宽面板', () => {
    const { unmount } = render(
      <Drawer open title="资产详情" onClose={() => undefined} width="lg">
        <p>内容</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-width', 'lg');
    unmount();

    render(
      <Drawer open title="项目导航" onClose={() => undefined}>
        <p>内容</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-width', 'sm');
  });
```

若文件顶部尚未 import `useState`，在 `react` 的 import 里补上（该文件已有
`Dialog` 的同类用例，import 很可能已经齐了 —— 先看再用）。

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/components.test.tsx
```

Expected: FAIL —— `expect(element).toHaveFocus()` 失败（焦点还在触发按钮上，
或掉到了 `body`）。

- [ ] **Step 3: 改造 `Drawer.tsx`**

把文件整体替换为（**只改焦点部分**，其余逐字保留）：

```tsx
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  side?: 'left' | 'right';
  /** 宽度档位。`sm`（默认）320px，工作台侧区用；`lg` 560px，资产详情表单用 */
  width?: 'sm' | 'lg';
  children: ReactNode;
}

/**
 * 侧抽屉。窄屏时用来收纳工作台的侧区（项目/会话导航、任务面板），
 * 也用作资产详情的容器。
 *
 * 键盘可达性保证三件事，与 `Dialog` 一致：
 *   1. `Esc` 关闭；
 *   2. 打开时焦点进入面板（否则 Tab 会从页面开头重新走一遍，
 *      面板里的内容对键盘用户等于不存在）；
 *   3. 关闭后焦点还给触发元素（否则焦点掉回 `body`，键盘用户当场迷路）。
 *
 * 刻意**不**做焦点陷阱：面板之外的页面内容仍然可达，
 * 而 `aria-modal="true"` 已经把它标成了模态对话框。
 */
export function Drawer({
  open,
  title,
  onClose,
  side = 'right',
  width = 'sm',
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  /** 打开前的焦点元素：关闭时还给它 */
  const restoreRef = useRef<HTMLElement | null>(null);

  // Esc 关闭：键盘用户必须能退出模态，否则会被困住
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时把焦点移进面板，关闭时归还给触发元素
  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} role="presentation" />
      <aside
        ref={panelRef}
        className={`${styles.panel} ${side === 'left' ? styles.left : styles.right} ${
          width === 'lg' ? styles.wide : ''
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 宽度档位用 data 属性暴露：jsdom 看不见布局，只能断言这个
        data-width={width}
        // 面板本身不参与 Tab 序列，但要能被聚焦（`focus()` 需要）
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </Button>
        </div>
        {children}
      </aside>
    </>
  );
}
```

同时给 `apps/web/src/components/Drawer.module.css` 追加：

```css
/*
 * 宽档位：资产详情里是一张 metadata 表单，320px 会挤成一条。
 * 96vw 的上限保证 390px 手机屏上仍然留出边距，不会贴边。
 */
.wide {
  width: min(560px, 96vw);
}
```

- [ ] **Step 4: 运行该文件，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/components.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 跑一遍全部前端测试（`Drawer` 被工作台窄屏复用，必须确认没有连带破坏）**

```bash
pnpm --filter @svh/web test
```

Expected: 全绿。若 `agent-workspace*.test.tsx` / `responsive.test.tsx` 出现
「元素不在文档中」一类失败，先检查是不是新加的焦点行为导致面板被卸载 ——
**不要**为了让测试过而删掉焦点管理。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/Drawer.tsx \
        apps/web/src/components/Drawer.module.css \
        apps/web/test/components.test.tsx
git commit -m "fix(web): Drawer 补焦点管理，并加宽面板档位供资产详情使用"
```

---

## Task 4: `AssetCreateDialog` —— 先选类型，再填表单

**Files:**
- Create: `apps/web/src/features/assets/AssetCreateDialog.tsx`
- Create: `apps/web/src/features/assets/AssetCreateDialog.module.css`
- Test: `apps/web/test/asset-create-dialog.test.tsx`

**Interfaces:**
- Consumes: `CREATABLE_TYPE_OPTIONS`（Task 1）、`parseFieldErrors`（Task 1）、`METADATA_SPECS` / `diffMetadata` / `fieldPaths` / `GENERAL_FIELD_KEYS`（Task 1）、`MetadataForm` / `TagsField`（Task 2）、`Dialog` / `Field` / `Button`（既有）
- Produces:
  ```ts
  interface AssetCreateDialogProps {
    open: boolean;
    projectId: string;
    /** 预填名称（来自「项目里还没有 @X」的「现在新建」） */
    initialName?: string;
    onClose: () => void;
    /** 创建成功。刷新列表 / 重建资产索引 / 弹提示都由调用方负责 */
    onCreated: (asset: AssetDetail) => void;
  }
  export function AssetCreateDialog(props: AssetCreateDialogProps): JSX.Element;
  ```

### 设计要点

**两步，不是一个长表单。** 14 类资产的字段表互不相同；把类型选择塞进表单顶部
意味着用户要先选类型、再面对一张**变了样**的表单，字段位置会跳。分开两步，
第二步的标题就是「新建角色」，用户知道自己在填什么。

**失败时内容必须全留。** 提交失败只设置错误状态，**不动**任何输入 state：
用户可能刚填了 12 个字段，一次 400 就清空是不可接受的。

**错误分两层落。** 后端 `suggestions` 里形如 `appearance.hair: …` 的进对应输入框，
其余（含通用建议）原样显示在顶部 —— 解析不出来就显示原文，绝不丢掉。

**body 里不发的键，比发的键更重要。** `slug` / `coverUrl` 留空时不发（而不是发空串），
`metadata` 用 `diffMetadata(specs, {}, values)` 只取填过的字段：
没填过的字段发 `null` 会被 `z.optional()` 拒掉（它只接受 `undefined`）。

- [ ] **Step 1: 写测试（先写、先看它失败）**

创建 `apps/web/test/asset-create-dialog.test.tsx`：

```tsx
/**
 * 新建资产对话框测试。
 *
 * 重点是两件容易写错、又不会当场报错的事：
 *   1. 提交的 body 里**只包含用户真的填过的东西**（发空串 / 发 null 都会被 schema 拒）；
 *   2. 失败之后用户填的内容一个都不能丢。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AssetCreateDialog } from '../src/features/assets/AssetCreateDialog.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 后端错误体（与 apps/api 的错误信封一致） */
function apiError(message: string, suggestions: string[] = []): Response {
  return json(
    { error: { code: 'VALIDATION_ERROR', message, suggestions, retryable: false } },
    400,
  );
}

const CREATED = {
  id: 'a1',
  projectId: 'p1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  description: '',
  metadata: {},
  tags: [],
  coverUrl: null,
  status: 'active',
  files: [],
  updatedAt: '2026-09-13T10:00:00.000Z',
};

/** 记录每次请求的 body，返回固定的创建结果 */
function mockFetch(response: () => Response): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.body !== undefined && typeof init.body === 'string') {
      bodies.push({ url, body: JSON.parse(init.body) as unknown });
    }
    return Promise.resolve(response());
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies };
}

function renderDialog(props: Partial<Parameters<typeof AssetCreateDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <AssetCreateDialog open projectId="p1" onClose={onClose} onCreated={onCreated} {...props} />,
  );
  return { onClose, onCreated };
}

/** 走完「选类型」这一步 */
async function pickCharacter(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: '角色' }));
}

describe('AssetCreateDialog 的类型选择', () => {
  it('只列出 7 类创作实体，不含生成产物', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: '角色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '品牌' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '图片' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '视频' })).not.toBeInTheDocument();
  });

  it('选了类型才出现该类型的字段', async () => {
    renderDialog();
    expect(screen.queryByLabelText('发型发色')).not.toBeInTheDocument();
    await pickCharacter();
    expect(screen.getByRole('group', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByLabelText('发型发色')).toBeInTheDocument();
  });

  it('预填名称：从「现在新建」进来时名字已经写好', async () => {
    renderDialog({ initialName: '苏晚' });
    await pickCharacter();
    expect(screen.getByLabelText('名称')).toHaveValue('苏晚');
  });
});

describe('AssetCreateDialog 的提交', () => {
  it('只提交填过的字段：留空的 slug / coverUrl 不出现在 body 里', async () => {
    const { bodies } = mockFetch(() => json(CREATED, 201));
    renderDialog();
    await pickCharacter();

    await userEvent.type(screen.getByLabelText('名称'), '苏晚');
    await userEvent.type(screen.getByLabelText('发型发色'), '黑色长直发');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toEqual({
      url: '/api/assets',
      body: {
        projectId: 'p1',
        type: 'character',
        name: '苏晚',
        description: '',
        tags: [],
        metadata: { appearance: { hair: '黑色长直发' } },
      },
    });
  });

  it('成功后回调 onCreated，由调用方负责关闭与刷新', async () => {
    mockFetch(() => json(CREATED, 201));
    const { onCreated } = renderDialog();
    await pickCharacter();
    await userEvent.type(screen.getByLabelText('名称'), '苏晚');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(CREATED);
    });
  });

  it('失败时保留已填内容，并把后端文案显示出来', async () => {
    mockFetch(() =>
      apiError('character 类型的资产数据不合法：appearance.hair: 字符串长度不能超过 200', [
        'appearance.hair: 字符串长度不能超过 200',
        '检查请求体字段名称与类型是否正确',
      ]),
    );
    const { onCreated } = renderDialog();
    await pickCharacter();

    await userEvent.type(screen.getByLabelText('名称'), '苏晚');
    await userEvent.type(screen.getByLabelText('发型发色'), '黑色长直发');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    // 输入一个都没丢
    await waitFor(() => {
      expect(screen.getByLabelText('名称')).toHaveValue('苏晚');
    });
    expect(screen.getByLabelText('发型发色')).toHaveValue('黑色长直发');
    expect(onCreated).not.toHaveBeenCalled();

    // 字段级错误落到对应输入框
    expect(screen.getByLabelText('发型发色')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('字符串长度不能超过 200')).toBeInTheDocument();

    // 没匹配上的原文照样显示，不静默丢弃
    expect(screen.getByText(/检查请求体字段名称与类型是否正确/)).toBeInTheDocument();
  });

  it('提交中禁用创建按钮，避免连点创建出两条', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => {
              resolve(json(CREATED, 201));
            };
          }),
      ),
    );
    renderDialog();
    await pickCharacter();
    await userEvent.type(screen.getByLabelText('名称'), '苏晚');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    });
    release?.();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/asset-create-dialog.test.tsx
```

Expected: FAIL —— 找不到 `AssetCreateDialog.js`。

- [ ] **Step 3: 创建 `AssetCreateDialog.module.css`**

```css
/* 新建资产对话框的内部布局。输入框外观来自 Field.module.css */

.stepHint {
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
}

.typeGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.typeButton {
  width: 100%;
  justify-content: flex-start;
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.general {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.banner {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-error-subtle);
  border: 1px solid var(--color-error);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-secondary);
}

.bannerIcon {
  flex-shrink: 0;
  color: var(--color-error);
}

.bannerText {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.bannerList {
  margin: 0;
  padding-left: var(--space-4);
  color: var(--color-text-secondary);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

@media (max-width: 480px) {
  .typeGrid {
    grid-template-columns: 1fr 1fr;
  }
}
```

- [ ] **Step 4: 创建 `AssetCreateDialog.tsx`**

```tsx
/**
 * 新建资产对话框：先选类型，再填表单。
 *
 * ── 为什么是两步 ──
 * 14 类资产的字段表互不相同。把类型选择塞进表单顶部，用户选完类型会看到
 * 一张**变了样**的表单，字段位置整体跳动。分开两步，第二步的标题就是
 * 「新建角色」，用户始终知道自己在填什么。
 *
 * ── 为什么只提交填过的字段 ──
 * `slug` / `coverUrl` 留空时不发（而不是发空串）；metadata 用
 * `diffMetadata(specs, {}, values)` 过滤，只保留用户真的碰过的键。
 * 没碰过的键发 `null` 会被 `z.optional()` 拒掉 —— 它只接受 `undefined`。
 *
 * ── 失败时保留输入 ──
 * 提交失败只设置错误状态，**不动**任何输入 state。用户可能刚填了十几个字段，
 * 一次 400 就清空是不可接受的。
 */
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { ApiError, apiPost } from '../../lib/api.js';
import type { AssetDetail, CreativeAssetType } from '../../lib/api-types.js';
import { parseFieldErrors } from './assetErrors.js';
import { CREATABLE_TYPE_OPTIONS } from './assetLabels.js';
import { MetadataForm, TagsField } from './metadata/MetadataForm.js';
import {
  GENERAL_FIELD_KEYS,
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
} from './metadata/specs.js';
import styles from './AssetCreateDialog.module.css';

export interface AssetCreateDialogProps {
  open: boolean;
  projectId: string;
  /** 预填名称（来自「项目里还没有 @X」的「现在新建」） */
  initialName?: string;
  onClose: () => void;
  /** 创建成功。刷新列表 / 重建资产索引 / 弹提示都由调用方负责 */
  onCreated: (asset: AssetDetail) => void;
}

interface FormError {
  message: string;
  /** 没能落到具体输入框的原文（含后端给的通用建议） */
  suggestions: string[];
}

export function AssetCreateDialog({
  open,
  projectId,
  initialName = '',
  onClose,
  onCreated,
}: AssetCreateDialogProps) {
  const [type, setType] = useState<CreativeAssetType | null>(null);
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [coverUrl, setCoverUrl] = useState('');
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /*
   * 每次重新打开都从干净状态开始。
   * 依赖里有 `initialName`：从「项目里还没有 @苏晚」点进来时名称要跟着变。
   */
  useEffect(() => {
    if (!open) return;
    setType(null);
    setName(initialName);
    setSlug('');
    setDescription('');
    setTags([]);
    setCoverUrl('');
    setMetadata({});
    setSubmitting(false);
    setFormError(null);
    setFieldErrors({});
  }, [open, initialName]);

  /** 后端可能对通用字段报错，它们的路径不在 METADATA_SPECS 里 */
  const knownPaths = useMemo(() => {
    const specs = type === null ? [] : METADATA_SPECS[type];
    return new Set<string>([...GENERAL_FIELD_KEYS, ...fieldPaths(specs)]);
  }, [type]);

  async function submit(): Promise<void> {
    if (type === null || submitting) return;

    const trimmedName = name.trim();
    if (trimmedName === '') {
      // 前端拦一道只是为了少一次往返；后端同样会拒（`name` 有 min(1)）
      setFieldErrors({ name: '资产名称不能为空' });
      setFormError(null);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const created = await apiPost<AssetDetail>('/api/assets', {
        projectId,
        type,
        name: trimmedName,
        // 留空就不发这个键：发空串会占住 slug 的唯一性，发 null 会被 schema 拒
        ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
        description,
        tags,
        ...(coverUrl.trim() === '' ? {} : { coverUrl: coverUrl.trim() }),
        // 只交用户真的填过的字段（详见文件头注释）
        metadata: diffMetadata(METADATA_SPECS[type], {}, metadata),
      });
      onCreated(created);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const parsed = parseFieldErrors(apiError?.suggestions ?? [], knownPaths);
      setFieldErrors(parsed.fieldErrors);
      setFormError({
        message: apiError?.message ?? '创建资产失败。',
        suggestions: parsed.unmatched,
      });
    } finally {
      setSubmitting(false);
    }
  }

  const typeLabel =
    CREATABLE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? '资产';

  return (
    <Dialog
      open={open}
      title={type === null ? '新建资产 · 选择类型' : `新建${typeLabel}`}
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {type === null ? (
            <Button onClick={onClose}>取消</Button>
          ) : (
            <>
              <Button onClick={() => { setType(null); }} disabled={submitting}>
                换类型
              </Button>
              {/* 表单在 children 里，按钮在 footer 里，靠 form 属性关联 */}
              <Button variant="primary" type="submit" form="asset-create-form" loading={submitting}>
                创建
              </Button>
            </>
          )}
        </div>
      }
    >
      {type === null ? (
        <>
          <p className={styles.stepHint}>
            选一个类型。图片、视频这类**生成产物**不在这里新建 —— 它们由 Agent
            生成后自动入库，避免手填的数据与实际文件不符。
          </p>
          <ul className={styles.typeGrid}>
            {CREATABLE_TYPE_OPTIONS.map((option) => (
              <li key={option.value}>
                <Button
                  className={styles.typeButton}
                  onClick={() => {
                    setType(option.value);
                  }}
                >
                  {option.label}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form
          id="asset-create-form"
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {formError !== null ? (
            <div className={styles.banner} role="alert">
              <Icon name="alert" className={styles.bannerIcon} />
              <div className={styles.bannerText}>
                <span>{formError.message}</span>
                {formError.suggestions.length > 0 ? (
                  <ul className={styles.bannerList}>
                    {formError.suggestions.map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className={styles.general}>
            <Field
              label="名称"
              htmlFor="asset-create-name"
              {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
            >
              <input
                id="asset-create-name"
                type="text"
                value={name}
                disabled={submitting}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>

            <Field
              label="引用名"
              htmlFor="asset-create-slug"
              helper="在对话里用 @引用名 指定它。留空则按名称自动生成"
              {...(fieldErrors.slug !== undefined ? { error: fieldErrors.slug } : {})}
            >
              <input
                id="asset-create-slug"
                type="text"
                value={slug}
                disabled={submitting}
                onChange={(event) => {
                  setSlug(event.target.value);
                }}
              />
            </Field>

            <Field
              label="说明"
              htmlFor="asset-create-description"
              {...(fieldErrors.description !== undefined ? { error: fieldErrors.description } : {})}
            >
              <textarea
                id="asset-create-description"
                rows={2}
                value={description}
                disabled={submitting}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>

            <TagsField
              label="标签"
              htmlFor="asset-create-tags"
              id="asset-create-tags"
              value={tags}
              disabled={submitting}
              helper="回车添加一项"
              {...(fieldErrors.tags !== undefined ? { error: fieldErrors.tags } : {})}
              onChange={setTags}
            />

            <Field
              label="封面图地址"
              htmlFor="asset-create-cover"
              helper="图片直链。留空则列表里用类型标签占位"
              {...(fieldErrors.coverUrl !== undefined ? { error: fieldErrors.coverUrl } : {})}
            >
              <input
                id="asset-create-cover"
                type="text"
                value={coverUrl}
                disabled={submitting}
                onChange={(event) => {
                  setCoverUrl(event.target.value);
                }}
              />
            </Field>
          </div>

          <MetadataForm
            specs={METADATA_SPECS[type]}
            value={metadata}
            onChange={setMetadata}
            errors={fieldErrors}
            disabled={submitting}
            idPrefix="asset-create"
          />
        </form>
      )}
    </Dialog>
  );
}
```

**注意 `stepHint` 里那句里的 `**生成产物**`**：JSX 里 `**` 不是 Markdown，
会原样显示成星号。把它改成中文引号或 `「」`。**实现时请写成纯文本**，例如
`图片、视频这类「生成产物」不在这里新建`。这条不是可选项 —— 星号会真的出现在界面上。

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/asset-create-dialog.test.tsx
```

Expected: PASS（7 个用例）。

- [ ] **Step 6: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
```

Expected: 0 error。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/assets/AssetCreateDialog.tsx \
        apps/web/src/features/assets/AssetCreateDialog.module.css \
        apps/web/test/asset-create-dialog.test.tsx
git commit -m "feat(assets): 新建资产对话框（先选类型再填表单）"
```

---

## Task 5: `AssetDetailDrawer` —— 只读态与编辑态

**Files:**
- Create: `apps/web/src/features/assets/AssetDetailDrawer.tsx`
- Create: `apps/web/src/features/assets/AssetDetailDrawer.module.css`
- Test: `apps/web/test/asset-detail-drawer.test.tsx`

**Interfaces:**
- Consumes: `Drawer`（Task 3，`width="lg"`）、`METADATA_SPECS` / `diffMetadata` / `fieldPaths` / `isCreativeAssetType` / `GENERAL_FIELD_KEYS`（Task 1）、`parseFieldErrors`（Task 1）、`MetadataForm` / `TagsField`（Task 2）、`ErrorState` / `SkeletonLines` / `Dialog` / `Field` / `Button` / `useToast`（既有）
- Produces:
  ```ts
  interface AssetDetailDrawerProps {
    /** 要打开的资产 id；`null` 表示关闭 */
    assetId: string | null;
    projectId: string;
    onClose: () => void;
    /** 资产不存在，或不属于本项目。调用方负责清掉深链参数并提示一次 */
    onMissing: () => void;
    /** 保存 / 归档成功后调用，用于刷新列表 */
    onChanged: () => void;
  }
  export function AssetDetailDrawer(props: AssetDetailDrawerProps): JSX.Element;
  ```

### 设计要点

**两种形态，差别只在 metadata 那一块。**

| | 通用字段 | metadata |
| --- | --- | --- |
| 创作实体（7 类） | name / slug / description / tags / coverUrl | `MetadataForm` 可编辑 |
| 生成产物（7 类） | name / description / tags | 只读展示（`width`/`format`/`duration`/`generation`…） |

生成产物的 metadata 是**生成结果**，让用户手填只会填出与实际文件不符的数据；
但它必须能**看到** —— 那正是排查「这份媒体为什么是这样」要看的东西。

**只提交 dirty 字段，一个没改就不发请求。** 见文件头注释与 Task 6 的集成测试。
一个字段都没改还发 PATCH，会平白多出一个版本号，把真正的改动淹掉。

**归档被拒时把后端的话原样显示。** `DELETE /api/assets/:id` 在被引用时返回
409 + `该资产正在被 N 处内容引用，无法直接删除。` + 两条 suggestions。
换成「删除失败」就把唯一的线索丢了。

**回调用 ref 拿，不进依赖数组。** `load` 只依赖 `assetId` / `projectId`；
若把 `onMissing` 直接放进依赖，调用方少写一个 `useCallback` 就会变成
「每次渲染都重新拉一次详情」的死循环。

- [ ] **Step 1: 写测试（先写、先看它失败）**

创建 `apps/web/test/asset-detail-drawer.test.tsx`：

```tsx
/**
 * 资产详情抽屉测试。
 *
 * 最要紧的一条：**编辑只发改动过的字段**。
 * Agent 会往 metadata 里写表单没有的东西（`generation` / `reference_images` /
 * `cues`）。提交整份 = 把它们悄悄抹掉，而这种丢失在界面上**完全看不出来**——
 * 用户只会觉得「我什么都没干，提示词怎么没了」。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AssetDetailDrawer } from '../src/features/assets/AssetDetailDrawer.js';
import type { AssetDetail } from '../src/lib/api-types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 一个创作实体：metadata 里有 Agent 写入、表单**没有**暴露的 generation */
const CHARACTER: AssetDetail = {
  id: 'a1',
  projectId: 'p1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  description: '女主',
  metadata: {
    appearance: { hair: '黑色长直发', age: 22 },
    generation: { prompt: 'Agent 写入的提示词' },
  },
  tags: ['女主'],
  coverUrl: null,
  status: 'active',
  files: [],
  updatedAt: '2026-09-13T10:00:00.000Z',
};

/** 一个生成产物：metadata 只读 */
const IMAGE: AssetDetail = {
  ...CHARACTER,
  id: 'a2',
  type: 'image',
  name: '主视觉',
  slug: '主视觉',
  metadata: {
    width: 1024,
    height: 1536,
    aspectRatio: '2:3',
    generation: { prompt: '护肤品主视觉', modelId: 'm1' },
  },
  files: [
    {
      driver: 'local',
      key: 'assets/a2.png',
      url: 'http://127.0.0.1:3030/files/a2.png',
      mimeType: 'image/png',
      size: 204800,
    },
  ],
};

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

function renderDrawer(asset: AssetDetail, options: { deleteResponse?: () => Response } = {}) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      if (method === 'DELETE') {
        return Promise.resolve(options.deleteResponse?.() ?? new Response(null, { status: 204 }));
      }
      if (method === 'PATCH') return Promise.resolve(json({ ...asset, version: 2 }));
      return Promise.resolve(json(asset));
    }),
  );

  const onClose = vi.fn();
  const onMissing = vi.fn();
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <AssetDetailDrawer
        assetId={asset.id}
        projectId="p1"
        onClose={onClose}
        onMissing={onMissing}
        onChanged={onChanged}
      />
    </ToastProvider>,
  );
  return { requests, onClose, onMissing, onChanged };
}

describe('AssetDetailDrawer 的两种形态', () => {
  it('创作实体：渲染可编辑表单', async () => {
    renderDrawer(CHARACTER);
    expect(await screen.findByLabelText('名称')).toHaveValue('苏晚');
    expect(screen.getByLabelText('引用名')).toHaveValue('苏晚');
    expect(screen.getByRole('group', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByLabelText('发型发色')).toHaveValue('黑色长直发');
  });

  it('生成产物：metadata 只读展示，没有可填字段与引用名', async () => {
    renderDrawer(IMAGE);
    expect(await screen.findByDisplayValue('主视觉')).toBeInTheDocument();

    // 只读展示：键名有中文标签，值原样呈现
    expect(screen.getByText('画幅比例')).toBeInTheDocument();
    expect(screen.getByText('2:3')).toBeInTheDocument();
    expect(screen.getByText('生成信息')).toBeInTheDocument();
    expect(screen.getByText('护肤品主视觉')).toBeInTheDocument();

    // 不可手填
    expect(screen.queryByRole('group', { name: '外观' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('引用名')).not.toBeInTheDocument();
    // 文件按可点链接列出
    expect(screen.getByRole('link', { name: 'assets/a2.png' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:3030/files/a2.png',
    );
  });

  it('深链指向别的项目的资产 → 交给调用方处理，不渲染内容', async () => {
    const { onMissing } = renderDrawer({ ...CHARACTER, projectId: 'p-other' });
    await waitFor(() => {
      expect(onMissing).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText('名称')).not.toBeInTheDocument();
  });
});

describe('AssetDetailDrawer 的保存', () => {
  it('改一个 metadata 字段 → 只发那个字段，Agent 写入的 generation 不在请求里', async () => {
    const { requests } = renderDrawer(CHARACTER);
    const hair = await screen.findByLabelText('发型发色');
    await userEvent.clear(hair);
    await userEvent.type(hair, '红色短发');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
    });
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.url).toBe('/api/assets/a1');
    expect(patch?.body).toEqual({ metadata: { appearance: { hair: '红色短发' } } });
    // 整份 metadata 一旦被提交，generation 就会被抹掉
    expect(JSON.stringify(patch?.body)).not.toContain('generation');
  });

  it('只改通用字段 → body 里只有那个字段，metadata 完全不出现', async () => {
    const { requests } = renderDrawer(CHARACTER);
    const description = await screen.findByLabelText('说明');
    await userEvent.clear(description);
    await userEvent.type(description, '改成女二号');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
    });
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      description: '改成女二号',
    });
  });

  it('什么都没改就点保存 → 不发请求（避免平白多一个版本号）', async () => {
    const { requests } = renderDrawer(CHARACTER);
    await screen.findByLabelText('名称');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('没有需要保存的改动。')).toBeInTheDocument();
    });
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('名称为空 → 不发请求，错误落在名称输入框上', async () => {
    const { requests } = renderDrawer(CHARACTER);
    const name = await screen.findByLabelText('名称');
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('资产名称不能为空')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });
});

describe('AssetDetailDrawer 的归档', () => {
  it('先二次确认，确认后才真的 DELETE', async () => {
    const { requests, onChanged, onClose } = renderDrawer(CHARACTER);
    await screen.findByLabelText('名称');

    await userEvent.click(screen.getByRole('button', { name: '归档' }));
    // 只是打开了确认框：还没有发任何请求
    expect(screen.getByRole('button', { name: '确认归档' })).toBeInTheDocument();
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(
      requests.some((request) => request.method === 'DELETE' && request.url === '/api/assets/a1'),
    ).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('被引用时把后端的拒绝理由原样显示，且不关闭抽屉', async () => {
    const { onClose, onChanged } = renderDrawer(CHARACTER, {
      deleteResponse: () =>
        json(
          {
            error: {
              code: 'ASSET_IN_USE',
              message: '该资产正在被 3 处内容引用，无法直接删除。',
              suggestions: ['先解除这些引用再删除', '改为归档以保留历史'],
              retryable: false,
            },
          },
          409,
        ),
    });
    await screen.findByLabelText('名称');

    await userEvent.click(screen.getByRole('button', { name: '归档' }));
    await userEvent.click(screen.getByRole('button', { name: '确认归档' }));

    expect(
      await screen.findByText('该资产正在被 3 处内容引用，无法直接删除。'),
    ).toBeInTheDocument();
    expect(screen.getByText('先解除这些引用再删除')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/asset-detail-drawer.test.tsx
```

Expected: FAIL —— 找不到 `AssetDetailDrawer.js`。

- [ ] **Step 3: 创建 `AssetDetailDrawer.module.css`**

```css
/* 资产详情抽屉的内部布局。输入框外观来自 Field.module.css */

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
}

.typeTag {
  padding: var(--space-1) var(--space-2);
  background: var(--color-primary-subtle);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-weight: var(--font-weight-medium);
}

.slug {
  font-family: var(--font-family-mono);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sectionTitle {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.general {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.hint {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.banner {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-error-subtle);
  border: 1px solid var(--color-error);
  border-radius: var(--radius-md);
  font-size: var(--font-size-secondary);
}

.bannerIcon {
  flex-shrink: 0;
  color: var(--color-error);
}

.bannerText {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.bannerList {
  margin: 0;
  padding-left: var(--space-4);
  color: var(--color-text-secondary);
}

/* 只读元数据：dl 的分组用 div 包 dt/dd，是 HTML 规范允许的形态 */
.metaList {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}

.metaRow {
  display: grid;
  grid-template-columns: minmax(88px, 24%) 1fr;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.metaLabel {
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
}

.metaValue {
  margin: 0;
  font-size: var(--font-size-secondary);
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.metaNested {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
}

.fileList {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.fileItem {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-secondary);
}

.fileLink {
  color: var(--color-primary);
  overflow-wrap: anywhere;
}

.fileMeta {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-caption);
  flex-shrink: 0;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 窄屏时两个按钮换行而不是被压扁溢出 */
  flex-wrap: wrap;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

@media (max-width: 480px) {
  .metaRow {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
}
```

- [ ] **Step 4: 创建 `AssetDetailDrawer.tsx`**

```tsx
/**
 * 资产详情抽屉。
 *
 * ── 两种形态 ──
 * 创作实体（角色/场景/道具/服装/品牌/产品/数字人）：metadata 可编辑 → 表单
 * 生成产物（图片/视频/音频/音色/音乐/标识/字体）：metadata 是**生成结果**，
 *   只读展示；只允许改 name / description / tags，避免手填出与文件不符的数据
 *
 * ── 只提交 dirty 字段 ──
 * 这是本阶段最要紧的一条：Agent 会往 metadata 里写表单没有的东西
 * （`generation` / `reference_images` / `cues`）。提交整份 = 把它们悄悄抹掉。
 * 因此 metadata 用 `diffMetadata` 产出补丁，通用字段也逐个与初始值比对；
 * 一个字段都没改时**不发请求**（避免平白的版本号增长把真实改动淹掉）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Drawer } from '../../components/Drawer.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPatch } from '../../lib/api.js';
import type { AssetDetail, AssetUpdateResult } from '../../lib/api-types.js';
import { parseFieldErrors } from './assetErrors.js';
import { ASSET_STATUS_LABELS, ASSET_TYPE_LABELS } from './assetLabels.js';
import { MetadataForm, TagsField } from './metadata/MetadataForm.js';
import {
  GENERAL_FIELD_KEYS,
  METADATA_SPECS,
  diffMetadata,
  fieldPaths,
  isCreativeAssetType,
} from './metadata/specs.js';
import styles from './AssetDetailDrawer.module.css';

export interface AssetDetailDrawerProps {
  /** 要打开的资产 id；`null` 表示关闭 */
  assetId: string | null;
  projectId: string;
  onClose: () => void;
  /** 资产不存在，或不属于本项目。调用方负责清掉深链参数并提示一次 */
  onMissing: () => void;
  /** 保存 / 归档成功后调用，用于刷新列表 */
  onChanged: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; asset: AssetDetail }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

interface Draft {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  coverUrl: string;
  metadata: Record<string, unknown>;
}

interface FormError {
  message: string;
  /** 没能落到具体输入框的原文（含后端给的通用建议） */
  suggestions: string[];
}

function toDraft(asset: AssetDetail): Draft {
  return {
    name: asset.name,
    slug: asset.slug,
    description: asset.description,
    tags: asset.tags,
    coverUrl: asset.coverUrl ?? '',
    metadata: asset.metadata,
  };
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 媒体 metadata 常见键的中文名。表里没有的键**按原样显示** —— 宁可显示得笨，也不能不显示 */
const MEDIA_LABELS: Record<string, string> = {
  width: '宽度',
  height: '高度',
  duration: '时长（秒）',
  format: '格式',
  fps: '帧率',
  sampleRate: '采样率',
  channels: '声道数',
  language: '语言',
  transcript: '文本内容',
  aspectRatio: '画幅比例',
  shotCount: '镜头数',
  cues: '字幕条目',
  generation: '生成信息',
};

/** `generation` 子键的中文名 */
const GENERATION_LABELS: Record<string, string> = {
  modelId: '模型',
  prompt: '提示词',
  negativePrompt: '负向提示词',
  seed: '随机种子',
  steps: '步数',
  guidance: '引导强度',
  skillId: '技能',
  taskId: '任务',
  editedFrom: '编辑自',
  extendedFrom: '延长自',
  extraSeconds: '延长时长（秒）',
  voiceAssetId: '音色资产',
};

function MetaValue({
  value,
  labels,
}: {
  value: unknown;
  labels: Record<string, string>;
}): ReactNode {
  if (Array.isArray(value)) {
    /*
     * 数组只报个数：`cues` 可能有几千条字幕，逐条铺开会把抽屉淹掉。
     * 「共 N 项」已经能回答「这份字幕是不是空的」这个问题。
     */
    return <span>共 {value.length} 项</span>;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span>（空）</span>;
    return (
      <dl className={styles.metaNested}>
        {entries.map(([key, item]) => (
          <MetaRow key={key} label={labels[key] ?? key} value={item} labels={GENERATION_LABELS} />
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function MetaRow({
  label,
  value,
  labels,
}: {
  label: string;
  value: unknown;
  labels: Record<string, string>;
}): ReactNode {
  // 空值不占一行：metadata 里大量可选字段，逐个显示「（未设置）」只会淹没有效信息
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>
        <MetaValue value={value} labels={labels} />
      </dd>
    </div>
  );
}

export function AssetDetailDrawer({
  assetId,
  projectId,
  onClose,
  onMissing,
  onChanged,
}: AssetDetailDrawerProps) {
  const { show: toast } = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<FormError | null>(null);

  /*
   * 回调用 ref 拿，**不进依赖数组**：调用方少写一个 useCallback 的话，
   * `load` 每次渲染都会变，effect 就会变成「每次渲染都重新拉一次详情」的死循环。
   */
  const missingRef = useRef(onMissing);
  useEffect(() => {
    missingRef.current = onMissing;
  }, [onMissing]);

  const load = useCallback(
    async (id: string) => {
      setState({ kind: 'loading' });
      setFormError(null);
      setFieldErrors({});
      setArchiveError(null);
      try {
        const asset = await apiFetch<AssetDetail>(`/api/assets/${id}`);
        /*
         * 深链可以指向任何 id。不属于本项目的资产**不能**在这里打开：
         * 页面是项目作用域的，打开别家的资产会让人以为它属于当前项目。
         * 静默退开更糟 —— 用户会以为链接坏了却看不出为什么。
         */
        if (asset.projectId !== projectId) {
          missingRef.current();
          return;
        }
        setState({ kind: 'ready', asset });
        setDraft(toDraft(asset));
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        // 404 与「资产不存在」是一回事，交给调用方统一处理（清参数 + 提示一次）
        if (apiError?.status === 404) {
          missingRef.current();
          return;
        }
        setState({
          kind: 'error',
          message: apiError?.message ?? '加载资产详情失败。',
          suggestions: apiError?.suggestions ?? [],
          retryable: apiError?.retryable ?? false,
        });
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (assetId === null) {
      setState({ kind: 'loading' });
      setDraft(null);
      setArchiveOpen(false);
      return;
    }
    void load(assetId);
  }, [assetId, load]);

  const creative = state.kind === 'ready' && isCreativeAssetType(state.asset.type);

  /** 后端可能对通用字段报错，它们的路径不在 METADATA_SPECS 里 */
  const knownPaths = useMemo(() => {
    const keys: readonly string[] = creative
      ? GENERAL_FIELD_KEYS
      : ['name', 'description', 'tags'];
    return new Set<string>([
      ...keys,
      ...(state.kind === 'ready' ? fieldPaths(METADATA_SPECS[state.asset.type]) : []),
    ]);
  }, [creative, state]);

  async function save(): Promise<void> {
    if (state.kind !== 'ready' || draft === null || submitting) return;
    const asset = state.asset;
    const isCreative = isCreativeAssetType(asset.type);

    const trimmedName = draft.name.trim();
    if (trimmedName === '') {
      setFieldErrors({ name: '资产名称不能为空' });
      setFormError(null);
      return;
    }

    const body: Record<string, unknown> = {};
    if (trimmedName !== asset.name) body.name = trimmedName;
    // slug 与封面只对创作实体开放：生成产物的这两个字段不该被人手改
    if (isCreative && draft.slug !== asset.slug) body.slug = draft.slug.trim();
    if (draft.description !== asset.description) body.description = draft.description;
    if (!sameStringList(draft.tags, asset.tags)) body.tags = draft.tags;
    if (isCreative) {
      const currentCover = asset.coverUrl ?? '';
      if (draft.coverUrl.trim() !== currentCover) {
        // 服务端的 coverUrl 是 `.nullable().optional()`：清空要发 null
        body.coverUrl = draft.coverUrl.trim() === '' ? null : draft.coverUrl.trim();
      }
      const patch = diffMetadata(METADATA_SPECS[asset.type], asset.metadata, draft.metadata);
      if (Object.keys(patch).length > 0) body.metadata = patch;
    }

    if (Object.keys(body).length === 0) {
      toast('没有需要保存的改动。', 'info');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      await apiPatch<AssetUpdateResult>(`/api/assets/${asset.id}`, body);
      toast(`已保存「${asset.name}」`, 'success');
      onChanged();
      onClose();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      const parsed = parseFieldErrors(apiError?.suggestions ?? [], knownPaths);
      setFieldErrors(parsed.fieldErrors);
      setFormError({
        message: apiError?.message ?? '保存失败。',
        suggestions: parsed.unmatched,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function archive(): Promise<void> {
    if (state.kind !== 'ready' || archiving) return;
    const asset = state.asset;
    setArchiving(true);
    setArchiveError(null);
    try {
      await apiFetch<void>(`/api/assets/${asset.id}`, { method: 'DELETE' });
      setArchiveOpen(false);
      toast(`已归档「${asset.name}」`, 'success');
      onChanged();
      onClose();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      /*
       * 被引用时后端返回 409，并已经说清「被几处内容引用」+ 两条建议。
       * 这段理由必须**原样**显示：换成「删除失败」就把唯一的线索丢了。
       */
      setArchiveError({
        message: apiError?.message ?? '归档失败。',
        suggestions: apiError?.suggestions ?? [],
      });
    } finally {
      setArchiving(false);
    }
  }

  const asset = state.kind === 'ready' ? state.asset : null;

  return (
    <>
      <Drawer
        open={assetId !== null}
        title={asset?.name ?? '资产详情'}
        onClose={onClose}
        width="lg"
      >
        {state.kind === 'loading' ? <SkeletonLines lines={6} /> : null}

        {state.kind === 'error' ? (
          <ErrorState
            title="加载资产详情失败"
            reason={state.message}
            {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
            {...(state.retryable && assetId !== null
              ? {
                  onRetry: () => {
                    void load(assetId);
                  },
                }
              : {})}
          />
        ) : null}

        {asset !== null && draft !== null ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className={styles.summary}>
              <span className={styles.typeTag}>{ASSET_TYPE_LABELS[asset.type]}</span>
              <span>{ASSET_STATUS_LABELS[asset.status]}</span>
              {/* slug 要显式展示：@slug 才是用户实际会打的东西 */}
              <span className={styles.slug}>@{asset.slug}</span>
            </p>

            {formError !== null ? (
              <div className={styles.banner} role="alert">
                <Icon name="alert" className={styles.bannerIcon} />
                <div className={styles.bannerText}>
                  <span>{formError.message}</span>
                  {formError.suggestions.length > 0 ? (
                    <ul className={styles.bannerList}>
                      {formError.suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : null}

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>基本信息</h3>
              <div className={styles.general}>
                <Field
                  label="名称"
                  htmlFor="asset-detail-name"
                  {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
                >
                  <input
                    id="asset-detail-name"
                    type="text"
                    value={draft.name}
                    disabled={submitting}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value });
                    }}
                  />
                </Field>

                {creative ? (
                  <Field
                    label="引用名"
                    htmlFor="asset-detail-slug"
                    helper="在对话里用 @引用名 指定它"
                    {...(fieldErrors.slug !== undefined ? { error: fieldErrors.slug } : {})}
                  >
                    <input
                      id="asset-detail-slug"
                      type="text"
                      value={draft.slug}
                      disabled={submitting}
                      onChange={(event) => {
                        setDraft({ ...draft, slug: event.target.value });
                      }}
                    />
                  </Field>
                ) : null}

                <Field
                  label="说明"
                  htmlFor="asset-detail-description"
                  {...(fieldErrors.description !== undefined
                    ? { error: fieldErrors.description }
                    : {})}
                >
                  <textarea
                    id="asset-detail-description"
                    rows={2}
                    value={draft.description}
                    disabled={submitting}
                    onChange={(event) => {
                      setDraft({ ...draft, description: event.target.value });
                    }}
                  />
                </Field>

                <TagsField
                  label="标签"
                  htmlFor="asset-detail-tags"
                  id="asset-detail-tags"
                  value={draft.tags}
                  disabled={submitting}
                  helper="回车添加一项"
                  {...(fieldErrors.tags !== undefined ? { error: fieldErrors.tags } : {})}
                  onChange={(next) => {
                    setDraft({ ...draft, tags: next });
                  }}
                />

                {creative ? (
                  <Field
                    label="封面图地址"
                    htmlFor="asset-detail-cover"
                    helper="图片直链。留空则列表里用类型标签占位"
                    {...(fieldErrors.coverUrl !== undefined ? { error: fieldErrors.coverUrl } : {})}
                  >
                    <input
                      id="asset-detail-cover"
                      type="text"
                      value={draft.coverUrl}
                      disabled={submitting}
                      onChange={(event) => {
                        setDraft({ ...draft, coverUrl: event.target.value });
                      }}
                    />
                  </Field>
                ) : null}
              </div>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>元数据</h3>
              {creative ? (
                <MetadataForm
                  specs={METADATA_SPECS[asset.type]}
                  value={draft.metadata}
                  onChange={(next) => {
                    setDraft({ ...draft, metadata: next });
                  }}
                  errors={fieldErrors}
                  disabled={submitting}
                  idPrefix="asset-detail"
                />
              ) : (
                <>
                  <p className={styles.hint}>
                    这些数据由生成链路写入，不提供手填 —— 手填的值会与实际文件不符。
                  </p>
                  {Object.keys(asset.metadata).length === 0 ? (
                    <p className={styles.hint}>这份资产还没有元数据。</p>
                  ) : (
                    <dl className={styles.metaList}>
                      {Object.entries(asset.metadata).map(([key, value]) => (
                        <MetaRow
                          key={key}
                          label={MEDIA_LABELS[key] ?? key}
                          value={value}
                          labels={GENERATION_LABELS}
                        />
                      ))}
                    </dl>
                  )}
                </>
              )}
            </section>

            {asset.files.length > 0 ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>文件（{asset.files.length}）</h3>
                <ul className={styles.fileList}>
                  {asset.files.map((file) => (
                    <li className={styles.fileItem} key={`${file.driver}:${file.key}`}>
                      {file.url !== undefined ? (
                        <a className={styles.fileLink} href={file.url} target="_blank" rel="noreferrer">
                          {file.key}
                        </a>
                      ) : (
                        <span>{file.key}</span>
                      )}
                      <span className={styles.fileMeta}>
                        {file.mimeType ?? file.driver}
                        {file.size !== undefined ? ` · ${formatSize(file.size)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className={styles.actions}>
              <Button
                variant="danger"
                disabled={submitting}
                onClick={() => {
                  setArchiveError(null);
                  setArchiveOpen(true);
                }}
              >
                归档
              </Button>
              <Button variant="primary" type="submit" loading={submitting}>
                保存
              </Button>
            </div>
          </form>
        ) : null}
      </Drawer>

      <Dialog
        open={archiveOpen}
        title={`归档「${asset?.name ?? ''}」`}
        onClose={() => {
          setArchiveOpen(false);
        }}
        footer={
          <div className={styles.actions}>
            <Button
              onClick={() => {
                setArchiveOpen(false);
              }}
              disabled={archiving}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={archiving}
              onClick={() => {
                void archive();
              }}
            >
              确认归档
            </Button>
          </div>
        }
      >
        <p>
          归档是软删除：资产会被标记为「已归档」，从默认列表里消失，历史记录保留。
        </p>
        <p>
          归档后，引用它的内容将不再显示该资产。若它正在被内容引用，服务端会拒绝这次归档
          并说明被哪些内容引用。
        </p>
        {archiveError !== null ? (
          <div className={styles.banner} role="alert">
            <Icon name="alert" className={styles.bannerIcon} />
            <div className={styles.bannerText}>
              <span>{archiveError.message}</span>
              {archiveError.suggestions.length > 0 ? (
                <ul className={styles.bannerList}>
                  {archiveError.suggestions.map((suggestion) => (
                    <li key={suggestion}>{suggestion}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/asset-detail-drawer.test.tsx
```

Expected: PASS（9 个用例）。

- [ ] **Step 6: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
```

Expected: 0 error。若报 `AssetUpdateResult` 已 import 未使用 —— 它用在
`apiPatch<AssetUpdateResult>` 的泛型里，是真的用到了，检查是不是写成了
`apiPatch(...)` 而漏掉泛型。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/assets/AssetDetailDrawer.tsx \
        apps/web/src/features/assets/AssetDetailDrawer.module.css \
        apps/web/test/asset-detail-drawer.test.tsx
git commit -m "feat(assets): 资产详情抽屉（媒体只读 / 创作实体可编辑）"
```

---

## Task 6: `AssetLibraryPage` —— 列表、工具栏、抽屉宿主、深链

**Files:**
- Create: `apps/web/src/features/assets/AssetLibraryPage.tsx`
- Create: `apps/web/src/features/assets/AssetLibraryPage.module.css`
- Modify: `apps/web/src/App.tsx`（注册路由）
- Modify: `apps/web/src/features/agent/AgentWorkspace.tsx`（头部「资产」入口）
- Modify: `apps/web/src/features/agent/AgentWorkspace.module.css`（头部入口样式）
- Test: `apps/web/test/asset-library.test.tsx`

**Interfaces:**
- Consumes: `AssetSummary`（Task 1）、`ASSET_TYPE_LABELS` / `ASSET_TYPE_OPTIONS`（Task 1）、`AssetCreateDialog`（Task 4）、`AssetDetailDrawer`（Task 5）、`EmptyState` / `ErrorState` / `SkeletonLines` / `Button` / `useToast`（既有）
- Produces: `export function AssetLibraryPage(): JSX.Element`（无 props，`projectId` 取自路由参数）

### 设计要点

**列表端点用 `/api/assets`，不用 `/api/projects/:id/assets`。**
见「控制方已做的技术裁定」第 1 条：前者默认排除 `archived`，后者的 `q` 也不搜 `description`。
但 `ProjectListPage` 的既有惯例是「项目作用域」—— 这里不冲突，因为 `projectId` 是我们自己传的查询参数。

**两种「空」必须分开。** 混成一个会让人以为项目里真的没有资产，
而实际上只是筛选条件没清。

**深链的进与出不对称，这是有意的。**
点开资产 = `push`（`?asset=<id>`），于是浏览器后退键能关掉抽屉；
关闭抽屉 = `replace` 清掉参数，于是后退键不会又把它打开。
参数指向不存在或不属于本项目的资产时，退回列表并用 toast 提示**一次**
（不常驻）—— 不静默忽略：那会让人以为链接坏了却说不出为什么。

**抽屉的回调必须 `useCallback`。** `AssetDetailDrawer` 的 `load` 依赖
`projectId`，`onMissing` 走 ref；但 `handleMissing` 自己会被 `useCallback` 包住，
避免每次渲染都产生新函数引起下游 effect 反复触发。

- [ ] **Step 1: 写测试（先写、先看它失败）**

创建 `apps/web/test/asset-library.test.tsx`：

```tsx
/**
 * 资产库页面测试。
 *
 * 守四件事：
 *   1. 三态齐全（加载 / 空 / 错误）—— 规范禁止空白页面，也禁止只写「出错了」；
 *   2. **两种空态不混用**：项目里没有资产 ≠ 筛选后没有结果；
 *   3. 搜索是 debounce 的、筛选是即时的、翻页靠「加载更多」追加；
 *   4. 深链 `?asset=` 能直接打开抽屉，失效时提示一次并把参数清掉。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AssetLibraryPage } from '../src/features/assets/AssetLibraryPage.js';
import type { AssetDetail, AssetSummary } from '../src/lib/api-types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pageOf(items: AssetSummary[], hasMore = false, total = items.length): unknown {
  return { items, total, page: 1, pageSize: 50, hasMore };
}

const SU_WAN: AssetSummary = {
  id: 'a1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  coverUrl: null,
};

const CHANG_AN: AssetSummary = {
  id: 'a2',
  type: 'scene',
  name: '长安城朱雀大街',
  slug: '长安城朱雀大街',
  coverUrl: 'https://example.com/changan.jpg',
};

const SU_WAN_DETAIL: AssetDetail = {
  ...SU_WAN,
  projectId: 'p1',
  description: '女主',
  metadata: { appearance: { hair: '黑色长直发' } },
  tags: [],
  status: 'active',
  files: [],
  updatedAt: '2026-09-13T10:00:00.000Z',
};

interface RecordedRequest {
  url: string;
  method: string;
}

/**
 * 装一个按 URL 分派的假后端（本文件专用，与工作台接线测试里的同名函数互不相干）。
 *
 * `assets` 是 `/api/assets` 的响应构造器，由各用例决定返回什么；
 * 单个资产的详情固定返回 `SU_WAN_DETAIL`。
 */
function setup(assets: (url: string) => Response) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, method: init?.method ?? 'GET' });

      if (url.includes('/api/assets?')) return Promise.resolve(assets(url));
      if (url.startsWith('/api/projects/')) {
        return Promise.resolve(json({ id: 'p1', name: '短剧项目', description: '' }));
      }
      if (url.match(/^\/api\/assets\/[^/?]+$/)) return Promise.resolve(json(SU_WAN_DETAIL));
      return Promise.resolve(json({}, 404));
    }),
  );
  return { requests };
}

/**
 * 把当前查询串渲染出来。
 *
 * `MemoryRouter` 不动 `window.location`，所以「参数有没有被清掉」这件事
 * 只能从路由状态里读。放在测试里而不是页面里 —— 页面不需要这个探针。
 */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

function renderPage(initialEntries: string[] = ['/projects/p1/assets']) {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <LocationProbe />
        <Routes>
          <Route path="/projects/:projectId/assets" element={<AssetLibraryPage />} />
          <Route path="/projects/:projectId" element={<p>工作台</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('AssetLibraryPage 的三态', () => {
  it('加载中显示骨架，加载完显示列表项（名称 + 类型 + @引用名）', async () => {
    setup(() => json(pageOf([SU_WAN, CHANG_AN])));
    renderPage();

    expect(screen.getByRole('status')).toHaveTextContent('正在加载');
    const item = await screen.findByRole('button', { name: /苏晚/ });
    // 类型标签是权威指示；左边 48×48 的方块只是首字占位，不重复整词
    expect(within(item).getByText('角色')).toBeInTheDocument();
    expect(within(item).getByText('角')).toBeInTheDocument();
    expect(within(item).getByText('@苏晚')).toBeInTheDocument();
    // 项目名进副标题，用户得知道自己在哪个项目里
    expect(await screen.findByText(/短剧项目/)).toBeInTheDocument();
  });

  it('项目里没有资产 → 主操作是「新建资产」', async () => {
    setup(() => json(pageOf([])));
    renderPage();

    expect(await screen.findByText('这个项目还没有资产')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建资产' })).toBeInTheDocument();
  });

  it('筛选后没有结果 → 是另一套空态，带「清除筛选」', async () => {
    setup((url) => (url.includes('type=') ? json(pageOf([])) : json(pageOf([SU_WAN]))));
    renderPage();

    await screen.findByRole('button', { name: /苏晚/ });
    await userEvent.click(screen.getByRole('button', { name: '图片' }));

    expect(await screen.findByText('没有匹配的资产')).toBeInTheDocument();
    // 关键：不能说成「这个项目还没有资产」——那会让人以为数据没了
    expect(screen.queryByText('这个项目还没有资产')).not.toBeInTheDocument();
    expect(screen.getByText(/类型：图片/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });

  it('加载失败 → 显示发生了什么 / 原因 / 下一步，并能重试', async () => {
    let attempt = 0;
    setup(() => {
      attempt += 1;
      if (attempt === 1) {
        return json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: '数据库连接失败。',
              suggestions: ['稍后重试'],
              retryable: true,
            },
          },
          500,
        );
      }
      return json(pageOf([SU_WAN]));
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库连接失败。');
    expect(screen.getByText('稍后重试')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});

describe('AssetLibraryPage 的工具栏', () => {
  it('搜索是 debounce 的：连续输入只发最后那一次', async () => {
    const { requests } = setup(() => json(pageOf([SU_WAN])));
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    /*
     * `delay: null` 是必需的，不是风格问题：这条用例断言「两次按键之间没有
     * 跨过 300ms 的防抖窗口」，而 userEvent 默认每次按键之间 await 一个
     * `setTimeout(0)`。机器有负载时那一下可能被拖长，用例就会变成偶发变红 ——
     * 而它一旦偶发变红，就再也证明不了「逐字打请求」这件事。
     */
    const typing = userEvent.setup({ delay: null });
    await typing.type(screen.getByLabelText('搜索资产'), '苏晚');
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes('q=%E8%8B%8F%E6%99%9A'))).toBe(true);
    });
    // 逐字触发的话这里会有两条（q=苏、q=苏晚）
    expect(requests.filter((request) => request.url.includes('q='))).toHaveLength(1);
  });

  it('类型筛选是即时的（不等 debounce）', async () => {
    const { requests } = setup(() => json(pageOf([SU_WAN])));
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    await userEvent.click(screen.getByRole('button', { name: '角色' }));
    await waitFor(() => {
      expect(requests.some((request) => request.url.includes('type=character'))).toBe(true);
    });
  });

  it('「加载更多」把下一页追加到列表后面，而不是替换', async () => {
    setup((url) =>
      url.includes('page=2') ? json(pageOf([CHANG_AN], false, 3)) : json(pageOf([SU_WAN], true, 3)),
    );
    renderPage();
    await screen.findByRole('button', { name: /苏晚/ });

    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('button', { name: /长安城朱雀大街/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});

describe('AssetLibraryPage 的深链', () => {
  it('直接带 ?asset= 进来就打开详情抽屉', async () => {
    setup(() => json(pageOf([SU_WAN])));
    renderPage(['/projects/p1/assets?asset=a1']);

    expect(await screen.findByRole('dialog', { name: '苏晚' })).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?asset=a1');
  });

  it('点列表项打开抽屉（push，后退键可关），关闭后查询参数被清掉（replace，后退键不会又弹开）', async () => {
    setup(() => json(pageOf([SU_WAN])));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /苏晚/ }));
    expect(await screen.findByRole('dialog', { name: '苏晚' })).toBeInTheDocument();
    expect(screen.getByTestId('search')).toHaveTextContent('?asset=a1');

    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '苏晚' })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('search')).not.toHaveTextContent('asset=');
  });

  it('深链指向不存在的资产 → 提示一次、清掉参数、退回列表，不静默无视', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/assets?')) return Promise.resolve(json(pageOf([SU_WAN])));
        if (url.startsWith('/api/projects/')) {
          return Promise.resolve(json({ id: 'p1', name: '短剧项目', description: '' }));
        }
        return Promise.resolve(
          json(
            {
              error: {
                code: 'ASSET_NOT_FOUND',
                message: '资产 nope 不存在',
                suggestions: [],
                retryable: false,
              },
            },
            404,
          ),
        );
      }),
    );
    renderPage(['/projects/p1/assets?asset=nope']);

    expect(await screen.findByText(/不存在，或者不属于当前项目/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('search')).not.toHaveTextContent('asset=');
    // 列表照常可用
    expect(await screen.findByRole('button', { name: /苏晚/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/asset-library.test.tsx
```

Expected: FAIL —— 找不到 `AssetLibraryPage.js`。

- [ ] **Step 3: 创建 `AssetLibraryPage.module.css`**

```css
/*
 * 资产库页面。套 AppShell（顶部主导航 + 内容区），不是工作台那种 100dvh 布局：
 * 这是「查阅与维护」型页面，用户会想直接回项目列表或去配置页。
 */

.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-6);
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.subtitle {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
}

.headerActions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.backLink {
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
  text-decoration: none;
}

.backLink:hover {
  color: var(--color-text-primary);
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.search {
  max-width: 360px;
}

/* 14 类 + 全部：横向可滚，窄屏不换行成一大片 */
.filters {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.filterChip {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  font-size: var(--font-size-secondary);
  cursor: pointer;
  white-space: nowrap;
}

.filterChip:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

.filterChipActive {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: var(--font-weight-medium);
}

.list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--color-border);
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-3) var(--space-2);
  background: none;
  border: none;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--color-surface-secondary);
}

.cover {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  overflow: hidden;
  background: var(--color-surface-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.coverImage {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/*
 * 无封面时的占位：类型中文名的**首字**（角 / 场 / 道 / 服 / 品 / 牌 / 数 / 图 / 视 / 音 / 标 / 字）。
 * 不用图标 —— 图标集里没有 14 类各自的图形，用同一个通用图标反而分不出类型。
 * 只取首字而不是整个词：右侧的类型标签已经写了全名，同一个词在一行里出现两次是噪音。
 */
.coverFallback {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-tertiary);
  text-align: center;
}

.itemBody {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.itemName {
  font-size: var(--font-size-body);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemMeta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.typeChip {
  padding: 0 var(--space-2);
  background: var(--color-surface-secondary);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
}

.slug {
  font-family: var(--font-family-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer {
  display: flex;
  justify-content: center;
}

@media (max-width: 720px) {
  .page {
    padding: var(--space-4);
  }

  .header {
    flex-direction: column;
    align-items: stretch;
  }
}
```

- [ ] **Step 4: 创建 `AssetLibraryPage.tsx`**

```tsx
/**
 * 项目资产库。
 *
 * ── 路由归属 ──
 * `/projects/:projectId/assets`，套 AppShell。资产库是「查阅与维护」型页面，
 * 用户在这里会想要直接回项目列表或去配置页，因此不用工作台那种 100dvh 布局。
 *
 * ── 列表端点为什么是 `/api/assets` 而不是 `/api/projects/:id/assets` ──
 * 实测：前者不传 `status` 时自动排除 `archived`（正是资产库要的默认行为），
 * 后者的**没有状态过滤**，归档资产会混进来；前者的 `q` 还多搜一个 `description`。
 *
 * ── 两种「空」必须分开 ──
 * 「项目里没有资产」与「筛选后没有结果」混成一个，会让人以为数据没了，
 * 而实际上只是筛选条件没清。两套文案、两个不同的主操作。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch } from '../../lib/api.js';
import type { AssetSummary, AssetType, PageBody, Project } from '../../lib/api-types.js';
import { AssetCreateDialog } from './AssetCreateDialog.js';
import { AssetDetailDrawer } from './AssetDetailDrawer.js';
import { ASSET_TYPE_LABELS, ASSET_TYPE_OPTIONS } from './assetLabels.js';
import styles from './AssetLibraryPage.module.css';

/** 每页条数。上限是 200（`paginationSchema`），50 是列表的取舍：够长又不至于一次拉太多 */
const PAGE_SIZE = 50;

/** 搜索防抖时长 */
const SEARCH_DEBOUNCE_MS = 300;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/**
 * 封面缩略图。图挂了就退回类型标签占位。
 *
 * 不复用 ResultCard 的 `media-health` 体检：那是为了回答「文件还在不在」，
 * 要发一次额外请求；列表里几十行逐个体检代价太大，而**破了就换占位**
 * 已经足够 —— 这一行仍然可点、可辨认。
 */
function CoverThumb({ asset }: { asset: AssetSummary }) {
  const [broken, setBroken] = useState(false);

  if (asset.coverUrl === null || broken) {
    // 首字字形块（角/场/道/服/品/牌/数…），不是图标：图标集里没有 14 类各自的图形，
    // 用同一个通用图标反而分不出类型。右侧的类型标签才是权威指示，这里只负责把
    // 48×48 的方块填成一个看上去是有意为之的东西
    return <span className={styles.coverFallback}>{ASSET_TYPE_LABELS[asset.type].slice(0, 1)}</span>;
  }
  return (
    <img
      className={styles.coverImage}
      src={asset.coverUrl}
      alt=""
      loading="lazy"
      onError={() => {
        setBroken(true);
      }}
    />
  );
}

export function AssetLibraryPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { show: toast } = useToast();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all');
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** 递增即要求重新拉第一页（保存 / 归档 / 新建之后） */
  const [reloadToken, setReloadToken] = useState(0);
  const [projectName, setProjectName] = useState<string | null>(null);

  const selectedId = searchParams.get('asset');
  const filtering = typeFilter !== 'all' || debouncedQuery.trim() !== '';
  /**
   * 页头要不要放「新建资产」主操作。
   *
   * 「项目里还没有资产」那套空态自带一个主操作，页头再放一个同名的 primary，
   * 一屏上就有两个一模一样的主按钮 —— 规范里「一个操作区域只有一个 Primary」
   * 说的正是这种情况。筛选后无结果时**要**保留页头这个：
   * 那时空态的主操作是「清除筛选」，新建入口不该跟着消失。
   */
  const showHeaderCreate = !(state.kind === 'ready' && items.length === 0 && !filtering);

  // 搜索防抖：逐字打请求会把后端打满，也会让列表在打字过程中反复闪
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const buildUrl = useCallback(
    (targetPage: number): string => {
      const params = new URLSearchParams({
        projectId,
        pageSize: String(PAGE_SIZE),
        page: String(targetPage),
        sortOrder: 'desc',
      });
      if (debouncedQuery.trim() !== '') params.set('q', debouncedQuery.trim());
      if (typeFilter !== 'all') params.set('type', typeFilter);
      return `/api/assets?${params.toString()}`;
    },
    [projectId, debouncedQuery, typeFilter],
  );

  // 第一页：筛选条件或 reloadToken 变化时整体重拉
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const body = await apiFetch<PageBody<AssetSummary>>(buildUrl(1));
        if (cancelled) return;
        setItems(body.items);
        setTotal(body.total);
        setPage(1);
        setHasMore(body.hasMore);
        setState({ kind: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const apiError = err instanceof ApiError ? err : null;
        setState({
          kind: 'error',
          message: apiError?.message ?? '加载资产列表失败。',
          suggestions: apiError?.suggestions ?? [],
          retryable: apiError?.retryable ?? false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildUrl, reloadToken]);

  /*
   * 项目名只是标题的副标题。刻意**不**因为拉不到它就让整页失败：
   * 资产列表能显示才是这条页面存在的意义，项目名拉不到时少显示一段就行。
   * 真正的故障（后端挂了）会由上面的列表请求报出来。
   */
  useEffect(() => {
    let cancelled = false;
    void apiFetch<Project>(`/api/projects/${projectId}`)
      .then((project) => {
        if (!cancelled) setProjectName(project.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const body = await apiFetch<PageBody<AssetSummary>>(buildUrl(next));
      setItems((prev) => [...prev, ...body.items]);
      setTotal(body.total);
      setPage(next);
      setHasMore(body.hasMore);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      toast(apiError?.message ?? '加载更多失败，请重试。', 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  /** 打开详情：**push**，这样浏览器后退键能关掉抽屉 */
  const openAsset = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('asset', id);
        return next;
      });
    },
    [setSearchParams],
  );

  /** 关闭详情：**replace** 清掉参数，否则后退键会又把它打开 */
  const closeAsset = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('asset');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  /*
   * 深链指向不存在、或不属于本项目的资产。
   * 提示**一次**（toast 不常驻），然后把参数清掉退回列表 ——
   * 静默忽略会让人以为链接坏了却说不出为什么。
   */
  const handleMissing = useCallback(() => {
    toast('这个资产不存在，或者不属于当前项目。', 'error');
    closeAsset();
  }, [closeAsset, toast]);

  const clearFilters = useCallback(() => {
    setQuery('');
    setTypeFilter('all');
  }, []);

  function renderBody(): ReactNode {
    if (state.kind === 'loading') return <SkeletonLines lines={5} />;
    if (state.kind === 'error') {
      return (
        <ErrorState
          title="加载资产列表失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable
            ? {
                onRetry: () => {
                  setReloadToken((token) => token + 1);
                },
              }
            : {})}
        />
      );
    }
    if (items.length === 0) {
      // 两种「空」：项目里没有资产 / 筛选后没有结果
      return filtering ? (
        <EmptyState
          icon="folder"
          title="没有匹配的资产"
          description={`当前条件：${[
            typeFilter === 'all' ? null : `类型：${ASSET_TYPE_LABELS[typeFilter]}`,
            debouncedQuery.trim() === '' ? null : `关键词：「${debouncedQuery.trim()}」`,
          ]
            .filter((part) => part !== null)
            .join(' · ')}。清掉条件就能看到全部资产。`}
          action={
            <Button onClick={clearFilters}>清除筛选</Button>
          }
        />
      ) : (
        <EmptyState
          icon="folder"
          title="这个项目还没有资产"
          description="角色、场景、品牌、产品都可以先建在这里，之后在对话里用 @名字 直接引用。Agent 生成的内容也会自动入库。"
          action={
            <Button
              variant="primary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建资产
            </Button>
          }
        />
      );
    }
    return (
      <>
        <ul className={styles.list}>
          {items.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                className={styles.item}
                data-asset-id={asset.id}
                onClick={() => {
                  openAsset(asset.id);
                }}
              >
                <span className={styles.cover}>
                  <CoverThumb asset={asset} />
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemName}>{asset.name}</span>
                  <span className={styles.itemMeta}>
                    <span className={styles.typeChip}>{ASSET_TYPE_LABELS[asset.type]}</span>
                    {/* slug 要显式展示：@slug 才是用户实际会打的东西 */}
                    <span className={styles.slug}>@{asset.slug}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className={styles.footer}>
            <Button
              loading={loadingMore}
              onClick={() => {
                void loadMore();
              }}
            >
              加载更多
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>资产</h1>
          <p className={styles.subtitle}>
            {projectName ?? '当前项目'} · 共 {total} 项
          </p>
        </div>
        <div className={styles.headerActions}>
          <Link className={styles.backLink} to={`/projects/${projectId}`}>
            返回工作台
          </Link>
          {showHeaderCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              新建资产
            </Button>
          ) : null}
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Field label="搜索资产" htmlFor="asset-search">
            <input
              id="asset-search"
              type="search"
              value={query}
              placeholder="按名称、引用名或说明搜索"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className={styles.filters} role="group" aria-label="按类型筛选">
          <button
            type="button"
            className={`${styles.filterChip} ${typeFilter === 'all' ? styles.filterChipActive : ''}`}
            aria-pressed={typeFilter === 'all'}
            onClick={() => {
              setTypeFilter('all');
            }}
          >
            全部
          </button>
          {ASSET_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.filterChip} ${
                typeFilter === option.value ? styles.filterChipActive : ''
              }`}
              aria-pressed={typeFilter === option.value}
              onClick={() => {
                setTypeFilter(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {renderBody()}

      <AssetCreateDialog
        open={createOpen}
        projectId={projectId}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={() => {
          setCreateOpen(false);
          toast('资产已创建。', 'success');
          setReloadToken((token) => token + 1);
        }}
      />

      <AssetDetailDrawer
        assetId={selectedId}
        projectId={projectId}
        onClose={closeAsset}
        onMissing={handleMissing}
        onChanged={() => {
          setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}
```

**注意 `renderBody` 的返回类型是 `ReactNode`** —— 顶部 import 里已经带了
`type ReactNode`，不要写成 `React.ReactNode`（那需要额外的默认导入）。

- [ ] **Step 5: 注册路由并加工作台入口**

`apps/web/src/App.tsx`：

1. 顶部 import 追加：
```tsx
import { AssetLibraryPage } from './features/assets/AssetLibraryPage.js';
```
2. 在 `AppShell` 那一组里（`/settings/providers` 之后）追加一条：
```tsx
            <Route path="/projects/:projectId/assets" element={<AssetLibraryPage />} />
```
并把 `AppShell` 的注释从「两个页面」改成三个入口的事实（注释里那句
「工作台刻意不套外框」保持不变 —— 资产库**套**外框，这一点要在注释里写清楚）。

`apps/web/src/features/agent/AgentWorkspace.tsx`：把 `<header>` 改成

```tsx
        <header className={styles.header}>
          <h1 className={styles.title}>
            {loadState.kind === 'ready' ? loadState.session.title || '新会话' : '工作台'}
          </h1>
          <div className={styles.headerActions}>
            {/*
              资产库入口：**始终显示**。
              窄屏那个「任务」按钮是另一回事（侧区被 CSS 收起时的补救入口），
              而资产库在这个页面上没有别的可达路径 —— 藏起来就等于没有。
            */}
            <Link className={styles.headerAction} to={`/projects/${projectIdValue}/assets`}>
              资产
            </Link>
            {isNarrow ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setTaskDrawerOpen(true)}
                aria-expanded={taskDrawerOpen}
              >
                <Icon name="chevron-right" />
                任务
              </Button>
            ) : null}
          </div>
        </header>
```

`apps/web/src/features/agent/AgentWorkspace.module.css` 追加：

```css
.headerActions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  /* 标题过长时先挤标题，不把入口挤出视口 */
  flex-shrink: 0;
}

.headerAction {
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
  text-decoration: none;
  white-space: nowrap;
}

.headerAction:hover {
  color: var(--color-text-primary);
}
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/asset-library.test.tsx
```

Expected: PASS（10 个用例）。

- [ ] **Step 7: 跑一遍全部前端测试**

```bash
pnpm --filter @svh/web test
```

Expected: 全绿。`App.tsx` 加了路由、工作台头部多了一个链接，
`agent-workspace*.test.tsx` 里若有「头部只有 N 个元素」之类的断言会在这里暴露。

- [ ] **Step 8: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
```

Expected: 0 error。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/features/assets/AssetLibraryPage.tsx \
        apps/web/src/features/assets/AssetLibraryPage.module.css \
        apps/web/src/App.tsx \
        apps/web/src/features/agent/AgentWorkspace.tsx \
        apps/web/src/features/agent/AgentWorkspace.module.css \
        apps/web/test/asset-library.test.tsx
git commit -m "feat(assets): 项目资产库页面（列表 / 搜索 / 筛选 / 深链）"
```

---

## Task 7: `@资产` 成为一等交互

**Files:**
- Create: `apps/web/src/features/assets/MentionText.tsx`
- Create: `apps/web/src/features/assets/MentionText.module.css`
- Modify: `apps/web/src/features/agent/AgentWorkspace.tsx`（拉资产索引 + 透传 + 给 Composer 的刷新回调）
- Modify: `apps/web/src/features/agent/MessageList.tsx`（透传）
- Modify: `apps/web/src/features/agent/MessageItem.tsx`（正文改用 `MentionText`；把 `projectId` 透给结果卡）
- Modify: `apps/web/src/features/agent/renderers/ResultCard.tsx`（`assetId` → 深链）
- Modify: `apps/web/src/features/agent/renderers/card.module.css`（深链样式）
- Modify: `apps/web/src/features/agent/Composer.tsx`（`missing` 提示 + 「现在新建」）
- Modify: `apps/web/src/features/agent/Composer.module.css`（提示条样式）
- Test: `apps/web/test/mention-text.test.tsx`
- Test: `apps/web/test/agent-workspace-wiring.test.tsx`（追加一组用例 + 两处 mock 分支）

**Interfaces:**
- Consumes: `AssetSummary`（Task 1）、`AssetCreateDialog`（Task 4）、既有 `apiFetch` / `PageBody`
- Produces:
  ```ts
  interface MentionTextProps {
    text: string;
    /** slug → 资产 id */
    assetIndex: ReadonlyMap<string, string>;
    projectId: string;
  }
  export function MentionText(props: MentionTextProps): JSX.Element;
  ```
  - `MessageItemProps` / `MessageListProps` 各新增 `assetIndex?: ReadonlyMap<string, string>`、`projectId?: string`
  - `ResultCardProps` 新增 `projectId?: string`
  - `ComposerProps` 新增 `onAssetCreated?: () => void`

### 设计要点

**正则与后端逐字相同。** `apps/api/src/core/slug.ts:83` 是
`/@([\w\u4e00-\u9fa5-]+)/gu`。前端用同一条，保证「后端认得的引用」
与「前端可能链接化的引用」是同一批。代价是 `a@b.com` 里的 `@b` 也会被当成引用 ——
但**后端本来就这么解析**，只改前端会让「后端认得的引用」点不开。
这条口径由 `mention-text.test.tsx` 的一个用例明文写下来。

**匹配不上就保持纯文本。** 索引只含项目里真实存在、且在前 200 条窗口内的资产。
宁可不可点，也不要链错：一个把 `@张三` 链到李四的链接比没有链接糟得多。

**索引要新拉一次，不能复用 Composer 的补全列表。**
`Composer` 的资产清单是在用户敲 `@` 时才拉的（在 `loadSuggestions` 回调里），
而消息渲染发生在页面加载时，两者时机不同，复用拿不到数据。
工作台加载时拉一次 `GET /api/assets?projectId=…&pageSize=200` 建 `slug → id` 映射。

**索引拉不到是降级，不是失败。** 消息正文保持纯文本，对话流照常可用。
刻意不弹提示：为了一条链接能不能点而打断阅读，代价大于收益。

- [ ] **Step 1: 写 `MentionText` 的测试（先写、先看它失败）**

创建 `apps/web/test/mention-text.test.tsx`：

```tsx
/**
 * `@资产` 文本解析与渲染测试。
 *
 * 这里守的是一条**宁可不可点，也不要链错**的原则，以及「渲染不能吃掉文字」——
 * 后者的失败形态是：一段好好的回复，因为其中一个 @ 命中，中间的逗号句号没了。
 * 所以最有力的一条断言是 `container.textContent` 与原文**逐字相同**。
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { MentionText } from '../src/features/assets/MentionText.js';

const INDEX = new Map([
  ['苏晚', 'a1'],
  ['长安城', 'a2'],
]);

function renderText(text: string, index: ReadonlyMap<string, string> = INDEX) {
  return render(
    <MemoryRouter>
      <MentionText text={text} assetIndex={index} projectId="p1" />
    </MemoryRouter>,
  );
}

describe('MentionText', () => {
  it('命中的 @名字 变成指向资产详情的链接', () => {
    renderText('先定 @苏晚 的外观');
    expect(screen.getByRole('link', { name: '@苏晚' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('渲染后的可见文字与原文逐字相同（不多不少）', () => {
    const text = '让 @苏晚 在 @长安城 走，@张三 不来。';
    const { container } = renderText(text);
    expect(container.textContent).toBe(text);
  });

  it('未命中的引用保持纯文本，绝不链错', () => {
    renderText('参考 @张三 的风格');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/参考 @张三 的风格/)).toBeInTheDocument();
  });

  it('一段文字里的多个引用都成链', () => {
    renderText('@苏晚 在 @长安城');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('索引为空时整段原样返回（降级路径）', () => {
    const { container } = renderText('先定 @苏晚 的外观', new Map());
    expect(container.textContent).toBe('先定 @苏晚 的外观');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('与后端同一条正则：`a@b.com` 里的 @b 同样算引用', () => {
    /*
     * 这条断言是把「前后端口径一致」明文写下来。
     * `apps/api/src/core/slug.ts` 的 `parseAssetMentions` 用同一条正则，
     * 所以后端**本来就会**把 `@b` 当成引用去解析。若将来想让邮箱不误链，
     * 必须两边一起改 —— 只改前端会让「后端认得的引用」在界面上点不开。
     */
    renderText('联系 a@b.com', new Map([['b', 'a9']]));
    expect(screen.getByRole('link', { name: '@b' })).toBeInTheDocument();
  });

  it('正文里没有 @ 时不做任何包装', () => {
    const { container } = renderText('好的，我先把分镜列出来。');
    expect(container.textContent).toBe('好的，我先把分镜列出来。');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
pnpm --filter @svh/web exec vitest run test/mention-text.test.tsx
```

Expected: FAIL —— 找不到 `MentionText.js`。

- [ ] **Step 3: 创建 `MentionText.tsx` 与 `MentionText.module.css`**

```tsx
/**
 * 消息正文里的 `@资产`。
 *
 * ── 正则与后端**逐字相同** ──
 * `apps/api/src/core/slug.ts` 的 `parseAssetMentions` 用的是
 * `/@([\w\u4e00-\u9fa5-]+)/gu`。前端用同一条，保证「后端认得的引用」与
 * 「前端可能链接化的引用」是同一批。代价是 `a@b.com` 里的 `@b` 也会被当成
 * 引用 —— 但后端本来就这么解析，只改前端会让「后端认得的引用」点不开。
 *
 * ── 匹配不上就保持纯文本 ──
 * 索引只含项目里**真实存在**、且在前 200 条窗口内的资产。
 * 宁可不可点，也不要链错：一个把 `@张三` 链到李四的链接比没有链接糟得多。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import styles from './MentionText.module.css';

const MENTION_PATTERN = /@([\w\u4e00-\u9fa5-]+)/gu;

export interface MentionTextProps {
  text: string;
  /** slug → 资产 id */
  assetIndex: ReadonlyMap<string, string>;
  projectId: string;
}

export function MentionText({ text, assetIndex, projectId }: MentionTextProps) {
  // 空索引（还没拉到 / 拉失败）时不做任何解析：降级就是纯文本
  if (assetIndex.size === 0) return <>{text}</>;

  /*
   * 每次都新建正则：带 `g` 的正则带 `lastIndex` 状态，跨渲染复用会从上次的位置
   * 继续匹配，表现为「同一段文字第二次渲染就漏掉了前面的引用」。
   */
  const pattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    const slug = match[1];
    const assetId = slug === undefined ? undefined : assetIndex.get(slug);
    if (slug !== undefined && assetId !== undefined) {
      nodes.push(text.slice(cursor, match.index));
      nodes.push(
        <Link
          key={`${String(match.index)}-${slug}`}
          className={styles.mention}
          to={`/projects/${projectId}/assets?asset=${assetId}`}
        >
          {match[0]}
        </Link>,
      );
      cursor = match.index + match[0].length;
    }
    match = pattern.exec(text);
  }

  // 一个都没命中：整段原样返回，不产生多余的 DOM 层级
  if (nodes.length === 0) return <>{text}</>;

  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
```

```css
/* @资产 链接。用正文色 + 下划线，不用主题蓝：一句话里可能出现三四个引用，
   全部染成主色会把正文的阅读节奏打散 */
.mention {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: var(--color-border-strong);
}

.mention:hover {
  color: var(--color-primary);
  text-decoration-color: var(--color-primary);
}
```

- [ ] **Step 4: 运行，确认通过**

```bash
pnpm --filter @svh/web exec vitest run test/mention-text.test.tsx
```

Expected: PASS（7 个用例）。

- [ ] **Step 5: 把 `MentionText` 接进消息与结果卡**

`apps/web/src/features/agent/MessageItem.tsx`：

1. import 追加：
```tsx
import { MentionText } from '../assets/MentionText.js';
```
2. `MessageItemProps` 追加两个可选字段：
```tsx
  /** slug → 资产 id。空表示不做链接化（正文保持纯文本） */
  assetIndex?: ReadonlyMap<string, string>;
  /** 结果卡深链所需。缺省时不渲染「查看资产详情」 */
  projectId?: string;
```
3. `PayloadViewProps` 同样追加这两个字段，并在 `result_card` 分支透传：
```tsx
      return (
        <ResultCard
          payload={payload}
          onAction={onAction}
          {...(projectId !== undefined ? { projectId } : {})}
        />
      );
```
4. 组件签名解构加默认值：
```tsx
export function MessageItem({
  message,
  onReply = () => undefined,
  onConfirm = () => undefined,
  onAction = () => undefined,
  assetIndex = new Map<string, string>(),
  projectId,
}: MessageItemProps) {
```
5. 两处正文改用 `MentionText`：
```tsx
      {isUser ? (
        <div className={styles.userBubble}>
          <MentionText text={message.content} assetIndex={assetIndex} projectId={projectId ?? ''} />
        </div>
      ) : (
        <div className={styles.agentText}>
          {/* 有载荷时正文可能为空（例如纯计划消息），此时不渲染空段落 */}
          {message.content.length > 0 ? (
            <p>
              <MentionText
                text={message.content}
                assetIndex={assetIndex}
                projectId={projectId ?? ''}
              />
            </p>
          ) : null}
```
6. `<PayloadView ... assetIndex={assetIndex} projectId={projectId} />`。

`apps/web/src/features/agent/MessageList.tsx`：`MessageListProps` 追加同样两个字段，
解构后透传给 `<MessageItem>`。

`apps/web/src/features/agent/renderers/ResultCard.tsx`：

1. import 追加 `import { Link } from 'react-router-dom';`
2. props：
```tsx
export interface ResultCardProps {
  payload: ResultCardPayload;
  onAction: (action: CardAction) => void;
  /**
   * 深链所需。**刻意可选**：`renderers.test.tsx` 直接渲染这个组件、
   * 外面没有 Router，渲染 `<Link>` 会直接抛错；而且缺 projectId 时
   * 渲染一个 `/projects//assets?asset=x` 的坏链接比没有链接更糟。
   */
  projectId?: string;
}
```
3. 在媒体网格之后、动作之前插入：
```tsx
      {/*
        资产深链：`assetId` 以前只是数据 —— 用户看得见卡片，却点不开对应的资产。
      */}
      {payload.assetId !== undefined && projectId !== undefined && projectId !== '' ? (
        <p className={shared.assetLinkRow}>
          <Link
            className={shared.assetLink}
            to={`/projects/${projectId}/assets?asset=${payload.assetId}`}
          >
            查看资产详情
          </Link>
        </p>
      ) : null}
```

`apps/web/src/features/agent/renderers/card.module.css` 追加：

```css
.assetLinkRow {
  margin: 0;
}

.assetLink {
  font-size: var(--font-size-secondary);
  color: var(--color-primary);
}
```

- [ ] **Step 6: 在工作台里拉资产索引并透传**

`apps/web/src/features/agent/AgentWorkspace.tsx`：

1. 常量（放在其它常量旁）：
```tsx
/**
 * `@资产` 索引一次拉多少条。
 *
 * 与「回捞结果卡」的 50 条是同一类取舍：超出窗口的引用**保持纯文本**，而不是猜。
 * 200 是服务端 `pageSize` 的上限。
 */
const ASSET_INDEX_PAGE_SIZE = 200;
```
2. state 与 effect（放在会话加载 effect 之后）：
```tsx
  /** 项目资产的 slug → id 索引：把消息正文里的 @名字 链接化 */
  const [assetIndex, setAssetIndex] = useState<ReadonlyMap<string, string>>(new Map());
  /** 递增即重新拉索引（新建资产之后） */
  const [assetIndexToken, setAssetIndexToken] = useState(0);

  useEffect(() => {
    if (projectIdValue === '') return;
    let cancelled = false;
    void apiFetch<PageBody<AssetSummary>>(
      `/api/assets?projectId=${projectIdValue}&pageSize=${String(ASSET_INDEX_PAGE_SIZE)}`,
    )
      .then((body) => {
        if (cancelled) return;
        setAssetIndex(new Map(body.items.map((asset) => [asset.slug, asset.id])));
      })
      .catch(() => {
        /*
         * 拉不到索引是**降级**，不是失败：消息正文里的 @名字 保持纯文本，
         * 对话流照常可用。刻意不弹提示 —— 为了一条链接能不能点而打断阅读，
         * 代价大于收益；真正的故障（后端挂了）会由会话加载自己报出来。
         */
      });
    return () => {
      cancelled = true;
    };
  }, [projectIdValue, assetIndexToken]);
```
   注意 import 里要加 `useState`（大概率已有）、`apiFetch`（已有）、
   `type AssetSummary, type PageBody`（`api-types` 的 import 里补）。
3. `<MessageList>` 追加 `assetIndex={assetIndex} projectId={projectIdValue}`。
4. `<Composer>` 追加：
```tsx
              onAssetCreated={() => {
                // 新建之后项目里的资产清单变了：重建索引，让刚打的 @名字 立刻可点
                setAssetIndexToken((token) => token + 1);
              }}
```

- [ ] **Step 7: 在输入区上方加 `missing` 提示**

`apps/web/src/features/agent/Composer.tsx`：

1. import 追加：
```tsx
import { AssetCreateDialog } from '../assets/AssetCreateDialog.js';
```
2. props 追加：
```tsx
  /** 资产新建成功。工作台据此重建 `@资产` 索引 */
  onAssetCreated?: () => void;
```
3. state：
```tsx
  /**
   * 文本里出现、但项目里并不存在的引用名。
   *
   * **不阻止发送**：改成阻塞会把一个提示变成一种新的失败。
   * 用户照样把消息发出去，Agent 会在对话里回答「我没有找到 @X」。
   */
  const [missingMentions, setMissingMentions] = useState<string[]>([]);
  /** 非 null 时打开创建对话框，并把该名字预填进去 */
  const [createName, setCreateName] = useState<string | null>(null);
```
4. `handleChange` 里加一句（任何编辑都让上一次的解析结果失效）：
```tsx
    setMissingMentions([]);
```
5. `submit()` 开头、`setSending(true)` 之前加 `setMissingMentions([]);`；
   解析成功那一段改成：
```tsx
        const matched = Array.isArray(resolved.matched) ? resolved.matched : [];
        matchedIds = matched.map((asset) => asset.id);
        // missing 只是提示，不参与放行判定（见 state 上的注释）
        setMissingMentions(Array.isArray(resolved.missing) ? resolved.missing : []);
```
6. 渲染：在 `<div className={styles.row}>` **之前**插入提示条：
```tsx
      {missingMentions.length > 0 ? (
        <div className={styles.missing} role="status">
          <span>
            项目里还没有 {missingMentions.map((name) => `@${name}`).join('、')}
          </span>
          <Button
            size="sm"
            onClick={() => {
              // 一次建一个：多个缺失时先建第一个，建完提示里就少一个
              setCreateName(missingMentions[0] ?? '');
            }}
          >
            现在新建
          </Button>
        </div>
      ) : null}
```
7. 组件返回的最外层（`</div>` 之前）追加对话框：
```tsx
      <AssetCreateDialog
        open={createName !== null}
        projectId={projectId}
        initialName={createName ?? ''}
        onClose={() => {
          setCreateName(null);
        }}
        onCreated={(asset) => {
          setCreateName(null);
          // 建好了就从提示里去掉（按名字与 slug 双匹配：用户可能填了不同的引用名）
          setMissingMentions((prev) =>
            prev.filter((name) => name !== asset.name && name !== asset.slug),
          );
          onAssetCreated?.();
        }}
      />
```

`apps/web/src/features/agent/Composer.module.css` 追加：

```css
.missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--color-warning-subtle);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-md);
  font-size: var(--font-size-secondary);
  color: var(--color-text-primary);
}
```

- [ ] **Step 8: 给接线测试补 mock 分支**

`apps/web/test/agent-workspace-wiring.test.tsx`：

1. `setup` 的 `HarnessOptions` 接口追加两项：
```tsx
  /** `/api/assets?` 的响应（`@资产` 索引） */
  assetList?: () => { items: unknown[]; total: number; page: number; pageSize: number; hasMore: boolean };
  /** `/api/assets/resolve-mentions` 的响应 */
  resolveMentions?: () => { mentions: string[]; matched: unknown[]; missing: string[] };
```
2. `route` 里把 resolve-mentions 那条改成读 options：
```tsx
    if (url === '/api/assets/resolve-mentions') {
      return Promise.resolve(
        json(options.resolveMentions?.() ?? { mentions: [], matched: [], missing: [] }),
      );
    }
    if (url.startsWith('/api/assets?')) {
      return Promise.resolve(
        json(
          options.assetList?.() ?? { items: [], total: 0, page: 1, pageSize: 200, hasMore: false },
        ),
      );
    }
```
   顺序要放在 `url === '/api/assets/resolve-mentions'` **之后**
   （它不以 `?` 结尾，两条不会互相吃掉）。

- [ ] **Step 9: 追加接线用例**

在 `apps/web/test/agent-workspace-wiring.test.tsx` 末尾追加：

```tsx
/* ─────────────────────────── @资产 接线 ─────────────────────────── */

/** 一条正文里带引用的 Agent 消息 */
function textMessage(id: string, content: string) {
  return {
    id,
    role: 'agent',
    kind: 'text',
    content,
    payload: null,
    createdAt: '2026-09-12T10:05:00.000Z',
  };
}

/** 一张带 assetId 的结果卡 */
const ASSET_RESULT_CARD = {
  id: 'm-card',
  role: 'agent',
  kind: 'result_card',
  content: '',
  payload: {
    type: 'result_card',
    title: '角色已创建',
    category: 'character',
    media: [],
    assetId: 'a1',
    actions: [],
  },
  createdAt: '2026-09-12T10:06:00.000Z',
};

const SU_WAN_ASSET = {
  id: 'a1',
  type: 'character',
  name: '苏晚',
  slug: '苏晚',
  coverUrl: null,
};

describe('@资产 接线', () => {
  it('工作台加载时按项目拉一次资产索引（窗口 200）', async () => {
    const { fetchMock } = setup({
      assetList: () => ({ items: [SU_WAN_ASSET], total: 1, page: 1, pageSize: 200, hasMore: false }),
    });
    renderWorkspace();

    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/assets?').length).toBeGreaterThan(0);
    });
    expect(callsTo(fetchMock, '/api/assets?')[0]?.[0]).toContain('projectId=p1');
    expect(callsTo(fetchMock, '/api/assets?')[0]?.[0]).toContain('pageSize=200');
  });

  it('消息里的 @名字 命中项目资产时链到资产详情', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      assetList: () => ({ items: [SU_WAN_ASSET], total: 1, page: 1, pageSize: 200, hasMore: false }),
    });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: '@苏晚' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('项目里没有那个引用 → 保持纯文本，不链错', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '参考 @张三 的风格')],
      assetList: () => ({ items: [SU_WAN_ASSET], total: 1, page: 1, pageSize: 200, hasMore: false }),
    });
    renderWorkspace();

    await screen.findByText(/参考 @张三 的风格/);
    expect(screen.queryByRole('link', { name: '@张三' })).not.toBeInTheDocument();
  });

  it('索引拉不到时正文照常显示为纯文本（降级，不打断阅读）', async () => {
    setup({
      messages: [GREETING, textMessage('m-text', '好的，先定 @苏晚 的外观')],
      // 不给 assetList：会落到「用例未打桩的请求」那条 404
    });
    renderWorkspace();

    await screen.findByText(/好的，先定 @苏晚 的外观/);
    expect(screen.queryByRole('link', { name: '@苏晚' })).not.toBeInTheDocument();
  });

  it('结果卡上的 assetId 深链到资产详情', async () => {
    setup({ messages: [GREETING, ASSET_RESULT_CARD] });
    renderWorkspace();

    expect(await screen.findByRole('link', { name: '查看资产详情' })).toHaveAttribute(
      'href',
      '/projects/p1/assets?asset=a1',
    );
  });

  it('引用了项目里没有的资产 → 输入区上方提示，并可不阻塞地发出去', async () => {
    const { fetchMock } = setup({
      resolveMentions: () => ({ mentions: ['苏晚'], matched: [], missing: ['苏晚'] }),
    });
    renderWorkspace();
    await screen.findByLabelText('需求输入');

    await userEvent.type(screen.getByLabelText('需求输入'), '让 @苏晚 穿红衣服');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText(/项目里还没有 @苏晚/)).toBeInTheDocument();
    // 不阻止发送：消息真的发出去了
    expect(callsTo(fetchMock, '/api/agent/chat')).toHaveLength(1);
  });

  it('「现在新建」打开创建对话框并预填名称', async () => {
    setup({
      resolveMentions: () => ({ mentions: ['苏晚'], matched: [], missing: ['苏晚'] }),
    });
    renderWorkspace();
    await screen.findByLabelText('需求输入');

    await userEvent.type(screen.getByLabelText('需求输入'), '让 @苏晚 穿红衣服');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await userEvent.click(await screen.findByRole('button', { name: '现在新建' }));

    expect(screen.getByRole('dialog', { name: '新建资产 · 选择类型' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '角色' }));
    expect(screen.getByLabelText('名称')).toHaveValue('苏晚');
  });
});
```

- [ ] **Step 10: 运行，逐个修到通过**

```bash
pnpm --filter @svh/web exec vitest run test/mention-text.test.tsx test/agent-workspace-wiring.test.tsx
```

Expected: 两个文件全绿。

- [ ] **Step 11: 跑一遍全部前端测试**

```bash
pnpm --filter @svh/web test
```

Expected: 全绿。这一跑必须过 —— `MessageItem` / `MessageList` / `ResultCard`
三个文件都被既有用例覆盖着（`renderers.test.tsx` 直接渲染 `ResultCard`，
`agent-workspace.test.tsx` 渲染整棵树）。

- [ ] **Step 12: 类型检查与 lint**

```bash
pnpm --filter @svh/web typecheck && pnpm --filter @svh/web lint
```

Expected: 0 error。

- [ ] **Step 13: 提交**

```bash
git add apps/web/src/features/assets/MentionText.tsx \
        apps/web/src/features/assets/MentionText.module.css \
        apps/web/src/features/agent/AgentWorkspace.tsx \
        apps/web/src/features/agent/MessageList.tsx \
        apps/web/src/features/agent/MessageItem.tsx \
        apps/web/src/features/agent/renderers/ResultCard.tsx \
        apps/web/src/features/agent/renderers/card.module.css \
        apps/web/src/features/agent/Composer.tsx \
        apps/web/src/features/agent/Composer.module.css \
        apps/web/test/mention-text.test.tsx \
        apps/web/test/agent-workspace-wiring.test.tsx
git commit -m "feat(agent): @资产 成为一等交互（链接化 / 深链 / 缺失引用可一键新建）"
```

---

## Task 8: 真机验证、文档与收尾

**Files:**
- Create: `~/svh-probe/phase6/seed.mts`（探针夹具，不进仓库）
- Create: `~/svh-probe/phase6/assets.mjs`（探针，不进仓库）
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: 前七个任务的全部产物
- Produces: 三档视口的浏览器证据 + 更新后的文档

### 为什么必须有真机证据

jsdom 不做布局、不做层叠、不做命中测试。本会话已经被这条咬过三次：
「停止生成」在 390×320 下跑出视口、`Drawer` 的遮罩盖住面板（点哪都关）、
媒体失败的文案与真实原因不符。**下面每一条判据都必须在真浏览器里量出来**，
不接受「读 CSS 推断」。

- [ ] **Step 1: 确认五个服务都在**

```bash
ss -ltnp 2>/dev/null | grep -E ':(3030|5173|18080|55432|56379)' || echo '有服务没起'
```

Expected: 五条都在（API 3030 / Web 5173 / 模型桩 18080 / Postgres 55432 / Redis 56379）。
**缺哪个就把它起回来** —— 后台任务会被回收，每次验证前都要重新确认，
不能因为「上一轮还在」就跳过。启动命令：

```bash
pnpm api:dev      # 后台
pnpm worker:dev   # 后台
pnpm web:dev      # 后台
```

- [ ] **Step 2: 造探针夹具**

创建 `~/svh-probe/phase6/seed.mts`：

```ts
/**
 * Phase 6 探针夹具：一个项目 + 四个资产（3 个创作实体 + 1 个生成产物）
 * + 一条正文里带 @苏晚 的 Agent 消息。
 *
 * 资产走真实 API（顺带验证写入路径），消息走 Prisma 直写 ——
 * 没有「往会话里插一条任意消息」的接口，而为了造夹具去跑一轮 Agent
 * 会顺带写一堆任务。这是**探针夹具**，不是被测代码路径。
 *
 * 用法：cd ~/svh-probe/phase6 && node --import tsx seed.mts
 * 输出：项目 id（喂给 assets.mjs）
 */
import { readFileSync } from 'node:fs';

const REPO = '/home/yesheng/projects/SVH';
const API = 'http://127.0.0.1:3030';

// 必须在 import prisma 之前把 env 准备好：PrismaClient 在模块加载时读 DATABASE_URL
for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
  if (process.env[key] === undefined) process.env[key] = value;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} → ${String(res.status)}：${JSON.stringify(json)}`);
  return json;
}

const project = await post('/api/projects', { name: `Phase6 探针 ${String(Date.now())}` });
const projectId = project.id as string;

await post('/api/assets', {
  projectId,
  type: 'character',
  name: '苏晚',
  description: '清冷疏离的女主，擅长用眼神演戏',
  tags: ['女主', '古装'],
  metadata: {
    appearance: { gender: 'female', hair: '黑色长直发', heightCm: 168, vibe: '清冷疏离' },
    personality: '外冷内热',
    role: '女主',
  },
});

await post('/api/assets', {
  projectId,
  type: 'scene',
  name: '长安城朱雀大街',
  coverUrl: 'https://picsum.photos/seed/changan/400/300',
  metadata: { timeOfDay: '夜', lighting: '月光', weather: '小雨' },
});

await post('/api/assets', {
  projectId,
  type: 'brand',
  name: '清源',
  metadata: { colors: ['#1F6FEB', '#F5F5F7'], tone: '克制、专业' },
});

// 生成产物：列表里用来验证「无手填表单」那一种形态
await post('/api/assets', {
  projectId,
  type: 'image',
  name: '主视觉 01',
  metadata: { width: 1024, height: 1536, aspectRatio: '2:3', format: 'png' },
});

const { prisma } = await import(`${REPO}/packages/database/src/index.ts`);

const session = await prisma.session.create({
  data: { projectId, title: '探针会话' },
  select: { id: true },
});

await prisma.sessionMessage.create({
  data: {
    sessionId: session.id,
    role: 'agent',
    direction: 'outbound',
    kind: 'text',
    // 正文里同时有一个**存在**的引用与一个**不存在**的引用：
    // 前者要成链，后者必须保持纯文本
    content: '好的。我先按 @苏晚 的外观来定妆，@不存在的角色 这一条我还没有找到。',
  },
});

await prisma.$disconnect();

console.log(projectId);
process.exit(0);
```

运行：

```bash
mkdir -p ~/svh-probe/phase6/out
cd ~/svh-probe/phase6 && node --import tsx seed.mts
```

Expected: 打印一个项目 id（记作 `<PROJECT_ID>`，下面两步要用）。

- [ ] **Step 3: 写并跑三档视口探针**

创建 `~/svh-probe/phase6/assets.mjs`：

```js
/**
 * Phase 6 真机探针：资产库三档视口 + 抽屉层叠 + @资产 链接化。
 *
 * 判据（全部页内实测，不读 CSS 推断）：
 *   1. 文档有没有横向溢出（`scrollWidth > innerWidth`）
 *   2. 主操作「新建资产」是否**完全落在视口内**
 *   3. 列表首行是否真的能被点到（`elementFromPoint` 命中该行）
 *   4. 抽屉打开后，面板是否在**遮罩之上**（命中点落在面板内而不是 backdrop），
 *      以及焦点是否进了面板
 *   5. Esc 关闭后焦点是否回到触发它的那一行
 *   6. 消息里的 @苏晚 是否成链、@不存在的角色 是否**保持纯文本**，
 *      点链接是否落到资产库并打开抽屉
 *
 * 用法：node assets.mjs <projectId> [outDir]
 */
import {
  launch,
  connect,
  evaluate,
  setViewport,
  goto,
  waitFor,
  clickSelector,
  screenshot,
  sleep,
} from '../phase5b-tail/cdp.mjs';

const projectId = process.argv[2];
const outDir = process.argv[3] ?? `${process.env.HOME}/svh-probe/phase6/out`;
const WEB = 'http://127.0.0.1:5173';

if (projectId === undefined) {
  console.error('用法：node assets.mjs <projectId> [outDir]');
  process.exit(2);
}

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`);
  if (!ok) failures.push(label);
}

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false },
  { name: 'tablet-1024', width: 1024, height: 768, mobile: false },
  { name: 'mobile-390', width: 390, height: 844, mobile: true },
];

const MEASURE = `(() => {
  const de = document.documentElement;
  const rect = (el) => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
             bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const inViewport = (r) => r !== null && r.left >= 0 && r.top >= 0 &&
    r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
  const row = document.querySelector('[data-asset-id]');
  const primary = [...document.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').trim() === '新建资产');
  const filters = document.querySelector('[aria-label="按类型筛选"]');
  const rowRect = rect(row);
  const hit = rowRect === null ? null : document.elementFromPoint(
    Math.round(rowRect.left + rowRect.w / 2), Math.round(rowRect.top + rowRect.h / 2));
  return {
    视口: [window.innerWidth, window.innerHeight],
    文档宽: de.scrollWidth,
    横向溢出: de.scrollWidth > window.innerWidth + 1,
    列表行数: document.querySelectorAll('[data-asset-id]').length,
    首行矩形: rowRect,
    首行在视口内: inViewport(rowRect),
    首行命中自己或后代: hit !== null && row !== null && (hit === row || row.contains(hit)),
    主操作矩形: rect(primary),
    主操作在视口内: inViewport(rect(primary)),
    筛选条自身可滚: filters === null ? null : filters.scrollWidth > filters.clientWidth + 1,
  };
})()`;

const DRAWER = `(() => {
  const panel = document.querySelector('aside[role="dialog"]');
  if (panel === null) return { 打开: false };
  const r = panel.getBoundingClientRect();
  const x = Math.round(Math.min(r.right - 12, r.left + r.width / 2));
  const y = Math.round(r.top + 40);
  const hit = document.elementFromPoint(x, y);
  const backdrop = document.querySelector('[class*="backdrop"]');
  const br = backdrop === null ? null : backdrop.getBoundingClientRect();
  return {
    打开: true,
    面板矩形: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right),
                bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    命中标签: hit === null ? null : hit.tagName,
    命中在面板内: hit !== null && panel.contains(hit),
    命中是遮罩: backdrop !== null && hit === backdrop,
    遮罩覆盖全屏: br !== null && Math.round(br.width) >= window.innerWidth &&
      Math.round(br.height) >= window.innerHeight,
    焦点在面板内: panel.contains(document.activeElement),
    面板在视口内: Math.round(r.left) >= 0 && Math.round(r.right) <= window.innerWidth + 1,
    文档宽: document.documentElement.scrollWidth,
    横向溢出: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`;

const child = await launch({ profileDir: '/tmp/phase6-chrome-profile' });
const cdp = await connect(null);

try {
  /* ───────────────── 一、三档视口下的资产库 ───────────────── */
  for (const vp of VIEWPORTS) {
    await setViewport(cdp, vp.width, vp.height, vp.mobile);
    await goto(cdp, `${WEB}/projects/${projectId}/assets`);
    await waitFor(cdp, `document.querySelectorAll('[data-asset-id]').length > 0`, {
      label: `${vp.name} 资产列表出现`,
    });

    const m = await evaluate(cdp, MEASURE);
    console.log(`\n########## ${vp.name} ##########`);
    console.log(JSON.stringify(m, null, 2));

    check(`${vp.name} 无横向溢出`, m.横向溢出 === false, `文档宽 ${m.文档宽} / 视口 ${m.视口[0]}`);
    check(`${vp.name} 列表首行在视口内`, m.首行在视口内 === true, JSON.stringify(m.首行矩形));
    check(`${vp.name} 首行可被命中（elementFromPoint）`, m.首行命中自己或后代 === true,
      `命中的是 ${String(m.首行命中自己或后代)}`);
    check(`${vp.name} 主操作「新建资产」在视口内`, m.主操作在视口内 === true,
      JSON.stringify(m.主操作矩形));
    check(`${vp.name} 列表至少 4 行`, m.列表行数 >= 4, `实际 ${String(m.列表行数)}`);

    // 抽屉：层叠 + 焦点
    await clickSelector(cdp, '[data-asset-id]');
    await waitFor(cdp, `document.querySelector('aside[role="dialog"]') !== null`, {
      label: `${vp.name} 抽屉打开`,
    });
    await sleep(300);
    const d = await evaluate(cdp, DRAWER);
    console.log(JSON.stringify(d, null, 2));

    check(`${vp.name} 抽屉面板在遮罩之上（命中点落在面板内）`, d.命中在面板内 === true,
      `命中标签 ${String(d.命中标签)} / 命中是遮罩 ${String(d.命中是遮罩)}`);
    check(`${vp.name} 遮罩铺满视口`, d.遮罩覆盖全屏 === true);
    check(`${vp.name} 打开后焦点进入面板`, d.焦点在面板内 === true);
    check(`${vp.name} 抽屉不引起横向溢出`, d.横向溢出 === false);
    check(`${vp.name} 面板整体在视口内`, d.面板在视口内 === true, JSON.stringify(d.面板矩形));

    await screenshot(cdp, `${outDir}/library-${vp.name}.png`);

    // Esc 关闭 + 焦点归还
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `document.querySelector('aside[role="dialog"]') === null`, {
      label: `${vp.name} Esc 关闭抽屉`,
    });
    const focusBack = await evaluate(
      cdp,
      `document.activeElement !== null && document.activeElement.hasAttribute('data-asset-id')`,
    );
    check(`${vp.name} 关闭后焦点回到列表行`, focusBack === true);
    const urlAfterClose = await evaluate(cdp, 'location.search');
    check(`${vp.name} 关闭后查询参数被清掉`, urlAfterClose === '', `实际 "${String(urlAfterClose)}"`);
  }

  /* ───────────────── 二、消息里的 @资产 ───────────────── */
  await setViewport(cdp, 1440, 900, false);
  await goto(cdp, `${WEB}/projects/${projectId}`);
  await waitFor(cdp, `document.body.innerText.includes('@苏晚')`, { label: '探针消息渲染' });
  await sleep(800); // 等资产索引那一次请求落地

  const mention = await evaluate(
    cdp,
    `(() => {
       const links = [...document.querySelectorAll('a')];
       const su = links.find((a) => (a.textContent ?? '').trim() === '@苏晚');
       const ghost = links.find((a) => (a.textContent ?? '').trim() === '@不存在的角色');
       const text = document.body.innerText;
       return {
         苏晚是链接: su !== undefined,
         苏晚href: su === undefined ? null : su.getAttribute('href'),
         不存在的引用被链: ghost !== undefined,
         正文里仍有不存在的引用: text.includes('@不存在的角色'),
       };
     })()`,
  );
  console.log(`\n########## @资产 ##########`);
  console.log(JSON.stringify(mention, null, 2));

  check('消息里的 @苏晚 成了链接', mention.苏晚是链接 === true);
  check(
    '@苏晚 的链接指向资产深链',
    typeof mention.苏晚href === 'string' && /\/assets\?asset=/.test(mention.苏晚href),
    String(mention.苏晚href),
  );
  check('项目里没有的引用保持纯文本（不链错）', mention.不存在的引用被链 === false);
  check('不存在的引用在正文里照常可见', mention.正文里仍有不存在的引用 === true);

  await clickSelector(cdp, 'a[href*="/assets?asset="]');
  await waitFor(cdp, `document.querySelector('aside[role="dialog"]') !== null`, {
    label: '点 @资产 打开详情抽屉',
  });
  const landed = await evaluate(cdp, '({ href: location.href, hasPanel: document.querySelector(\'aside[role="dialog"]\') !== null })');
  check('点 @苏晚 落到资产库并打开了抽屉', landed.hasPanel === true, landed.href);
  await screenshot(cdp, `${outDir}/mention-link.png`);
} catch (error) {
  console.log(`\n########## 探针异常 ##########`);
  console.log(String(error.message));
  const snapshot = await evaluate(
    cdp,
    `({ 地址: location.href, 就绪: document.readyState, 根子元素: document.getElementById('root')?.childElementCount ?? -1, 正文: document.body.innerText.slice(0, 400) })`,
  ).catch((e) => `取快照也失败：${String(e.message)}`);
  console.log('页面状态：', JSON.stringify(snapshot, null, 2));
  failures.push(`探针异常：${String(error.message)}`);
} finally {
  child.kill('SIGTERM');
}

console.log('\n########## 汇总 ##########');
console.log(failures.length === 0 ? 'ALL PASS' : `FAILED (${String(failures.length)})`);
for (const item of failures) console.log(` - ${item}`);
process.exit(failures.length === 0 ? 0 : 1);
```

运行（把 `<PROJECT_ID>` 换成 Step 2 打印出来的那个）：

```bash
cd ~/svh-probe/phase6 && node assets.mjs <PROJECT_ID>
```

Expected: 最后一行 `ALL PASS`，退出码 0。
截图落在 `~/svh-probe/phase6/out/`（desktop / tablet / mobile 三张 + mention-link 一张）——
**逐张看一眼**：探针只量了几何与命中，遮挡、错位、颜色这类问题它量不出来。

若失败，按 `systematic-debugging` 的流程定位，**不要**为了让探针过而改判据。
判据是 Spec §9.2 与验收标准第 6 条明写的。

- [ ] **Step 3.5: 跑数字输入探针（单元测试测不了的那一条）**

`~/svh-probe/phase6/number-typing.mjs` 已经在计划阶段写好并跑通过，这一步只是复跑确认它仍然通过：

```bash
cd ~/svh-probe/phase6 && node number-typing.mjs
```

Expected: `PASS  受控的 number 输入框能输入小数（中间态不会抹掉小数点）`。

为什么这条必须由真机保证：`metadata/specs.ts` 里的 `speed` / `pitch` / `volume`
是 0.5~2 的小数（`step="any"`），而 jsdom 30 把 `input.value = '1.'` 读回 `''`，
受控重写会抹掉小数点 —— 在单元测试里输入 `1.5` 会得到 `5`，
即**小数输入在 jsdom 里根本测不出来**。真机实测（Chromium + CDP 真实按键）
逐字键入 `1` `.` `5` 得到 `1.5`。这条探针就是那个行为的证据。

- [ ] **Step 4: 全量门禁**

```bash
pnpm turbo run lint typecheck test build
```

Expected: 全部任务成功。若 `test` 命中缓存而你想确认真跑过，加 `--force`：

```bash
pnpm turbo run lint typecheck test build --force
```

Expected: 各包 `test` 全绿（本轮新增约 60 个用例；
`apps/web` 与 `apps/api` 的用例数都要 >= 改动前）。

- [ ] **Step 5: 更新文档**

`README.md`：把阶段表里 Phase 6 那一行标为完成，并在包结构里补
`apps/web/src/features/assets/`。

`docs/ARCHITECTURE.md`：新增一节「资产库前端」（放在前端结构那一节之后），写清四件事：

1. **数据表 + 一个渲染器**：`metadata/specs.ts` 是字段描述（数据），
   `MetadataForm.tsx` 是渲染器（6 种控件）。新增字段 = 往表里加一行。
2. **表单 ↔ schema 的机械契约**：`apps/api/test/asset-form-contract.test.ts`
   用编译器 API 解析前端字段表，对每个叶子键断言它在 `@svh/domain` 的
   schema 分支里存在、控件类型匹配、select 选项与枚举一致。
   没有它，表单写了 schema 不认的字段时**所有组件测试都会是绿的**。
3. **编辑只发 dirty 字段**：服务端是「深合并 + 整体校验」，因此部分提交安全；
   提交整份会把 Agent 写入、表单未暴露的字段（`generation` 等）抹掉。
   清空发 `null`（`deepMerge` 的显式清除语义），新建时**不发**（`optional()` 不接受 `null`）。
4. **`@资产` 的口径**：前端 tokenizer 与后端 `parseAssetMentions` 用同一条正则；
   索引是工作台加载时拉的 `slug → id` 映射（窗口 200），匹配不上保持纯文本。

并更新「已知限制」，把本阶段登记的四项写进去（见 Spec §11）：
`character.metadata.appearanceFields` 死字段、版本历史界面（Phase 10）、
全局资产库、`Composer` 的 `@` 补全会列出已归档资产。
再加一条本计划新登记的：**跨资产引用与自由键值对字段暂不可编辑**
（缺「资产选择器」与「键值对编辑器」两种控件，见 `specs.ts` 顶部注释）。

- [ ] **Step 6: 提交**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: Phase 6 资产库前端结构与已知限制"
```

- [ ] **Step 7: 收尾核对**

逐条对照 Spec §10 的验收标准，**每条都要能指出证据**（测试名或探针输出）：

| 验收标准 | 证据 |
| --- | --- |
| 1. 浏览 / 按中文名搜索 / 按 14 类筛选 / 加载更多 | `asset-library.test.tsx` 的工具栏与翻页用例 + `assets.mjs` 三档视口 |
| 2. 能创建 7 类创作实体并通过 schema 校验落库 | `asset-create-dialog.test.tsx` + `seed.mts` 真实 API 建了 3 类 + 抽屉/对话框联调 |
| 3. 编辑只改动过的字段；Agent 写入的字段仍在 | `asset-detail-drawer.test.tsx` 的 three 条保存用例 |
| 4. 结果卡与消息里的资产可点开详情 | `agent-workspace-wiring.test.tsx` + `assets.mjs` 的 @资产 段 |
| 5. 引用不存在的资产时当场提示并可一键新建 | `agent-workspace-wiring.test.tsx` 的两条 missing 用例 |
| 6. 三档视口无横向溢出、核心操作在视口内 | `assets.mjs` 的 41 条 check（每档 12 条 × 3 档 + `@资产` 段 5 条） |

有哪一条拿不出证据，就**先补证据**再宣布完成。

---

## Self-Review

写完计划后对着 Spec 又过了一遍，下面是结果（已就地修掉发现的问题）。

### 1. Spec 覆盖

| Spec 章节 | 落在哪个任务 |
| --- | --- |
| §2 现状核对（死字段不动 schema） | Task 1（`specs.ts` 不暴露 `appearanceFields`）+ Task 8 Step 5 登记 |
| §3.1 路由归属（套 `AppShell`） | Task 6 Step 5 |
| §3.2 三个入口 | Task 6 Step 5（工作台头部）、Task 7 Step 5（结果卡深链）与 Step 7（消息 `@名字`） |
| §3.3 深链（进 push / 出 replace / 失效提示一次） | Task 6 Step 4 的 `openAsset` / `closeAsset` / `handleMissing` |
| §4 文件结构 | Task 1（`assetLabels` / `specs`）、Task 2（`MetadataForm`）、Task 4 / 5 / 6（三个页面件）、Task 7（`MentionText`） |
| §5.1 `FieldSpec` 形状（6 种控件） | Task 1 Step 6 |
| §5.2 7 类可创建 / 7 类只读 | Task 1（空表 + `CREATABLE_TYPE_OPTIONS`）、Task 4、Task 5 |
| §5.3 通用字段（含 slug 显式展示） | Task 4 / 5（表单）、Task 6（列表里的 `@slug`） |
| §6.1 列表 / 创建 / 编辑 | Task 6（列表与工具栏）、Task 4（两步创建）、Task 5（只发 dirty） |
| §6.2 `@资产` | Task 7 全程 |
| §6.3 归档 | Task 5 Step 4 的 `archive()` + 二次确认 |
| §7 状态设计 | Task 6（列表三态 + **两种空态**）、Task 5（抽屉骨架 / `ErrorState`）、Task 4 / 5（提交中保留输入） |
| §8 `Drawer` 焦点管理 | Task 3 |
| §9.1 五个新增测试 | Task 1（契约 + 纯函数）、Task 2（渲染器）、Task 5（只发 dirty）、Task 6（页面与三态）、Task 7（`@资产` 接线） |
| §9.2 真机验证 | Task 8 Step 3（三档视口 + 抽屉层叠 + 链接化） |
| §10 验收标准 | Task 8 Step 7 的逐条证据表 |
| §11 后续任务登记 | Task 8 Step 5 |

一条都没漏。

### 2. 与 Spec 文件树的差异（都是有理由的，不是随手加）

| 多出来的文件 | 为什么 |
| --- | --- |
| `assets/assetErrors.ts` | `parseFieldErrors` 被创建对话框与详情抽屉**两处**需要。塞进任一处都会让另一处依赖它的邻居 |
| `assets/MentionText.tsx` + `.module.css` | Spec §6.2 提了需求但没点文件。它是纯文本→链接的渲染件，与页面无关，单独放便于单测 |
| `AssetCreateDialog.module.css` / `AssetDetailDrawer.module.css` | Spec 只给 `AssetLibraryPage` 点了 CSS，另两个组件的样式同样不该内联 |
| `test/asset-metadata.test.ts` / `mention-text.test.tsx` / `asset-create-dialog.test.tsx` / `asset-detail-drawer.test.tsx` | Spec §9.1 列了 4 个测试文件，其中「资产库页面」一个文件要覆盖三态 + 工具栏 + 两个组件的行为会变成上千行、失败信息也定位不到是哪一层。按组件拆开后，纯逻辑（`asset-metadata`）与渲染行为（`metadata-form`）也分得开 |
| `Drawer` 的 `width` 档位 | Spec §8 只提焦点，但 320px 的面板塞不下 metadata 表单。默认值不变，工作台布局不受影响 |

另外**加强**了一处：Spec §9.1 要求契约测试断言「每个叶子 key 在 schema 里存在」，
计划里还多断言了**控件类型与 zod 类型一致**与 **select 选项与枚举完全一致**，
并补了两条反向用例（污染字段表后必须报错）—— 否则一个恒定返回空数组的校验器
也能让主用例通过。

### 3. 类型与命名一致性（逐条核对过）

- `diffMetadata(specs, initial, current)` / `fieldPaths(specs)` / `parseFieldErrors(suggestions, paths)`
  / `GENERAL_FIELD_KEYS` —— Task 1 定义，Task 4 / 5 的调用签名一致
- `TagsField({ label, htmlFor, id, value, onChange, helper?, error?, disabled? })` ——
  Task 2 导出，Task 4 / 5 的用法一致（`htmlFor` 与 `id` 传同一个值）
- `AssetCreateDialog({ open, projectId, initialName?, onClose, onCreated })` ——
  Task 4 定义，Task 6 / 7 的调用一致（Task 7 用到 `onCreated(asset)` 的入参）
- `AssetDetailDrawer({ assetId, projectId, onClose, onMissing, onChanged })` ——
  Task 5 定义，Task 6 的调用一致
- `MentionText({ text, assetIndex, projectId })` —— Task 7 定义与使用一致
- `assetIndex: ReadonlyMap<string, string>` —— 工作台 `setAssetIndex(new Map(...))`、
  `MessageList` 透传、`MessageItem` 默认值三处类型一致
- `Drawer({ width })` —— Task 3 定义，Task 5 传 `"lg"`
- `AssetSummary` 的四个字段（`id` / `type` / `name` / `slug` / `coverUrl`）——
  列表项渲染、索引构建、测试夹具三处一致

**发现并修掉的两个问题**（写在这里是为了让执行者知道这些坑真的存在）：

1. `MetadataForm` 递归渲染 group 时，子字段的写回若直接调顶层 `onChange`，
   会把整个 metadata 替换成那个子对象 —— 外层的键全丢。
   Task 2 因此给 `renderNodes` 增加了 `emit` 参数，并补了一条专门的用例。
2. 资产库页头与「项目里还没有资产」空态各有一个 primary 的「新建资产」按钮，
   一屏两个主操作。Task 6 用 `showHeaderCreate` 让空态独占那个主操作。

### 4. 明确记下的取舍（执行时不要「顺手改好」）

- **跨资产引用 id、自由键值对、对象数组不放进表单**：6 种控件表达不了，
  硬塞会产出 schema 不认的数据。见 `specs.ts` 顶部注释与 Task 8 Step 5 的登记
- **生成产物不能改 slug / coverUrl**：Spec §5.2 的编辑列只给了
  `name` / `description` / `tags`，照字面执行
- **封面是文本 URL 输入，没有上传**：上传要走存储与文件选择器，不在本阶段
- **列表无封面时用类型中文名占位，不用类型图标**：图标集里没有 14 类各自的图形，
  用同一个通用图标反而分不出类型；中文名无歧义且不需要新增素材
- **`@` 索引窗口 200**：超出窗口的引用保持纯文本，不猜
- **`a@b.com` 里的 `@b` 会被当成引用**：与后端 `parseAssetMentions` 同一条正则，
  要改必须两边一起改（Task 7 有专门的用例把这条口径写下来）

### 5. 占位符扫描

全文 grep `TBD` / `TODO` / `待补` / `类似 Task` / `同上` —— **0 命中**。
每个代码步骤都给的是完整可运行代码；每个测试步骤都给的是完整测试文件。

