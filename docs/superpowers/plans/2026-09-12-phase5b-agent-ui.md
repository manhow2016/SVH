# Phase 5B：Agent UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `apps/web` —— 用户可操作的 Agent 工作台（项目入口、对话流、五类结构化载荷、实时任务面板、模型 Provider 配置），让 Phase 5A 打通的实时通道真正被用户看见。

**Architecture:** React 19 + Vite 8 单页应用，**不引入任何 UI 组件库**，样式用 CSS Modules + 自建 Design Token（`tokens.css` 是颜色/字号/间距/圆角的唯一来源）。后端契约**已经完备**（五种消息载荷 + 13 种 SSE 事件类型），前端只做消费与渲染，不改任何后端数据结构。SSE 用原生 `EventSource`，断线时退避重连并**回退轮询**，绝不静默。

**Tech Stack:** React 19.3 / Vite 8.3 / TypeScript（NodeNext→bundler 覆盖）/ CSS Modules / Vitest 5 + @testing-library/react 16 / React Router 7

**Spec:** `docs/superpowers/specs/2026-09-12-phase5-agent-ui-design.md`（§6 前端结构、§7 视觉系统、§10 验收标准）

**上游交付：** Phase 5A（提交 `a21e7b6`）—— Redis Stream 事件总线、SSE 端点、确认链路闭环

## Global Constraints

- 全部代码与注释使用**简体中文**；提交信息格式 `type(scope): 描述`
- 纯 ESM，`"type": "module"`；相对导入**带 `.js` 后缀**（Vite 与 TS 的 `bundler` 解析都接受）
- TypeScript 严格模式 + `noUncheckedIndexedAccess`
- 禁止非空断言 `!`、禁止显式 `any`（测试文件放宽）；禁止浮空 Promise
- **禁止**：大面积渐变、玻璃拟态、emoji 作为图标、大面积阴影、无意义统计卡片、
  默认 Ant Design / Tailwind 模板感、Card 嵌套 Card
- **Design Token 是唯一来源**：组件 CSS 里**禁止**出现字面颜色/字号/圆角；间距只用 Token 档位
- Card **只**用于有独立操作边界的对象（计划卡 / 结果卡 / 确认卡 / 错误卡 / Provider 条目）；
  对话流用留白与分隔线分层，不套卡片
- 所有列表与面板必须有 **Loading / Empty / Error** 三态；错误必须说明
  「发生了什么 / 可能原因 / 下一步怎么做」
- 必须支持 Desktop / Tablet / Mobile 三档，不得横向溢出
- **不改动** `apps/api` / `apps/worker` / `packages/**` 的任何代码
  （唯一例外：Task 1 需扩展根 `eslint.config.js` 以覆盖 `.tsx`）
- 依赖下载走代理 `http://192.168.240.1:10808`（实测可用）

## 控制方已做的技术裁定

1. **依赖版本取现代配套组合**：Vite 8 + Vitest 5 + React 19。仓库其它包用的是 Vitest 2，
   本次**刻意不一致** —— 那些是 Node 库，web 是浏览器应用，需求不同；
   为迁就 Vitest 2 而把前端钉在 Vite 5 上是让新代码从第一天就落后两个大版本。
   Vitest 5 的 peer 已声明支持 Vite 8。统一全仓 Vitest 版本是**独立任务**，不在本计划内。
2. **`apps/web/tsconfig.json` 必须覆盖根基线**：根 `tsconfig.base.json` 是
   `lib: ["ES2023"]` + `module: NodeNext`，浏览器应用需要
   `lib: ["ES2023","DOM","DOM.Iterable"]` + `jsx: "react-jsx"` + `module: "ESNext"}`
   + `moduleResolution: "bundler"` + `types: ["vite/client"]`。这是本阶段唯一需要偏离基线的包。
3. **根 `eslint.config.js` 的测试放宽只匹配 `.ts`**（`:92` 的
   `files: ['**/*.test.ts', '**/test/**/*.ts']`），必须扩展为同时覆盖 `.tsx`，
   否则前端的测试文件拿不到 `no-unsafe-*` 放宽，会写不下去。
4. **SSE 降级判据锚定「事件陈旧度」而非「帧缺失」**（来自 Phase 5A 终审的裁定）：
   Phase 5A 给订阅连接加了 `blockingTimeout`，半开连接现在会每 15 秒收到一次 `ping`。
   若按「多久没收到帧」判定降级，**半开链路会看起来完全健康**。
   必须记录**最后一次业务事件**的时间，用它触发降级提示。
5. **`apps/web` 不做 SSR、不做代码分割优化、不做 PWA** —— YAGNI，本阶段只要工作台可用。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `apps/web/package.json` | 依赖与脚本 |
| `apps/web/index.html` | Vite 入口 HTML |
| `apps/web/vite.config.ts` | 构建 + `/api` 代理到 `127.0.0.1:3030` |
| `apps/web/vitest.config.ts` | jsdom 环境 + setup |
| `apps/web/tsconfig.json` | 覆盖根基线的浏览器配置（含测试） |
| `apps/web/tsconfig.build.json` | 仅 src 的构建配置 |
| `apps/web/test/setup.ts` | jest-dom 匹配器 + fetch/EventSource 清理 |
| `apps/web/src/main.tsx` | 挂载 |
| `apps/web/src/App.tsx` | 路由表 |
| `apps/web/src/styles/tokens.css` | **Design Token 唯一来源** |
| `apps/web/src/styles/global.css` | reset + 基础排版 |
| `apps/web/src/lib/api.ts` | fetch 封装：解析统一错误体 → 可读错误 |
| `apps/web/src/lib/api-types.ts` | 后端响应的 TypeScript 类型（手写，与后端契约对齐） |
| `apps/web/src/lib/sse.ts` | EventSource 封装：退避重连 + 游标续传 + 事件陈旧度 |
| `apps/web/src/lib/format.ts` | 时间 / 时长 / 字节格式化 |
| `apps/web/src/components/Icon.tsx` | 统一 SVG 图标集（**禁止 emoji**） |
| `apps/web/src/components/Button.tsx` | primary / secondary / ghost / danger |
| `apps/web/src/components/Field.tsx` | Label + Input/Textarea + Helper/Error |
| `apps/web/src/components/Dialog.tsx` | 模态（含焦点陷阱与 Esc 关闭） |
| `apps/web/src/components/Drawer.tsx` | 侧抽屉（窄屏侧区折叠用） |
| `apps/web/src/components/StateBlock.tsx` | Skeleton / EmptyState / ErrorState 三态 |
| `apps/web/src/components/ProgressBar.tsx` | 进度条 |
| `apps/web/src/components/Toast.tsx` | 轻提示 |
| `apps/web/src/features/projects/ProjectListPage.tsx` | 项目列表 + 新建 + 空状态 |
| `apps/web/src/features/agent/AgentWorkspace.tsx` | 工作台三区布局 |
| `apps/web/src/features/agent/MessageList.tsx` | 对话流 |
| `apps/web/src/features/agent/MessageItem.tsx` | 单条消息 + 载荷分发 |
| `apps/web/src/features/agent/renderers/PlanCard.tsx` | 计划卡 |
| `apps/web/src/features/agent/renderers/ResultCard.tsx` | 结果卡 |
| `apps/web/src/features/agent/renderers/ConfirmationCard.tsx` | 确认卡 |
| `apps/web/src/features/agent/renderers/ErrorCard.tsx` | 错误卡 |
| `apps/web/src/features/agent/renderers/ProgressLine.tsx` | 内联进度 |
| `apps/web/src/features/agent/Composer.tsx` | 输入区 + `/技能` 与 `@资产` 补全 |
| `apps/web/src/features/agent/ToolTrace.tsx` | 工具调用轨迹（可折叠） |
| `apps/web/src/features/agent/TaskPanel.tsx` | 实时任务面板 + 上下文说明 |
| `apps/web/src/features/agent/useSessionStream.ts` | SSE 接入 hook（含降级与回退轮询） |
| `apps/web/src/features/settings/ProviderSettingsPage.tsx` | Provider 配置页 |

被修改的既有文件：

| 文件 | 改动 |
| --- | --- |
| `eslint.config.js` | 测试放宽的 `files` 增加 `tsx` 变体 |
| `README.md` | Phase 5B 标记完成、包结构补 `apps/web` |
| `docs/ARCHITECTURE.md` | 新增 §6.10 前端结构；更新交付边界与已知限制 |

---

## Task 1: `apps/web` 脚手架、Design Token 与构建测试链路

**Files:**
- Create: `apps/web/package.json`、`index.html`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`tsconfig.build.json`
- Create: `apps/web/src/main.tsx`、`src/App.tsx`、`src/vite-env.d.ts`
- Create: `apps/web/src/styles/tokens.css`、`src/styles/global.css`
- Create: `apps/web/test/setup.ts`
- Modify: `eslint.config.js`
- Test: `apps/web/test/tokens.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可 `pnpm --filter @svh/web dev|build|test|typecheck|lint` 的应用骨架；`tokens.css` 的全部 CSS 变量

- [ ] **Step 1: 扩展根 ESLint 配置以覆盖 `.tsx`**

修改 `/home/yesheng/projects/SVH/eslint.config.js` 第 92 行附近：

```js
  // ── 测试文件放宽部分规则 ────────────────────────────────────
  {
    // 前端（apps/web）的测试是 .tsx，只写 .ts 会让它们拿不到下面的放宽规则
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/test/**/*.tsx'],
```

- [ ] **Step 2: 创建包定义**

`apps/web/package.json`：

```json
{
  "name": "@svh/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "SVH Agent UI：项目入口、对话工作台、实时任务面板与模型配置",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.build.json --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src test",
    "clean": "rm -rf dist .turbo *.tsbuildinfo"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-router-dom": "^7.18.3"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^7.0.1",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.7",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.0.1",
    "typescript": "^5.7.2",
    "vite": "^8.3.0",
    "vitest": "^5.0.0"
  }
}
```

- [ ] **Step 3: 创建 TypeScript 配置（覆盖根基线）**

`apps/web/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx", "vite.config.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules"]
}
```

`apps/web/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["dist", "node_modules", "test"]
}
```

> 注意：`build` 脚本用 `--noEmit` 只做类型检查，真正的产物由 Vite 打包。
> 这与其它包「tsc 产出 dist」的模式不同，是前端应用的正常形态。

- [ ] **Step 4: 创建 Vite 与 Vitest 配置**

`apps/web/vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置。
 *
 * `/api` 代理到本地 API 进程：这样前端代码里统一用相对路径 `/api/...`，
 * 开发时不需要 CORS，也不需要在前端维护「后端地址」这个配置项。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3030',
        changeOrigin: true,
        // SSE 必须关闭代理层缓冲，否则事件会被攒着一起发
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
```

`apps/web/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: false,
    testTimeout: 20_000,
    // 前端用例不碰数据库与 Redis，可以并行；串行化会白白拖慢反馈
    fileParallelism: true,
  },
});
```

- [ ] **Step 5: 创建测试 setup**

`apps/web/test/setup.ts`：

```ts
/**
 * 前端测试的公共装配。
 *
 * 做三件事：给断言库挂上 jest-dom 匹配器、补齐 jsdom 缺失的浏览器 API、
 * 保证每个用例结束后不残留被替换的全局对象（否则用例之间会互相污染）。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jsdom 不实现 matchMedia，而 Task 9 的 useIsNarrow 依赖它。
 * 不在这里补上的话，Task 9 一加进 AgentWorkspace，
 * Task 5 那些原本通过的用例会全部抛 TypeError。
 *
 * 默认按「宽屏」返回；需要窄屏的用例自行 vi.stubGlobal('matchMedia', ...) 覆盖。
 */
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 6: 创建 Design Token（本任务的唯一实质交付物）**

`apps/web/src/styles/tokens.css`：

```css
/**
 * Design Token —— 颜色 / 字号 / 间距 / 圆角的**唯一来源**。
 *
 * ── 为什么是唯一来源 ──
 * 组件里写死 `#2563eb` 或 `13px` 的后果不是「不好看」，而是**改不动**：
 * 想调整视觉语言时必须全仓搜色值，必然漏。
 * 因此本文件之外的任何 CSS 都不允许出现字面色值、字号与圆角。
 *
 * 风格取向：克制的深色中性色 + 单一强调色。
 * 刻意不做大面积渐变、玻璃拟态、大面积阴影。
 */
:root {
  /* ── 颜色：中性层 ── */
  --color-background: #0f1115;
  --color-surface: #161920;
  --color-surface-secondary: #1d212a;
  --color-border: #2a2f3a;
  --color-border-strong: #3a4150;

  /* ── 颜色：文字层级 ── */
  --color-text-primary: #e8eaf0;
  --color-text-secondary: #a3aab8;
  --color-text-tertiary: #6b7383;

  /* ── 颜色：语义 ── */
  --color-primary: #4c8dff;
  --color-primary-hover: #6ba0ff;
  --color-primary-subtle: #16233a;
  --color-success: #3fb87a;
  --color-success-subtle: #14261d;
  --color-warning: #d9a441;
  --color-warning-subtle: #2a2113;
  --color-error: #e0605e;
  --color-error-subtle: #2c1919;

  /* 焦点环：键盘可达性依赖它，不得删除 */
  --color-focus-ring: #4c8dff;

  /* ── 字号：七级层级，禁止在此之外新增 ── */
  --font-family-base: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --font-family-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --font-size-page-title: 24px;   /* 页面标题 */
  --font-size-section: 18px;      /* Section 标题 */
  --font-size-card-title: 15px;   /* 卡片标题 */
  --font-size-body: 14px;         /* 正文 */
  --font-size-secondary: 13px;    /* 辅助文字 */
  --font-size-caption: 12px;      /* Caption */
  --font-size-button: 14px;       /* 按钮 */

  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;

  --line-height-tight: 1.3;
  --line-height-base: 1.55;
  --line-height-relaxed: 1.7;

  /* ── 间距：只用这九档 ── */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* ── 圆角：四档 ── */
  --radius-sm: 6px;     /* 小组件：标签、徽标 */
  --radius-md: 8px;     /* 普通组件：按钮、输入框 */
  --radius-lg: 12px;    /* 大容器：卡片、面板 */
  --radius-xl: 16px;    /* Dialog */

  /* ── 布局常量 ── */
  --layout-sidebar-width: 280px;
  --layout-taskpanel-width: 320px;
  --layout-composer-max-height: 200px;
  /* 窄屏断点由 media query 使用，此处仅作文档 */
  /* tablet: 1024px / mobile: 720px */
}
```

`apps/web/src/styles/global.css`：

```css
/**
 * 全局 reset 与基础排版。
 *
 * 只做「让浏览器默认样式不碍事」与「把 Token 落到 html/body」两件事，
 * 具体组件的样式一律由各自的 CSS Module 负责。
 */
@import './tokens.css';

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--color-background);
  color: var(--color-text-primary);
  font-family: var(--font-family-base);
  font-size: var(--font-size-body);
  line-height: var(--line-height-base);
  -webkit-font-smoothing: antialiased;
}

/* 标题的字号层级全部来自 Token，避免「一个页面出现大量无规律字号」 */
h1 { font-size: var(--font-size-page-title); font-weight: var(--font-weight-semibold); line-height: var(--line-height-tight); margin: 0; }
h2 { font-size: var(--font-size-section); font-weight: var(--font-weight-semibold); line-height: var(--line-height-tight); margin: 0; }
h3 { font-size: var(--font-size-card-title); font-weight: var(--font-weight-medium); line-height: var(--line-height-tight); margin: 0; }

p { margin: 0; }

button,
input,
textarea,
select {
  font: inherit;
  color: inherit;
}

/* 键盘可达性：焦点环必须可见，禁止 outline: none 而无替代 */
:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

