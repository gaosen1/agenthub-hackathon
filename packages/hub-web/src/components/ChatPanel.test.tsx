/**
 * ChatPanel = Web Shell 承载面：可达时 iframe 同 src 嵌入；不可达/非 running 诚实空态。
 */
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { ChatPanel } from './ChatPanel.js';

const detail = { id: 'hf-shell1', status: 'running', sessionId: 'sess-1' } as unknown as HandoffDetail;

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChatPanel Web Shell 承载', () => {
  it('可达时 iframe 嵌入 shell（src 为 port-forward 地址）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://127.0.0.1:55512', reachable: true }), { status: 200 })),
    );
    render(<ChatPanel detail={detail} />);
    const frame = await screen.findByTitle('Qwen Code Web Shell');
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:55512');
  });

  it('非 running（409）显示诚实空态，无 iframe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'ERR_NOT_READY', message: 'handoff is done' } }), { status: 409 })),
    );
    render(<ChatPanel detail={detail} />);
    expect(await screen.findByText(/云端会话不可用/)).toBeInTheDocument();
    expect(screen.queryByTitle('Qwen Code Web Shell')).toBeNull();
  });

  it('reachable=false 提示不可直达（hub 与浏览器不同机）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'http://10.0.0.1:8081', reachable: false }), { status: 200 })),
    );
    render(<ChatPanel detail={detail} />);
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
    render(<ChatPanel detail={detail} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55512');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTitle('Qwen Code Web Shell')).toHaveAttribute('src', 'http://127.0.0.1:55999');
  });
});
