/**
 * 路由外壳（S3）。重点是 `/tasks/:id` 深链——hub-server 创建 handoff 时返回的
 * `webUrl = <base>/tasks/<id>` 此前无人消费，链接能打开但渲染的是错误的任务。
 *
 * 这里用 useRoutes(routes) + MemoryRouter（声明式路由）而不是 createMemoryRouter：
 * react-router 7 的数据路由在导航时会 new Request(...)，而 jsdom 的 AbortSignal
 * 与 Node undici 的 Request 不同源，会抛 "Expected signal to be an instance of AbortSignal"。
 * 那是测试环境的兼容问题，与被验证的路由行为无关；真实浏览器里不存在。
 * 换成声明式路由后跑的仍是同一份 routes 表。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes.js';
import { mockSummaries } from './api/mock.js';

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function Harness() {
  return (
    <>
      {useRoutes(routes)}
      <LocationProbe />
    </>
  );
}

function mount(at: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pathname = () => screen.getByTestId('pathname').textContent;

describe('路由外壳', () => {
  beforeEach(() => {
    // Hub 不可达 → client.ts 回退 mock，视图有稳定数据可渲染
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
  });

  it('根路径重定向到 /tasks', async () => {
    mount('/');
    await waitFor(() => expect(pathname()).toBe('/tasks'));
  });

  it('/tasks 无 id 时落到列表第一个任务', async () => {
    mount('/tasks');
    await waitFor(() => expect(pathname()).toBe(`/tasks/${mockSummaries[0]!.id}`));
  });

  it('/tasks/:id 深链保持指定任务，不被重定向走', async () => {
    const target = mockSummaries[1]!.id;
    mount(`/tasks/${target}`);

    await waitFor(() => expect(screen.getByRole('navigation')).toBeInTheDocument());
    expect(pathname()).toBe(`/tasks/${target}`);
  });

  it('未知路径兜底回 /tasks', async () => {
    mount('/nope');
    await waitFor(() => expect(pathname()).toBe('/tasks'));
  });

  it.each([
    ['/sandbox', 'Sandbox 调度层'],
    ['/oss', 'OSS 对象存储'],
    ['/settings', '设置'],
  ])('%s 可达且渲染自己的标题', async (path, title) => {
    mount(path);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(pathname()).toBe(path);
  });
});
