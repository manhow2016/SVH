/**
 * 通用组件测试。
 *
 * 重点验证三件事：可访问性（label 关联、对话框语义）、交互（点击/键盘）、
 * 以及三态组件真的表达了状态（而不是只有一个空壳）。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../src/components/Button.js';
import { Field } from '../src/components/Field.js';
import { Dialog } from '../src/components/Dialog.js';
import { Drawer } from '../src/components/Drawer.js';
import { EmptyState, ErrorState, SkeletonLines } from '../src/components/StateBlock.js';
import { ProgressBar } from '../src/components/ProgressBar.js';
import { ToastProvider, useToast } from '../src/components/Toast.js';

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

  it('把 helper 文字通过 aria-describedby 接到输入框上', () => {
    render(
      <Field label="名称" htmlFor="h" helper="最多 50 个字">
        <input id="h" />
      </Field>,
    );
    const input = screen.getByLabelText('名称');
    // 只把说明文字渲染在旁边，读屏用户是听不到的 —— 必须真正接上
    expect(input).toHaveAttribute('aria-describedby', screen.getByText('最多 50 个字').id);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('error 时 aria-describedby 指向错误文字而不是 helper', () => {
    render(
      <Field label="名称" htmlFor="e" helper="随便填" error="名称不能为空">
        <input id="e" />
      </Field>,
    );
    const input = screen.getByLabelText('名称');
    expect(input).toHaveAttribute('aria-describedby', screen.getByText('名称不能为空').id);
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

  it('打开时焦点移入对话框，关闭后把焦点还给触发按钮', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>打开</Button>
          <Dialog open={open} title="新建项目" onClose={() => setOpen(false)}>
            <p>内容</p>
          </Dialog>
        </>
      );
    }
    render(<Host />);

    const trigger = screen.getByRole('button', { name: '打开' });
    await userEvent.click(trigger);
    // 焦点必须落在模态内，否则键盘用户还在背景里打转
    expect(screen.getByRole('dialog')).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    // 关闭后焦点归还触发元素，而不是掉回 body
    expect(trigger).toHaveFocus();
  });
});

describe('Drawer', () => {
  it('渲染标题语义，并按 Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="项目导航" onClose={onClose}>
        <p>内容</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('项目导航');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('关闭时不渲染任何内容', () => {
    render(
      <Drawer open={false} title="项目导航" onClose={() => undefined}>
        <p>内容</p>
      </Drawer>,
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

describe('Toast', () => {
  it('useToast 显示的消息出现在 live region 中', async () => {
    function Probe() {
      const { show } = useToast();
      return <Button onClick={() => show('已保存', 'success')}>保存</Button>;
    }
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('已保存')).toBeInTheDocument();
  });
});
