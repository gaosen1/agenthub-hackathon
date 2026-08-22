/**
 * 钉钉群推总结封装：未配置 no-op / token 缓存复用 / 逐群发送 / 单群失败不阻断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dtDeps, notifyGroups, resetDingtalkForTest } from './dingtalk.js';

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  resetDingtalkForTest();
  process.env.DINGTALK_CLIENT_ID = 'app-key';
  process.env.DINGTALK_CLIENT_SECRET = 'app-secret';
});

afterEach(() => {
  delete process.env.DINGTALK_CLIENT_ID;
  delete process.env.DINGTALK_CLIENT_SECRET;
  vi.restoreAllMocks();
});

describe('notifyGroups', () => {
  it('未配置凭证时静默 no-op，不发任何请求', async () => {
    delete process.env.DINGTALK_CLIENT_ID;
    const fetchSpy = vi.fn();
    dtDeps.fetch = fetchSpy as typeof fetch;
    await notifyGroups([{ chatId: 'cid-1' }], 't', 'x');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('配置后逐群发送，token 只取一次（缓存复用）', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    dtDeps.fetch = vi.fn((url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.includes('accessToken')) return json(200, { accessToken: 'tk-1', expireIn: 7200 });
      return json(200, { processQueryKey: 'ok' });
    }) as typeof fetch;

    await notifyGroups([{ chatId: 'cid-1' }, { chatId: 'cid-2' }], '✅ 云端任务完成', 'text');

    const tokenCalls = calls.filter((c) => c.url.includes('accessToken'));
    const sendCalls = calls.filter((c) => c.url.includes('groupMessages/send'));
    expect(tokenCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]!.body).toMatchObject({ msgKey: 'sampleMarkdown', openConversationId: 'cid-1', robotCode: 'app-key' });
    expect(sendCalls[1]!.body).toMatchObject({ openConversationId: 'cid-2' });
  });

  it('单群失败只记日志，不阻断其余群', async () => {
    let sends = 0;
    dtDeps.fetch = vi.fn((url: string) => {
      if (url.includes('accessToken')) return json(200, { accessToken: 'tk-1', expireIn: 7200 });
      sends += 1;
      return sends === 1 ? json(500, { message: 'boom' }) : json(200, { ok: true });
    }) as typeof fetch;

    await expect(notifyGroups([{ chatId: 'cid-bad' }, { chatId: 'cid-ok' }], 't', 'x')).resolves.toBeUndefined();
    expect(sends).toBe(2);
  });
});
