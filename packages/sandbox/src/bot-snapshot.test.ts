import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreBotSnapshot, uploadBotSnapshot, wsSlug } from './bot-snapshot.js';
import { qwenHome } from './context.js';

describe('bot 外置存储快照', () => {
  let srv: Server;
  let base: string;
  let blob: Buffer | undefined;
  const root = join(tmpdir(), `bot-snap-test-${process.pid}`);
  const ws = join(root, 'ws');

  beforeAll(async () => {
    process.env.QWEN_HOME_DIR = join(root, 'qwen-home');
    srv = createServer((req, res) => {
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          blob = Buffer.concat(chunks);
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === 'GET') {
        if (!blob) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(blob);
        return;
      }
      res.writeHead(405);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('wsSlug 为绝对路径 dash-slug', () => {
    expect(wsSlug('/Users/x/y')).toBe('-Users-x-y');
  });

  it('无 GET URL 时回退默认 workspace', async () => {
    expect(await restoreBotSnapshot(undefined, '/tmp/def')).toBe('/tmp/def');
  });

  it('404（首启无快照）回退默认', async () => {
    expect(await restoreBotSnapshot(`${base}/snap`, '/tmp/def')).toBe('/tmp/def');
  });

  it('上传→删除→还原 往返保住 workspace 与 chats', async () => {
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(join(ws, 'CODE.md'), '# bot memory');
    const chats = join(qwenHome(), 'projects', wsSlug(ws), 'chats');
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(join(chats, 'sess-1.jsonl'), '{"type":"user","message":{"parts":[{"text":"hi"}]}}\n');

    await uploadBotSnapshot(`${base}/snap`, ws);
    expect(blob).toBeTruthy();

    // 模拟沙箱销毁：workspace 与 chats 全没
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(chats, { recursive: true, force: true });

    const restored = await restoreBotSnapshot(`${base}/snap`, join(root, 'fresh'));
    expect(restored).toBe(ws);
    expect(await fs.readFile(join(ws, 'CODE.md'), 'utf8')).toBe('# bot memory');
    expect(await fs.readFile(join(chats, 'sess-1.jsonl'), 'utf8')).toContain('hi');
  });
});
