/**
 * 五类载荷渲染器测试。
 *
 * 这些组件的价值在于「把后端的结构化协议翻译成可操作的界面」，
 * 因此断言都落在**用户能做什么**上（按钮文案、点击后的调用），
 * 而不是断言 DOM 结构。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../src/lib/api-types.js';

/*
 * 媒体体检用真实的 `apiFetch` 打到被替换的全局 fetch 上 ——
 * 不 mock 掉 `apiFetch` 本身：它内部还有「非 2xx 要抛 ApiError」这类行为，
 * 换掉就等于把那段排除在用例之外。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 让 `/api/assets/:id/media-health` 返回指定结论 */
function stubMediaHealth(exists: boolean | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ assetId: 'a1', items: [{ url: 'http://x/gone.png', driver: 'local', exists }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

import { ConfirmationCard } from '../src/features/agent/renderers/ConfirmationCard.js';
import { ErrorCard } from '../src/features/agent/renderers/ErrorCard.js';
import { PlanCard } from '../src/features/agent/renderers/PlanCard.js';
import { ProgressLine } from '../src/features/agent/renderers/ProgressLine.js';
import { ResultCard } from '../src/features/agent/renderers/ResultCard.js';
import { MessageItem } from '../src/features/agent/MessageItem.js';
import { MessageList } from '../src/features/agent/MessageList.js';

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

  it('点击「开始制作」发送一条回复消息（不是本地执行）', async () => {
    const onReply = vi.fn();
    render(<PlanCard payload={plan} onReply={onReply} />);

    await userEvent.click(screen.getByRole('button', { name: '开始制作' }));
    expect(onReply).toHaveBeenCalledWith('开始制作');
  });

  /*
   * 回归守卫：广告这类「高成本节点不到 3 个」的计划**必须**有「开始制作」入口。
   *
   * 这里原本是一条「不需要审批时不显示「开始制作」」—— 它把这个缺陷写成了预期行为。
   * 判据「模板里高成本节点 ≥ 3」回答的是「系统要不要先停下来等你」，
   * 与「界面上有没有动手的入口」是两件事；广告模板只有 1 个高成本节点，
   * 于是计划消息说着「确认后我就开始制作」，卡片上却一个按钮都没有。
   */
  it('不需要审批时同样给出「开始制作」入口', () => {
    render(<PlanCard payload={{ ...plan, requiresApproval: false }} onReply={() => undefined} />);
    expect(screen.getByRole('button', { name: '开始制作' })).toBeInTheDocument();
  });

  it('需要审批时额外说明「确认后才会开始执行」，而不是拿它挡住入口', () => {
    render(<PlanCard payload={{ ...plan, requiresApproval: true }} onReply={() => undefined} />);
    expect(screen.getByText(/确认后才会开始执行/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始制作' })).toBeInTheDocument();
  });

  it('协议省略 tasks 时仍保留操作入口（否则用户被困在卡片上）', () => {
    /*
     * `tasks: []` 就是「协议省略了 tasks」在 PlanCard 眼里的样子：
     * 数组默认值由 MessageItem 的 `withArrayDefaults` **单点**补齐
     * （协议允许省略 tasks，但组件拿到的一定是数组）。
     * 这里不去在 PlanCard 里再兜一层 —— 两处兜底会让「默认值到底谁负责」
     * 变得没有答案，而本项目已经因为把可省略字段当必填白屏过一次。
     */
    render(<PlanCard payload={{ ...plan, tasks: [] }} onReply={() => undefined} />);
    expect(screen.getByText('这条计划没有可展示的步骤')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始制作' })).toBeInTheDocument();
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

  /**
   * 媒体打不开 vs 生成失败 —— 这是两种不同的故障。
   *
   * 存储不可用、文件被清理、链接过期时，`<img>` 只会渲染成一张破图：
   * 界面既不说明发生了什么，也不给下一步，用户会把它读成「这次生成失败了」，
   * 于是白花一次生成去重跑。这里守住「两种故障在界面上必须能被区分」。
   */
  it('媒体打不开时说的是「打不开」而不是「生成失败」，并露出原始地址', () => {
    const 带图 = {
      ...payload,
      media: [
        {
          kind: 'image' as const,
          url: 'http://127.0.0.1:3030/files/gone.png',
          caption: '产品主视觉',
        },
      ],
    };

    render(<ResultCard payload={带图} onAction={() => undefined} />);

    // 还没失败：正常渲染 img，不出现任何降级提示（负向断言）
    const img = screen.getByAltText('产品主视觉');
    expect(img).toHaveAttribute('src', 'http://127.0.0.1:3030/files/gone.png');
    expect(screen.queryByText(/媒体打不开/)).not.toBeInTheDocument();

    // 模拟浏览器加载失败
    fireEvent.error(img);

    expect(screen.getByText(/媒体打不开/)).toBeInTheDocument();
    // 关键区分：生成是成功的
    expect(screen.getByText(/这次生成是成功的/)).toBeInTheDocument();
    /*
     * 两种原因都要列出来。
     * `error` 分不出「取不回来」与「取回来了但解不开」—— 真机上就撞到过后一种
     * （桩服务把文本标成 video/mp4，HTTP 200、字节完整，<video> 照样报错）。
     * 只写「取不回来」是把猜测当成事实。
     */
    expect(screen.getByText(/已失效或取不回来/)).toBeInTheDocument();
    expect(screen.getByText(/格式不被浏览器支持/)).toBeInTheDocument();
    // 排查的人第一眼要看的就是地址指向哪里
    expect(screen.getByText('http://127.0.0.1:3030/files/gone.png')).toBeInTheDocument();
    // 说明文字里不能出现「生成失败」这种会误导的说法
    expect(screen.queryByText(/生成失败/)).not.toBeInTheDocument();
  });

  it('体检说文件没了 → 明确说「已经不在了」，并给出可执行的下一步', async () => {
    stubMediaHealth(false);
    const 带图 = {
      ...payload,
      assetId: 'a1',
      media: [{ kind: 'image' as const, url: 'http://x/gone.png', caption: '产品主视觉' }],
    };

    render(<ResultCard payload={带图} onAction={() => undefined} />);
    fireEvent.error(screen.getByAltText('产品主视觉'));

    expect(await screen.findByText(/媒体已经不在了/)).toBeInTheDocument();
    // 下一步必须可执行：这条路径重跑就能补回来
    expect(screen.getByText(/重新生成一次可以补回来/)).toBeInTheDocument();
    // 不能出现中性的含糊说法 —— 那正是这次要消除的
    expect(screen.queryByText(/也可能是格式不被浏览器支持/)).not.toBeInTheDocument();
  });

  it('体检说文件还在 → 明确说「解不了」，并说明重跑没有用', async () => {
    stubMediaHealth(true);
    const 带图 = {
      ...payload,
      assetId: 'a1',
      media: [{ kind: 'image' as const, url: 'http://x/gone.png', caption: '产品主视觉' }],
    };

    render(<ResultCard payload={带图} onAction={() => undefined} />);
    fireEvent.error(screen.getByAltText('产品主视觉'));

    expect(await screen.findByText(/文件也还在存储里/)).toBeInTheDocument();
    // 这条路径与「文件没了」的处置相反：重跑大概率同样结果，要让用户知道
    expect(screen.getByText(/重新生成大概率是同样结果/)).toBeInTheDocument();
  });

  it('体检拿不到结论（或没有 assetId）时退回中性文案，而不是猜', async () => {
    // 没有 assetId：无从体检，保持原来的两种可能都列出
    const 带图 = {
      ...payload,
      media: [{ kind: 'image' as const, url: 'http://x/gone.png', caption: '产品主视觉' }],
    };
    render(<ResultCard payload={带图} onAction={() => undefined} />);
    fireEvent.error(screen.getByAltText('产品主视觉'));

    expect(screen.getByText(/媒体打不开/)).toBeInTheDocument();
    expect(screen.getByText(/也可能是格式不被浏览器支持/)).toBeInTheDocument();
  });

  it('体检请求失败时同样退回中性文案（不把错误换成更含糊的错误）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    const 带图 = {
      ...payload,
      assetId: 'a1',
      media: [{ kind: 'image' as const, url: 'http://x/gone.png', caption: '产品主视觉' }],
    };

    render(<ResultCard payload={带图} onAction={() => undefined} />);
    fireEvent.error(screen.getByAltText('产品主视觉'));

    // 中性文案仍然在，且不会出现任何断言性的结论
    expect(await screen.findByText(/媒体打不开/)).toBeInTheDocument();
    expect(screen.queryByText(/媒体已经不在了/)).not.toBeInTheDocument();
    expect(screen.queryByText(/文件也还在存储里/)).not.toBeInTheDocument();
  });

  it('视频加载失败同样降级（不是只有图片那条路径）', () => {
    const 带视频 = {
      ...payload,
      media: [{ kind: 'video' as const, url: 'http://127.0.0.1:3030/files/gone.mp4' }],
    };

    const { container } = render(<ResultCard payload={带视频} onAction={() => undefined} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    if (video !== null) fireEvent.error(video);

    expect(screen.getByText(/媒体打不开/)).toBeInTheDocument();
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

  it('未知的 payload.type 降级为可见提示，而不是静默丢弃', () => {
    /*
     * asPayload 只保证 type 是字符串，不保证是那五类之一：旧 bundle 撞上新 API
     * （滚动发布）时就会走到分发链的 default 分支。那里必须留下可见信号 ——
     * 静默 return null 会让纯载荷消息退化成一个只有时间戳的空条目。
     */
    render(<MessageItem message={agentMessage({ type: '未来才有的类型' }, '正文仍在')} />);
    expect(screen.getByText('正文仍在')).toBeInTheDocument();
    expect(screen.getByText(/收到一条暂不支持的卡片/)).toBeInTheDocument();
    // 未知类型名要显示出来：日志与客诉排查都靠它定位是哪个新协议
    expect(screen.getByText(/未来才有的类型/)).toBeInTheDocument();
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

/**
 * 畸形载荷的降级。
 *
 * 后端把 payload 存成 JSON，前端拿到的结构**没有 schema 保证**；
 * 而 React 19 在没有错误边界时会卸载整棵根树 —— 一条坏消息足以让整个工作台白屏。
 * 这些用例钉住两层护栏：收窄处的数组兜底，以及逐条消息的错误边界。
 */
describe('畸形载荷的降级', () => {
  /** 造一条完整的 agent 消息；payload 走 unknown，模拟后端存下来的 JSON */
  function agentMessage(id: string, content: string, payload: unknown): SessionMessage {
    return {
      id,
      role: 'agent',
      kind: 'plan',
      content,
      payload,
      createdAt: '2026-09-12T10:00:00.000Z',
    };
  }

  /*
   * 协议里这些数组字段都带 `.default([])`：生产者**可以省略**它们，
   * 省略后前端拿到 `undefined`。渲染器一旦把它当必填数组解引用，
   * 抛错就会把整棵树带走。
   */
  const malformedPayloads: Array<[string, Record<string, unknown>, string]> = [
    ['plan（缺 tasks）', { type: 'plan' }, '制作计划'],
    [
      'confirmation_request（缺 impacts / planTaskIds）',
      { type: 'confirmation_request', summary: '即将执行：video.generate' },
      '需要确认',
    ],
    ['result_card（缺 media / actions）', { type: 'result_card', title: '角色已创建' }, '角色已创建'],
    [
      'error（缺 suggestions / actions）',
      { type: 'error', title: '生成失败', reason: '模型不可用' },
      '错误',
    ],
  ];

  it.each(malformedPayloads)('%s：缺数组字段时卡片照常渲染，不抛错', (_label, payload, cardName) => {
    render(<MessageItem message={agentMessage('m1', '正文仍在', payload)} />);
    expect(screen.getByLabelText(cardName)).toBeInTheDocument();
    expect(screen.getByText('正文仍在')).toBeInTheDocument();
  });

  it('缺数组字段的消息不炸整棵树：其余消息照常渲染，坏消息降级可见', () => {
    render(
      <MessageList
        messages={[
          agentMessage('m1', '这条只有计划载荷', { type: 'plan' }),
          agentMessage('m2', '后面的消息还在', null),
        ]}
      />,
    );

    // 坏消息仍然渲染出卡片与自己的正文（不是白屏），并说清楚步骤缺失
    expect(screen.getByLabelText('制作计划')).toBeInTheDocument();
    expect(screen.getByText('这条只有计划载荷')).toBeInTheDocument();
    expect(screen.getByText('这条计划没有可展示的步骤')).toBeInTheDocument();
    // 同一条流里的其它消息完全不受影响
    expect(screen.getByText('后面的消息还在')).toBeInTheDocument();
  });

  it('渲染器抛错时错误边界只降级这一条，其余消息照常渲染', () => {
    // React 捕获渲染错误时自己也会打 console.error，这里静音以便断言我们自己的日志
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <MessageList
        messages={[
          /*
           * media 的元素畸形（不是「字段缺失」）：结构收窄补不出形状，
           * 只能在渲染时抛错 —— 这正是错误边界要接住的场景。
           */
          agentMessage('m1', '坏掉的是这一条', {
            type: 'result_card',
            title: '结果',
            media: [null],
            actions: [],
          }),
          agentMessage('m2', '这一条不受影响', null),
        ]}
      />,
    );

    expect(screen.getByText('坏掉的是这一条')).toBeInTheDocument();
    expect(screen.getByText(/卡片渲染失败/)).toBeInTheDocument();
    expect(screen.getByText('这一条不受影响')).toBeInTheDocument();
    // 降级不是静默：日志里必须留下痕迹，否则线上只能看到「界面少了一块」
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('消息载荷渲染失败'))).toBe(
      true,
    );
  });
});