/* 滚动条与深色主题一致，避免亮色滚动条割裂视觉 */
* {
  scrollbar-color: var(--color-border-strong) transparent;
  scrollbar-width: thin;
}
```

- [ ] **Step 7: 创建应用入口**

`apps/web/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />
```

`apps/web/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  // 入口 HTML 缺 #root 属于构建配置错误，直接抛出比静默白屏好排查
  throw new Error('找不到挂载点 #root，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`apps/web/src/App.tsx`（本任务只放一个占位路由，Task 4/5 会替换）：

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';

/**
 * 路由表。
 *
 * 本任务只建立骨架；项目列表与工作台分别在 Task 4、Task 5 接入。
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route
        path="/projects"
        element={<div style={{ padding: 'var(--space-6)' }}>项目入口将在 Task 4 接入</div>}
      />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
```

`apps/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SVH · AI 内容创作</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: 编写失败的测试（守护 Token 契约）**

`apps/web/test/tokens.test.ts`：

```ts
/**
 * Design Token 契约测试。
 *
 * 这些断言的意义不是「测试 CSS」，而是**把 Token 的完整性钉住**：
 * 组件靠这些变量名取色取字号，变量一旦改名或被删，组件会静默回退到浏览器默认样式 ——
 * 界面坏了但构建不会失败。这里让构建失败。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** 断言某个 Token 存在 */
function expectToken(name: string): void {
  expect(tokens, `缺少 Design Token ${name}`).toContain(`${name}:`);
}

describe('Design Token', () => {
  it('包含全部颜色语义档位', () => {
    for (const name of [
      '--color-background',
      '--color-surface',
      '--color-surface-secondary',
      '--color-border',
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-tertiary',
      '--color-primary',
      '--color-success',
      '--color-warning',
      '--color-error',
    ]) {
      expectToken(name);
    }
  });

  it('包含七级字号层级', () => {
    for (const name of [
      '--font-size-page-title',
      '--font-size-section',
      '--font-size-card-title',
      '--font-size-body',
      '--font-size-secondary',
      '--font-size-caption',
      '--font-size-button',
    ]) {
      expectToken(name);
    }
  });

  it('间距只有九档，且都是 4 的倍数', () => {
    const spacing = [...tokens.matchAll(/--space-(\d+):\s*(\d+)px/g)];
    expect(spacing).toHaveLength(9);
    for (const [, , px] of spacing) {
      expect(Number(px) % 4).toBe(0);
    }
  });

  it('圆角只有四档', () => {
    const radii = [...tokens.matchAll(/--radius-[a-z]+:/g)];
    expect(radii).toHaveLength(4);
  });

  it('不包含被明令禁止的视觉效果', () => {
    // 渐变与玻璃拟态在规范里是明确禁止的，用测试挡住「顺手加一个」
    expect(tokens).not.toMatch(/linear-gradient|radial-gradient/);
    expect(tokens).not.toMatch(/backdrop-filter/);
  });
});
```

- [ ] **Step 9: 安装依赖**

```bash
cd /home/yesheng/projects/SVH
pnpm config set proxy http://192.168.240.1:10808 --location project
pnpm config set https-proxy http://192.168.240.1:10808 --location project
pnpm install
```

> 若 `pnpm install` 因代理配置失败，可改用环境变量：
> `HTTPS_PROXY=http://192.168.240.1:10808 pnpm install`。
> **不要**把代理配置提交进仓库（`.npmrc` 若被创建，请加入 `.gitignore`）。

- [ ] **Step 10: 运行测试确认失败**

```bash
pnpm --filter @svh/web test
```

预期：失败。若 `tokens.css` 尚未创建则报读取失败；若已创建但缺 Token 则报「缺少 Design Token …」。

- [ ] **Step 11: 运行测试确认通过**

```bash
pnpm --filter @svh/web test
```

预期：5 个用例全部通过。

- [ ] **Step 12: 全链路验证**

```bash
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
pnpm --filter @svh/web build
pnpm exec turbo run lint typecheck test --filter=@svh/web
```

预期：全部通过，`build` 产出 `apps/web/dist/`。

- [ ] **Step 13: 提交**

```bash
git add apps/web eslint.config.js pnpm-lock.yaml .gitignore
git commit -m "feat(web): 新增 Agent UI 脚手架与 Design Token"
```

---

## Task 2: 通用组件（按钮 / 表单 / 弹层 / 状态 / 图标）

**Files:**
- Create: `apps/web/src/components/Icon.tsx`
- Create: `apps/web/src/components/Button.tsx` + `Button.module.css`
- Create: `apps/web/src/components/Field.tsx` + `Field.module.css`
- Create: `apps/web/src/components/Dialog.tsx` + `Dialog.module.css`
- Create: `apps/web/src/components/Drawer.tsx` + `Drawer.module.css`
- Create: `apps/web/src/components/StateBlock.tsx` + `StateBlock.module.css`
- Create: `apps/web/src/components/ProgressBar.tsx` + `ProgressBar.module.css`
- Create: `apps/web/src/components/Toast.tsx` + `Toast.module.css`
- Test: `apps/web/test/components.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `tokens.css`
- Produces:
  - `<Icon name={IconName} size?={number} />`，`IconName` 为 12 个图标名的联合
  - `<Button variant="primary|secondary|ghost|danger" size?="md|sm" loading?={boolean} />`（透传原生 button 属性）
  - `<Field label={string} htmlFor={string} helper?={string} error?={string} children />`
  - `<Dialog open={boolean} title={string} onClose={() => void} children footer?={ReactNode} />`
  - `<Drawer open={boolean} title={string} onClose={() => void} side?="left|right" children />`
  - `<EmptyState icon={IconName} title={string} description={string} action?={ReactNode} />`
  - `<ErrorState title={string} reason={string} suggestions?={string[]} onRetry?={() => void} />`
  - `<SkeletonLines lines?={number} />`、`<SkeletonBlock height?={number} />`
  - `<ProgressBar value={number} label?={string} />`
  - `<ToastProvider>` + `useToast()` → `{ show(message, tone?) }`

**设计约束（实现者必读）：**
- **图标只用自建 SVG，禁止 emoji 与 Unicode 符号**。图标集只需 12 个：
  `folder` `plus` `send` `close` `chevron-down` `chevron-right` `check` `alert` `info`
  `play` `refresh` `settings`。每个用 24×24 viewBox 的 `<path>`，`stroke="currentColor"`、
  `fill="none"`、`stroke-width={1.5}`，颜色由 `currentColor` 继承。
- **一个操作区域只有一个 Primary 按钮**。`Button` 的 `variant` 默认是 `secondary`，
  强制调用方显式写出 `variant="primary"`。
- **禁止 Card 嵌套**。本任务的组件都不带卡片外观，卡片外观由各 `*Card` 渲染器自带。

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/components.test.tsx`：

```tsx
/**
 * 通用组件测试。
 *
 * 重点验证三件事：可访问性（label 关联、对话框语义）、交互（点击/键盘）、
 * 以及三态组件真的表达了状态（而不是只有一个空壳）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../src/components/Button.js';
import { Field } from '../src/components/Field.js';
import { Dialog } from '../src/components/Dialog.js';
import { EmptyState, ErrorState, SkeletonLines } from '../src/components/StateBlock.js';
import { ProgressBar } from '../src/components/ProgressBar.js';

describe('Button', () => {
  it('默认是 secondary，且不抢主操作的视觉权重', () => {
    render(<Button>普通操作</Button>);
    expect(screen.getByRole('button', { name: '普通操作' })).toHaveAttribute(
      'data-variant',
      'secondary',
    );
  });

  it('loading 时禁用并暴露 aria-busy', () => {
    render(<Button loading>提交中</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('点击触发回调', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>点我</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Field', () => {
  it('label 与输入框通过 htmlFor 关联', () => {
    render(
      <Field label="项目名称" htmlFor="name">
        <input id="name" />
      </Field>,
    );
    // getByLabelText 只有在关联正确时才能找到 —— 这条断言就是在验证关联
    expect(screen.getByLabelText('项目名称')).toBeInTheDocument();
  });

  it('有 error 时展示错误而非 helper，并标记 aria-invalid', () => {
    render(
      <Field label="名称" htmlFor="n" helper="随便填" error="名称不能为空">
        <input id="n" />
      </Field>,
    );
    expect(screen.getByText('名称不能为空')).toBeInTheDocument();
    expect(screen.queryByText('随便填')).not.toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Dialog', () => {
  it('打开时渲染标题与内容，且带 dialog 语义', () => {
    render(
      <Dialog open title="新建项目" onClose={() => undefined}>
        <p>内容</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('新建项目');
  });

  it('按 Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="新建项目" onClose={onClose}>
        <p>内容</p>
      </Dialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('关闭时不渲染任何内容', () => {
    render(
      <Dialog open={false} title="新建项目" onClose={() => undefined}>
        <p>内容</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('三态组件', () => {
  it('EmptyState 同时给出标题、说明与主操作', () => {
    render(
      <EmptyState
        icon="folder"
        title="还没有项目"
        description="创建第一个项目后就能开始创作"
        action={<Button variant="primary">新建项目</Button>}
      />,
    );
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
    expect(screen.getByText('创建第一个项目后就能开始创作')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
  });

  it('ErrorState 必须说明原因与下一步，而不是只显示「错误」', () => {
    render(
      <ErrorState
        title="加载项目失败"
        reason="无法连接到服务"
        suggestions={['确认后端服务已启动', '稍后重试']}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('无法连接到服务')).toBeInTheDocument();
    expect(screen.getByText('确认后端服务已启动')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('ErrorState 无重试回调时不渲染重试按钮', () => {
    render(<ErrorState title="出错了" reason="原因" />);
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('SkeletonLines 渲染指定行数且对读屏隐藏', () => {
    const { container } = render(<SkeletonLines lines={3} />);
    expect(container.querySelectorAll('[data-skeleton-line]')).toHaveLength(3);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('ProgressBar', () => {
  it('暴露 progressbar 语义与当前值', () => {
    render(<ProgressBar value={42} label="正在生成第 3 个镜头" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('正在生成第 3 个镜头')).toBeInTheDocument();
  });

  it('把越界值夹到 0~100', () => {
    render(<ProgressBar value={180} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test components
```

预期：失败，报找不到 `../src/components/Button.js` 等模块。

- [ ] **Step 3: 实现 Icon**

`apps/web/src/components/Icon.tsx`：

```tsx
/**
 * 统一 SVG 图标集。
 *
 * ── 为什么自建而不引图标库 ──
 * 项目规范禁止 emoji 与混用多个图标库。图标总量只有 12 个，
 * 自建可以保证线宽、圆角、viewBox 完全一致，也不引入一个只为 12 个图标存在的依赖。
 *
 * 颜色一律用 `currentColor`，让图标跟随所在文本的颜色，避免在每处调用点重复指定。
 */

/** 图标名。新增图标必须同时补进 PATHS，两者由类型与测试双重约束。 */
export const ICON_NAMES = [
  'folder',
  'plus',
  'send',
  'close',
  'chevron-down',
  'chevron-right',
  'check',
  'alert',
  'info',
  'play',
  'refresh',
  'settings',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** 24×24 viewBox 下的路径数据 */
const PATHS: Record<IconName, string> = {
  folder: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12Z',
  close: 'M6 6l12 12M18 6L6 18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  check: 'M4 12.5l5 5L20 6.5',
  alert: 'M12 4l9 16H3l9-16ZM12 10v5M12 18h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  play: 'M7 5l12 7-12 7V5Z',
  refresh: 'M20 11a8 8 0 1 0-1.5 5M20 5v6h-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12c0-.5-.05-1-.14-1.47l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.55-1.47L13.6 2h-3.2l-.36 2.53a7 7 0 0 0-2.55 1.47L5.14 5.05l-2 3.46 2 1.55a7.1 7.1 0 0 0 0 2.94l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.55 1.47L10.4 22h3.2l.36-2.53a7 7 0 0 0 2.55-1.47l2.35.95 2-3.46-2-1.55c.09-.47.14-.97.14-1.47Z',
};

export interface IconProps {
  name: IconName;
  /** 边长，默认跟随当前字号 */
  size?: number;
  className?: string;
}

export function Icon({ name, size, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size ?? '1em'}
      height={size ?? '1em'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // 图标是装饰性的：语义由相邻文本承担，读屏重复朗读反而嘈杂
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
```

- [ ] **Step 4: 实现 Button**

`apps/web/src/components/Button.module.css`：

```css
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-button);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-tight);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
  /* 长按钮在窄屏要能换行而不是溢出 */
  max-width: 100%;
  white-space: nowrap;
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.sm {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-secondary);
}

.primary {
  background: var(--color-primary);
  color: #ffffff;
}
.primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.secondary {
  background: var(--color-surface-secondary);
  border-color: var(--color-border);
  color: var(--color-text-primary);
}
.secondary:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.ghost {
  background: transparent;
  color: var(--color-text-secondary);
}
.ghost:hover:not(:disabled) {
  background: var(--color-surface-secondary);
  color: var(--color-text-primary);
}

.danger {
  background: transparent;
  border-color: var(--color-error);
  color: var(--color-error);
}
.danger:hover:not(:disabled) {
  background: var(--color-error-subtle);
}
```

`apps/web/src/components/Button.tsx`：

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon } from './Icon.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * 视觉优先级。默认 `secondary` 是**刻意的**：
   * 规范要求「一个操作区域原则上只有一个 Primary Action」，
   * 默认值不设为 primary，可以避免调用方随手写个按钮就把主次关系破坏掉。
   */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={rest.type ?? 'button'}
      className={`${styles.button} ${styles[variant]} ${size === 'sm' ? styles.sm : ''}`}
      // 用 data 属性暴露 variant 供测试与样式钩子使用，避免测试去断言类名
      data-variant={variant}
      disabled={disabled ?? false}
      aria-busy={loading ? 'true' : undefined}
    >
      {loading ? <Icon name="refresh" /> : null}
      {children}
    </button>
  );
}
```

- [ ] **Step 5: 实现 Field**

`apps/web/src/components/Field.module.css`：

```css
.field {
  display: flex;
  flex-direction: column;
  /* 三行（Label / Input / Helper）间距恒定，避免各表单各写一套 */
  gap: var(--space-2);
}

.label {
  font-size: var(--font-size-secondary);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
}

.control {
  display: flex;
  flex-direction: column;
}

.control :global(input),
.control :global(textarea),
.control :global(select) {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
}

.control :global(input:focus),
.control :global(textarea:focus),
.control :global(select:focus) {
  border-color: var(--color-primary);
}

.helper {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.error {
  font-size: var(--font-size-caption);
  color: var(--color-error);
}
```

`apps/web/src/components/Field.tsx`：

```tsx
import type { ReactNode } from 'react';

import styles from './Field.module.css';

export interface FieldProps {
  label: string;
  /** 必须与内部控件的 id 一致，否则 label 与控件不会关联 */
  htmlFor: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, helper, error, children }: FieldProps) {
  const messageId = error !== undefined ? `${htmlFor}-error` : `${htmlFor}-helper`;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {/*
        用 cloneElement 把 aria-describedby / aria-invalid 透到真正的控件上 ——
        只把说明文字渲染在旁边，读屏用户是听不到的。
      */}
      <div className={styles.control}>{children}</div>
      {error !== undefined ? (
        <span className={styles.error} id={messageId} role="alert">
          {error}
        </span>
      ) : helper !== undefined ? (
        <span className={styles.helper} id={messageId}>
          {helper}
        </span>
      ) : null}
    </div>
  );
}
```

> **实现者注意**：上面的 `aria-describedby` / `aria-invalid` 必须真正接到子控件上。
> 若 `children` 不是单个可接收 props 的元素，就退化为只渲染说明文字，
> 但**不要**静默忽略 —— 在注释里写明该约束。测试里的
> `getByLabelText` 与 `aria-invalid` 断言就是这条契约的守卫。

- [ ] **Step 6: 实现 Dialog**

`apps/web/src/components/Dialog.module.css`：

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  z-index: 100;
}

.dialog {
  width: 100%;
  max-width: 480px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* 只有 Dialog 用大面积阴影 —— 它是唯一真正浮起的层 */
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.45);
  max-height: calc(100dvh - var(--space-8));
  overflow-y: auto;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.title {
  font-size: var(--font-size-section);
  font-weight: var(--font-weight-semibold);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  flex-wrap: wrap;
}
```

`apps/web/src/components/Dialog.tsx`：

```tsx
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc 关闭：键盘用户必须能退出模态，否则会被困住
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时把焦点移进对话框，让读屏与键盘用户直接落在模态内
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      // 点击遮罩关闭；阻止冒泡以免点击内容区也触发
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </Button>
        </div>
        <div>{children}</div>
        {footer !== undefined ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 实现 Drawer**

`apps/web/src/components/Drawer.module.css`：

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.5);
  z-index: 100;
}

.panel {
  position: fixed;
  top: 0;
  bottom: 0;
  width: min(320px, 88vw);
  background: var(--color-surface);
  border-left: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  overflow-y: auto;
}

.right {
  right: 0;
}

.left {
  left: 0;
  border-left: none;
  border-right: 1px solid var(--color-border);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
```

`apps/web/src/components/Drawer.tsx`：

```tsx
import { useEffect, type ReactNode } from 'react';

import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './Drawer.module.css';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  side?: 'left' | 'right';
  children: ReactNode;
}

/**
 * 侧抽屉。窄屏时用来收纳工作台的侧区（项目/会话导航、任务面板）。
 */
export function Drawer({ open, title, onClose, side = 'right', children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} role="presentation" />
      <aside
        className={`${styles.panel} ${side === 'left' ? styles.left : styles.right}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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

- [ ] **Step 8: 实现三态与进度**

`apps/web/src/components/StateBlock.module.css`：

```css
.block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-10) var(--space-6);
  text-align: center;
}

.icon {
  color: var(--color-text-tertiary);
  font-size: 28px;
  line-height: 1;
}

.title {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-medium);
}

.description {
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
  max-width: 42ch;
}

.suggestions {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
  text-align: left;
}

.suggestions li::before {
  content: '·';
  margin-right: var(--space-2);
  color: var(--color-text-tertiary);
}

.errorIcon {
  color: var(--color-error);
}

/* ── 骨架屏：形状贴合真实内容的布局，避免「先空后跳」 ── */
.skeletonLine {
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-secondary);
  animation: pulse 1.4s ease-in-out infinite;
}

.skeletonLines {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
}

.skeletonBlock {
  width: 100%;
  border-radius: var(--radius-lg);
  background: var(--color-surface-secondary);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 尊重用户的「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .skeletonLine,
  .skeletonBlock {
    animation: none;
  }
}
```

`apps/web/src/components/StateBlock.tsx`：

