/**
 * 资产详情抽屉测试。
 *
 * 最要紧的一条：**编辑只发改动过的字段**。
 * Agent 会往 metadata 里写表单没有的东西（`generation` / `reference_images` /
 * `cues`）。提交整份 = 把它们悄悄抹掉，而这种丢失在界面上**完全看不出来**——
 * 用户只会觉得「我什么都没干，提示词怎么没了」。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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

/**
 * 可切换资产的宿主：深链能在加载途中或确认框开着时切到另一个资产，
 * 这条路径必须先能构造出来，才可能有用例钉住它。
 *
 * `slow` 指定哪个资产的响应**先挂起**，由 `release(id)` 放行 ——
 * 用来构造「A 的响应迟到」这种竞态。
 */
function renderSwitcher(options: { slow?: string } = {}) {
  const assets: Record<string, AssetDetail> = { a1: CHARACTER, a2: IMAGE };
  const resolvers = new Map<string, () => void>();

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const id = url.split('/').pop() ?? '';
      if (id === options.slow) {
        return new Promise<Response>((resolve) => {
          resolvers.set(id, () => {
            resolve(json(assets[id] ?? {}));
          });
        });
      }
      return Promise.resolve(json(assets[id] ?? {}));
    }),
  );

  function Host() {
    const [assetId, setAssetId] = useState('a1');
    return (
      <ToastProvider>
        <button
          type="button"
          onClick={() => {
            setAssetId('a2');
          }}
        >
          切到另一个资产
        </button>
        <AssetDetailDrawer
          assetId={assetId}
          projectId="p1"
          onClose={vi.fn()}
          onMissing={vi.fn()}
          onChanged={vi.fn()}
        />
      </ToastProvider>
    );
  }

  render(<Host />);
  return {
    release: (id: string) => {
      resolvers.get(id)?.();
    },
  };
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

  it('生成产物改名：body 里没有 slug 与 coverUrl（这两个字段只对创作实体开放）', async () => {
    const { requests } = renderDrawer(IMAGE);
    const name = await screen.findByLabelText('名称');
    await userEvent.clear(name);
    await userEvent.type(name, '主视觉 02');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
    });
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toEqual({ name: '主视觉 02' });
    // 生成产物的 metadata 是生成结果，不该被这次编辑带上
    expect(JSON.stringify(patch?.body)).not.toContain('slug');
    expect(JSON.stringify(patch?.body)).not.toContain('coverUrl');
  });

  it('确认框开着时按 Esc 只关确认框，不连带关掉抽屉', async () => {
    /*
     * 两个组件都在 document 上监听 Escape，且抽屉先注册 —— 抽屉若照单全收，
     * 一次 Esc 会把确认框与抽屉一起关掉，用户刚填的东西跟着没了。
     * 断言必须盯 `onClose` 有没有被调用：renderDrawer 传的 assetId 是固定的，
     * 抽屉不会真的卸载，只断言「抽屉还在」的话这条用例会永远绿。
     */
    const { onClose } = renderDrawer(CHARACTER);
    await screen.findByLabelText('名称');
    await userEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(screen.getByRole('button', { name: '确认归档' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认归档' })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('名称')).toBeInTheDocument();

    // 反向：确认框没了之后，再按一次 Esc 应当真的关掉抽屉 ——
    // 少了这一半，一个「永不响应 Esc」的抽屉也能让上面那些断言通过
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('焦点 Tab 出确认框（落到 body）后按 Esc，仍然只关确认框', async () => {
    /*
     * 这一条钉的是 Esc 判据本身。
     * 判据曾经用「焦点落在哪个 role=dialog 里」，它在焦点走出所有模态后就失效
     * —— 而 `Drawer` 与 `Dialog` 都**刻意不做焦点陷阱**，所以「焦点在 body」
     * 是用户按几下 Tab 就能到达的真实状态，不是构造出来的怪状态。
     * 换成「DOM 序里的最后一个模态」之后这条才稳。
     */
    const { onClose } = renderDrawer(CHARACTER);
    await screen.findByLabelText('名称');
    await userEvent.click(screen.getByRole('button', { name: '归档' }));

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    expect(document.activeElement).toBe(document.body);

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认归档' })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('确认框开着时切到另一个资产 → 框必须关掉（否则一确认就删错对象）', async () => {
    const { release } = renderSwitcher();
    await screen.findByLabelText('名称');
    await userEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(screen.getByRole('button', { name: '确认归档' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '切到另一个资产' }));
    await screen.findByDisplayValue('主视觉');

    // 那个确认框是**为上一个资产**打开的：留着它，用户一点确认就把新资产删了
    expect(screen.queryByRole('button', { name: '确认归档' })).not.toBeInTheDocument();
    release('a1');
  });

  it('A→B 快速切换时，迟到的 A 响应不许覆盖 B', async () => {
    /*
     * 保存与归档都读 `state.asset.id`。迟到的响应若把 state 换回 A，
     * 用户看着 B 的界面、保存却写到了 A 上 —— 界面上完全看不出来。
     */
    const { release } = renderSwitcher({ slow: 'a1' });
    await userEvent.click(screen.getByRole('button', { name: '切到另一个资产' }));
    await screen.findByDisplayValue('主视觉');

    /*
     * 现在放行 A 的迟到响应，并把它的整条链路（fetch → text() → JSON.parse → setState，
     * 全是微任务）**确定性地**跑完。
     *
     * 为什么不是 `setTimeout(50)`：时间窗在慢机器上会失效，而且失效方向是**假绿**
     * —— 过期响应还没落地就断言，用例照样通过，等于没有护栏。
     * `act` 冲掉 React 的更新，再让出一个宏任务边界（宏任务一定排在所有微任务之后），
     * 两者合起来保证「该覆盖的已经覆盖完了」。
     *
     * 注意这条用例的护栏强度**必须靠对照证明**：去掉 `loadToken` 的两处检查后，
     * 它必须变红（见本任务 Step 7 的证伪要求）。不证明一次，就不知道它是不是假绿。
     */
    await act(async () => {
      release('a1');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(screen.getByLabelText('名称')).toHaveValue('主视觉');
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
