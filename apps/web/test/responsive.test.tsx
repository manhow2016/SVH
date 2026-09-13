/**
 * 窄屏（≤1024px）行为测试。
 *
 * ── 这里能验证什么、不能验证什么 ──
 * jsdom 没有真实布局：它不会计算媒体查询、不会折叠 flex、也不会告诉你
 * 「遮罩压住了面板」。因此本文件只验证**行为**：
 * 窄屏时侧区不再常驻、顶部出现入口、抽屉能开能关、切回宽屏时抽屉收起。
 * 真实的三档视觉检查（无横向滚动 / 按钮不溢出 / 层叠正确）由 Task 9 的
 * headless Chromium 探针覆盖 —— 本阶段已经证明 jsdom 对层叠与布局类缺陷完全失明。
 */
/*
 * 直接读 CSS 文件做契约断言：与 tokens.test.ts 同样的理由 ——
 * jsdom 环境会替换全局 `URL`，`new URL(..., import.meta.url)` 会被按文档地址
 * （http://localhost:3000/）解析而不再是 file:，因此先取文件路径再拼绝对路径。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor } from '@testing-library/react';
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

const SESSION_DETAIL = {
  id: 's1',
  projectId: 'p1',
  title: '护肤品广告',
  agentState: 'idle',
  messages: [],
};

const SESSION_SUMMARY = {
  id: 's1',
  projectId: 'p1',
  title: '护肤品广告',
  agentState: 'idle',
  status: 'active',
  messageCount: 0,
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
};

/** REST 假响应：区分会话详情 / 会话列表 / 任务列表三个端点 */
function restFetch(url: string): Promise<Response> {
  // 详情：/api/agent/sessions/<id>?limit=...
  if (/\/api\/agent\/sessions\/[^?]+/.test(url)) {
    return Promise.resolve(json(SESSION_DETAIL));
  }
  // 任务面板：/api/tasks?sessionId=...
  if (url.includes('/api/tasks')) {
    return Promise.resolve(json({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false }));
  }
  // 列表：/api/agent/sessions?projectId=...
  return Promise.resolve(
    json({ items: [SESSION_SUMMARY], total: 1, page: 1, pageSize: 1, hasMore: false }),
  );
}

/**
 * 事件端点必须返回真正的 `text/event-stream`，不能靠 stub 全局 EventSource ——
 * Task 3 的传输层是 fetch + ReadableStream 自解析，stub EventSource 对它无效，
 * 事件请求会落到 REST 分支、被当成「非事件流」从而挂上降级条，
 * 用例会以与预期无关的原因失败。
 */
function stubFetch(onRest?: (url: string) => void): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (!url.includes('/events')) {
        onRest?.(url);
        return restFetch(url);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: session.ready\ndata: {"seq":1,"type":"session.ready","at":"2026-09-12T10:00:00.000Z","sessionId":"s1","data":{}}\n\n',
            ),
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }),
  );
}

/**
 * 可控的 `matchMedia` 桩。
 *
 * 返回一个 `setMatches`，用来模拟「用户拖动窗口 / 旋转屏幕」——
 * 仅把 `matches` 写成常量的话，`change` 监听这条路径完全测不到，
 * 而它正是本任务要求用 matchMedia（而不是读一次 innerWidth）的全部理由。
 */
function stubMatchMedia(initial: boolean): (next: boolean) => void {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: vi.fn(),
    })),
  );

  return (next: boolean) => {
    matches = next;
    for (const listener of [...listeners]) {
      listener({ matches: next } as MediaQueryListEvent);
    }
  };
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

/** 任务面板空态文案：每个 TaskPanel 实例恰好出现一次，用来数「面板有几份」 */
const PANEL_MARK = '还没有任务';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('窄屏布局', () => {
  it('窄屏时提供打开任务抽屉的入口', async () => {
    stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    const trigger = await screen.findByRole('button', { name: '任务' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: '任务' })).toBeInTheDocument();
  });

  it('窄屏时侧区不常驻，任务面板只在抽屉里出现一份', async () => {
    stubMatchMedia(true);
    stubFetch();

    const { container } = renderWorkspace();

    // 入口就位，但抽屉还没开：此时文档里不应该有任何任务面板（侧区没被渲染）
    await screen.findByRole('button', { name: '任务' });
    expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByText(PANEL_MARK)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '任务' }));

    // 抽屉打开后恰好一份 —— 两份意味着侧区与抽屉同时渲染，任务列表会被拉两次
    await screen.findByRole('dialog', { name: '任务' });
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
    expect(container.querySelectorAll('aside')).toHaveLength(1);
  });

  it('抽屉可以从内部关闭，关闭后任务面板不再留在文档里', async () => {
    stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: '任务' }));
    await screen.findByRole('dialog', { name: '任务' });

    await userEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(PANEL_MARK)).not.toBeInTheDocument();
  });

  it('宽屏时没有抽屉入口，任务面板常驻侧区', async () => {
    stubMatchMedia(false);
    stubFetch();

    const { container } = renderWorkspace();

    // 等会话加载完成（标题出现即表示 loadState 进入 ready）
    await screen.findByRole('heading', { name: '护肤品广告' });

    expect(screen.queryByRole('button', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 侧区是一等公民（普通 aside），不是抽屉里的对话框
    expect(container.querySelector('aside')).not.toHaveAttribute('role', 'dialog');
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
  });

  it('拖宽窗口（窄 → 宽）时自动收起抽屉，避免侧区与抽屉双份面板', async () => {
    const setMatches = stubMatchMedia(true);
    stubFetch();

    renderWorkspace();

    await userEvent.click(await screen.findByRole('button', { name: '任务' }));
    await screen.findByRole('dialog', { name: '任务' });

    // 用户把窗口拉宽：change 事件到达，布局切回宽屏
    setMatches(false);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '任务' })).not.toBeInTheDocument();
    });
    // 侧区接管，面板仍然恰好一份 —— 没有出现「侧区 + 抽屉」同时挂载
    await waitFor(() => {
      expect(screen.getAllByText(PANEL_MARK)).toHaveLength(1);
    });
  });
});