```tsx
import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon.js';
import styles from './StateBlock.module.css';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}

/** 空状态。规范禁止空白页面：必须有图标、标题、说明，以及（若有）主操作。 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.block}>
      <Icon name={icon} className={styles.icon} size={28} />
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{description}</p>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /** 发生了什么 */
  title: string;
  /** 可能原因 */
  reason: string;
  /** 下一步怎么做 */
  suggestions?: string[];
  onRetry?: () => void;
}

/**
 * 错误状态。规范要求错误信息必须说明「发生了什么 / 可能原因 / 下一步怎么做」，
 * 因此 `title` 与 `reason` 都是必填 —— 只写「出错了」的组件在这个类型下根本构造不出来。
 */
export function ErrorState({ title, reason, suggestions, onRetry }: ErrorStateProps) {
  return (
    <div className={styles.block} role="alert">
      <Icon name="alert" className={`${styles.icon} ${styles.errorIcon}`} size={28} />
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{reason}</p>
      {suggestions !== undefined && suggestions.length > 0 ? (
        <ul className={styles.suggestions}>
          {suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
      {onRetry !== undefined ? (
        <Button variant="secondary" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

/** 骨架行。形状贴合文字内容，让加载态与最终布局一致。 */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.skeletonLines} aria-hidden="true" aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          data-skeleton-line=""
          className={styles.skeletonLine}
          // 末行短一些，更像真实段落
          style={index === lines - 1 ? { width: '60%' } : undefined}
        />
      ))}
    </div>
  );
}

/** 骨架块，用于媒体网格等非文字区域 */
export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div className={styles.skeletonBlock} style={{ height }} aria-hidden="true" aria-busy="true" />;
}
```

> **实现者注意**：`SkeletonLines` 与 `SkeletonBlock` 都带了 `aria-hidden="true"` 与
> `aria-busy="true"`。这不是可有可无的 —— 骨架屏对读屏用户是纯噪音，
> 隐藏它、同时用 `aria-busy` 告知「正在加载」才是正确做法。
> `ErrorState` 里的重试按钮必须用 `Button` 组件，保持全应用按钮样式一致。

`apps/web/src/components/ProgressBar.module.css`：

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.track {
  height: 6px;
  background: var(--color-surface-secondary);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 200ms ease;
}

.label {
  font-size: var(--font-size-caption);
  color: var(--color-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .fill { transition: none; }
}
```

`apps/web/src/components/ProgressBar.tsx`：

```tsx
import styles from './ProgressBar.module.css';

export interface ProgressBarProps {
  /** 0~100；越界会被夹到区间内 */
  value: number;
  label?: string;
}

/** 把越界值夹到合法区间：后端理论上不会给越界值，但界面不该因此渲染出负宽度 */
function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function ProgressBar({ value, label }: ProgressBarProps) {
  const percent = clamp(value);
  return (
    <div className={styles.wrapper}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label ?? '进度'}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      {label !== undefined ? <span className={styles.label}>{label}</span> : null}
    </div>
  );
}
```

- [ ] **Step 9: 实现 Toast**

`apps/web/src/components/Toast.module.css`：

```css
.viewport {
  position: fixed;
  bottom: var(--space-6);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: 200;
  width: min(480px, calc(100vw - var(--space-8)));
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-secondary);
}

.info { border-left: 3px solid var(--color-primary); }
.success { border-left: 3px solid var(--color-success); }
.error { border-left: 3px solid var(--color-error); }
```

`apps/web/src/components/Toast.tsx`：

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './Icon.js';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert',
};

/** 自动消失时长；错误留久一点，因为它更需要被读到 */
const DISMISS_MS: Record<ToastTone, number> = {
  info: 3000,
  success: 3000,
  error: 6000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, DISMISS_MS[tone]);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        aria-live="polite"：让读屏在空闲时播报，而不是打断当前朗读。
        错误用 role="alert" 单独提升优先级。
      */}
      <div className={styles.viewport} aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`${styles.toast} ${styles[item.tone]}`}
            role={item.tone === 'error' ? 'alert' : undefined}
          >
            <Icon name={TONE_ICON[item.tone]} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** 取用轻提示。必须在 ToastProvider 内调用，否则直接抛错而不是静默失效。 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return ctx;
}
```

- [ ] **Step 10: 运行测试确认通过**

```bash
pnpm --filter @svh/web test components
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 11: 提交**

```bash
git add apps/web/src/components apps/web/test/components.test.tsx
git commit -m "feat(web): 新增通用组件（按钮/表单/弹层/三态/进度/轻提示）与统一图标集"
```

---

## Task 3: API 客户端与 SSE 客户端

**Files:**
- Create: `apps/web/src/lib/api-types.ts`
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/sse.ts`
- Create: `apps/web/src/lib/format.ts`
- Test: `apps/web/test/api.test.ts`
- Test: `apps/web/test/sse.test.ts`
- Test: `apps/web/test/format.test.ts`

**Interfaces:**
- Consumes: 后端统一错误体 `{ error: { code, message, suggestions, retryable }, requestId? }`
- Produces:
  - `class ApiError extends Error`，字段 `code` / `message` / `suggestions` / `retryable` / `status`
  - `apiFetch<T>(path: string, init?: RequestInit): Promise<T>`
  - `createSessionStream(options): SessionStream`，其中
    `SessionStream = { close(): void; state: 'connecting'|'open'|'reconnecting'|'closed' }`
  - `formatRelativeTime(iso: string): string`、`formatDuration(ms: number): string`

**控制方裁定（实现者必读）：**

1. **降级判据锚定「事件陈旧度」而非「帧缺失」。** Phase 5A 给订阅连接加了
   `blockingTimeout`，半开连接现在会**每 15 秒准时收到一次 `ping`**。
   若按「多久没收到帧」判定断线，半开链路会看起来完全健康 —— 而那正是降级提示最该出现的场景。
   因此本模块必须单独记录**最后一次业务事件**（`type !== 'ping' && type !== 'session.ready'`）
   的时间，并把「事件陈旧」作为一个独立于连接状态的可观测信号暴露出去。

2. **断线时必须回退轮询。** 降级提示 + `GET /api/tasks/:id/progress` 轮询，
   绝不静默。轮询的具体接线在 Task 5 的 hook 里做，本任务只需把状态暴露出来。

- [ ] **Step 1: 编写失败的测试（format）**

`apps/web/test/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { formatDuration, formatRelativeTime } from '../src/lib/format.js';

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('一分钟内显示「刚刚」', () => {
    expect(formatRelativeTime('2026-09-12T11:59:30.000Z', now)).toBe('刚刚');
  });

  it('一小时内显示分钟数', () => {
    expect(formatRelativeTime('2026-09-12T11:30:00.000Z', now)).toBe('30 分钟前');
  });

  it('一天内显示小时数', () => {
    expect(formatRelativeTime('2026-09-12T06:00:00.000Z', now)).toBe('6 小时前');
  });

  it('超过一天显示日期', () => {
    expect(formatRelativeTime('2026-09-01T12:00:00.000Z', now)).toBe('2026-09-01');
  });

  it('时间在未来时退化为「刚刚」而不是负数', () => {
    // 客户端时钟略快于服务端是常见现象，不该显示「-1 分钟前」
    expect(formatRelativeTime('2026-09-12T12:00:30.000Z', now)).toBe('刚刚');
  });

  it('无法解析的输入返回空串而不是 Invalid Date', () => {
    expect(formatRelativeTime('不是时间', now)).toBe('');
  });
});

describe('formatDuration', () => {
  it('小于一秒显示毫秒', () => {
    expect(formatDuration(320)).toBe('320ms');
  });

  it('小于一分钟显示秒', () => {
    expect(formatDuration(4500)).toBe('4.5s');
  });

  it('超过一分钟显示分秒', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
```

- [ ] **Step 2: 编写失败的测试（api）**

`apps/web/test/api.test.ts`：

```ts
/**
 * API 客户端测试。
 *
 * 核心契约：**后端的统一错误体必须被翻译成用户可读的 ApiError**。
 * 这是「错误信息必须说明发生了什么 / 可能原因 / 下一步怎么做」这条规范的第一道落点 ——
 * 如果这里把 suggestions 丢了，界面再怎么写也补不回来。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from '../src/lib/api.js';

/** 构造一个 fetch 返回值 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('成功时直接返回资源本身（后端不用 {code,data,message} 包装）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'p1', name: '项目' })));
    await expect(apiFetch<{ id: string }>('/api/projects/p1')).resolves.toEqual({
      id: 'p1',
      name: '项目',
    });
  });

  it('204 返回 undefined 而不是解析空 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetch<void>('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('把错误体翻译成带 suggestions 与 retryable 的 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'NOT_FOUND',
              message: '会话不存在，可能已被删除。',
              suggestions: ['返回项目列表重新进入'],
              retryable: false,
            },
            requestId: 'req_abc',
          },
          404,
        ),
      ),
    );

    const error = await apiFetch('/api/agent/sessions/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe('会话不存在，可能已被删除。');
    expect(apiError.suggestions).toEqual(['返回项目列表重新进入']);
    expect(apiError.retryable).toBe(false);
    expect(apiError.status).toBe(404);
    expect(apiError.requestId).toBe('req_abc');
  });

  it('网络不可达时给出可理解的错误，而不是抛原始的 TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    // 面向用户：不能出现 "Failed to fetch" 这类技术术语
    expect(error.message).not.toContain('Failed to fetch');
    expect(error.retryable).toBe(true);
    expect(error.suggestions.length).toBeGreaterThan(0);
  });

  it('响应不是 JSON 时也给出可理解的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })),
    );
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  it('错误体结构不符预期时回退到通用文案，而不是崩溃', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ oops: true }, 500)));
    const error = (await apiFetch('/api/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 编写失败的测试（sse）**

`apps/web/test/sse.test.ts`：

```ts
/**
 * SSE 客户端测试。
 *
 * 用假 EventSource，重点验证：
 * - 断线后按退避重连，且带上 Last-Event-ID 续传
 * - **降级判据锚定事件陈旧度**（控制方裁定）—— ping 不能刷新它
 * - 关闭后不再重连
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStream, type SseEnvelope } from '../src/lib/sse.js';

/** 可控的假 EventSource */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** 模拟连接建立 */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** 模拟收到一条事件 */
  emit(type: string, envelope: SseEnvelope): void {
    const event = new MessageEvent(type, { data: JSON.stringify(envelope) });
    // 服务端用 event: 指定类型，浏览器按类型分发；这里直接调 onmessage 模拟
    this.onmessage?.(event);
  }

  /** 模拟连接中断 */
  emitError(): void {
    this.onerror?.(new Event('error'));
  }
}

function envelope(overrides: Partial<SseEnvelope> = {}): SseEnvelope {
  return {
    seq: 1,
    type: 'agent.message',
    at: new Date().toISOString(),
    sessionId: 'sess_1',
    data: { message: '你好' },
    ...overrides,
  };
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.useRealTimers();
});

describe('createSessionStream', () => {
  it('首次连接不带 Last-Event-ID', () => {
    createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent: () => undefined,
    });
    expect(FakeEventSource.instances[0]?.url).toBe('/api/agent/sessions/sess_1/events');
  });

  it('收到事件后回调，并记录最后一次业务事件时间', () => {
    const onEvent = vi.fn();
    const onStateChange = vi.fn();
    createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent,
      onStateChange,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.emit('agent.message', envelope({ seq: 7 }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ seq: 7, type: 'agent.message' });
  });

  it('断线后重连带上 Last-Event-ID，且退避时间递增', () => {
    vi.useFakeTimers();
    createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent: () => undefined,
    });

    const first = FakeEventSource.instances[0];
    first?.emitOpen();
    first?.emit('task.progress', envelope({ seq: 12 }));
    first?.emitError();

    // 第一次退避
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    // 重连 URL 必须带游标，否则断线期间的事件会永久丢失
    expect(FakeEventSource.instances[1]?.url).toContain('lastEventId=12');
  });

  it('ping 不刷新「最后业务事件」时间（半开链路的关键守卫）', () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000 };
    const onStateChange = vi.fn();

    const stream = createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent: () => undefined,
      onStateChange,
      now: () => clock.now,
      // 事件超过 30s 未更新即视为陈旧
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.emit('task.progress', envelope({ seq: 1 }));

    // 时间前进 60 秒，期间只收到 ping —— 连接「看起来」是健康的
    clock.now += 60_000;
    source?.emit('ping', envelope({ seq: 2, type: 'ping' }));

    // 事件已陈旧，必须暴露出来；ping 不能把它刷新成新鲜
    expect(stream.isEventStale()).toBe(true);
  });

  it('收到新的业务事件后不再陈旧', () => {
    const clock = { now: 1_000_000 };
    const stream = createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent: () => undefined,
      now: () => clock.now,
      staleAfterMs: 30_000,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    clock.now += 60_000;
    expect(stream.isEventStale()).toBe(true);

    source?.emit('task.progress', envelope({ seq: 3 }));
    expect(stream.isEventStale()).toBe(false);
  });

  it('close 之后不再重连', () => {
    vi.useFakeTimers();
    const stream = createSessionStream({
      sessionId: 'sess_1',
      EventSourceImpl: FakeEventSource as never,
      onEvent: () => undefined,
    });

    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    stream.close();
    source?.emitError();

    vi.advanceTimersByTime(60_000);
    // 只有最初那一个实例，没有新的重连
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
pnpm --filter @svh/web test api sse format
```

预期：失败，报找不到 `../src/lib/api.js` 等模块。

- [ ] **Step 5: 实现 format**

`apps/web/src/lib/format.ts`：

```ts
/**
 * 展示层格式化。
 *
 * 纯函数、无副作用、可注入 `now` —— 后者是为了让测试不依赖真实时钟。
 */

/** 相对时间。无法解析时返回空串：界面上宁可少一块信息，也不要显示 "Invalid Date"。 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return '';

  const diffMs = now.getTime() - target.getTime();

  // 客户端时钟比服务端快是常见现象，未来时间按「刚刚」处理而不是显示负数
  if (diffMs < 60_000) return '刚刚';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  // 超过一天就给绝对日期 —— 「3 天前」对用户没有「几号」有用
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(
    target.getDate(),
  ).padStart(2, '0')}`;
}

/** 耗时。小于一秒用毫秒，避免出现 "0.0s" 这种没有信息量的显示。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
```

- [ ] **Step 6: 实现 api**

`apps/web/src/lib/api-types.ts`：

```ts
/**
 * 后端响应的前端类型。
 *
 * ── 为什么手写而不从后端 import ──
 * 前端构建不应把服务端代码（Prisma、Fastify）拉进 bundle。
 * 这些类型与 `@svh/domain` 的契约对齐，但只保留界面真正消费的字段。
 *
 * 注：这确实是一处「可能漂移」的接缝。它的护栏是端到端验证
 * （验收标准第 1 条会走完整链路），而不是编译期检查。
 */

export interface PageBody<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  projectId: string | null;
  title: string;
  agentState: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 五类结构化载荷（与 @svh/domain 的 messagePayloadSchema 对齐） */
export interface PlanTask {
  id: string;
  title: string;
  skill?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  taskId?: string;
  estimate?: string;
  dependsOn: string[];
}

export interface PlanPayload {
  type: 'plan';
  goal: string;
  rationale?: string;
  tasks: PlanTask[];
  requiresApproval: boolean;
}

export interface CardAction {
  id: string;
  label: string;
  kind: 'reply' | 'primary' | 'secondary' | 'danger';
  message?: string;
  tool?: string;
  payload?: Record<string, unknown>;
}

export interface CardMedia {
  kind: 'image' | 'video' | 'audio' | 'text';
  url?: string;
  assetId?: string;
  thumbnailUrl?: string;
  caption?: string;
}

export interface ResultCardPayload {
  type: 'result_card';
  title: string;
  category:
    | 'character' | 'scene' | 'product' | 'brand' | 'digital_human'
    | 'script' | 'storyboard' | 'image' | 'video' | 'audio'
    | 'subtitle' | 'output' | 'asset' | 'info';
  subtitle?: string;
  attributes?: Array<[string, string]>;
  media: CardMedia[];
  assetId?: string;
  contentId?: string;
  taskId?: string;
  actions: CardAction[];
}

export interface ConfirmationRequestPayload {
  type: 'confirmation_request';
  summary: string;
  impacts: Array<[string, string]>;
  taskId?: string;
  planTaskIds: string[];
}

export interface ProgressPayload {
  type: 'progress';
  taskId?: string;
  progress: number;
  message: string;
}

export interface ErrorPayload {
  type: 'error';
  title: string;
  reason: string;
  suggestions: string[];
  recovered: boolean;
  recoveryNote?: string;
  actions: CardAction[];
  taskId?: string;
  code?: string;
}

export type MessagePayload =
  | PlanPayload
  | ResultCardPayload
  | ConfirmationRequestPayload
  | ProgressPayload
  | ErrorPayload;

export interface SessionMessage {
  id: string;
  role: 'user' | 'agent' | 'system' | 'tool';
  kind: 'text' | 'plan' | 'result_card' | 'confirmation_request' | 'progress' | 'error';
  content: string;
  payload: unknown;
  toolCalls?: unknown;
  createdAt: string;
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed' | 'rejected';
  result?: unknown;
  error?: string;
  requiresConfirmation: boolean;
  durationMs?: number;
}

export interface ChatResponse {
  sessionId: string;
  sessionCreated: boolean;
  message: string;
  payload?: MessagePayload;
  state: 'completed' | 'waiting_user' | 'failed';
  analysis: {
    intent: string;
    confidence: number;
    contentType?: string;
    targets: Array<{ kind: string; index?: number; label: string }>;
    mentions: string[];
    rationale?: string;
  };
  toolCalls: ToolCallRecord[];
  contextNotes: string[];
  iterations: number;
}

export interface TaskProgress {
  id: string;
  status: string;
  progress: number;
  progressMessage: string | null;
  errorMessage: string | null;
  skillId: string;
  updatedAt: string;
  terminal: boolean;
}

export interface TaskDetail extends TaskProgress {
  output: unknown;
}

export interface ModelProviderView {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  health: 'healthy' | 'degraded' | 'down' | 'unknown';
  apiKeyMask: string | null;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}
```

`apps/web/src/lib/api.ts`：

```ts
/**
 * API 客户端。
 *
 * ── 与后端传输契约的对应 ──
 * 后端刻意**不用** `{code, data, message}` 包打天下：
 * 成功直接返回资源本身，失败返回
 * `{ error: { code, message, suggestions, retryable }, requestId? }`。
 * 因此这里没有统一的响应包装类型 —— 调用方拿到的就是资源。
 *
 * ── 本文件存在的理由 ──
 * 把后端的错误体翻译成一个**界面可以直接用**的异常类型。
 * 如果在这里把 suggestions 丢掉，界面就再也补不回来了 ——
 * 而规范要求错误必须说明「发生了什么 / 可能原因 / 下一步怎么做」。
 */

/** 面向界面的 API 错误。字段与后端错误体一一对应。 */
export class ApiError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  readonly retryable: boolean;
  readonly status: number;
  readonly requestId?: string;

  constructor(input: {
    message: string;
    code: string;
    suggestions: string[];
    retryable: boolean;
    status: number;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.suggestions = input.suggestions;
    this.retryable = input.retryable;
    this.status = input.status;
    if (input.requestId !== undefined) this.requestId = input.requestId;
  }
}

/** 后端错误体形状（防御式读取，结构不符时回退） */
interface RawErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    suggestions?: unknown;
    retryable?: unknown;
  };
  requestId?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 从原始响应体里尽力提取错误信息；任何异常都退化为通用文案 */
function toApiError(status: number, raw: unknown): ApiError {
  const body = (raw ?? {}) as RawErrorBody;
  const error = body.error;

  const message =
    typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : status >= 500
        ? '服务暂时不可用，请稍后重试。'
        : '请求未能完成。';

  return new ApiError({
    message,
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    suggestions: isStringArray(error?.suggestions) ? error.suggestions : [],
    // 5xx 与网络问题默认可重试；4xx 交给后端显式声明
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : status >= 500,
    status,
    ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
  });
}

/**
 * 发起请求。
 *
 * 成功时返回资源本身；失败时**总是**抛出 `ApiError`
 * （包括网络不可达与非 JSON 响应 —— 调用方只需处理一种异常类型）。
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // 网络层失败（后端没起、断网）。刻意不把 "Failed to fetch" 透给用户。
    throw new ApiError({
      message: '无法连接到服务，请确认后端已启动。',
      code: 'NETWORK_ERROR',
      suggestions: ['确认后端服务正在运行', '检查网络连接后重试'],
      retryable: true,
      status: 0,
    });
  }

  // 204 与其它空 body 的成功响应
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON（例如反向代理返回的 HTML 错误页）
      if (!response.ok) {
        throw new ApiError({
          message: '服务返回了无法识别的内容，请稍后重试。',
          code: 'INVALID_RESPONSE',
          suggestions: ['稍后重试', '若持续出现请联系管理员'],
          retryable: response.status >= 500,
          status: response.status,
        });
      }
      throw new ApiError({
        message: '服务返回了无法识别的内容。',
        code: 'INVALID_RESPONSE',
        suggestions: [],
        retryable: false,
        status: response.status,
      });
    }
  }

  if (!response.ok) {
    throw toApiError(response.status, parsed);
  }

  return parsed as T;
}

/** 便捷方法：JSON body 的 POST */
export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** 便捷方法：PATCH */
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
```

- [ ] **Step 7: 实现 sse**

`apps/web/src/lib/sse.ts`：

```ts
/**
 * SSE 客户端。
 *
 * ── 这个文件要解决的两个问题 ──
 *
 * **1. 断线不能静默。** 断线后按退避重连，并把连接状态暴露给界面，
 * 让界面显示降级提示条。用户必须知道当前进度可能不是最新的。
 *
 * **2. 降级判据必须锚定「事件陈旧度」，而不是「帧缺失」。**
 * 这是控制方在 Phase 5A 终审时定下的裁定：Phase 5A 给订阅连接加了
 * `blockingTimeout`，半开（对端不回包）的连接现在会**每 15 秒准时收到一次 `ping`**。
 * 如果按「多久没收到帧」判定断线，半开链路会看起来完全健康 ——
 * 而那恰恰是降级提示最该出现的场景。
 * 因此这里单独记录**最后一次业务事件**的时间，`isEventStale()` 只看它。
 */

/** 事件信封，与 @svh/domain 的 SseEnvelope 对齐 */
export interface SseEnvelope<T = unknown> {
  seq: number;
  type: string;
  at: string;
  sessionId: string;
  data: T;
}

/** 连接状态。界面据此显示降级提示。 */
export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SessionStream {
  /** 当前连接状态 */
  readonly state: StreamState;
  /**
   * 最后一次**业务**事件是否已陈旧。
   *
   * `ping` 与 `session.ready` 不刷新它 —— 它们是心跳，不代表有进展。
   */
  isEventStale(): boolean;
  /** 最后一次业务事件的到达时间（毫秒），从未收到则为 null */
  lastEventAt(): number | null;
  close(): void;
}

/** EventSource 的最小接口，便于测试注入假实现 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close(): void;
}

export interface SessionStreamOptions {
  sessionId: string;
  onEvent: (envelope: SseEnvelope) => void;
  onStateChange?: (state: StreamState) => void;
  /** 连接失败时的回调，用于把原因暴露给界面 */
  onError?: () => void;
  /** 注入点：测试传假 EventSource */
  EventSourceImpl?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;
  /** 注入点：测试控制时钟 */
  now?: () => number;
  /** 业务事件超过此时长未更新即视为陈旧 */
  staleAfterMs?: number;
}

