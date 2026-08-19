/**
 * client.ts 的三态数据源契约（spec §7 CP-3）：
 * Hub 不可达 → mock 回退；401 → unauth 且不回退；正常 → hub。
 */
import { describe, expect, it, vi } from 'vitest';

/** dataSource 是 client.ts 里的 module 级可变量，每个用例重新 import 取干净初值 */
async function freshClient() {
  vi.resetModules();
  return import('./client.js');
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('client 数据源回退', () => {
  it('初始态为 mock', async () => {
    const client = await freshClient();
    expect(client.dataSource).toBe('mock');
  });

  it('Hub 不可达 → 回退 mock 数据', async () => {
    const client = await freshClient();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const { items } = await client.fetchHandoffs();

    expect(items.length).toBeGreaterThan(0);
    expect(client.dataSource).toBe('mock');
  });

  it('Hub 可达但 401 → unauth，且不回退 mock', async () => {
    const client = await freshClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

    const { items } = await client.fetchHandoffs();

    expect(items).toEqual([]);
    expect(client.dataSource).toBe('unauth');
  });

  it('Hub 正常应答 → hub，且带上 Bearer token', async () => {
    const client = await freshClient();
    localStorage.setItem('agenthub_token', 'tok-1');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const { items } = await client.fetchHandoffs();

    expect(items).toEqual([]);
    expect(client.dataSource).toBe('hub');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
  });

  it('登录成功后写入 token 并置为 hub', async () => {
    const client = await freshClient();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ token: 'tok-2', user: { id: 1, username: 'devuser' } })),
    );

    await client.login('devuser', 'pw');

    expect(client.getToken()).toBe('tok-2');
    expect(client.dataSource).toBe('hub');
  });
});
