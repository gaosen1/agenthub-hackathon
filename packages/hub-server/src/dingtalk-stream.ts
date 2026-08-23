/**
 * 钉钉 Stream 兜底连接（bot 唤醒看门人）。沙箱死亡 = 沙箱内原生 Stream 断，
 * 无人「听见」@；hub 持本连接先接消息，回「唤醒中」后拉沙箱、跑问题、回答案、交棒。
 * 纯服务端组件，只需出网到钉钉，与 hub 部署位置无关（Mac/ECS 均可）。
 * 协议对齐 dingtalk-stream SDK：gettoken → POST /v1.0/gateway/connections/open →
 * wss `${endpoint}?ticket=${ticket}`；SYSTEM ping 回 ack；CALLBACK ack 后上抛。
 */
export interface DingBotMessage {
  text: string;
  senderId: string;
  conversationId: string;
  /** '1' 单聊 '2' 群聊 */
  conversationType: string;
  /** 回调自带回复入口（含签名），无需 access_token */
  sessionWebhook: string;
}

const BOT_MSG_TOPIC = '/v1.0/im/bot/messages/get';

export class DingtalkStreamWaker {
  private ws: WebSocket | undefined;
  private stopped = false;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private onMessage: (m: DingBotMessage) => void,
    private log: (s: string) => void,
  ) {}

  get alive(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    const tk = (await fetch(
      `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(this.clientId)}&appsecret=${encodeURIComponent(this.clientSecret)}`,
    ).then((r) => r.json())) as { access_token?: string };
    if (!tk.access_token) throw new Error('dingtalk gettoken failed');
    const open = (await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'access-token': tk.access_token },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        ua: 'agenthub-bot-waker',
        subscriptions: [
          { type: 'CALLBACK', topic: BOT_MSG_TOPIC },
          { type: 'EVENT', topic: '*' },
        ],
      }),
    }).then((r) => r.json())) as { endpoint?: string; ticket?: string };
    if (!open.endpoint || !open.ticket) throw new Error('dingtalk connections/open failed');

    const ws = new WebSocket(`${open.endpoint}?ticket=${open.ticket}`);
    this.ws = ws;
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('waker connect failed')), { once: true });
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; headers?: Record<string, unknown>; data?: string };
        if (msg.type === 'SYSTEM' && (msg.headers as { topic?: string } | undefined)?.topic === 'ping') {
          ws.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: msg.data ?? '' }));
          return;
        }
        if (msg.type === 'CALLBACK' && (msg.headers as { topic?: string } | undefined)?.topic === BOT_MSG_TOPIC && msg.data) {
          // 先 ack 再处理，避免钉钉侧重投
          ws.send(JSON.stringify({ code: 200, headers: msg.headers, message: 'OK', data: '{}' }));
          const d = JSON.parse(msg.data) as Record<string, unknown>;
          const text = (((d.text as { content?: string } | undefined)?.content ?? (d.content as string | undefined)) ?? '').trim();
          this.onMessage({
            text,
            senderId: String(d.senderStaffId ?? d.senderId ?? ''),
            conversationId: String(d.conversationId ?? ''),
            conversationType: String(d.conversationType ?? '2'),
            sessionWebhook: String(d.sessionWebhook ?? ''),
          });
        }
      } catch (e) {
        this.log(`waker parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    ws.addEventListener('close', () => {
      this.ws = undefined;
      if (!this.stopped) this.log('waker socket closed unexpectedly');
    });
    await opened;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = undefined;
  }
}

/** 经 sessionWebhook 回复（markdown），失败静默 */
export async function replyViaWebhook(sessionWebhook: string, title: string, text: string): Promise<void> {
  if (!sessionWebhook) return;
  await fetch(sessionWebhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } }),
  }).catch(() => undefined);
}
