/**
 * 状态变更通知器（S18）：fetch 注入打本地 http server，绝不真连 oapi.dingtalk.com。
 * 验收：at-least-once（失败不推进游标、下轮重试）、开关关闭不发、游标推进不重发。
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from './db.js';
import { encryptSecret } from './crypto.js';
import { setSetting } from './store.js';
import { Notifier } from './notifier.js';

const SECRET = 'notify-secret';
let db: DB;
let server: Server;
let webhookUrl: string;
let received: Array<{ title: string; text: string }>;
let failNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (failNext) {
        failNext = false;
        res.writeHead(500).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { markdown: { title: string; text: string } };
      received.push(body.markdown);
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  webhookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/robot/send?access_token=t`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  db = openDb(':memory:');
  received = [];
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (1,\'alice\',\'h\',\'t0\')').run();
  db
    .prepare(
      `INSERT INTO handoffs (id,user_id,agent_name,workspace_path,ws_hash,session_id,status,kind,base_commit,branch,created_at,updated_at)
       VALUES ('hf-notify',1,'proj','/w','wh','sess','done','web','b','main','t0','t0')`,
    )
    .run();
  setSetting(db, 1, 'dingtalkWebhook', encryptSecret(webhookUrl, SECRET));
});

const seedEvent = (status: string) =>
  db.prepare("INSERT INTO handoff_events (handoff_id, at, kind, payload) VALUES ('hf-notify','t1','status',?)").run(status);

describe('Notifier（S18）', () => {
  it('终态事件推送 markdown，游标推进后不重发', async () => {
    seedEvent('done');
    const n = new Notifier(db, SECRET, fetch);

    await n.notifyPending();
    expect(received).toHaveLength(1);
    expect(received[0]!.title).toContain('proj');
    expect(received[0]!.title).toContain('done');
    expect(received[0]!.text).toContain('hf-notify');

    await n.notifyPending();
    expect(received).toHaveLength(1);
  });

  it('发送失败游标不推进，修复后下轮重试（at-least-once）', async () => {
    seedEvent('failed');
    const n = new Notifier(db, SECRET, fetch);

    failNext = true;
    await n.notifyPending();
    expect(received).toHaveLength(0);

    await n.notifyPending();
    expect(received).toHaveLength(1);
    expect(received[0]!.title).toContain('failed');
  });

  it('notifyStatusChange 关闭时不发送', async () => {
    seedEvent('done');
    setSetting(db, 1, 'notifyStatusChange', '0');

    await new Notifier(db, SECRET, fetch).notifyPending();
    expect(received).toHaveLength(0);
  });

  it('未配置 webhook 的用户直接跳过', async () => {
    db.prepare('DELETE FROM user_settings WHERE key=\'dingtalkWebhook\'').run();
    seedEvent('done');

    await new Notifier(db, SECRET, fetch).notifyPending();
    expect(received).toHaveLength(0);
  });

  it('非通知状态（queued 等）不推送但推进游标', async () => {
    seedEvent('queued');
    seedEvent('done');
    const n = new Notifier(db, SECRET, fetch);

    await n.notifyPending();
    expect(received).toHaveLength(1); // 只有 done 推送
    expect(received[0]!.title).toContain('done');
  });
});
