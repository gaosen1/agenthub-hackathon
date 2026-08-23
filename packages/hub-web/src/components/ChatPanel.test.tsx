/**
 * ChatPanel：单 UI 架构——running 与终态均由 qwen-code 原生 Web Shell iframe 承载
 * （终态走后端本地 replay serve）；入口不可达/无返回包时诚实占位，无自研聊天 UI 回退。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { ChatPanel } from './ChatPanel.js';
import { setDataSource } from '../api/client.js';
import { clearEventCursors } from '../api/hooks.js';

const detail = { id: 'hf-shell1', status: 'running', sessionId: 'sess-1' } as unknown as HandoffDetail;

function mount(d: HandoffDetail) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatPanel detail={d} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearEventCursors();
  setDataSource('hub');
  localStorage.setItem('agenthub_token', 't');
});

describe('ChatPanel Web Shell 承载（running）', () => {
  it('可达时 iframe 嵌入 shell（src 为 port-forward 地址）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://127.0.0.1:55512', reachable: true }), { status: 200 })),
    );
    mount(detail);
    const frame = await screen.findByTitle('Qwen Code Web Shell');
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:55512');
  });

  it('bot 载体 running 同样嵌 Web Shell（serve 先起，task 流式可见）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://127.0.0.1:55513', reachable: true }), { status: 200 })),
    );
    mount({ ...detail, kind: 'bot' } as unknown as HandoffDetail);
    const frame = await screen.findByTitle('Qwen Code Web Shell');
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:55513');
  });

  it('running 但入口报错时显示诚实空态，无 iframe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'ERR_NOT_READY', message: 'sandbox not provisioned' } }), { status: 409 })),
    );
    mount(detail);
    expect(await screen.findByText(/云端会话不可用/)).toBeInTheDocument();
    expect(screen.queryByTitle('Qwen Code Web Shell')).toBeNull();
  });

  it('reachable=false 提示不可直达（hub 与浏览器不同机）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://10.0.0.1:8081', reachable: false }), { status: 200 })),
    );
    mount(detail);
    expect(await screen.findByText(/不可直达/)).toBeInTheDocument();
  });

  it('周期重取返回新入口时更换 iframe src（转发死亡/hub 重启恢复）', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'http://127.0.0.1:55512', reachable: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'http://127.0.0.1:55999', reachable: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount(detail);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55512');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55999');
  });
});

describe('ChatPanel 终态 Web Shell 回放（单 UI）', () => {
  const doneDetail = {
    id: 'hf-done1',
    status: 'done',
    sessionId: 'sess-9',
    task: '把功能做完',
    createdAt: '2026-08-22T10:00:00Z',
  } as unknown as HandoffDetail;

  it('done 且 replay serve 可达时继续嵌原生 Web Shell iframe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://127.0.0.1:55700/session/sess-9', reachable: true }), { status: 200 })),
    );
    mount(doneDetail);
    const frame = await screen.findByTitle('Qwen Code Web Shell');
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:55700/session/sess-9');
    expect(screen.getByText(/会话回放/)).toBeInTheDocument();
  });

  it('无返回包时诚实占位，不回退自研聊天 UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: '', reachable: false }), { status: 200 })),
    );
    mount({ ...doneDetail, task: undefined } as unknown as HandoffDetail);
    expect(await screen.findByText(/Web Shell 回放不可用/)).toBeInTheDocument();
    expect(screen.queryByTitle('Qwen Code Web Shell')).toBeNull();
  });
});
