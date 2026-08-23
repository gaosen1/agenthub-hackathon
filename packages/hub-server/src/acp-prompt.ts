/**
 * hub 侧最小 ACP prompt runner：bot 唤醒后把「唤醒那条问题」经沙箱 serve 的 /acp 跑掉，
 * 收集 agent_message_chunk 拼成全文经 sessionWebhook 回钉钉。
 * 帧序列与 sandbox 包 qwen.ts runTaskViaServe 同构（initialize → session/new →
 * session/prompt；连接级 SSE 收应答帧，session 级 SSE 收 session/update 流）。
 */
export async function runPromptViaServe(base: string, cwd: string, question: string, timeoutMs = 10 * 60_000): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let rpcId = 0;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const resolved = new Map<number, Record<string, unknown>>();
  const settle = (m: Record<string, unknown>): void => {
    const cb = pending.get(m.id as number);
    if (cb) {
      pending.delete(m.id as number);
      cb(m);
    } else {
      resolved.set(m.id as number, m);
    }
  };
  const post = async (method: string, params: unknown): Promise<number> => {
    const id = ++rpcId;
    const r = await fetch(`${base}/acp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const cid = r.headers.get('acp-connection-id');
    if (cid) headers['acp-connection-id'] = cid;
    if (r.status >= 400) throw new Error(`ACP ${method} → ${r.status}`);
    try {
      const m = JSON.parse(await r.text()) as Record<string, unknown>;
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) settle(m);
    } catch {
      // 应答帧走 SSE
    }
    return id;
  };
  const wait = (id: number, ms: number): Promise<Record<string, unknown>> => {
    const hit = resolved.get(id);
    if (hit) {
      resolved.delete(id);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP 应答超时（#${id}）`));
      }, ms);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  };

  let out = '';
  const ac = new AbortController();
  const gate = { live: false };
  const openSse = (extra: Record<string, string> = {}): Promise<void> =>
    (async () => {
      const r = await fetch(`${base}/acp`, {
        headers: { accept: 'text/event-stream', ...headers, ...extra },
        signal: ac.signal,
      });
      if (!r.ok || !r.body) return;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let sbuf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sbuf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = sbuf.indexOf('\n\n')) >= 0) {
          const frame = sbuf.slice(0, idx);
          sbuf = sbuf.slice(idx + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
            settle(m);
            continue;
          }
          if (m.method !== 'session/update' || !gate.live) continue;
          const u = ((m as { params?: { update?: Record<string, unknown> } }).params?.update) ?? {};
          if (u.sessionUpdate === 'agent_message_chunk') {
            out += ((u.content as { text?: string } | undefined)?.text ?? (u.text as string | undefined)) ?? '';
          }
        }
      }
    })().catch(() => undefined);
  const sseConns: Array<Promise<void>> = [openSse()];

  try {
    const initId = await post('initialize', { protocolVersion: 1 });
    await wait(initId, 15_000);
    const newId = await post('session/new', { cwd, mcpServers: [] });
    const newResp = await wait(newId, 30_000);
    const sessionId = (newResp.result as { sessionId?: string } | undefined)?.sessionId;
    if (newResp.error || !sessionId) throw new Error('session/new 失败');
    sseConns.push(openSse({ 'acp-session-id': sessionId }));
    const promptId = await post('session/prompt', { sessionId, prompt: [{ type: 'text', text: question }] });
    gate.live = true;
    const resp = await wait(promptId, timeoutMs);
    if (resp.error) throw new Error('session/prompt 失败');
    return out.trim();
  } finally {
    ac.abort();
    void sseConns;
  }
}
