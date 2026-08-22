/**
 * Web Shell 头部改写代理：qwen serve 对 http 祖先硬设 frame-ancestors 'none'
 *（frameAncestors 只放行 chrome/moz-extension://），侧栏 iframe 永远不合法。
 * Pod 内 8082 起一层透明转发：剥 CSP/X-Frame-Options，含 WS upgrade；
 * hub port-forward 指向 8082，shell 同源语义不变（/assets、/acp、WS 原样穿过）。
 */
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';

const STRIP_HEADERS = ['content-security-policy', 'x-frame-options'];

let singleton: Server | null = null;

export function startShellProxy(targetPort: number, listenPort: number): void {
  if (singleton) return; // 模块级单例：重复 /load 不二次 bind
  const server = createServer((req, res) => {
    // qwen serve（vite 内核）校验 Host：客户端原始 Host 带代理端口会被 403 Invalid Host，改写为真实目标
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const proxyReq = request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
      (pr) => {
        const headers = { ...pr.headers };
        for (const h of STRIP_HEADERS) delete headers[h];
        res.writeHead(pr.statusCode ?? 502, headers);
        pr.on('data', (c: Buffer) => res.write(c));
        pr.on('end', () => res.end());
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('shell proxy error');
    });
    req.pipe(proxyReq);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]!.toLowerCase() === 'host') continue; // 同 HTTP 路径：Host 改写
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`host: 127.0.0.1:${targetPort}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.on('error', () => {
    singleton = null; // EADDRINUSE 等：静默降级，shell 入口不可用但主流程不受影响
  });
  server.listen(listenPort, '0.0.0.0', () => {
    singleton = server;
  });
}

let runnerSingleton: Server | null = null;

/**
 * runner API 绕行代理：Aone 入口网关对 8080 端口有特殊处理（实测空 200，疑 execd 保留），
 * 裸代理 8085→8080 透明转发（含 WS），网关侧改走 8085。
 */
export function startRunnerProxy(targetPort: number, listenPort: number): void {
  if (runnerSingleton) return;
  const server = createServer((req, res) => {
    const proxyReq = request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (pr) => {
        res.writeHead(pr.statusCode ?? 502, pr.headers);
        pr.on('data', (c: Buffer) => res.write(c));
        pr.on('end', () => res.end());
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('runner proxy error');
    });
    req.pipe(proxyReq);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.on('error', () => {
    runnerSingleton = null;
  });
  server.listen(listenPort, '0.0.0.0', () => {
    runnerSingleton = server;
  });
}
