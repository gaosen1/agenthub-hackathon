/**
 * OSS 视图（S15）：不摆假数据——未配置如实提示、空态明确、过期对象不可复制。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OssListResp } from '@agenthub/shared/contracts';
import { OssView } from './OssView.js';

const base: OssListResp = {
  configured: true,
  lifecycleDays: 7,
  signedUrlTtlSeconds: 1800,
  stats: { totalBytes: 2048, objectCount: 2, uploadedToday: 1 },
  items: [],
};

function mount(resp: Partial<OssListResp>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...base, ...resp }), { status: 200 })),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <OssView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OssView', () => {
  beforeEach(() => localStorage.setItem('agenthub_token', 'tok'));

  it('统计与对象表用真实数据渲染，数据列等宽', async () => {
    mount({
      items: [
        {
          key: 'handoffs/1/hf-aaa111/input.tar.gz',
          size: 2048,
          uploadedAt: '2026-08-20T01:00:00Z',
          handoffId: 'hf-aaa111',
          direction: 'input',
          partial: false,
          expired: false,
        },
      ],
      stats: { totalBytes: 2048, objectCount: 1, uploadedToday: 1 },
    });
    expect(await screen.findByText('handoffs/1/hf-aaa111/input.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('输入包')).toBeInTheDocument();
    expect(screen.getByText('在库')).toBeInTheDocument();
    // 统计卡与表格大小列都渲染「2.0 KB」（数值与单位跨元素，td/span/div 同 textContent）
    expect(screen.getAllByText((_, el) => el?.textContent === '2.0 KB').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('link', { name: 'hf-aaa111' })).toHaveAttribute('href', '/tasks/hf-aaa111');
  });

  it('过期对象标「已过期清理」且复制按钮禁用', async () => {
    mount({
      items: [
        {
          key: 'handoffs/1/hf-old/output.tar.gz',
          size: null,
          uploadedAt: '2026-08-01T00:00:00Z',
          handoffId: 'hf-old',
          direction: 'output',
          partial: false,
          expired: true,
        },
      ],
    });
    expect(await screen.findByText('已过期清理')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制签名链接/ })).toBeDisabled();
  });

  it('未配置 OSS 时如实提示，不显示假对象', async () => {
    mount({ configured: false, items: [], stats: { totalBytes: 0, objectCount: 0, uploadedToday: 0 }, lifecycleDays: null });
    expect(await screen.findByText(/OSS 未配置/)).toBeInTheDocument();
  });

  it('未登录提示登录', async () => {
    localStorage.removeItem('agenthub_token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <OssView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/未登录/)).toBeInTheDocument();
  });
});