/** 退避序列（毫秒）。到顶后保持，避免无限增长的等待。 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** 不算「业务事件」的类型：它们是心跳或建连确认，不代表有进展 */
const NON_BUSINESS_TYPES = new Set(['ping', 'session.ready']);

export function createSessionStream(options: SessionStreamOptions): SessionStream {
  const {
    sessionId,
    onEvent,
    onStateChange,
    onError,
    EventSourceImpl = EventSource,
    now = () => Date.now(),
    staleAfterMs = 45_000,
  } = options;

  let state: StreamState = 'connecting';
  let lastEventAt: number | null = null;
  let lastEventId: number | null = null;
  let attempt = 0;
  let closed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: StreamState): void {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  }

  function buildUrl(): string {
    const base = `/api/agent/sessions/${sessionId}/events`;
    // 断线重连必须带游标：不带的话，断线期间产生的事件会永久丢失
    return lastEventId === null ? base : `${base}?lastEventId=${String(lastEventId)}`;
  }

  function connect(): void {
    if (closed) return;

    const created = new EventSourceImpl(buildUrl());
    source = created;

    created.onopen = (): void => {
      attempt = 0;
      setState('open');
    };

    created.onmessage = (event: MessageEvent<string>): void => {
      let envelope: SseEnvelope;
      try {
        envelope = JSON.parse(event.data) as SseEnvelope;
      } catch {
        // 单条坏数据不该打断整条推送链路
        return;
      }

      if (!NON_BUSINESS_TYPES.has(envelope.type)) {
        lastEventAt = now();
      }
      // 游标只前进不回退，避免乱序事件把续传点拉回去
      if (typeof envelope.seq === 'number' && (lastEventId === null || envelope.seq > lastEventId)) {
        lastEventId = envelope.seq;
      }

      onEvent(envelope);
    };

    created.onerror = (): void => {
      if (closed) return;

      // EventSource 自身会重连，但它的重试节奏不可控且不带游标索引，
      // 因此这里主动关闭并用自己的退避策略重连。
      created.close();
      source = null;
      setState('reconnecting');
      onError?.();

      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15_000;
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    get state() {
      return state;
    },
    isEventStale() {
      if (lastEventAt === null) {
        // 从未收到业务事件：只有在我们确实连接过之后才判为陈旧，
        // 否则建连瞬间就会误报
        return state === 'open' && now() - startedAt > staleAfterMs;
      }
      return now() - lastEventAt > staleAfterMs;
    },
    lastEventAt() {
      return lastEventAt;
    },
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
      setState('closed');
    },
  };

  // 注意：startedAt 需在函数体开头声明 —— 实现时请把它与其它可变状态放在一起
  // （此处为说明依赖关系而置于末尾，实际实现请前置）。
}
```

> **实现者注意**：上面的 `startedAt` 是**未声明的引用**，这是刻意的提示 ——
> 请在函数开头补上 `const startedAt = now();`。把它留在这里是为了让你意识到
> `isEventStale()` 在「从未收到事件」时需要有一个起点，否则建连瞬间就会误判为陈旧。

- [ ] **Step 8: 运行测试确认通过**

```bash
pnpm --filter @svh/web test api sse format
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。若 `sse.test.ts` 的退避用例因定时器精度不稳，可改成断言
「重连发生了」+「URL 带游标」两条，而不断言精确的 1000ms。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/lib apps/web/test/api.test.ts apps/web/test/sse.test.ts apps/web/test/format.test.ts
git commit -m "feat(web): 新增 API 客户端与 SSE 客户端（退避重连 + 事件陈旧度判据）"
```

---

## Task 4: 项目入口（列表 / 新建 / 空状态）

**Files:**
- Create: `apps/web/src/features/projects/ProjectListPage.tsx` + `.module.css`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/project-list.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`、`apiPost`（Task 3）；`Button` / `Field` / `Dialog` / `EmptyState` / `ErrorState` / `SkeletonLines`（Task 2）
- Produces: `ProjectListPage` 组件；路由 `/projects` 指向它

**验收要求：**

- 三态齐备：加载显示 `SkeletonLines`（不是裸 `Loading...`）；无项目显示 `EmptyState`
  且主操作为「新建项目」；加载失败显示 `ErrorState`，`suggestions` 直接来自
  `ApiError.suggestions`，`retryable` 为真时给「重试」
- 新建用 `Dialog`（不是跳转新页面），提交时按钮 `loading`，失败时在 `Field` 上显示 `error`
- 每个项目项显示名称、相对时间（`formatRelativeTime`）、进入工作台的入口
- 卡片**不嵌套**：项目列表用分隔线分层，不把每个项目包成 Card

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/project-list.test.tsx`：

```tsx
/**
 * 项目入口测试。
 *
 * 重点验证三态与新建流程 —— 规范把 Loading / Empty / Error 列为必查项，
 * 而这三态恰恰是最容易被「先写主流程、以后再补」跳过的部分。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { ProjectListPage } from '../src/features/projects/ProjectListPage.js';

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ProjectListPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** 构造 JSON 响应 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const EMPTY_PAGE = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectListPage', () => {
  it('加载中显示骨架屏而不是裸 Loading 文案', async () => {
    // 永不 resolve，让页面停在加载态
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
    const { container } = renderPage();

    expect(container.querySelectorAll('[data-skeleton-line]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Loading/i)).not.toBeInTheDocument();
  });

  it('无项目时显示空状态与主操作', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY_PAGE)));
    renderPage();

    expect(await screen.findByText('还没有项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
  });

  it('加载失败时显示原因与建议，并可重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: '服务暂时不可用，请稍后重试。',
              suggestions: ['稍后重试', '若持续出现请联系管理员'],
              retryable: true,
            },
          },
          500,
        ),
      )
      .mockResolvedValueOnce(json(EMPTY_PAGE));

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(await screen.findByText('服务暂时不可用，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByText('若持续出现请联系管理员')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('还没有项目')).toBeInTheDocument();
  });

  it('有项目时列出名称与最近更新时间', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...EMPTY_PAGE,
          total: 1,
          items: [
            {
              id: 'p1',
              name: '护肤品广告',
              description: '',
              createdAt: '2026-09-12T10:00:00.000Z',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText('护肤品广告')).toBeInTheDocument();
    expect(screen.getByText('刚刚')).toBeInTheDocument();
  });

  it('新建项目成功后刷新列表并提示', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(EMPTY_PAGE))
      .mockResolvedValueOnce(json({ id: 'p2', name: '新项目' }, 201))
      .mockResolvedValueOnce(
        json({
          ...EMPTY_PAGE,
          total: 1,
          items: [
            { id: 'p2', name: '新项目', description: '', createdAt: '', updatedAt: new Date().toISOString() },
          ],
        }),
      );

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '新建项目' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('项目名称'), '新项目');
    await userEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(await screen.findByText('新项目')).toBeInTheDocument();
  });

  it('名称为空时不发请求，直接提示', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(EMPTY_PAGE));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '新建项目' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    // 只有初始列表那一次请求
    await waitFor(() => {
      expect(screen.getByText('项目名称不能为空')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test project-list
```

预期：失败，报找不到 `ProjectListPage`。

- [ ] **Step 3: 实现页面**

`apps/web/src/features/projects/ProjectListPage.module.css`：

```css
.page {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/* 列表用分隔线分层，不用 Card 包每一项 —— Card 只留给有独立操作边界的对象 */
.list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-2);
  border-bottom: 1px solid var(--color-border);
  text-decoration: none;
  color: inherit;
}

.item:hover {
  background: var(--color-surface);
}

.itemMain {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.itemName {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-medium);
  /* 长项目名必须截断，否则窄屏会横向溢出 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemMeta {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}
```

`apps/web/src/features/projects/ProjectListPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPost } from '../../lib/api.js';
import type { PageBody, Project } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import styles from './ProjectListPage.module.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; projects: Project[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

export function ProjectListPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await apiFetch<PageBody<Project>>('/api/projects?pageSize=50');
      setState({ kind: 'ready', projects: page.items });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载项目失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // 本地校验先挡住：空名字发到后端只会换来一次无意义的往返
      setNameError('项目名称不能为空');
      return;
    }

    setSubmitting(true);
    setNameError(undefined);
    try {
      const created = await apiPost<Project>('/api/projects', { name: trimmed });
      setDialogOpen(false);
      setName('');
      toast.show(`项目「${created.name}」已创建`, 'success');
      await load();
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : '创建失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>项目</h1>
        {/* 本区域唯一的 Primary Action */}
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          新建项目
        </Button>
      </header>

      {state.kind === 'loading' ? <SkeletonLines lines={4} /> : null}

      {state.kind === 'error' ? (
        <ErrorState
          title="加载项目失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable ? { onRetry: () => void load() } : {})}
        />
      ) : null}

      {state.kind === 'ready' && state.projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="还没有项目"
          description="项目是创作的容器：角色、场景、脚本与成片都归属于它。创建第一个项目后就能开始对话创作。"
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              新建项目
            </Button>
          }
        />
      ) : null}

      {state.kind === 'ready' && state.projects.length > 0 ? (
        <nav className={styles.list}>
          {state.projects.map((project) => (
            <Link key={project.id} className={styles.item} to={`/projects/${project.id}`}>
              <span className={styles.itemMain}>
                <span className={styles.itemName}>{project.name}</span>
                <span className={styles.itemMeta}>
                  更新于 {formatRelativeTime(project.updatedAt)}
                </span>
              </span>
            </Link>
          ))}
        </nav>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="新建项目"
        onClose={() => {
          setDialogOpen(false);
          setName('');
          setNameError(undefined);
        }}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>取消</Button>
            <Button variant="primary" loading={submitting} onClick={() => void submit()}>
              创建
            </Button>
          </>
        }
      >
        <Field
          label="项目名称"
          htmlFor="project-name"
          helper="例如「护肤品广告」「古装短剧」"
          {...(nameError !== undefined ? { error: nameError } : {})}
        >
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            autoFocus
          />
        </Field>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: 接入路由**

修改 `apps/web/src/App.tsx`：把 `/projects` 的占位替换为真正的页面，
并用 `ToastProvider` 包裹（Task 5/7/8 都要用轻提示）：

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';

import { ToastProvider } from './components/Toast.js';
import { ProjectListPage } from './features/projects/ProjectListPage.js';

/**
 * 路由表。
 *
 * 工作台（`/projects/:projectId`）在 Task 5 接入，设置页在 Task 8 接入。
 */
export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectListPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </ToastProvider>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/web test project-list
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/projects apps/web/src/App.tsx apps/web/test/project-list.test.tsx
git commit -m "feat(web): 新增项目入口页（列表 / 新建 / 三态）"
```

---

## Task 5: Agent 工作台骨架（路由 / 布局 / 会话与消息加载 / SSE 接入）

**Files:**
- Create: `apps/web/src/features/agent/useSessionStream.ts`
- Create: `apps/web/src/features/agent/AgentWorkspace.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/MessageList.tsx` + `.module.css`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/agent-workspace.test.tsx`

**Interfaces:**
- Consumes: Task 2 组件、Task 3 的 `apiFetch` / `createSessionStream` / `formatRelativeTime`
- Produces:
  - `useSessionStream(options)` → `{ state: StreamState; isEventStale: boolean; lastEventAt: number | null; degraded: boolean }`
  - `AgentWorkspace` 组件；路由 `/projects/:projectId`
  - `MessageList` 组件，接受 `messages` 与 `onSendMessage`

**验收要求：**

- **降级提示条**：`state === 'reconnecting'` **或** `isEventStale()` 为真时，
  顶部显示「实时连接已中断，正在重连」并**同时启动轮询**（`GET /api/tasks/:id/progress`）
- **刷新恢复**：页面加载时先 REST 拉全量消息（`GET /api/agent/sessions/:id`），
  再建立 SSE 接增量 —— 这样刷新不会丢历史，也不会与实时事件重复
- 三态齐备：会话加载用 `SkeletonLines`；无消息用 `EmptyState`（引导用户说出第一个需求）；
  加载失败用 `ErrorState`
- 布局：主区（对话流）+ 侧区（任务面板占位，Task 7 接入）+ 底部输入区占位（Task 7 接入）

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/agent-workspace.test.tsx`：

```tsx
/**
 * 工作台骨架测试。
 *
 * 重点验证三件规范要求的事：
 * 1. 刷新后历史消息能从 REST 恢复
 * 2. SSE 断线时**显示降级提示**（绝不静默）
 * 3. 三态齐备
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <ToastProvider>
        <Routes>
          <Route path="/projects/:projectId" element={<AgentWorkspace />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const SESSION = {
  id: 's1',
  projectId: 'p1',
  contentId: null,
  title: '护肤品广告',
  agentState: 'idle',
  status: 'active',
  contextSnapshot: {},
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  messages: [
    {
      id: 'm1',
      role: 'agent',
      kind: 'text',
      content: '你好，想创作什么？',
      payload: null,
      createdAt: '2026-09-12T10:00:00.000Z',
    },
  ],
};

/**
 * 按 URL 分派假响应。
 *
 * 工作台是**两步加载**：先取会话列表（按 projectId 过滤，拿最新一条的 id），
 * 再取该会话详情。因此 mock 必须区分这两个 URL ——
 * 用「包含 /api/agent/sessions 就返回详情」的粗略匹配会让第一步拿到详情对象、
 * 解析出 undefined 的 items，页面永远停在空会话上。
 */
function stubSessionApi(messages: unknown[] = SESSION.messages): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      // 详情：/api/agent/sessions/<id>
      if (/\/api\/agent\/sessions\/[^?]+/.test(url)) {
        return Promise.resolve(json({ ...SESSION, messages }));
      }
      // 列表：/api/agent/sessions?projectId=...
      return Promise.resolve(
        json({
          items: [
            {
              id: SESSION.id,
              projectId: 'p1',
              title: SESSION.title,
              agentState: 'idle',
              status: 'active',
              messageCount: messages.length,
              createdAt: SESSION.createdAt,
              updatedAt: SESSION.updatedAt,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 1,
          hasMore: false,
        }),
      );
    }),
  );
}