/**
 * 布局契约：把「jsdom 看不见、但真机会坏」的两条前提钉在构建里。
 *
 * B1 的真机探针（headless Chromium）实测到的缺陷是：`.workspace` 只声明了列、
 * 没声明行高，栅格行于是按内容长高（实测 9225px），`.scroll` 永远没有可滚动
 * 余量，滚动被页面级接管 —— 用户敲完几行需求后，发送 /「停止生成」按钮被留在
 * 视口下沿之外，`elementFromPoint(停止按钮中心)` 命中 `null`。
 *
 * jsdom 不做布局，这条回归只能在真机探针里发现；这里退而求其次，
 * 把判据的**必要前提**钉住：行高必须有界。
 *
 * 注：终审曾把同一缺陷归因于**水平方向**（textarea 的 `min-width: auto` 等于
 * 其多行内容的 min-content 宽度，把停止按钮顶出这一行）。该归因**已被探针
 * 否证**：修复前实测 `textarea 与停止按钮重叠面积 == 0`，且 `.textarea` 带
 * `overflow-y: auto`，按 Flexbox 规范其主轴自动最小尺寸已退化为 0。
 * 下面第二条用例因此不再声称它守的是这条缺陷，只守一条通用卫生约束。
 */
describe('布局契约（真机探针的前提条件）', () => {
  const cssDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/features/agent');
  const read = (name: string): string => readFileSync(resolve(cssDir, name), 'utf8');

  /*
   * 断言前必须先去注释 —— 这里有真实教训。
   *
   * `.row` 的注释里为了讲清楚成对关系，原样写了 `` `.textarea { min-width: 0 }` ``。
   * 于是 `css.indexOf('.textarea {')` 命中的是**注释里的那句话**，
   * 切片到最近的 `}` 只拿到 `".textarea { min-width: 0 "`：断言看着通过，
   * 实际根本没读到 `.textarea` 规则本身。注释一旦被改写，这条用例会毫无
   * 征兆地翻脸。凡是「从 CSS 文本里挑一段规则来断言」的地方，一律先剥注释。
   */
  const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const readCss = (name: string): string => stripComments(read(name));

  it('工作台栅格的行高必须有界，否则输入区会被挤出视口', () => {
    const css = readCss('AgentWorkspace.module.css');
    expect(css, '缺少 grid-template-rows：栅格行会按内容长高').toContain('grid-template-rows');
    // 实测到的缺陷形态是「完全没有行定义」（行 = auto，按内容长高到 9225px）。
    // 这里进一步要求下界显式为 0：裸 `1fr` 等价于 `minmax(auto, 1fr)`，
    // 其 auto 下界是内容的最小尺寸，会重现同一失效模式。
    expect(css, '行高下界必须显式为 0：裸 1fr 的 auto 下界仍会按内容长高').toContain(
      'grid-template-rows: minmax(0, 1fr)',
    );
  });

  it('输入行的子项必须允许收缩（min-width: 0）', () => {
    const css = readCss('Composer.module.css');
    const rowStart = css.indexOf('.row {');
    const row = css.slice(rowStart, css.indexOf('}', rowStart));
    const areaStart = css.indexOf('.textarea {');
    const textarea = css.slice(areaStart, css.indexOf('}', areaStart));
    /*
     * 这是一条**通用卫生约束**，不是某次缺陷的回归守卫。
     *
     * flex / grid 子项默认 `min-width: auto`（不小于内容最小宽度），
     * 一旦这一行里出现不可断行的宽内容（长 URL、长英文串），它就有被
     * 顶出容器的风险。注意 `.textarea` 自身带 `overflow-y: auto`，主轴
     * 自动最小尺寸已退化为 0，所以**当前**这行内容并不会真的溢出 ——
     * 「min-content 顶掉停止按钮」这个归因已被探针否证（重叠面积实测 0）。
     * 保留 `min-width: 0` 是为了让未来加进这一行的元素不必重新踩一遍。
     */
    expect(rowStart, '找不到 .row 规则（注释未剥离干净？）').toBeGreaterThan(-1);
    expect(areaStart, '找不到 .textarea 规则（注释未剥离干净？）').toBeGreaterThan(-1);
    expect(row).toContain('min-width: 0');
    expect(textarea).toContain('min-width: 0');
  });

  it('输入框的高度上限必须与视口挂钩，否则矮屏会重新触发页面级滚动', () => {
    const css = readCss('Composer.module.css');
    const start = css.indexOf('.textarea {');
    expect(start, '找不到 .textarea 规则（注释未剥离干净？）').toBeGreaterThan(-1);
    const textarea = css.slice(start, css.indexOf('}', start));

    /*
     * 真机探针实测：绝对值 200px 的上限在 390×320 上会让 header + 输入区的
     * 最小高度超过视口，`.main` 的 min-content 撑破容器，对话流被压到只剩
     * 内边距（48px），页面级滚动重新接管，停止按钮底边被切掉 5px。
     * 上限必须用 `min(绝对上限, 视口比例)` 的形式，才能随视口一起收缩。
     */
    expect(textarea, '输入框高度上限必须与视口挂钩（min(…, 40dvh)）').toMatch(
      /max-height:\s*min\(\s*var\(--layout-composer-max-height\)\s*,\s*\d+dvh\s*\)/,
    );
  });
});
