/**
 * Sandbox 面板（S10）。重点验证「不摆假数据」：
 * 未配置编排要如实提示，空数据给明确空态，bot 实例没有 handoff 深链。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { SandboxListResp } from '@agenthub/shared/contracts';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxView } from './SandboxView.js';

const baseResp: SandboxListResp = {
  configured: true,
  windowHours: 24,
  items: [],
  stats: { running: 0, reclaimedInWindow: 0, templates: 1, execSecondsInWindow: 0 },
  template: {
    image: 'registry.example.com/agenthub-demo/sandbox:dev',
    namespace: 'agenthub',
    baseImage: 'node:22-slim',
    qwenVersion: '0.20.1',
    toolchain: ['Node.js 22', 'Qwen Code 0.20.1', 'git', 'ripgrep', 'procps'],
    resources: { cpu: '2', memory: '4Gi' },
    ports: { runner: 8080, serve: 8081 },
    acs: true,
    backend: 'k8s',
  },
  policy: {
    defaultTimeoutMinutes: 30,
    idleTtlMinutes: 120,
    taskLingerMinutes: 0,
    orphanIntervalMs: 600_000,
    workerIntervalMs: 5000,
  },
};

function mount(resp: Partial<SandboxListResp>) {
  const body = { ...baseResp, ...resp };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SandboxView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SandboxView', () => {
  beforeEach(() => {
    localStorage.setItem('agenthub_token', 'tok');
  });

  it('副标题写 ACK/ACS，不沿用原型虚构的 E2B', async () => {
    mount({});
    expect(await screen.findByRole('heading', { name: 'Sandbox 调度层' })).toBeInTheDocument();
    const sub = screen.getByText(/ACK 集群/);
    expect(sub).toBeInTheDocument();
    expect(screen.queryByText(/E2B/)).not.toBeInTheDocument();
  });

  it('模板卡展示真实镜像与资源规格，不出现原型写死的 qwen-code:v1.4.2', async () => {
    mount({});
    expect(await screen.findByText('registry.example.com/agenthub-demo/sandbox:dev')).toBeInTheDocument();
    expect(screen.getByText(/单实例 2 core \/ 4Gi/)).toBeInTheDocument();
    expect(screen.getByText('Qwen Code 0.20.1')).toBeInTheDocument();
    expect(screen.queryByText(/v1\.4\.2/)).not.toBeInTheDocument();
  });

  it('策略卡用真实配置渲染，随配置变化', async () => {
    mount({ policy: { ...baseResp.policy, idleTtlMinutes: 45, orphanIntervalMs: 1_200_000, defaultTimeoutMinutes: 60 } });
    expect(await screen.findByText(/空闲超 45 分钟回收/)).toBeInTheDocument();
    expect(screen.getByText(/默认 1 小时硬超时/)).toBeInTheDocument();
    expect(screen.getByText(/每 20 分钟清理无关联任务的孤儿实例/)).toBeInTheDocument();
  });

  it('aone 后端副标题与模板卡如实标注', async () => {
    mount({ template: { ...baseResp.template!, backend: 'aone', acs: false } });
    expect(await screen.findByText(/Aone 沙箱 · 弹内算力/)).toBeInTheDocument();
    expect(screen.getByText(/Aone 沙箱（弹内算力）/)).toBeInTheDocument();
  });

  it('web 实例给出 handoff 深链，bot 实例没有归属故不给链接', async () => {
    mount({
      items: [
        {
          podName: 'ah-web-9f3a2c',
          kind: 'web',
          handoffId: 'hf-9f3a2c',
          botId: null,
          image: 'img',
          status: 'running',
          createdAt: '2026-08-04T14:03:00.000Z',
          readyAt: '2026-08-04T14:03:52.000Z',
          endedAt: null,
          durationSeconds: null,
          reclaimReason: null,
          lastError: null,
        },
        {
          podName: 'ah-bot-1-ops',
          kind: 'bot',
          handoffId: null,
          botId: 1,
          image: 'img',
          status: 'reclaimed',
          createdAt: '2026-08-04T10:00:00.000Z',
          readyAt: '2026-08-04T10:00:10.000Z',
          endedAt: '2026-08-04T10:12:50.000Z',
          durationSeconds: 760,
          reclaimReason: 'bot-deleted',
          lastError: null,
        },
      ],
      stats: { running: 1, reclaimedInWindow: 1, templates: 1, execSecondsInWindow: 760 },
    });

    expect(await screen.findByRole('link', { name: 'hf-9f3a2c' })).toHaveAttribute('href', '/tasks/hf-9f3a2c');
    expect(screen.getByText('ah-bot-1-ops')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    // 时长按 ready→ended 展示；未结束的实例不编造数字
    expect(screen.getByText('12m 40s')).toBeInTheDocument();
    expect(screen.getByText('已回收')).toBeInTheDocument();
    expect(screen.getByText('Bot 已删除')).toBeInTheDocument();
  });

  it('未配置编排时如实提示，而不是显示空模板', async () => {
    mount({ configured: false, template: null, stats: { ...baseResp.stats, templates: 0 } });
    expect(await screen.findByText('编排未启用')).toBeInTheDocument();
    expect(screen.getByText(/HUB_NO_K8S/)).toBeInTheDocument();
  });

  it('无实例时给明确空态', async () => {
    mount({});
    expect(await screen.findByText(/近 24 小时内没有 Sandbox 实例/)).toBeInTheDocument();
  });

  it('未登录时提示登录而不是报错堆栈', async () => {
    localStorage.removeItem('agenthub_token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SandboxView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/未登录，请点击右上角登录/)).toBeInTheDocument();
  });
});
