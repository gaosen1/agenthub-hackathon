/**
 * context 测试（spec §7 D2–D3 / D4–D5）：
 * settings 注入、routes.json 改写（保留既有路由）、chats 合并、返回包构建
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listChats, rewriteRoute, routesPath, writeChannelsConfig } from './context.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ah-runner-test-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('writeChannelsConfig', () => {
  it('生成 chat_thread scope 的钉钉 channel 配置，凭证走 $ENV 引用', async () => {
    await writeChannelsConfig(home, 'mybot', '/Users/x/proj');
    const settings = JSON.parse(await fs.readFile(join(home, 'settings.json'), 'utf8'));
    expect(settings.channels.mybot).toEqual({
      type: 'dingtalk',
      clientId: '$DINGTALK_CLIENT_ID',
      clientSecret: '$DINGTALK_CLIENT_SECRET',
      cwd: '/Users/x/proj',
      sessionScope: 'chat_thread',
      groupPolicy: 'open',
    });
  });

  it('合并进既有 settings.json，不覆盖其他字段', async () => {
    await fs.writeFile(join(home, 'settings.json'), JSON.stringify({ theme: 'dark', channels: { other: { type: 'feishu' } } }));
    await writeChannelsConfig(home, 'mybot', '/w');
    const settings = JSON.parse(await fs.readFile(join(home, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.channels.other.type).toBe('feishu');
    expect(settings.channels.mybot.type).toBe('dingtalk');
  });
});

describe('rewriteRoute（spec §8.2 绑定语义）', () => {
  it('新表建路由：key=<bot>:<chatId>，占位 target', async () => {
    await rewriteRoute(home, 'ws-hash', 'mybot', 'cidAAA', 'sess-pushed', '/w');
    const routes = JSON.parse(await fs.readFile(routesPath(home, 'ws-hash'), 'utf8'));
    expect(routes['mybot:cidAAA']).toEqual({
      sessionId: 'sess-pushed',
      target: { channelName: 'mybot', senderId: '-', chatId: 'cidAAA', isGroup: true },
      cwd: '/w',
    });
  });

  it('改写既有条目只换 sessionId，保留 target；其他群路由不动（多 session 隔离）', async () => {
    const path = routesPath(home, 'ws-hash');
    await fs.mkdir(join(home, 'channels', 'daemon', 'ws-hash'), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({
        'mybot:cidAAA': { sessionId: 'old-sess', target: { channelName: 'mybot', senderId: 'u1', chatId: 'cidAAA', isGroup: true }, cwd: '/w' },
        'mybot:cidBBB': { sessionId: 'sess-b', target: { channelName: 'mybot', senderId: 'u2', chatId: 'cidBBB', isGroup: true }, cwd: '/w' },
      }),
    );
    await rewriteRoute(home, 'ws-hash', 'mybot', 'cidAAA', 'sess-pushed', '/w');
    const routes = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(routes['mybot:cidAAA'].sessionId).toBe('sess-pushed');
    expect(routes['mybot:cidAAA'].target.senderId).toBe('u1'); // 保留真实 target
    expect(routes['mybot:cidBBB'].sessionId).toBe('sess-b'); // 群 B 不受影响
  });
});

describe('listChats', () => {
  it('合并 routes.json 与 observed-contacts.json 去重', async () => {
    await rewriteRoute(home, 'ws-hash', 'mybot', 'cidAAA', 's1', '/w');
    await fs.writeFile(
      join(home, 'channels', 'daemon', 'ws-hash', 'observed-contacts.json'),
      JSON.stringify({
        cidAAA: { chatId: 'cidAAA', title: '项目群A', lastSeenAt: '2026-08-04T00:00:00Z' },
        cidCCC: { chatId: 'cidCCC', title: '群C' },
      }),
    );
    const chats = await listChats(home, 'ws-hash');
    const byId = Object.fromEntries(chats.map((c) => [c.chatId, c]));
    expect(Object.keys(byId).sort()).toEqual(['cidAAA', 'cidCCC']);
    expect(byId['cidAAA']!.title).toBe('项目群A');
  });

  it('无任何文件时返回空数组', async () => {
    expect(await listChats(home, 'nope')).toEqual([]);
  });
});
