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
