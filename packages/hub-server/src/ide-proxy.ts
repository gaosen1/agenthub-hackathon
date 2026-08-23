/**
 * Web IDE（code-server）透明反代管道（/api/handoffs/:id/ide/* → sandbox Pod :8082）
 * - 鉴权：Bearer JWT 或 ensure 时下发的 HttpOnly Cookie ah_ide（iframe 无法附加 Authorization 头）
 * - 支持 WebSocket upgrade（code-server 终端/重连）
 * - 上游根绝对 3xx Location 重写为带前缀路径（code-server 无 base-path 能力的兜底）
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { verifyJwt } from './auth.js';

export const IDE_COOKIE = 'ah_ide';
export const IDE_COOKIE_TTL_SECONDS = 2 * 3600;

/** 逐跳头与 Hub 侧凭证不转发给上游；origin 也剩掉：子路径代理下浏览器 Origin（hub 域）
 * 与上游 Host 不一致，code-server 会静默拒绝 WS 握手导致永久挂起 */
const SKIP_REQ_HEADERS = new Set(['connection', 'keep-alive', 'host', 'cookie', 'authorization', 'upgrade', 'origin']);
const SKIP_RES_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * IDE 凭证校验：优先 Bearer，回退 ah_ide Cookie；tv 轮换即时失效。
 * 通过返回 uid，否则 null。
 */
export function verifyIdeToken(
  headers: { authorization?: string | string[]; cookie?: string | string[] },
  secret: string,
  tvOf: (uid: number) => number | undefined,
): number | null {
  const candidates: string[] = [];
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) candidates.push(auth.slice(7));
  const cookieTok = parseCookies(typeof headers.cookie === 'string' ? headers.cookie : undefined)[IDE_COOKIE];
  if (cookieTok) candidates.push(cookieTok);
  for (const tok of candidates) {
    const payload = verifyJwt(tok, secret);
    if (!payload) continue;
    const tv = tvOf(payload.uid);
    if (tv === undefined || payload.tv !== tv) continue;
    return payload.uid;
  }
  return null;
}

function upstreamHeaders(headers: IncomingHttpHeaders, upstreamHost: string, keepAuthorization = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    // keepAuthorization 必须先于 SKIP 集判断（SKIP 含 authorization，否则是死代码）
    if (lk === 'authorization') {
      if (keepAuthorization) out[k] = Array.isArray(v) ? v.join(', ') : v;
      continue;
    }
    if (SKIP_REQ_HEADERS.has(lk)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['host'] = upstreamHost;
  return out;
}

export interface PipeOpts {
  /** 额外剥除的响应头（如 replay 代理剥 CSP/X-Frame-Options 以允许 iframe 嵌入） */
  stripResHeaders?: ReadonlySet<string>;
  /** 保留客户端 Authorization 透传（replay web-shell 自带 Bearer token） */
  keepAuthorization?: boolean;
}

/** HTTP 透明转发：剥前缀后的 upstreamPath 直连 code-server，Location 根绝对路径补前缀 */
export function pipeHttp(
  raw: IncomingMessage,
  res: ServerResponse,
  upstreamBase: string,
  upstreamPath: string,
  pathPrefix: string,
  opts?: PipeOpts,
): void {
  const u = new URL(upstreamBase);
  const upReq = httpRequest(
    {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 80,
      path: upstreamPath,
      method: raw.method ?? 'GET',
      headers: upstreamHeaders(raw.headers, u.host, opts?.keepAuthorization),
    },
    (upRes) => {
      const headers: Record<string, string | string[]> = {};
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        const k = upRes.rawHeaders[i]!.toLowerCase();
        const v = upRes.rawHeaders[i + 1]!;
        if (SKIP_RES_HEADERS.has(k) || opts?.stripResHeaders?.has(k)) continue;
        if (k === 'location' && v.startsWith('/')) {
          headers[k] = pathPrefix + v;
          continue;
        }
        const prev = headers[k];
        headers[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    },
  );
  upReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ERR_RUNNER', message: 'IDE upstream unreachable' } }));
    } else {
      res.end();
    }
  });
  raw.pipe(upReq);
}

/** WebSocket upgrade 透明转发：向上游发起 upgrade 并把 101 响应与双向流接回客户端 */
export function pipeUpgrade(
  headers: IncomingHttpHeaders,
  socket: Duplex,
  head: Buffer,
  upstreamBase: string,
  upstreamPath: string,
): void {
  const u = new URL(upstreamBase);
  const upReq = httpRequest({
    hostname: u.hostname,
    port: u.port ? Number(u.port) : 80,
    path: upstreamPath,
    method: 'GET',
    headers: {
      ...upstreamHeaders(headers, u.host),
      connection: 'upgrade',
      upgrade: (headers.upgrade as string) ?? 'websocket',
    },
  });
  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);
    // 任一侧断连（浏览器关闭 / port-forward 通道 ECONNRESET）都不能让进程崩：
    // 裸 socket 无 error 监听时 'error' 事件会直接 crash
    const teardown = (): void => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', teardown);
    socket.on('error', teardown);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upReq.on('error', () => socket.destroy());
  upReq.end();
}
