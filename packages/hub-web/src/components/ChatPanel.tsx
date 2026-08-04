import { useEffect, useRef, useState } from 'react';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { dataSource } from '../api/client.js';
import { mockExtras } from '../api/mock.js';
import type { ChatMsg } from '../api/mock.js';

/**
 * 云端会话面板。
 * mock 模式：本地状态模拟回复；真 Hub（CP-3）：切到 ACP over HTTP
 * （POST /api/handoffs/:id/chat/acp 提交 + GET SSE 收流，见 spec §4.4——acp.ts 已定义消息类型）
 */
export function ChatPanel({ detail: t }: { detail: HandoffDetail }) {
  const extra = mockExtras[t.id];
  const [msgs, setMsgs] = useState<ChatMsg[]>(extra?.chat ?? []);
  const [text, setText] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const canChat = t.status === 'running';

  useEffect(() => {
    setMsgs(mockExtras[t.id]?.chat ?? []);
  }, [t.id]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [msgs]);

  const send = () => {
    const v = text.trim();
    if (!v || !canChat) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setMsgs((m) => [...m, { role: 'user', via: 'Web', text: v, time: hm }]);
    setText('');
    if (dataSource === 'mock') {
      // mock 模拟回复；真 Hub 时替换为 ACP session/prompt + SSE session/update
      setTimeout(() => {
        setMsgs((m) => [
          ...m,
          { role: 'agent', text: '收到指令，已注入当前云端会话。我会在当前步骤完成后处理该请求，并同步写入 session 记录。', time: hm },
        ]);
      }, 900);
    }
    // TODO(CP-3 联调): dataSource === 'hub' 时走 ACP 薄客户端（spec §4.4 五个方法 + SSE）
  };

  const rounds = extra?.rounds ?? 0;

  return (
    <aside className="chat">
      <div className="chat-h">
        <div className="t">
          <i className="fa-solid fa-comments" /> 云端会话
          {canChat && (
            <span className="live">
              <span className="dot" />
              LIVE
            </span>
          )}
        </div>
        <div className="sess">
          <i className="fa-regular fa-file-lines" /> {t.sessionId}.jsonl · 本地 {rounds} 轮已接力
        </div>
      </div>
      <div className="chat-body" ref={body}>
        <div className="sysline">
          <i className="fa-solid fa-flag" /> handoff_marker · 本地 {rounds} 轮上下文已在云端恢复
        </div>
        {msgs.length === 0 && (
          <div className="empty-hint" style={{ textAlign: 'center', padding: '24px 0' }}>
            云端会话尚未开始
          </div>
        )}
        {msgs.map((c, i) => (
          <div className={`msg ${c.role} fade-in`} key={i}>
            <div className="av">
              <i className={`fa-solid ${c.role === 'user' ? 'fa-user' : 'fa-robot'}`} />
            </div>
            <div className="bd">
              <div className="who">
                {c.role === 'user' ? '我' : 'Cloud Agent'}
                {c.via && <span className="via">via {c.via}</span>} · {c.time}
              </div>
              <div className="bubble">
                {c.text}
                {c.tool && (
                  <div className="tool-call">
                    <i className="fa-solid fa-wrench" />
                    {c.tool}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {canChat ? (
        <div className="chat-input">
          <div className="box">
            <textarea
              placeholder="向云端 Agent 追加指令，将写入云端 session 并随返回包合并回本地…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="bar">
              <span className="tip">
                <i className="fa-solid fa-mobile-screen" /> 钉钉同步可用 · Enter 发送
              </span>
              <button className="send" onClick={send}>
                <i className="fa-solid fa-paper-plane" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-disabled">
          <i className="fa-solid fa-lock" />
          {t.status === 'done'
            ? '任务已完成，会话已随返回包归档，pull 后可在本地 Qwen Code 中续聊'
            : t.status === 'failed' || t.status === 'cancelled' || t.status === 'expired'
              ? '任务已终止，会话已归档至返回包'
              : '任务尚未进入 running 状态，暂不可对话'}
        </div>
      )}
    </aside>
  );
}
