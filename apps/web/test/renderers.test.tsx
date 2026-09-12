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

import type { SessionMessage } from '../src/lib/api-types.js';

import { ConfirmationCard } from '../src/features/agent/renderers/ConfirmationCard.js';
import { ErrorCard } from '../src/features/agent/renderers/ErrorCard.js';
import { PlanCard } from '../src/features/agent/renderers/PlanCard.js';
import { ProgressLine } from '../src/features/agent/renderers/ProgressLine.js';
import { ResultCard } from '../src/features/agent/renderers/ResultCard.js';
import { MessageItem } from '../src/features/agent/MessageItem.js';

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

  it('展示每个步骤的状态，但界面不假装计划在执行', () => {
    // 计划不是可执行的持久化对象：这里只有状态标签，没有进度条、没有「执行中」的推进
    render(<PlanCard payload={plan} onReply={() => undefined} />);
    expect(screen.getAllByText('待开始')).toHaveLength(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
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

  it('有 planTaskIds 时优先用整组 id 精确放行', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationCard
        payload={{ ...payload, taskId: 'task_x', planTaskIds: ['task_x', 'task_y'] }}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(onConfirm).toHaveBeenCalledWith({ taskIds: ['task_x', 'task_y'] });
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

  it('没有 taskId 时退化为放行全部，且不传任何 taskIds', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationCard
        payload={{ ...payload, taskId: undefined, planTaskIds: [] }}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /确认全部/ }));
    // 传 taskIds: [] 与「不传」在后端语义上应当一致，这里钉住前端不传参的形式
    expect(onConfirm).toHaveBeenCalledWith({});
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

  it('未恢复时不显示任何恢复说明，避免凭空给出「已恢复」的错觉', () => {
    render(
      <ErrorCard
        payload={{
          type: 'error',
          title: '生成图片失败',
          reason: '原模型不可用',
          suggestions: [],
          recovered: false,
          recoveryNote: '已自动切换备用模型继续生成',
          actions: [],
        }}
      />,
    );
    expect(screen.queryByText('已自动切换备用模型继续生成')).not.toBeInTheDocument();
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

  it('媒体没有 caption 时给出明确的替代文本，而不是留空', () => {
    // 空 alt 等于「这张图是装饰性的」，与「这是一张生成结果图」的语义相反
    render(
      <ResultCard
        payload={{ ...payload, media: [{ kind: 'image', url: '/y.png' }] }}
        onAction={() => undefined}
      />,
    );
    const image = screen.getByRole('img');
    expect(image).toHaveAttribute('alt', '生成结果');
  });
});

describe('MessageItem 的载荷分发', () => {
  /** 造一条 agent 消息；payload 走 unknown，模拟后端存下来的 JSON */
  function agentMessage(payload: unknown, content = ''): SessionMessage {
    return {
      id: 'm1',
      role: 'agent',
      kind: 'plan',
      content,
      payload,
      createdAt: '2026-09-12T10:00:00.000Z',
    };
  }

  it('按 payload.type 渲染对应卡片', () => {
    render(
      <MessageItem
        message={agentMessage({
          type: 'plan',
          goal: '制作 30 秒广告',
          tasks: [{ id: 't1', title: '生成脚本', status: 'pending', dependsOn: [] }],
          requiresApproval: true,
        })}
        onReply={() => undefined}
      />,
    );
    expect(screen.getByRole('region', { name: '制作计划' })).toBeInTheDocument();
    expect(screen.getByText('生成脚本')).toBeInTheDocument();
  });

  it('payload 为空或结构不对时不渲染卡片，只显示正文', () => {
    const { rerender } = render(<MessageItem message={agentMessage(null, '你好')} />);
    expect(screen.getByText('你好')).toBeInTheDocument();

    // 结构收窄要求 type 是字符串：数字型 type 视为没有载荷
    rerender(<MessageItem message={agentMessage({ type: 42 }, '你好')} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('未知的 payload.type 不渲染任何卡片，也不抛错', () => {
    // asPayload 只做结构校验：未知类型会落到分发链末尾，界面降级而不是崩溃
    render(<MessageItem message={agentMessage({ type: '未来才有的类型' }, '正文仍在')} />);
    expect(screen.getByText('正文仍在')).toBeInTheDocument();
  });

  it('确认卡的放行参数一路上报到调用方', async () => {
    const onConfirm = vi.fn();
    render(
      <MessageItem
        message={agentMessage({
          type: 'confirmation_request',
          summary: '即将执行：video.generate',
          impacts: [],
          taskId: 'task_x',
          planTaskIds: ['task_x'],
        })}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '确认执行' }));
    // 钉住的是**参数内容**：只放行卡片上这一条任务
    expect(onConfirm).toHaveBeenCalledWith({ taskIds: ['task_x'] });
  });

  it('只有载荷、正文为空时不渲染空段落', () => {
    render(
      <MessageItem
        message={agentMessage({
          type: 'progress',
          progress: 30,
          message: '正在生成第 1 个镜头',
        })}
      />,
    );
    expect(screen.getByText('正在生成第 1 个镜头')).toBeInTheDocument();
    expect(document.querySelector('p')).toBeNull();
  });
});
