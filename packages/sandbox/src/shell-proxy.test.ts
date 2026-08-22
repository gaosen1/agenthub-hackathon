/**
 * shell-proxy：剥 serve 的 CSP/X-Frame-Options（frame-ancestors 'none' 只放行 extension://），
 * 正文透传不缓冲破坏 SSE（按 chunk write）。
 */
import { createServer } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { startShellProxy } from './shell-proxy.js';

const PROXY_PORT = 8082;
let upstreamPort: number;

beforeAll(async () => {
  const up = createServer((_q, s) => {
    s.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    s.end('<html>shell</html>');
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (up.address() as { port: number }).port;
  startShellProxy(upstreamPort, PROXY_PORT);
  await new Promise((r) => setTimeout(r, 300));
});

describe('shell-proxy', () => {
  it('剥 CSP/X-Frame-Options，正文原样透传', async () => {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBeNull();
    expect(r.headers.get('x-frame-options')).toBeNull();
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toBe('<html>shell</html>');
  });
});
