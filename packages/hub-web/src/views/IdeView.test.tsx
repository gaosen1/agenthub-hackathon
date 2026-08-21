/**
 * Web IDE 视图：ensure 成功渲染 iframe；NAS 未播种给运维指引；其他错误如实展示。
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdeView } from './IdeView.js';

function mount(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  return render(
    <MemoryRouter initialEntries={['/tasks/hf-9f3a2c/ide']}>
      <Routes>
        <Route path="/tasks/:id/ide" element={<IdeView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('IdeView', () => {
  beforeEach(() => {
    localStorage.setItem('agenthub_token', 'tok');
  });

  it('ensure 就绪后渲染指向代理路径的 iframe', async () => {
    mount(() => json(200, { ready: true, pid: 777 }));
    const frame = await screen.findByTitle('Web IDE');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('/api/handoffs/hf-9f3a2c/ide/');
  });

  it('NAS 未预置 code-server 时给 seed Job 指引', async () => {
    mount(() => json(409, { error: { code: 'ERR_NOT_READY', message: 'code-server not preinstalled on shared layer' } }));
    expect(await screen.findByText(/NAS 共享层尚未预置/)).toBeInTheDocument();
    expect(screen.getByText(/30-nas-seed-job\.yaml/)).toBeInTheDocument();
  });

  it('其他错误如实展示（如 handoff 已终态）', async () => {
    mount(() => json(409, { error: { code: 'ERR_NOT_READY', message: 'handoff is done' } }));
    expect(await screen.findByText(/handoff is done/)).toBeInTheDocument();
  });
});
