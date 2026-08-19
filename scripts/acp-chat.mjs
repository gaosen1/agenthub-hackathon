// E2E: 通过 hub 反代与云端沙箱的 qwen serve 进行 ACP 对话
import { readFileSync } from 'node:fs';

const HUB = 'http://127.0.0.1:4180';
const HANDOFF = process.argv[2] ?? 'hf-3f9bd4';
const SESSION = process.argv[3] ?? '31da5e3d-a0ae-46bb-8f19-de66a4eb6fab';
const CWD = '/private/tmp/hub-e2e/demo-repo';
const PROMPT = process.argv[4] ?? '请只用一句话回答：math.js 里定义了什么函数？';

const token = JSON.parse(readFileSync(`${process.env.HOME}/.agenthub/config.json`, 'utf8')).token;
const url = `${HUB}/api/handoffs/${HANDOFF}/chat/acp`;
const auth = { authorization: `Bearer ${token}` };

let rpcId = 0;
let connId = '';
const pending = new Map();
const resolved = new Map();

function settle(msg) {
  if (pending.has(msg.id)) pending.get(msg.id)(msg);
  else resolved.set(msg.id, msg);
}

async function post(method, params) {
  const id = ++rpcId;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', ...(connId ? { 'acp-connection-id': connId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const cid = r.headers.get('acp-connection-id');
  if (cid) connId = cid;
  console.log(`>> POST ${method} → ${r.status}`);
  const text = await r.text();
  if (r.status >= 400) { console.log(text); return id; }
  // 同步应答直接 resolve
  try {
    const msg = JSON.parse(text);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      console.log(`<< sync resp#${msg.id}:`, JSON.stringify(msg.result ?? msg.error).slice(0, 200));
      settle(msg);
    }
  } catch { /* 202 空体走 SSE */ }
  return id;
}

const waitResp = (id, ms = 120000) => new Promise((res, rej) => {
  if (resolved.has(id)) return res(resolved.get(id));
  const t = setTimeout(() => rej(new Error(`timeout waiting resp#${id}`)), ms);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
});

// 1. initialize（服务端分配 connection id）
const initId = await post('initialize', { protocolVersion: 1 });
await waitResp(initId, 30000);
console.log(`.. connectionId = ${connId}`);

// 2. SSE 收流：连接级 + （load 后）session 级
async function openSse(extra = {}) {
  const r = await fetch(url, { headers: { ...auth, accept: 'text/event-stream', 'acp-connection-id': connId, ...extra } });
  console.log(`>> GET SSE ${JSON.stringify(extra)} → ${r.status}`);
  if (!r.ok || !r.body) { console.error(await r.text()); process.exit(1); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        let msg; try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          console.log(`<< resp#${msg.id}:`, JSON.stringify(msg.result ?? msg.error).slice(0, 200));
          settle(msg);
        } else if (msg.method === 'session/update') {
          const u = msg.params?.update ?? {};
          const text = u.content?.text ?? u.text ?? '';
          console.log(`<< ${u.sessionUpdate}${text ? ': ' + String(text).slice(0, 200) : ''}`);
        } else if (msg.method) {
          console.log(`<< notify ${msg.method}:`, JSON.stringify(msg.params ?? {}).slice(0, 150));
        }
      }
    }
  })();
}

await openSse();

// 3. session/load → 开 session 级 SSE → session/prompt
let id = await post('session/load', { sessionId: SESSION, cwd: CWD });
await waitResp(id, 60000);

await openSse({ 'acp-session-id': SESSION });

id = await post('session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text: PROMPT }] });
const resp = await waitResp(id, 180000);
console.log('\n=== prompt 完成:', JSON.stringify(resp.result ?? resp.error));

await fetch(url, { method: 'DELETE', headers: { ...auth, 'acp-connection-id': connId } }).catch(() => {});
process.exit(0);