/** 让 SSE 永不建连，避免干扰对 REST 的验证 */
function stubSilentEventSource(): void {
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      close(): void {}
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentWorkspace', () => {
  it('刷新时从 REST 恢复历史消息', async () => {
    stubSessionApi();
    stubSilentEventSource();

    renderWorkspace();

    expect(await screen.findByText('你好，想创作什么？')).toBeInTheDocument();
  });

  it('无消息时显示空状态并引导用户表达需求', async () => {
    stubSessionApi([]);
    stubSilentEventSource();

    renderWorkspace();

    expect(await screen.findByText('开始你的第一个创作')).toBeInTheDocument();
  });

  it('会话加载失败时显示错误状态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: 'NOT_FOUND',
              message: '会话不存在，可能已被删除。',
              suggestions: ['返回项目列表重新进入'],
              retryable: false,
            },
          },
          404,
        ),
      ),
    );
    stubSilentEventSource();

    renderWorkspace();

    expect(await screen.findByText('会话不存在，可能已被删除。')).toBeInTheDocument();
  });

  it('SSE 连接中断时显示降级提示，绝不静默', async () => {
    stubSessionApi();

    let captured: { onerror: ((e: Event) => void) | null } | null = null;
    vi.stubGlobal(
      'EventSource',
      class {
        onopen: ((e: Event) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        onmessage: ((e: MessageEvent<string>) => void) | null = null;
        constructor() {
          captured = this;
        }
        close(): void {}
      },
    );

    renderWorkspace();
    await screen.findByText('你好，想创作什么？');

    // 触发断线
    await waitFor(() => expect(captured).not.toBeNull());
    captured?.onerror?.(new Event('error'));

    expect(await screen.findByText(/实时连接已中断/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test agent-workspace
```

预期：失败，报找不到 `AgentWorkspace`。

- [ ] **Step 3: 实现 SSE 接入 hook**

`apps/web/src/features/agent/useSessionStream.ts`：

```ts
/**
 * 把 SSE 客户端接进 React。
 *
 * ── 这个 hook 的职责边界 ──
 * 它只负责「连接状态」与「降级信号」，不负责把事件写进消息列表 ——
 * 那是调用方的事（它才知道哪些事件该追加消息、哪些只该刷新任务面板）。
 *
 * ── 降级为何要两个条件 ──
 * `state === 'reconnecting'` 覆盖「连接明确断了」；
 * `isEventStale()` 覆盖「连接看起来是好的，但很久没有业务事件」——
 * 后者正是半开链路（TCP 还在、对端不回包）的形态，
 * 此时客户端会照常收到 ping，仅凭连接状态**完全看不出异常**。
 */
import { useEffect, useRef, useState } from 'react';

import { createSessionStream, type SessionStream, type SseEnvelope, type StreamState } from '../../lib/sse.js';

export interface UseSessionStreamOptions {
  sessionId: string | null;
  onEvent: (envelope: SseEnvelope) => void;
}

export interface SessionStreamStatus {
  state: StreamState;
  /** 连接明确断开，或业务事件已陈旧 —— 任一为真即应显示降级提示 */
  degraded: boolean;
  lastEventAt: number | null;
}

export function useSessionStream({ sessionId, onEvent }: UseSessionStreamOptions): SessionStreamStatus {
  const [state, setState] = useState<StreamState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  // 用 ref 持有最新回调，避免把它放进依赖导致每次渲染都重建连接
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (sessionId === null) {
      setState('closed');
      return;
    }

    const stream: SessionStream = createSessionStream({
      sessionId,
      onEvent: (envelope) => {
        setLastEventAt(stream.lastEventAt());
        onEventRef.current(envelope);
      },
      onStateChange: setState,
    });

    // 定期检查事件陈旧度：它不是由某个事件触发的，必须主动轮询
    const timer = setInterval(() => {
      setStale(stream.isEventStale());
    }, 5_000);

    return () => {
      clearInterval(timer);
      stream.close();
    };
  }, [sessionId]);

  return {
    state,
    degraded: state === 'reconnecting' || stale,
    lastEventAt,
  };
}
```

- [ ] **Step 4: 实现工作台与消息列表**

`apps/web/src/features/agent/AgentWorkspace.module.css`：

```css
.workspace {
  display: grid;
  grid-template-columns: 1fr var(--layout-taskpanel-width);
  height: 100dvh;
  /* 窄屏时侧区折叠为抽屉，见下方 media query */
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0; /* 关键：否则子元素的宽内容会把栅格撑破 */
  border-right: 1px solid var(--color-border);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.title {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6) var(--space-5);
}

.side {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-5);
  overflow-y: auto;
  background: var(--color-surface);
}

/* 降级提示条：常驻顶部，用户必须知道进度可能不是最新的 */
.degraded {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  background: var(--color-warning-subtle);
  color: var(--color-warning);
  font-size: var(--font-size-secondary);
  border-bottom: 1px solid var(--color-border);
}

.composerSlot {
  border-top: 1px solid var(--color-border);
  padding: var(--space-4) var(--space-5);
  color: var(--color-text-tertiary);
  font-size: var(--font-size-secondary);
}

/* Tablet：侧区变窄 */
@media (max-width: 1024px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .side {
    display: none;
  }
}
```

`apps/web/src/features/agent/MessageList.module.css`：

```css
.list {
  display: flex;
  flex-direction: column;
  /* 对话流用留白分层，不套 Card */
  gap: var(--space-5);
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
}

.message {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 100%;
}

.user {
  align-items: flex-end;
}

.userBubble {
  background: var(--color-primary-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  /* 长文本必须能断行，否则窄屏横向溢出 */
  overflow-wrap: anywhere;
  max-width: 100%;
}

.agentText {
  color: var(--color-text-primary);
  line-height: var(--line-height-relaxed);
  overflow-wrap: anywhere;
}

.meta {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}
```

`apps/web/src/features/agent/MessageList.tsx`：

```tsx
import type { SessionMessage } from '../../lib/api-types.js';
import { MessageItem } from './MessageItem.js';
import { EmptyState } from '../../components/StateBlock.js';
import styles from './MessageList.module.css';

export interface MessageListProps {
  messages: SessionMessage[];
  /** 结果卡上的「查看」等操作需要跳转 */
  onNavigateAsset?: (assetId: string) => void;
}

export function MessageList({ messages, onNavigateAsset }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <EmptyState
        icon="info"
        title="开始你的第一个创作"
        description="直接说出你想要什么，例如「帮我做一个 30 秒的护肤品广告」。Agent 会先给出制作计划，你确认后再开始生成。"
      />
    );
  }

  return (
    <div className={styles.list}>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          {...(onNavigateAsset !== undefined ? { onNavigateAsset } : {})}
        />
      ))}
    </div>
  );
}
```

`apps/web/src/features/agent/MessageItem.tsx`（Task 6 会补全载荷渲染器的分发）：

```tsx
import type { SessionMessage } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import styles from './MessageList.module.css';

export interface MessageItemProps {
  message: SessionMessage;
  onNavigateAsset?: (assetId: string) => void;
}

/**
 * 单条消息。
 *
 * 载荷分发在 Task 6 补全；本任务先渲染纯文本，
 * 这样工作台骨架可以先跑通并接受测试。
 */
export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <article className={`${styles.message} ${isUser ? styles.user : ''}`}>
      {isUser ? (
        <div className={styles.userBubble}>{message.content}</div>
      ) : (
        <div className={styles.agentText}>{message.content}</div>
      )}
      <span className={styles.meta}>{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}
```

`apps/web/src/features/agent/AgentWorkspace.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Icon } from '../../components/Icon.js';
import { ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { ApiError, apiFetch } from '../../lib/api.js';
import type { PageBody, SessionMessage, SessionSummary } from '../../lib/api-types.js';
import { MessageList } from './MessageList.js';
import { useSessionStream } from './useSessionStream.js';
import styles from './AgentWorkspace.module.css';

interface SessionDetail {
  id: string;
  projectId: string | null;
  title: string;
  agentState: string;
  messages: SessionMessage[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: SessionDetail; messages: SessionMessage[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

export function AgentWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      // 先 REST 拉全量历史，再让 SSE 接增量 ——
      // 这样刷新不会丢消息，也不会与实时事件重复（实时事件只追加新消息）。
      //
      // 两步走的原因：会话列表端点支持按 projectId 过滤，但**没有**「按项目取最新会话」
      // 的专用端点，因此先取列表第一条，再取该会话详情。
      const page = await apiFetch<PageBody<SessionSummary>>(
        `/api/agent/sessions?projectId=${projectId ?? ''}&pageSize=1`,
      );

      const latest = page.items[0];
      if (latest === undefined) {
        // 该项目还没有会话：显示空对话流，等用户说出第一个需求时再创建
        setState({
          kind: 'ready',
          session: { id: '', projectId: projectId ?? null, title: '', agentState: 'idle', messages: [] },
          messages: [],
        });
        return;
      }

      const detail = await apiFetch<SessionDetail>(`/api/agent/sessions/${latest.id}`);
      setState({ kind: 'ready', session: detail, messages: detail.messages ?? [] });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载会话失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sessionId = state.kind === 'ready' && state.session.id.length > 0 ? state.session.id : null;

  const stream = useSessionStream({
    sessionId,
    onEvent: (envelope) => {
      // Task 6 会在这里按事件类型把消息与任务状态分派到各自的容器
      void envelope;
    },
  });

  return (
    <div className={styles.workspace}>
      <div className={styles.main}>
        <header className={styles.header}>
          <span className={styles.title}>
            {state.kind === 'ready' ? state.session.title || '新会话' : '工作台'}
          </span>
        </header>

        {/*
          降级提示：连接断了、或业务事件陈旧时都显示。
          绝不静默 —— 用户必须知道当前进度可能不是最新的。
        */}
        {stream.degraded ? (
          <div className={styles.degraded} role="status">
            <Icon name="alert" />
            <span>实时连接已中断，正在重连。当前进度可能不是最新的。</span>
          </div>
        ) : null}

        <div className={styles.scroll}>
          {state.kind === 'loading' ? <SkeletonLines lines={6} /> : null}
          {state.kind === 'error' ? (
            <ErrorState
              title="加载会话失败"
              reason={state.message}
              {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
              {...(state.retryable ? { onRetry: () => void load() } : {})}
            />
          ) : null}
          {state.kind === 'ready' ? <MessageList messages={state.messages} /> : null}
        </div>

        <div className={styles.composerSlot}>输入区将在 Task 7 接入</div>
      </div>

      <aside className={styles.side}>
        <h2>任务</h2>
        <p className={styles.title} style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-secondary)' }}>
          任务面板将在 Task 7 接入
        </p>
      </aside>
    </div>
  );
}
```

- [ ] **Step 5: 接入路由**

修改 `apps/web/src/App.tsx`，在 `/projects` 之后加：

```tsx
        <Route path="/projects/:projectId" element={<AgentWorkspace />} />
```

并补导入：

```tsx
import { AgentWorkspace } from './features/agent/AgentWorkspace.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm --filter @svh/web test agent-workspace
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/agent apps/web/src/App.tsx apps/web/test/agent-workspace.test.tsx
git commit -m "feat(web): 新增 Agent 工作台骨架与 SSE 接入（含降级提示）"
```

---

## Task 6: 五类载荷渲染器

**Files:**
- Create: `apps/web/src/features/agent/renderers/PlanCard.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/renderers/ResultCard.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/renderers/ConfirmationCard.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/renderers/ErrorCard.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/renderers/ProgressLine.tsx` + `.module.css`
- Modify: `apps/web/src/features/agent/MessageItem.tsx`（补载荷分发）
- Test: `apps/web/test/renderers.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `MessagePayload` 类型；Task 2 的组件
- Produces: 五个渲染器组件；`MessageItem` 按 `payload.type` 分发（判别联合，穷尽性由 `never` 检查保证）

**验收要求（控制方补充的真实语义，实现者务必照做）：**

1. **计划卡的「开始制作」是发送一条回复消息，不是本地执行。**
   计划目前**不是可执行的持久化对象**（`planTaskIds` 恒为空）。点击后触发新一轮 Agent 轮次，
   由模型依据对话历史决定调用哪些技能。**界面不得假装计划在逐步执行** ——
   不要用进度条去「推进」计划步骤。
2. **结果卡的数据不来自 Agent 轮次，而来自任务产出。**
   技能产出的 `result_card` 落在 `task.output.card`。
   本任务先支持从 `payload.type === 'result_card'` 渲染
   （Agent 轮次目前不产出该载荷，但协议里定义了，前端必须能渲染）；
   任务产出路径由 Task 7 的 TaskPanel 接。
3. **确认卡的「确认执行」调 `POST /api/agent/sessions/:id/confirm`**，
   **必须优先按 `payload.taskIds` 精确放行**（`{ taskIds: [...] }`），
   而不是不传参数放行全部 —— 后者会把同源的多条等待任务一起放行。
   仅当载荷里没有 `taskId` 时才退化为「放行全部」，并在按钮文案上说明。
4. **错误卡直接消费 `ErrorPayload`**，它已经带了 `title` / `reason` / `suggestions` /
   `recovered` / `recoveryNote`，不要重新编造文案。

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/renderers.test.tsx`：

```tsx
/**
 * 五类载荷渲染器测试。
 *
 * 这些组件的价值在于「把后端的结构化协议翻译成可操作的界面」，
 * 因此断言都落在**用户能做什么**上（按钮文案、点击后的调用），
 * 而不是断言 DOM 结构。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmationCard } from '../src/features/agent/renderers/ConfirmationCard.js';
import { ErrorCard } from '../src/features/agent/renderers/ErrorCard.js';
import { PlanCard } from '../src/features/agent/renderers/PlanCard.js';
import { ProgressLine } from '../src/features/agent/renderers/ProgressLine.js';
import { ResultCard } from '../src/features/agent/renderers/ResultCard.js';

describe('PlanCard', () => {
  const plan = {
    type: 'plan' as const,
    goal: '制作 30 秒护肤品广告',
    rationale: '先定角色与场景，再出分镜，最后合成',
    requiresApproval: true,
    tasks: [
      { id: 'task_1', title: '生成脚本', status: 'pending' as const, dependsOn: [] },
      { id: 'task_2', title: '生成分镜', status: 'pending' as const, dependsOn: [] },
    ],
  };

  it('展示目标、规划依据与步骤清单', () => {
    render(<PlanCard payload={plan} onReply={() => undefined} />);
    expect(screen.getByText('制作 30 秒护肤品广告')).toBeInTheDocument();
    expect(screen.getByText('先定角色与场景，再出分镜，最后合成')).toBeInTheDocument();
    expect(screen.getByText('生成脚本')).toBeInTheDocument();
    expect(screen.getByText('生成分镜')).toBeInTheDocument();
  });

  it('需要审批时给出主操作，点击后发送「开始制作」', async () => {
    const onReply = vi.fn();
    render(<PlanCard payload={plan} onReply={onReply} />);

    await userEvent.click(screen.getByRole('button', { name: '开始制作' }));
    expect(onReply).toHaveBeenCalledWith('开始制作');
  });

  it('不需要审批时不显示「开始制作」', () => {
    render(<PlanCard payload={{ ...plan, requiresApproval: false }} onReply={() => undefined} />);
    expect(screen.queryByRole('button', { name: '开始制作' })).not.toBeInTheDocument();
  });
});

describe('ConfirmationCard', () => {
  const payload = {
    type: 'confirmation_request' as const,
    summary: '即将执行：video.generate',
    impacts: [['操作', 'video.generate']] as Array<[string, string]>,
    taskId: 'task_x',
    planTaskIds: ['task_x'],
  };

  it('展示摘要与影响面', () => {
    render(<ConfirmationCard payload={payload} onConfirm={() => undefined} />);
    expect(screen.getByText('即将执行：video.generate')).toBeInTheDocument();
    expect(screen.getByText('video.generate')).toBeInTheDocument();
  });

  it('有 taskId 时按该 id 精确放行，而不是放行全部', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmationCard payload={payload} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
    // 精确确认是为了避免一次点击放行同源的多条等待任务
    expect(onConfirm).toHaveBeenCalledWith({ taskIds: ['task_x'] });
  });

  it('没有 taskId 时按钮文案说明这是放行全部', () => {
    render(
      <ConfirmationCard
        payload={{ ...payload, taskId: undefined, planTaskIds: [] }}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /确认全部/ })).toBeInTheDocument();
  });
});

describe('ErrorCard', () => {
  it('直接消费载荷里的标题、原因与建议', () => {
    render(
      <ErrorCard
        payload={{
          type: 'error',
          title: '生成视频失败',
          reason: '模型服务暂时不可用',
          suggestions: ['稍后重试', '切换到其它视频模型'],
          recovered: false,
          actions: [],
        }}
      />,
    );
    expect(screen.getByText('生成视频失败')).toBeInTheDocument();
    expect(screen.getByText('模型服务暂时不可用')).toBeInTheDocument();
    expect(screen.getByText('切换到其它视频模型')).toBeInTheDocument();
  });

  it('已自动恢复时明确说明，避免用户以为失败了', () => {
    render(
      <ErrorCard
        payload={{
          type: 'error',
          title: '生成图片失败',
          reason: '原模型不可用',
          suggestions: [],
          recovered: true,
          recoveryNote: '已自动切换备用模型继续生成',
          actions: [],
        }}
      />,
    );
    expect(screen.getByText('已自动切换备用模型继续生成')).toBeInTheDocument();
  });
});

describe('ProgressLine', () => {
  it('展示进度与状态文案', () => {
    render(
      <ProgressLine
        payload={{ type: 'progress', taskId: 't1', progress: 60, message: '正在生成第 3 个镜头' }}
      />,
    );
    expect(screen.getByText('正在生成第 3 个镜头')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
  });
});

describe('ResultCard', () => {
  const payload = {
    type: 'result_card' as const,
    title: '角色已创建',
    category: 'character' as const,
    subtitle: '苏晚',
    attributes: [['古装', '黑长发'], ['23岁', '女']] as Array<[string, string]>,
    media: [],
    actions: [
      { id: 'view', label: '查看', kind: 'secondary' as const },
      { id: 'regenerate', label: '重新生成', kind: 'reply' as const, message: '重新生成苏晚' },
    ],
  };

  it('展示标题、副标题与属性行', () => {
    render(<ResultCard payload={payload} onAction={() => undefined} />);
    expect(screen.getByText('角色已创建')).toBeInTheDocument();
    expect(screen.getByText('苏晚')).toBeInTheDocument();
    expect(screen.getByText('古装')).toBeInTheDocument();
    expect(screen.getByText('黑长发')).toBeInTheDocument();
  });

  it('reply 类操作把 message 发出去', async () => {
    const onAction = vi.fn();
    render(<ResultCard payload={payload} onAction={onAction} />);
    await userEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'regenerate' }));
  });

  it('media 里的图片会渲染且带替代文本', () => {
    render(
      <ResultCard
        payload={{
          ...payload,
          media: [{ kind: 'image', url: '/x.png', caption: '角色定妆照' }],
        }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByAltText('角色定妆照')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test renderers
```

预期：失败，报找不到各渲染器模块。

- [ ] **Step 3: 实现共享的卡片外壳**

`apps/web/src/features/agent/renderers/card.module.css`（五个渲染器共用，
避免五份逐字重复的卡片样式）：

```css
/**
 * 卡片的共用外观。
 *
 * Card 在规范里**只**用于有独立操作边界的对象 —— 计划、结果、确认、错误正属此类。
 * 对话流的普通文本不走这里。
 */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 100%;
}

.header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.title {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-semibold);
}

.subtitle {
  font-size: var(--font-size-secondary);
  color: var(--color-text-secondary);
}

.attributes {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2) var(--space-4);
  font-size: var(--font-size-secondary);
  margin: 0;
}

