/**
 * 钉钉 OpenAPI 最小封装（bot 载体）：task 结束后向绑定群主动推送总结。
 * - 凭证 env：DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET（hub createBot 注入），未配置静默 no-op；
 * - 群消息走 robot/groupMessages/send（openConversationId）；单聊联系人无 userId 不推；
 * - 任何失败只记日志，绝不影响任务主流程；钉钉主动消息有频控，仅任务终态推一条。
 */
import { appendLog } from './state.js';

export const dtDeps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  clientId: (): string | undefined => process.env.DINGTALK_CLIENT_ID,
  clientSecret: (): string | undefined => process.env.DINGTALK_CLIENT_SECRET,
};

let tokenCache: { token: string; expireAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expireAt > Date.now() + 60_000) return tokenCache.token;
  const r = await dtDeps.fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: dtDeps.clientId(), appSecret: dtDeps.clientSecret() }),
  });
  if (r.status >= 400) throw new Error(`accessToken → ${r.status}`);
  const d = (await r.json()) as { accessToken?: string; expireIn?: number };
  if (!d.accessToken) throw new Error('accessToken missing');
  tokenCache = { token: d.accessToken, expireAt: Date.now() + Number(d.expireIn ?? 7200) * 1000 };
  return tokenCache.token;
}

/** 向群推送一条 markdown；失败抛错由调用方统一兜底 */
export async function sendGroupMarkdown(openConversationId: string, title: string, text: string): Promise<void> {
  const token = await accessToken();
  const r = await dtDeps.fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      msgParam: JSON.stringify({ title, text }),
      msgKey: 'sampleMarkdown',
      openConversationId,
      robotCode: dtDeps.clientId(),
    }),
  });
  if (r.status >= 400) throw new Error(`groupMessages/send → ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

export function dingtalkConfigured(): boolean {
  return Boolean(dtDeps.clientId() && dtDeps.clientSecret());
}

/** 逐群推送；单群失败只记日志不抛、不阻断其余群 */
export async function notifyGroups(chats: Array<{ chatId: string }>, title: string, text: string): Promise<void> {
  if (!dingtalkConfigured() || chats.length === 0) return;
  for (const c of chats) {
    try {
      await sendGroupMarkdown(c.chatId, title, text);
      appendLog('ok', `dingtalk notify sent → ${c.chatId.slice(0, 12)}`);
    } catch (e) {
      appendLog('info', `dingtalk notify failed (${c.chatId.slice(0, 12)}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 仅测试用：复位 token 缓存与依赖 */
export function resetDingtalkForTest(): void {
  tokenCache = undefined;
}
