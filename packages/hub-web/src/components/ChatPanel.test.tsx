/**
 * ChatPanel：running 时 iframe 承载 Web Shell（可达嵌入/不可达提示/探针换 src）；
 * 终态回退只读历史回放（task 指令 + [task] relay 卡片），不再请求 shell 入口。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { ChatPanel } from './ChatPanel.js';
import { setDataSource } from '../api/client.js';

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

  it('存活探针拒绝（转发死亡）时重取入口并更换 iframe src', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'http://127.0.0.1:55512', reachable: true }), { status: 200 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'http://127.0.0.1:55999', reachable: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount(detail);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55512');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55999');
  });
});

describe('ChatPanel 终态历史回放', () => {
  const doneDetail = {
    id: 'hf-done1',
    status: 'done',
    sessionId: 'sess-9',
    task: '把功能做完',
    createdAt: '2026-08-22T10:00:00Z',
  } as unknown as HandoffDetail;

  it('done handoff 渲染 task 指令与 [task] relay 卡片，无 iframe', async () => {
    const events = {
      items: [
        { id: 1, at: '2026-08-22T10:01:00Z', kind: 'log', payload: JSON.stringify({ t: 'x', tag: 'info', c: '[task] 已全部完成' }) },
      ],
      nextAfter: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const body = url.includes('/events') ? events : { items: [] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    mount(doneDetail);
    expect(await screen.findByText('把功能做完')).toBeInTheDocument();
    expect(await screen.findByText(/已全部完成/)).toBeInTheDocument();
    expect(screen.getByText(/历史回放/)).toBeInTheDocument();
    expect(screen.queryByTitle('Qwen Code Web Shell')).toBeNull();
  });

  it('无事件记录时诚实提示，不摆假数据', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [], nextAfter: 0 }), { status: 200 }))),
    );
    mount({ ...doneDetail, task: undefined } as unknown as HandoffDetail);
    expect(await screen.findByText(/无文本记录/)).toBeInTheDocument();
  });
});
