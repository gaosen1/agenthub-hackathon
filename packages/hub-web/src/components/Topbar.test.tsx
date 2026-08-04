import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Topbar } from './Topbar.js';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
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
});
