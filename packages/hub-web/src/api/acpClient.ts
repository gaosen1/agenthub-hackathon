/**
 * ACP over HTTP 浏览器薄客户端（spec §4.4；参照 scripts/acp-chat.mjs 移植）
 * 传输：POST /api/handoffs/:id/chat/acp（提交）+ GET SSE（收流）+ DELETE（关连接）
 */
import type { AcpFrame, JsonRpcResponse, SessionUpdateParams } from '@agenthub/shared/contracts';
import { getToken } from './client.js';

export interface AcpEvents {
  /** session/update 通知（增量输出/工具调用） */
  onUpdate: (params: SessionUpdateParams) => void;
  /** 连接/加载出错（UI 提示） */
  onError: (message: string) => void;
}

export class AcpClient {
  private rpcId = 0;
  private connId = '';
  private readonly pending = new Map<number, (m: JsonRpcResponse) => void>();
  private readonly resolved = new Map<number, JsonRpcResponse>();
  private aborts: AbortController[] = [];
  private closed = false;

  constructor(
    private readonly handoffId: string,
    private readonly events: AcpEvents,
  ) {}

  private get url(): string {
    return `/api/handoffs/${this.handoffId}/chat/acp`;
  }

  private authHeaders(): Record<string, string> {
    const t = getToken();
    return {
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(this.connId ? { 'acp-connection-id': this.connId } : {}),
    };
  }

  private settle(msg: JsonRpcResponse): void {
    const cb = this.pending.get(msg.id);
    if (cb) {
      this.pending.delete(msg.id);
      cb(msg);
    } else {
      this.resolved.set(msg.id, msg);
    }
  }

  private async post(method: string, params: unknown): Promise<number> {
    const id = ++this.rpcId;
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const cid = resp.headers.get('acp-connection-id');
    if (cid) this.connId = cid;
    if (resp.status >= 400) {
      const text = await resp.text().catch(() => '');
      throw new Error(`ACP ${method} → ${resp.status} ${text.slice(0, 120)}`);
    }
    // 同步应答直接 resolve；202 空体走 SSE
    try {
      const msg = JSON.parse(await resp.text()) as JsonRpcResponse;
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) this.settle(msg);
    } catch {
      // SSE 帧稍后到达
    }
    return id;
  }

  private waitResp(id: number, ms: number): Promise<JsonRpcResponse> {
    const hit = this.resolved.get(id);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 应答超时（#${id}）`));
      }, ms);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  private async openSse(extra: Record<string, string> = {}): Promise<void> {
    const ac = new AbortController();
    this.aborts.push(ac);
    const resp = await fetch(this.url, {
      headers: { ...this.authHeaders(), accept: 'text/event-stream', ...extra },
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`SSE 连接失败 ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (!data) continue;
            let msg: AcpFrame;
            try {
              msg = JSON.parse(data) as AcpFrame;
            } catch {
              continue;
            }
            if ('id' in msg && ('result' in msg || 'error' in msg)) {
              this.settle(msg as JsonRpcResponse);
            } else if ('method' in msg && msg.method === 'session/update') {
              this.events.onUpdate((msg as { params: SessionUpdateParams }).params);
            }
          }
        }
      } catch (e) {
        if (!this.closed) this.events.onError(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  /** initialize → 连接级 SSE → session/load → session 级 SSE */
  async connect(sessionId: string, cwd: string): Promise<void> {
    const initId = await this.post('initialize', { protocolVersion: 1 });
    await this.waitResp(initId, 30_000);
    await this.openSse();
    const loadId = await this.post('session/load', { sessionId, cwd });
    const resp = await this.waitResp(loadId, 60_000);
    if (resp.error) throw new Error(`session/load 失败: ${resp.error.message}`);
    await this.openSse({ 'acp-session-id': sessionId });
  }

  /** 发一轮 prompt；应答帧到达即本轮完成 */
  async prompt(sessionId: string, text: string): Promise<void> {
    const id = await this.post('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    const resp = await this.waitResp(id, 300_000);
    if (resp.error) throw new Error(`prompt 失败: ${resp.error.message}`);
  }

  close(): void {
    this.closed = true;
    for (const ac of this.aborts) ac.abort();
    this.aborts = [];
    void fetch(this.url, { method: 'DELETE', headers: this.authHeaders() }).catch(() => undefined);
  }
}
