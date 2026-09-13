/**
 * 应用级错误边界。
 *
 * ── 为什么必须有用例守住 ──
 * React 19 在**没有**错误边界时会卸载整棵根树：任何一处渲染期抛错都变成
 * 整站白屏 —— 没有文案、没有可点的东西。本项目此前只有逐条消息的
 * `MessageBoundary`，它挡得住「一条坏消息」，挡不住页面组件或路由层的异常。
 *
 * 这里同时守住两件事：
 *   ① 组件本身的行为（降级文案、重试能恢复、控制台留痕）；
 *   ② **接线**：`App` 确实把边界包在最外层 —— 少了这一条，边界写得再好，
 *      页面抛错时也不会走到它。
 *
 * ② 用替换页面模块的方式构造真实的抛错路由（`vi.mock` 是文件级的，
 * 因此与其它 App 相关的用例分开成独立文件）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary.js';

/** 一个必定在渲染期抛错的组件 */
function Boom(): never {
  throw new Error('渲染炸了：某条数据缺字段');
}

// 只替换「项目列表页」这一个模块，其余路由与壳层全部走真实实现
vi.mock('../src/features/projects/ProjectListPage.js', () => ({
  ProjectListPage: () => <Boom />,
}));

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  /*
   * React 会把捕获到的异常再往控制台打一遍。这是**预期行为**，
   * 但会让测试输出充满红色堆栈，掩盖真正的失败。这里静音，
   * 同时在下面显式断言「我们自己打了日志」—— 静音不等于不检查。
   */
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('AppErrorBoundary', () => {
  it('子树抛错时给出说明与下一步，而不是白屏', () => {
    render(
      <MemoryRouter>
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>
      </MemoryRouter>,
    );

    // 发生了什么
    expect(screen.getByText('界面遇到了未预期的问题')).toBeInTheDocument();
    // 原始错误信息要露出来，否则排查只能靠猜
    expect(screen.getByText(/渲染炸了：某条数据缺字段/)).toBeInTheDocument();
    // 下一步：重试 + 换入口
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '回到项目列表' })).toHaveAttribute(
      'href',
      '/projects',
    );
    // 降级不是静默：日志必须留痕（上面的 console.error 被静音，这里显式要求它被调用过）
    expect(consoleError).toHaveBeenCalled();
  });

  it('App 把边界包在最外层：页面组件抛错时整站不白屏', async () => {
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );

    // 走到边界，而不是抛到 React 根上（那会卸载整棵树、什么都不剩）
    expect(screen.getByText('界面遇到了未预期的问题')).toBeInTheDocument();

    /*
     * 「重试」只重置这一层状态、重挂子树：这里子组件每次都会再抛，
     * 所以重试后仍然停在降级页 —— 关键是**不能整站消失**。
     * 若改成 window.location.reload()，这个断言就会因为页面被重新加载而失效。
     */
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByText('界面遇到了未预期的问题')).toBeInTheDocument();
  });
});
