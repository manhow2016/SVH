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
