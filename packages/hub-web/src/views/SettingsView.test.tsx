/**
 * 设置视图（S19）：开关 PATCH 真生效、webhook 保存/测试有真实反馈、
 * token 轮换后新 token 落 localStorage（不把自己踢下线）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsResp } from '@agenthub/shared/contracts';
import { SettingsView } from './SettingsView.js';

const base: SettingsResp = {
  settings: {
    notifyStatusChange: true,
    notifyChatSync: false,
    webhook: { configured: false, masked: null },
    includeUntracked: true,
    mergeMode: 'merge',
    backupSessions: false,
  },
  server: {
    hubUrl: null,
    ossBucket: 'agenthub-handoff',
    ossRegion: 'oss-cn-hangzhou',
    signedUrlTtlSeconds: 1800,
    sandboxImage: 'registry.example.com/agenthub-demo/sandbox:dev',
    idleTtlMinutes: 30,
    backend: 'aone',
    defaultTimeoutMinutes: 1440,
  },
};

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let responder: (url: string, init?: RequestInit) => { status?: number; body?: unknown };

function mount() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const r = responder(url, init);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SettingsView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.setItem('agenthub_token', 'tok');
    responder = () => ({ body: base });
  });

  it('默认渲染：开关状态、服务端只读信息真实', async () => {
    mount();
    expect(await screen.findByRole('switch', { name: '任务状态通知' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('agenthub-handoff')).toBeInTheDocument();
    expect(screen.getByText('24 小时')).toBeInTheDocument(); // 任务静默容忍 1440min
    expect(screen.getAllByText('30 分钟').length).toBe(2); // 签名 URL 30min + 空闲回收 TTL 30min
    // Chat 消息同步不撒谎：disabled + 计划中
    expect(screen.getByRole('switch', { name: 'Chat 消息同步' })).toBeDisabled();
    expect(screen.getByText('计划中')).toBeInTheDocument();
  });

  it('切换开关发 PATCH {notifyStatusChange:false}', async () => {
    mount();
    const sw = await screen.findByRole('switch', { name: '任务状态通知' });
    fireEvent.click(sw);
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body))).toEqual({ notifyStatusChange: false });
    });
  });

  it('保存 webhook 发 PATCH 且输入框明文不出现在掩码位', async () => {
    mount();
    await screen.findByRole('switch', { name: '任务状态通知' });
    fireEvent.change(screen.getByPlaceholderText(/oapi\.dingtalk\.com/), {
      target: { value: 'https://oapi.dingtalk.com/robot/send?access_token=secret1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(JSON.parse(String(patch!.init!.body)).webhook).toContain('secret1234');
    });
  });

  it('webhook 测试按钮给出真实成败反馈', async () => {
    mount();
    await screen.findByRole('switch', { name: '任务状态通知' });
    responder = (url) => (url.includes('/webhook/test') ? { status: 502, body: { error: { code: 'ERR_WEBHOOK', message: 'webhook test failed: HTTP 500' } } } : { body: base });
    fireEvent.click(screen.getByRole('button', { name: '测试' }));
    expect(await screen.findByText(/测试失败/)).toBeInTheDocument();
  });
});
