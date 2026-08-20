/**
 * 状态变更通知器（S18）：由 handoff_events kind='status' 驱动，at-least-once、重启安全。
 *
 * 不挂 setStatus：它是同步、纯 DB 的函数，被 14 处调用，穿网络 IO 进去会污染纯写操作。
 * 作为 Worker.tick() 的第 5 步单点调用，能覆盖路由里发生的状态变更（如 cancel）。
 * 游标持久化在 user_settings；发送失败游标不推进，下轮重试。
 * 测试注入 fetch 打本地 http server，绝不真连 oapi.dingtalk.com。
 */
import type { DB } from './db.js';
import { decryptSecret } from './crypto.js';
import { getSettings, setSetting } from './store.js';

const NOTIFY_STATUSES = ['running', 'done', 'failed', 'expired', 'cancelled'];

interface StatusEventRow {
  id: number;
  at: string;
  payload: string;
  handoff_id: string;
  agent_name: string;
}

export class Notifier {
  constructor(
    private readonly db: DB,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 扫描未通知的状态事件推送到用户钉钉 webhook；失败游标不推进，下轮重试 */
  async notifyPending(): Promise<void> {
    const users = this.db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
    for (const u of users) {
      const settings = getSettings(this.db, u.id);
      const webhookEnc = settings['dingtalkWebhook'];
      if (!webhookEnc) continue;
      if ((settings['notifyStatusChange'] ?? '1') !== '1') continue;
      const cursor = Number(settings['notifyCursor'] ?? 0) || 0;
      const rows = this.db
        .prepare(
          `SELECT e.id, e.at, e.payload, h.id AS handoff_id, h.agent_name
           FROM handoff_events e JOIN handoffs h ON h.id = e.handoff_id
           WHERE e.kind='status' AND e.id > ? AND h.user_id = ?
           ORDER BY e.id LIMIT 50`,
        )
        .all(cursor, u.id) as StatusEventRow[];
      for (const r of rows) {
        if (NOTIFY_STATUSES.includes(r.payload)) {
          try {
            await this.send(webhookEnc, r);
          } catch {
            break; // at-least-once：本条未成功，游标不推进，下轮重试
          }
        }
        setSetting(this.db, u.id, 'notifyCursor', String(r.id));
      }
    }
  }

  private async send(webhookEnc: string, r: StatusEventRow): Promise<void> {
    const url = decryptSecret(webhookEnc, this.secret);
    const title = `AgentHub: ${r.agent_name} → ${r.payload}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title, text: `**${title}**\n\n- handoff: ${r.handoff_id}\n- 时间: ${r.at}` },
      }),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}