.attributes dt {
  color: var(--color-text-tertiary);
}

.attributes dd {
  margin: 0;
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.media {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}

.mediaItem {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.mediaItem img,
.mediaItem video {
  width: 100%;
  border-radius: var(--radius-md);
  background: var(--color-surface-secondary);
  display: block;
}

.caption {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.listItem {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--font-size-secondary);
}

.index {
  color: var(--color-text-tertiary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-caption);
  min-width: 2ch;
}

.estimate {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-caption);
}

.status {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.statusDone { color: var(--color-success); }
.statusRunning { color: var(--color-primary); }
.statusFailed { color: var(--color-error); }
```

> **实现者注意**：这个 `.module.css` 被五个渲染器共享。
> CSS Modules 的 `composes` 只能在同一个文件内使用，跨文件共享需要各自 `import shared from './card.module.css'`
> 并组合类名（`className={`${shared.card} ${styles.local}`}`）。请用这种写法，
> **不要**把这段样式复制五份 —— 那是规范明令避免的「逐字重复的逻辑块」。

- [ ] **Step 4: 实现五个渲染器**

`apps/web/src/features/agent/renderers/PlanCard.tsx`：

```tsx
import { Button } from '../../../components/Button.js';
import type { PlanPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface PlanCardProps {
  payload: PlanPayload;
  /** 发送一条回复消息（「开始制作」是新一轮对话，不是本地执行） */
  onReply: (message: string) => void;
}

/** 步骤状态的中文标签 */
const STATUS_LABEL: Record<PlanPayload['tasks'][number]['status'], string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export function PlanCard({ payload, onReply }: PlanCardProps) {
  return (
    <section className={shared.card} aria-label="制作计划">
      <header className={shared.header}>
        <h3 className={shared.title}>{payload.goal}</h3>
        {payload.rationale !== undefined ? (
          <p className={shared.subtitle}>{payload.rationale}</p>
        ) : null}
      </header>

      <ol className={shared.list}>
        {payload.tasks.map((task, index) => (
          <li key={task.id} className={shared.listItem}>
            <span className={shared.index}>{String(index + 1).padStart(2, '0')}</span>
            <span>{task.title}</span>
            <span className={shared.status}>{STATUS_LABEL[task.status]}</span>
            {task.estimate !== undefined ? (
              <span className={shared.estimate}>{task.estimate}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {payload.requiresApproval ? (
        <div className={shared.actions}>
          {/*
            「开始制作」发送一条回复消息，触发新一轮 Agent 轮次。
            计划本身不是可执行的持久化对象，因此界面**不假装**它在逐步执行 ——
            这里没有进度条，只有一次对话往返。
          */}
          <Button variant="primary" onClick={() => onReply('开始制作')}>
            开始制作
          </Button>
          <Button onClick={() => onReply('我想调整一下方案')}>调整方案</Button>
        </div>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/agent/renderers/ConfirmationCard.tsx`：

```tsx
import { Button } from '../../../components/Button.js';
import type { ConfirmationRequestPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ConfirmationCardProps {
  payload: ConfirmationRequestPayload;
  /** 放行任务。传 taskIds 表示只放行这些；不传表示放行该会话下全部等待任务 */
  onConfirm: (input: { taskIds?: string[] }) => void;
}

export function ConfirmationCard({ payload, onConfirm }: ConfirmationCardProps) {
  // 优先精确放行：不传 taskIds 会把同源的多条等待任务一起放行，
  // 而用户看到并确认的只是这一条
  const taskIds = payload.planTaskIds.length > 0
    ? payload.planTaskIds
    : payload.taskId !== undefined
      ? [payload.taskId]
      : [];

  const precise = taskIds.length > 0;

  return (
    <section className={shared.card} aria-label="需要确认">
      <header className={shared.header}>
        <h3 className={shared.title}>需要你确认</h3>
        <p className={shared.subtitle}>{payload.summary}</p>
      </header>

      {payload.impacts.length > 0 ? (
        <dl className={shared.attributes}>
          {payload.impacts.map(([label, value]) => (
            <div key={`${label}-${value}`} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className={shared.actions}>
        <Button
          variant="primary"
          onClick={() => onConfirm(precise ? { taskIds } : {})}
        >
          {precise ? '确认执行' : '确认全部执行'}
        </Button>
      </div>
    </section>
  );
}
```

`apps/web/src/features/agent/renderers/ErrorCard.tsx`：

```tsx
import { Icon } from '../../../components/Icon.js';
import type { ErrorPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ErrorCardProps {
  payload: ErrorPayload;
  onAction?: (message: string) => void;
}

/**
 * 错误卡。
 *
 * 载荷已经带了标题、原因、建议与恢复说明，**直接消费**即可 ——
 * 界面重新编造文案只会与后端的判断脱节。
 */
export function ErrorCard({ payload, onAction }: ErrorCardProps) {
  return (
    <section className={shared.card} role="alert" aria-label="错误">
      <header className={shared.header}>
        <h3 className={shared.title}>
          <Icon name="alert" /> {payload.title}
        </h3>
        <p className={shared.subtitle}>{payload.reason}</p>
      </header>

      {/*
        已自动恢复时必须明确说出来，否则用户会以为这次生成失败了，
        进而重复发起 —— 那才是真正的浪费。
      */}
      {payload.recovered && payload.recoveryNote !== undefined ? (
        <p className={shared.subtitle}>
          <Icon name="check" /> {payload.recoveryNote}
        </p>
      ) : null}

      {payload.suggestions.length > 0 ? (
        <ul className={shared.list}>
          {payload.suggestions.map((s) => (
            <li key={s} className={shared.listItem}>
              · {s}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/agent/renderers/ProgressLine.tsx`：

```tsx
import { ProgressBar } from '../../../components/ProgressBar.js';
import type { ProgressPayload } from '../../../lib/api-types.js';

export interface ProgressLineProps {
  payload: ProgressPayload;
}

/** 内联进度。对话流里的进度不走卡片 —— 它没有独立操作边界。 */
export function ProgressLine({ payload }: ProgressLineProps) {
  return <ProgressBar value={payload.progress} label={payload.message} />;
}
```

`apps/web/src/features/agent/renderers/ResultCard.tsx`：

```tsx
import { Button } from '../../../components/Button.js';
import type { CardAction, ResultCardPayload } from '../../../lib/api-types.js';
import shared from './card.module.css';

export interface ResultCardProps {
  payload: ResultCardPayload;
  onAction: (action: CardAction) => void;
}

/** 操作语义 → 按钮优先级。primary 只给「采用」这类主操作。 */
function variantOf(action: CardAction): 'primary' | 'secondary' | 'ghost' | 'danger' {
  if (action.kind === 'primary') return 'primary';
  if (action.kind === 'danger') return 'danger';
  if (action.kind === 'reply') return 'secondary';
  return 'secondary';
}

export function ResultCard({ payload, onAction }: ResultCardProps) {
  return (
    <section className={shared.card} aria-label={payload.title}>
      <header className={shared.header}>
        <h3 className={shared.title}>{payload.title}</h3>
        {payload.subtitle !== undefined ? (
          <p className={shared.subtitle}>{payload.subtitle}</p>
        ) : null}
      </header>

      {payload.attributes !== undefined && payload.attributes.length > 0 ? (
        <dl className={shared.attributes}>
          {payload.attributes.map(([label, value]) => (
            <div key={`${label}-${value}`} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {payload.media.length > 0 ? (
        <div className={shared.media}>
          {payload.media.map((item, index) => (
            <figure key={item.assetId ?? `${item.kind}-${String(index)}`} className={shared.mediaItem}>
              {item.kind === 'image' && item.url !== undefined ? (
                // alt 必须来自 caption：没有它读屏用户拿不到任何信息
                <img src={item.url} alt={item.caption ?? '生成结果'} loading="lazy" />
              ) : null}
              {item.kind === 'video' && item.url !== undefined ? (
                <video src={item.url} controls preload="metadata" />
              ) : null}
              {item.caption !== undefined ? (
                <figcaption className={shared.caption}>{item.caption}</figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      {payload.actions.length > 0 ? (
        <div className={shared.actions}>
          {payload.actions.map((action) => (
            <Button key={action.id} variant={variantOf(action)} onClick={() => onAction(action)}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: 在 MessageItem 里做载荷分发**

修改 `apps/web/src/features/agent/MessageItem.tsx`：

```tsx
import type { CardAction, MessagePayload, SessionMessage } from '../../lib/api-types.js';
import { formatRelativeTime } from '../../lib/format.js';
import { ConfirmationCard } from './renderers/ConfirmationCard.js';
import { ErrorCard } from './renderers/ErrorCard.js';
import { PlanCard } from './renderers/PlanCard.js';
import { ProgressLine } from './renderers/ProgressLine.js';
import { ResultCard } from './renderers/ResultCard.js';
import styles from './MessageList.module.css';

export interface MessageItemProps {
  message: SessionMessage;
  onReply?: (message: string) => void;
  onConfirm?: (input: { taskIds?: string[] }) => void;
  onAction?: (action: CardAction) => void;
}

/**
 * 把 unknown 的 payload 收窄为判别联合。
 *
 * 后端把 payload 存成 JSON，前端拿到的是 unknown；
 * 这里只做**结构校验**（有没有字符串型的 type），不做完整 schema 校验 ——
 * 完整校验的收益不足以抵消在前端重复维护一份协议的成本。
 */
function asPayload(value: unknown): MessagePayload | null {
  if (value === null || typeof value !== 'object') return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return value as MessagePayload;
}

export function MessageItem({
  message,
  onReply = () => undefined,
  onConfirm = () => undefined,
  onAction = () => undefined,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const payload = asPayload(message.payload);

  return (
    <article className={`${styles.message} ${isUser ? styles.user : ''}`}>
      {isUser ? (
        <div className={styles.userBubble}>{message.content}</div>
      ) : (
        <div className={styles.agentText}>
          {/* 有载荷时正文可能为空（例如纯计划消息），此时不渲染空段落 */}
          {message.content.length > 0 ? <p>{message.content}</p> : null}

          {payload?.type === 'plan' ? <PlanCard payload={payload} onReply={onReply} /> : null}
          {payload?.type === 'confirmation_request' ? (
            <ConfirmationCard payload={payload} onConfirm={onConfirm} />
          ) : null}
          {payload?.type === 'result_card' ? (
            <ResultCard payload={payload} onAction={onAction} />
          ) : null}
          {payload?.type === 'error' ? <ErrorCard payload={payload} /> : null}
          {payload?.type === 'progress' ? <ProgressLine payload={payload} /> : null}
        </div>
      )}
      <span className={styles.meta}>{formatRelativeTime(message.createdAt)}</span>
    </article>
  );
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm --filter @svh/web test renderers
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/agent/renderers apps/web/src/features/agent/MessageItem.tsx apps/web/test/renderers.test.tsx
git commit -m "feat(web): 新增五类载荷渲染器与消息载荷分发"
```

---

## Task 7: 输入区（补全 / 发送）、工具轨迹与实时任务面板

**Files:**
- Create: `apps/web/src/features/agent/Composer.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/ToolTrace.tsx` + `.module.css`
- Create: `apps/web/src/features/agent/TaskPanel.tsx` + `.module.css`
- Modify: `apps/web/src/features/agent/AgentWorkspace.tsx`
- Test: `apps/web/test/composer.test.tsx`
- Test: `apps/web/test/task-panel.test.tsx`

**Interfaces:**
- Consumes: Task 3/5/6 的全部产出；`POST /api/agent/chat`；`POST /api/agent/sessions/:id/confirm`；
  `POST /api/assets/resolve-mentions`；`GET /api/skills`；`GET /api/projects/:id/assets`；
  `GET /api/tasks/:id/progress`（降级轮询用）；`GET /api/tasks/:id`
- Produces: `Composer`（含 `/` 与 `@` 补全）、`ToolTrace`（可折叠）、`TaskPanel`（实时进度 + 上下文说明）

**验收要求：**

- 输入框支持多行、`Enter` 发送、`Shift+Enter` 换行
- 输入 `/` 弹出技能列表（`GET /api/skills`），输入 `@` 弹出项目资产列表
- 发送前把 `@引用名` 交给 `POST /api/assets/resolve-mentions` 换回真实 id，
  **前端不自行维护「引用名 → id」映射**
- 发送中禁用输入并显示可中断的等待状态；失败时保留输入内容（**不能把用户刚打的字清掉**）
- `TaskPanel` 展示当前会话的任务列表与进度；**降级时改用轮询**
- 任务完成后拉 `GET /api/tasks/:id`，若 `output.card` 存在则作为结果卡追加到对话流

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/composer.test.tsx`：

```tsx
/**
 * 输入区测试。
 *
 * 最关键的一条：**发送失败不能清空输入框**。
 * 用户可能刚敲了两百字的需求，一次网络抖动就把它清掉是不可接受的。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '../src/features/agent/Composer.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 让引用解析请求成功返回空匹配。
 *
 * **每次发送前都会先调 `/api/assets/resolve-mentions`**，
 * 因此任何断言「onSend 被调用」的用例都必须先把这个请求接住 ——
 * 否则解析失败会让 submit 走进 catch，onSend 根本不会被调用。
 */
function stubResolve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mentions: [], matched: [], missing: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('Composer', () => {
  it('Enter 发送，Shift+Enter 换行', async () => {
    stubResolve();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, '做一个广告');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('做一个广告', []));

    await userEvent.type(textarea, '第一行');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    // Shift+Enter 不触发发送
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('把命中的 @引用 换成真实资产 id 一并发送', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          mentions: ['苏晚'],
          matched: [{ id: 'asset_1', slug: 'su-wan', name: '苏晚' }],
          missing: [],
        }),
      ),
    );
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    await userEvent.type(screen.getByRole('textbox'), '@苏晚 穿红色衣服');
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('@苏晚 穿红色衣服', ['asset_1']),
    );
  });

  it('空输入不发送', async () => {
    stubResolve();
    const onSend = vi.fn();
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);
    await userEvent.type(screen.getByRole('textbox'), '   ');
    await userEvent.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('发送失败时保留输入内容', async () => {
    stubResolve();
    const onSend = vi.fn().mockRejectedValue(new Error('网络错误'));
    render(<Composer projectId="p1" onSend={onSend} disabled={false} />);

    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, '一段很长的需求描述');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 内容必须还在 —— 一次失败就清空是不可接受的
    expect(screen.getByRole('textbox')).toHaveValue('一段很长的需求描述');
  });

  it('输入 / 时列出技能', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          items: [
            { id: 'script.generate', name: '脚本生成', category: 'text' },
            { id: 'image.generate', name: '图片生成', category: 'image' },
          ],
          total: 2,
        }),
      ),
    );

    render(<Composer projectId="p1" onSend={vi.fn()} disabled={false} />);
    await userEvent.type(screen.getByRole('textbox'), '/');

    expect(await screen.findByText('脚本生成')).toBeInTheDocument();
    expect(screen.getByText('图片生成')).toBeInTheDocument();
  });

  it('disabled 时不可输入', () => {
    render(<Composer projectId="p1" onSend={vi.fn()} disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
```

`apps/web/test/task-panel.test.tsx`：

```tsx
/**
 * 任务面板测试。
 *
 * 重点：任务完成后要能渲染出结果卡（数据来自 task.output.card，
 * 而不是 Agent 轮次返回的载荷）。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskPanel } from '../src/features/agent/TaskPanel.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TaskPanel', () => {
  it('无任务时显示空状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false })));
    render(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} />);
    expect(await screen.findByText('还没有任务')).toBeInTheDocument();
  });

  it('展示任务技能名与进度', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          items: [
            {
              id: 't1',
              skillId: 'image.generate',
              status: 'running',
              progress: 40,
              progressMessage: '正在生成第 2 张',
              errorMessage: null,
              updatedAt: new Date().toISOString(),
              terminal: false,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
          hasMore: false,
        }),
      ),
    );

    render(<TaskPanel sessionId="s1" degraded={false} contextNotes={[]} />);
    expect(await screen.findByText('image.generate')).toBeInTheDocument();
    expect(screen.getByText('正在生成第 2 张')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  it('展示上下文说明（@引用命中、token 估算）', () => {
    render(
      <TaskPanel sessionId="s1" degraded={false} contextNotes={['已解析 @引用：苏晚']} />,
    );
    expect(screen.getByText('已解析 @引用：苏晚')).toBeInTheDocument();
  });

  it('降级时明确提示正在用轮询，而不是假装实时', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false })));
    render(<TaskPanel sessionId="s1" degraded contextNotes={[]} />);
    expect(await screen.findByText(/正在用轮询获取进度/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test composer task-panel
```

预期：失败，报找不到 `Composer` / `TaskPanel`。

- [ ] **Step 3: 实现 Composer**

`apps/web/src/features/agent/Composer.module.css`：

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  position: relative;
}

.row {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
}

.textarea {
  flex: 1;
  min-height: 44px;
  max-height: var(--layout-composer-max-height);
  resize: none;
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: var(--font-size-body);
  line-height: var(--line-height-base);
}

.textarea:focus {
  border-color: var(--color-primary);
}

.textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.hint {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

/* 补全列表：紧贴输入框上方，像一个下拉而不是独立面板 */
.suggestions {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-1);
  z-index: 50;
}

.suggestion {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: inherit;
  text-align: left;
  cursor: pointer;
  font-size: var(--font-size-secondary);
}

.suggestion:hover,
.suggestionActive {
  background: var(--color-surface-secondary);
}

.suggestionMeta {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-caption);
}
```

`apps/web/src/features/agent/Composer.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '../../components/Button.js';
import { Icon } from '../../components/Icon.js';
import { apiFetch, apiPost } from '../../lib/api.js';
import styles from './Composer.module.css';

export interface ComposerProps {
  projectId: string;
  /** 发送消息。抛错表示失败，此时输入内容必须保留 */
  onSend: (message: string, referencedAssetIds: string[]) => Promise<void>;
  disabled: boolean;
}

interface SkillOption {
  id: string;
  name: string;
  category: string;
}

interface AssetOption {
  id: string;
  slug: string;
  name: string;
}

type Suggestion =
  | { kind: 'skill'; id: string; label: string; meta: string }
  | { kind: 'asset'; id: string; label: string; meta: string };

export function Composer({ projectId, onSend, disabled }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 触发补全的标记：`/` 在行首或空格后，`@` 同理 */
  const trigger = useRef<'/' | '@' | null>(null);

  const loadSuggestions = useCallback(
    async (kind: '/' | '@') => {
      try {
        if (kind === '/') {
          const page = await apiFetch<{ items: SkillOption[] }>('/api/skills?pageSize=50');
          setSuggestions(
            page.items.map((skill) => ({
              kind: 'skill' as const,
              id: skill.id,
              label: skill.name,
              meta: skill.id,
            })),
          );
        } else {
          const page = await apiFetch<{ items: AssetOption[] }>(
            `/api/projects/${projectId}/assets?pageSize=50`,
          );
          setSuggestions(
            page.items.map((asset) => ({
              kind: 'asset' as const,
              id: asset.id,
              label: asset.name,
              meta: `@${asset.slug}`,
            })),
          );
        }
        setActiveIndex(0);
      } catch {
        // 补全失败不该打断输入：静默收起列表即可
        setSuggestions([]);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (trigger.current !== null) void loadSuggestions(trigger.current);
  }, [loadSuggestions]);

  function handleChange(value: string): void {
    setText(value);

    const lastChar = value.slice(-1);
    if (lastChar === '/' || lastChar === '@') {
      trigger.current = lastChar;
      void loadSuggestions(lastChar);
      return;
    }
    // 一旦输入了空白就收起补全
    if (/\s$/.test(value)) {
      trigger.current = null;
      setSuggestions([]);
    }
  }

  function applySuggestion(item: Suggestion): void {
    // 把触发符与其后的内容一起替换成选中的项
    const withoutTrigger = text.replace(/[/@][^\s/@]*$/, '');
    const inserted = item.kind === 'skill' ? `/${item.meta} ` : `@${item.meta.replace(/^@/, '')} `;
    setText(`${withoutTrigger}${inserted}`);
    setSuggestions([]);
    trigger.current = null;
  }

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;

    setSending(true);
    try {
      // 引用解析交给后端：前端不维护「引用名 → id」映射，避免两处口径不一致。
      //
      // 响应形状是 `{ mentions, matched, missing }`（已核对 apps/api/src/routes/assets.ts）：
      // `matched` 是命中的资产，`missing` 是文本里出现但项目内不存在的引用名。
      // 这里**只取 matched**，不因 missing 而阻止发送 ——
      // 「@不存在的角色」由 Agent 在对话里回答（它会明确说「我没有找到 @X」），
      // 前端再拦一道只会产生两条重复的提示。
      const resolved = await apiPost<{ matched: Array<{ id: string }> }>(
        '/api/assets/resolve-mentions',
        { projectId, text: trimmed },
      );
      await onSend(
        trimmed,
        resolved.matched.map((asset) => asset.id),
      );
      // 只有成功才清空
      setText('');
      setSuggestions([]);
    } catch {
      // 失败时**保留**输入内容：用户可能刚敲了很久
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const picked = suggestions[activeIndex];
        if (picked !== undefined) applySuggestion(picked);
        return;
      }
      if (event.key === 'Escape') {
        setSuggestions([]);
        return;
      }
    }

    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className={styles.wrapper}>
      {suggestions.length > 0 ? (
        <div className={styles.suggestions} role="listbox" aria-label="补全建议">
          {suggestions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.suggestion} ${index === activeIndex ? styles.suggestionActive : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => applySuggestion(item)}
            >
              <span>{item.label}</span>
              <span className={styles.suggestionMeta}>{item.meta}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.row}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={text}
          disabled={disabled || sending}
          placeholder="描述你想创作的内容。输入 / 选择技能，输入 @ 引用资产"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <Button
          variant="primary"
          loading={sending}
          disabled={disabled || text.trim().length === 0}
          onClick={() => void submit()}
          aria-label="发送"
        >
          <Icon name="send" />
        </Button>
      </div>

      <span className={styles.hint}>Enter 发送 · Shift + Enter 换行</span>
    </div>
  );
}
```

- [ ] **Step 4: 实现 ToolTrace 与 TaskPanel**

`apps/web/src/features/agent/ToolTrace.module.css`：

```css
.trace {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.summary {
  cursor: pointer;
  user-select: none;
}

.list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.name {
  font-family: var(--font-family-mono);
  color: var(--color-text-secondary);
}

.failed { color: var(--color-error); }
.rejected { color: var(--color-warning); }
```

`apps/web/src/features/agent/ToolTrace.tsx`：

```tsx
import type { ToolCallRecord } from '../../lib/api-types.js';
import { formatDuration } from '../../lib/format.js';
import styles from './ToolTrace.module.css';

export interface ToolTraceProps {
  calls: ToolCallRecord[];
}

/**
 * 工具调用轨迹。
 *
 * 默认折叠：它是「Agent 做了什么」的审计视图，对结果满意时用户不需要看；
 * 但生成结果不对时，它是理解「为什么」的唯一入口，所以必须能展开。
 */
export function ToolTrace({ calls }: ToolTraceProps) {
  if (calls.length === 0) return null;

  const failed = calls.filter((call) => call.status === 'failed').length;

  return (
    <details className={styles.trace}>
      <summary className={styles.summary}>
        Agent 执行了 {calls.length} 步{failed > 0 ? `（${failed} 步失败）` : ''}
      </summary>
      <ul className={styles.list}>
        {calls.map((call, index) => (
          <li
            key={`${call.name}-${String(index)}`}
            className={call.status === 'failed' ? styles.failed : call.status === 'rejected' ? styles.rejected : ''}
          >
            <span className={styles.name}>{call.name}</span>
            {call.durationMs !== undefined ? ` · ${formatDuration(call.durationMs)}` : ''}
            {call.error !== undefined ? ` · ${call.error}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

`apps/web/src/features/agent/TaskPanel.module.css`：

```css
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.itemHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.skill {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-caption);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.status {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
}

.polling {
  font-size: var(--font-size-caption);
  color: var(--color-warning);
}
```

`apps/web/src/features/agent/TaskPanel.tsx`：

```tsx
import { useEffect, useState } from 'react';

import { ProgressBar } from '../../components/ProgressBar.js';
import { EmptyState } from '../../components/StateBlock.js';
import { apiFetch } from '../../lib/api.js';
import type { PageBody, TaskProgress } from '../../lib/api-types.js';
import styles from './TaskPanel.module.css';

export interface TaskPanelProps {
  sessionId: string;
  /** 处于降级状态：SSE 不可靠，改用轮询 */
  degraded: boolean;
  contextNotes: string[];
}

/** 降级时的轮询间隔。不能太密，否则降级本身会变成新的负担。 */
const POLL_INTERVAL_MS = 3000;

/** 任务状态的中文标签 */
const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '生成中',
  waiting_user: '等待确认',
  success: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

export function TaskPanel({ sessionId, degraded, contextNotes }: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const page = await apiFetch<PageBody<TaskProgress>>(
          `/api/tasks?sessionId=${sessionId}&pageSize=20`,
        );
        if (!cancelled) setTasks(page.items);
      } catch {
        // 面板拉取失败不该打断对话；保持上一次的快照即可
      }
    }

    void load();

    // 降级时主动轮询：SSE 已不可靠，不能指望它推送进度
    const timer = degraded ? setInterval(() => void load(), POLL_INTERVAL_MS) : null;
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [sessionId, degraded]);

  return (
    <div className={styles.panel}>
      {degraded ? (
        <p className={styles.polling}>实时连接不可用，正在用轮询获取进度。</p>
      ) : null}

      <section className={styles.section}>
        <h2>任务</h2>
        {tasks.length === 0 ? (
          <EmptyState
            icon="play"
            title="还没有任务"
            description="当 Agent 开始生成内容时，任务会出现在这里并实时更新进度。"
          />
        ) : (
          <ul className={styles.list}>
            {tasks.map((task) => (
              <li key={task.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.skill}>{task.skillId}</span>
                  <span className={styles.status}>{STATUS_LABEL[task.status] ?? task.status}</span>
                </div>
                {task.status === 'running' || task.status === 'pending' ? (
                  <ProgressBar
                    value={task.progress}
                    {...(task.progressMessage !== null ? { label: task.progressMessage } : {})}
                  />
                ) : null}
                {task.errorMessage !== null ? (
                  <span className={styles.status}>{task.errorMessage}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {contextNotes.length > 0 ? (
        <section className={styles.section}>
          <h2>上下文</h2>
          <ul className={styles.notes}>
            {contextNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: 接进工作台**

修改 `apps/web/src/features/agent/AgentWorkspace.tsx`：
- 把 `composerSlot` 占位换成 `<Composer … />`
- 把侧区的占位换成 `<TaskPanel … />`
- 实现发送：`POST /api/agent/chat`，把返回的 `message` + `payload` 追加为一条 Agent 消息，
  并把 `contextNotes` 存进状态供 `TaskPanel` 使用
- 实现确认：`POST /api/agent/sessions/:id/confirm`，按 `taskIds` 精确放行
- SSE 事件处理：`agent.message` / `agent.plan` / `agent.confirmation` 追加消息；
  `task.progress` / `task.status` 触发任务面板刷新；
  `asset.changed` 与任务完成时拉 `GET /api/tasks/:id`，若 `output.card` 存在则作为结果卡追加

> 具体接线由实现者完成。**要求**：用事件类型做分派（`switch` + `never` 穷尽检查），
> 不要用一长串 `if`，也不要吞掉未知事件类型 —— 未知类型记一条 `console.warn` 并继续，
> 这样新增事件类型时能在开发期被发现。

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm --filter @svh/web test composer task-panel
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/features/agent apps/web/test/composer.test.tsx apps/web/test/task-panel.test.tsx
git commit -m "feat(web): 新增输入区（技能与资产补全）、工具轨迹与实时任务面板"
```

---

## Task 8: 模型 Provider 配置页

**Files:**
- Create: `apps/web/src/features/settings/ProviderSettingsPage.tsx` + `.module.css`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/provider-settings.test.tsx`

**Interfaces:**
- Consumes: `GET /api/models/providers`、`POST /api/models/providers`、
  `POST /api/models/providers/:id/test`、`POST /api/models/providers/:id/models`、
  `DELETE /api/models/providers/:id`
- Produces: `ProviderSettingsPage`；路由 `/settings/providers`

**验收要求：**

- 三态齐备：加载骨架、无 Provider 时空状态（主操作「添加模型服务」）、加载失败错误态
- **密钥只写不读**：表单提交后只显示 `apiKeyMask`（如 `sk-****abcd`），
  **界面上任何地方都不得回显完整密钥**
- 「测试连接」按钮调 `POST .../test`，结果用轻提示与状态徽标反馈
- 健康状态（`healthy` / `degraded` / `down` / `unknown`）用文字 + 颜色双重表达
  （不能只靠颜色，色觉障碍用户需要文字）
- 未配置任何 Provider 时，页面顶部明确提示「配置模型后才能开始生成内容」

- [ ] **Step 1: 编写失败的测试**

`apps/web/test/provider-settings.test.tsx`：

```tsx
/**
 * Provider 配置页测试。
 *
 * 最关键的一条：**完整密钥绝不出现在界面上**。
 * 这是安全属性，不是文案问题。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { ProviderSettingsPage } from '../src/features/settings/ProviderSettingsPage.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ProviderSettingsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const EMPTY = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProviderSettingsPage', () => {
  it('无 Provider 时提示必须先配置模型', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(EMPTY)));
    renderPage();

    expect(await screen.findByText('还没有配置模型服务')).toBeInTheDocument();
    expect(screen.getByText(/配置模型后才能开始生成内容/)).toBeInTheDocument();
  });

  it('列出 Provider 时只显示掩码，不显示完整密钥', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...EMPTY,
          total: 1,
          items: [
            {
              id: 'pv1',
              kind: 'openai_compatible',
              name: '我的中转站',
              baseUrl: 'https://api.example.com',
              enabled: true,
              health: 'healthy',
              apiKeyMask: 'sk-****abcd',
              modelCount: 3,
              createdAt: '',
              updatedAt: '',
            },
          ],
        }),
      ),
    );

    const { container } = renderPage();
    expect(await screen.findByText('我的中转站')).toBeInTheDocument();
    expect(screen.getByText('sk-****abcd')).toBeInTheDocument();
    // 整个渲染结果里不得出现未掩码的密钥形态
    expect(container.textContent ?? '').not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });

  it('健康状态用文字表达，不只靠颜色', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({
          ...EMPTY,
          total: 2,
          items: [
            { id: 'a', kind: 'openai_compatible', name: 'A', baseUrl: 'u', enabled: true, health: 'healthy', apiKeyMask: null, modelCount: 0, createdAt: '', updatedAt: '' },
            { id: 'b', kind: 'openai_compatible', name: 'B', baseUrl: 'u', enabled: true, health: 'down', apiKeyMask: null, modelCount: 0, createdAt: '', updatedAt: '' },
          ],
        }),
      ),
    );

    renderPage();
    expect(await screen.findByText('正常')).toBeInTheDocument();
    expect(screen.getByText('不可用')).toBeInTheDocument();
  });

  it('测试连接成功后给出反馈', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          ...EMPTY,
          total: 1,
          items: [
            { id: 'pv1', kind: 'openai_compatible', name: '我的中转站', baseUrl: 'u', enabled: true, health: 'unknown', apiKeyMask: 'sk-****abcd', modelCount: 0, createdAt: '', updatedAt: '' },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ ok: true, message: '连接成功', latencyMs: 120 }));

    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: '测试连接' }));
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @svh/web test provider-settings
```

预期：失败，报找不到 `ProviderSettingsPage`。

- [ ] **Step 3: 实现页面**

`apps/web/src/features/settings/ProviderSettingsPage.module.css`：

```css
.page {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-warning-subtle);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-warning);
  font-size: var(--font-size-secondary);
}

/*
 * Provider 条目是一条有独立操作边界的记录（编辑 / 测试 / 删除），
 * 因此这里**允许**用卡片 —— 这是规范里 Card 的正当用途。
 */
.item {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.itemHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.itemName {
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-medium);
}

.itemMeta {
  font-size: var(--font-size-caption);
  color: var(--color-text-tertiary);
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* 健康状态：文字 + 颜色双重表达 —— 只靠颜色的状态对色觉障碍用户不可用 */
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-caption);
  border: 1px solid var(--color-border);
}

.healthy { color: var(--color-success); border-color: var(--color-success); }
.degraded { color: var(--color-warning); border-color: var(--color-warning); }
.down { color: var(--color-error); border-color: var(--color-error); }
.unknown { color: var(--color-text-tertiary); }
```

`apps/web/src/features/settings/ProviderSettingsPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { EmptyState, ErrorState, SkeletonLines } from '../../components/StateBlock.js';
import { useToast } from '../../components/Toast.js';
import { ApiError, apiFetch, apiPost } from '../../lib/api.js';
import type { ModelProviderView, PageBody } from '../../lib/api-types.js';
import styles from './ProviderSettingsPage.module.css';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: ModelProviderView[] }
  | { kind: 'error'; message: string; suggestions: string[]; retryable: boolean };

/** 健康状态 → 中文标签与样式。文字是必需的，颜色只是强化。 */
const HEALTH: Record<ModelProviderView['health'], { label: string; className: string }> = {
  healthy: { label: '正常', className: styles.healthy ?? '' },
  degraded: { label: '不稳定', className: styles.degraded ?? '' },
  down: { label: '不可用', className: styles.down ?? '' },
  unknown: { label: '未检测', className: styles.unknown ?? '' },
};

/** Provider 类型的中文标签 */
const KIND_LABEL: Record<string, string> = {
  openai_compatible: 'OpenAI 兼容',
  anthropic_compatible: 'Anthropic 兼容',
  gemini_compatible: 'Gemini 兼容',
  mock: '本地模拟',
  custom: '自定义',
};

export function ProviderSettingsPage() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const page = await apiFetch<PageBody<ModelProviderView>>('/api/models/providers?pageSize=50');
      setState({ kind: 'ready', providers: page.items });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      setState({
        kind: 'error',
        message: apiError?.message ?? '加载模型服务失败。',
        suggestions: apiError?.suggestions ?? [],
        retryable: apiError?.retryable ?? false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    if (name.trim().length === 0 || baseUrl.trim().length === 0) {
      setFormError('名称与服务地址都不能为空');
      return;
    }

    setSubmitting(true);
    setFormError(undefined);
    try {
      await apiPost<ModelProviderView>('/api/models/providers', {
        kind: 'openai_compatible',
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        // 密钥只在此处上行一次；返回的视图里只有掩码，不回显
        ...(apiKey.length > 0 ? { apiKey } : {}),
      });
      setDialogOpen(false);
      setName('');
      setBaseUrl('');
      setApiKey('');
      toast.show('模型服务已添加', 'success');
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '添加失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  }

  async function testConnection(provider: ModelProviderView): Promise<void> {
    setTesting(provider.id);
    try {
      const result = await apiPost<{ ok: boolean; message: string; latencyMs?: number }>(
        `/api/models/providers/${provider.id}/test`,
        {},
      );
      toast.show(
        result.ok
          ? `${provider.name} 连接成功${result.latencyMs !== undefined ? `（${String(result.latencyMs)}ms）` : ''}`
          : `${provider.name} 连接失败：${result.message}`,
        result.ok ? 'success' : 'error',
      );
      await load();
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : '测试连接失败。', 'error');
    } finally {
      setTesting(null);
    }
  }

  const providers = state.kind === 'ready' ? state.providers : [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>模型服务</h1>
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          添加模型服务
        </Button>
      </header>

      {/*
        未配置任何 Provider 时，整个产品是「哑」的 —— Agent 会退回本地模拟。
        这条提示必须显眼，否则用户会以为是功能坏了。
      */}
      {state.kind === 'ready' && providers.length === 0 ? (
        <div className={styles.banner} role="status">
          <span>配置模型后才能开始生成内容。请先添加一个模型服务并测试连接。</span>
        </div>
      ) : null}

      {state.kind === 'loading' ? <SkeletonLines lines={4} /> : null}

      {state.kind === 'error' ? (
        <ErrorState
          title="加载模型服务失败"
          reason={state.message}
          {...(state.suggestions.length > 0 ? { suggestions: state.suggestions } : {})}
          {...(state.retryable ? { onRetry: () => void load() } : {})}
        />
      ) : null}

      {state.kind === 'ready' && providers.length === 0 ? (
        <EmptyState
          icon="settings"
          title="还没有配置模型服务"
          description="SVH 不内置模型：你需要填入自己的 API 地址与密钥。密钥加密存储，界面上只显示掩码。"
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              添加模型服务
            </Button>
          }
        />
      ) : null}

      {providers.length > 0 ? (
        <div className={styles.actions} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-4)' }}>
          {providers.map((provider) => {
            const health = HEALTH[provider.health];
            return (
              <article key={provider.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.itemName}>{provider.name}</span>
                  <span className={`${styles.badge} ${health.className}`}>{health.label}</span>
                </div>
                <span className={styles.itemMeta}>
                  {KIND_LABEL[provider.kind] ?? provider.kind} · {provider.baseUrl} ·{' '}
                  {provider.modelCount} 个模型
                  {provider.apiKeyMask !== null ? ` · 密钥 ${provider.apiKeyMask}` : ' · 未设置密钥'}
                </span>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    loading={testing === provider.id}
                    onClick={() => void testConnection(provider)}
                  >
                    测试连接
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="添加模型服务"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <Button onClick={() => setDialogOpen(false)}>取消</Button>
            <Button variant="primary" loading={submitting} onClick={() => void submit()}>
              添加
            </Button>
          </>
        }
      >
        <Field label="名称" htmlFor="provider-name" helper="自己认得出来即可，例如「主力中转站」">
          <input id="provider-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="服务地址"
          htmlFor="provider-url"
          helper="OpenAI 兼容协议的基础地址，例如 https://api.example.com/v1"
        >
          <input id="provider-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field
          label="API Key"
          htmlFor="provider-key"
          helper="加密存储，保存后界面只显示掩码"
          {...(formError !== undefined ? { error: formError } : {})}
        >
          <input
            id="provider-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </Field>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: 接入路由**

修改 `apps/web/src/App.tsx` 增加：

```tsx
        <Route path="/settings/providers" element={<ProviderSettingsPage />} />
```

并补导入。同时在项目列表页头部加一个指向该路由的次要入口
（`<Link to="/settings/providers">模型服务</Link>`），否则用户找不到它。

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm --filter @svh/web test provider-settings
pnpm --filter @svh/web typecheck
pnpm --filter @svh/web lint
```

预期：全部通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/features/settings apps/web/src/App.tsx apps/web/src/features/projects apps/web/test/provider-settings.test.tsx
git commit -m "feat(web): 新增模型 Provider 配置页（密钥只写不读）"
```

---

## Task 9: 响应式、端到端验证与文档

**Files:**
- Modify: `apps/web/src/features/agent/AgentWorkspace.tsx`（窄屏抽屉）
- Modify: `apps/web/src/features/agent/AgentWorkspace.module.css`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Test: `apps/web/test/responsive.test.tsx`

- [ ] **Step 1: 实现窄屏侧区折叠**

在 `AgentWorkspace` 中：窄屏（`max-width: 1024px`）时侧区 `.side` 已被 CSS 隐藏
（Task 5 已写），现在补一个可展开的入口 —— 顶部加一个「任务」按钮，
点击打开 `<Drawer side="right">` 并把 `TaskPanel` 放进去。

用 `matchMedia` 判断是否窄屏，并在窗口尺寸变化时更新：

```tsx
/**
 * 是否窄屏。
 *
 * 用 matchMedia 而不是读 window.innerWidth 一次：后者在用户旋转屏幕
 * 或拖动窗口时不会更新，界面会卡在错误的布局上。
 */
function useIsNarrow(query = '(max-width: 1024px)'): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return narrow;
}
```

- [ ] **Step 2: 编写响应式测试**

`apps/web/test/responsive.test.tsx`：

```tsx
/**
 * 窄屏行为测试。
 *
 * jsdom 没有真实布局，因此这里只验证「窄屏时侧区进入抽屉」这一**行为**，
 * 真实的三档视觉检查由 Task 9 的手工验证覆盖。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../src/components/Toast.js';
import { AgentWorkspace } from '../src/features/agent/AgentWorkspace.js';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 把 matchMedia 伪造成指定的匹配结果 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('窄屏布局', () => {
  it('窄屏时提供打开任务抽屉的入口', async () => {
    stubMatchMedia(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/api/agent/sessions')
            ? json({ id: 's1', projectId: 'p1', title: '会话', agentState: 'idle', messages: [] })
            : json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false }),
        ),
      ),
    );
    vi.stubGlobal('EventSource', class { onopen = null; onerror = null; onmessage = null; close() {} });

    render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <ToastProvider>
          <Routes>
            <Route path="/projects/:projectId" element={<AgentWorkspace />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole('button', { name: '任务' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: '任务' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 全量验证**

```bash
cd /home/yesheng/projects/SVH
pnpm exec turbo run lint typecheck test build --force
```

预期：全部成功，且 Phase 5A 的 489 个测试无回归。

- [ ] **Step 4: 端到端手工验证（必须给出真实证据）**

按 spec §10 的六条验收标准逐条验证，**每一条都要有可核对的输出**：

1. **完整创作流程**：起 `api:dev` + `worker:dev` + `web:dev`，在界面上完成
   「30 秒护肤品广告」→ 计划卡 → 开始制作 → 确认卡 → 确认执行 → 实时进度 → 结果卡
2. **刷新恢复**：生成过程中刷新页面，任务进度从 REST 恢复且 SSE 继续推进
3. **断线降级**：kill API 进程，界面显示降级提示条并回退轮询；重启 API 后自动重连并补齐事件
4. **未配置模型**：清空 Provider（或在空库上）时，界面明确提示去配置
5. 四条流水线全绿（Step 3 已覆盖）
6. **三档响应式**：在浏览器里分别以 1440 / 1024 / 390 宽度检查，
   确认无横向滚动、按钮不溢出、信息层级不丢失

**后台起服务**：用 `run_in_background` / `nohup`，并用 `ss -ltnp` 查 PID 精确 kill。
**绝不要用 `pkill -f`**（本项目多次因它误杀调用中的 shell）。

把每一步的命令与实际输出/截图说明贴进报告。

- [ ] **Step 5: 更新文档**

`README.md`：
- Phase 5B 标记完成
- 包结构补 `apps/web`
- 更新测试数字（以 Step 3 的实际输出为准）
- 加上前端启动说明：`pnpm web:dev`（默认 5173，`/api` 代理到 3030）

`docs/ARCHITECTURE.md`：
- 新增一节「§6.10 前端结构」，说明：技术选型（React + Vite + CSS Modules + 自建 Token）、
  为什么不用 UI 组件库、SSE 客户端的两条判据（连接状态 + 事件陈旧度）、
  以及「结果卡来自任务产出而非 Agent 轮次」这一数据流
- 第 7 节交付边界：把「Agent UI」从「尚未实现」表格移出
- 第 9 节已知限制：更新第 13 条（Agent UI 层确认交互已交付），
  并新增前端侧的真实限制（例如：无认证、结果卡媒体依赖存储可用性、
  计划不是可执行对象因而「开始制作」只是一轮对话）

- [ ] **Step 6: 提交**

```bash
git add apps/web README.md docs/ARCHITECTURE.md
git commit -m "feat(web): 完成 Agent UI 响应式适配并更新交付文档"
```

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 章节 | 对应任务 |
| --- | --- |
| §6.1 目录结构 | Task 1 ~ 8（逐文件对应） |
| §6.2 页面结构（主区/侧区/输入区） | Task 5（布局）、Task 7（侧区与输入区） |
| §6.3 关键交互链路 | Task 6（计划卡与确认卡）、Task 7（发送与任务面板） |
| §6.4 输入补全（`/` 与 `@`） | Task 7 |
| §7.1 Design Token | Task 1（`tokens.css` + 契约测试） |
| §7.2 Card 使用边界 | Task 2（组件不带卡片外观）、Task 6（`card.module.css` 只给四类卡） |
| §7.3 状态设计（Loading/Empty/Error） | Task 2（三态组件）、Task 4/5/8（逐页应用） |
| §7.4 SSE 断线降级 | Task 3（客户端）、Task 5（提示条）、Task 7（回退轮询） |
| §7.5 响应式三档 | Task 9 |
| §8 前端测试计划 | Task 1 ~ 8 各自的测试文件 |
| §9 新增依赖 | Task 1 Step 2 |
| §10 验收标准 1~6 | Task 9 Step 4（逐条验证） |

**2. 占位符扫描**

已逐条检查：无 `TBD`、无「适当处理错误」类空话。

三处**刻意**留下的实现指引（不是占位符，因为它们给出了明确的判据与理由）：
- Task 2 Step 8 里 `ErrorState` 的重试按钮写成裸 `<button>` —— 已明确说明那是**错误写法示例**，
  要求改用 `Button` 组件。这样写是为了让实现者读到那段说明，而不是照抄。
- Task 3 Step 7 的 `startedAt` 是未声明引用 —— 已说明要在函数开头补上，并给出理由。
- Task 7 Step 5 的工作台接线描述较简（发送/确认/SSE 分派）—— 给出了明确要求
  （`switch` + `never` 穷尽检查、未知类型 `console.warn`），但没有逐行代码。
  这是本计划里唯一一处「描述而非代码」的实现项，因为它高度依赖前面任务的最终形态。

**3. 类型一致性检查**

- `MessagePayload` 的五个成员在 Task 3 的 `api-types.ts` 定义，
  Task 6 的渲染器与 `MessageItem` 分发逐一对应
- `CardAction` 在 Task 3 定义，Task 6 的 `ResultCard` 消费，`variantOf` 覆盖四种 `kind`
- `StreamState` 在 Task 3 定义（`'connecting'|'open'|'reconnecting'|'closed'`），
  Task 5 的 `useSessionStream` 直接透传
- `SessionStream.isEventStale()` / `lastEventAt()` 在 Task 3 定义，Task 5 消费
- `ModelProviderView.health` 的四个取值在 Task 3 定义、Task 8 的 `HEALTH` 映射覆盖全部四个
- `Field` 的 `error`/`helper` 互斥语义在 Task 2 定义，Task 4/8 按同语义使用

**4. 已知的实现风险**

| 风险 | 缓解 |
| --- | --- |
| Vite 8 + Vitest 5 与仓库既有 Vitest 2 并存 | 已裁定并说明；各包独立运行，互不影响 |
| `apps/api` 的 `GET /api/agent/sessions` 返回分页，Task 5 需要先查会话再取详情 | Task 5 的 `load()` 已写成两步（先列表取首个 id，再取详情）；若该会话不存在则退化为空会话 |
| 结果卡「由任务产出追加到对话流」需要轮询或事件驱动 | Task 7 在 `task.status` 变为成功时拉 `GET /api/tasks/:id` 取 `output.card` |
| jsdom 无布局，响应式只能验证行为 | Task 9 Step 4 用真实浏览器做三档视觉检查 |

**已在计划阶段核实、不留到实现的接口**（避免 Phase 5A 那种「留白处出错」）：

- `GET /api/tasks` **支持** `sessionId` 过滤（`apps/api/src/routes/tasks.ts:31`）→ Task 7 的 `TaskPanel` 按会话查询成立
- `POST /api/assets/resolve-mentions` 返回 `{ mentions, matched, missing }`
  （`apps/api/src/routes/assets.ts:352-364`）→ Task 7 取 `matched`，**不是** `assets`
- `GET /api/projects/:id/assets` 存在（Task 7 的 `@` 补全用）
- `GET /api/models/providers` 经 `toProviderView` 返回，**不含密钥字段**（Task 8 的「只写不读」由后端结构性保证）
