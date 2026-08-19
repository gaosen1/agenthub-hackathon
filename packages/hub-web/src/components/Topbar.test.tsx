import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Topbar } from './Topbar.js';

// Topbar 用 NavLink 高亮当前 tab，必须有 router 上下文
const wrap = (ui: ReactNode, at = '/tasks') => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

describe('Topbar', () => {
  it('默认 mock 数据源下提示未连接，并给出登录入口', async () => {
    const onLogin = vi.fn();
    render(wrap(<Topbar onLogin={onLogin} />));

    expect(screen.getByText('Mock 数据 · Hub 未连接')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /登录/ }));
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it('渲染原型定义的四个顶级 tab', () => {
    render(wrap(<Topbar onLogin={vi.fn()} />));

    const labels = ['Handoff 任务', 'Sandbox', 'OSS 存储', '设置'];
    for (const label of labels) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('当前路由对应的 tab 标记 active', () => {
    render(wrap(<Topbar onLogin={vi.fn()} />, '/oss'));

    expect(screen.getByRole('link', { name: /OSS 存储/ })).toHaveClass('active');
    expect(screen.getByRole('link', { name: /Sandbox/ })).not.toHaveClass('active');
  });
});
