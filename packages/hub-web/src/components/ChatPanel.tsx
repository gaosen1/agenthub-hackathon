import { useEffect, useMemo, useRef, useState } from 'react';
import type { HandoffDetail, SandboxEvent } from '@agenthub/shared/contracts';
import { dataSource } from '../api/client.js';
import { AcpClient } from '../api/acpClient.js';
import { useHandoffEvents } from '../api/hooks.js';
import { mockExtras } from '../api/mock.js';
import type { ChatMsg } from '../api/mock.js';

const nowHm = (): string => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

/**
 * 云端会话面板。
 * hub 模式（CP-3）：ACP over HTTP 薄客户端（spec §4.4）——initialize → session/load →
 * SSE 收流渲染 session/update，多轮 session/prompt。
 * mock 模式：本地状态模拟回复（离线 UI 验收用）。
 */
export function ChatPanel({ detail: t }: { detail: HandoffDetail }) {
  const extra = mockExtras[t.id];
  const isHub = dataSource === 'hub';
  const canChat = t.status === 'running';

  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [conn, setConn] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');
  const [connErr, setConnErr] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const acp = useRef<AcpClient | null>(null);
  /** 流式中的 agent 气泡索引（-1 = 无进行中气泡） */
  const streamIdx = useRef(-1);

  // task 接力历史（真 Hub）：task 指令 + runner [task] 日志里的 agent 总结
  const { data: eventsData } = useHandoffEvents(t.id, isHub);
  const taskHistory = useMemo<ChatMsg[]>(() => {
    if (!isHub || !t.task) return [];
    const out: ChatMsg[] = [{ role: 'user', via: 'push --task', text: t.task, time: '' }];
    for (const e of eventsData?.items ?? []) {
      if (e.kind !== 'log') continue;
      try {
        const ev = JSON.parse(e.payload) as SandboxEvent;
        if (ev.tag === 'info' && ev.c.startsWith('[task] ')) {
          out.push({ role: 'agent', via: 'task relay', text: ev.c.slice(7), time: '' });
        }
      } catch {
        /* 非 JSON 日志跳过 */
      }
    }
    return out;
  }, [isHub, t.id, t.task, eventsData]);

  // mock 模式：装载样本对话
  useEffect(() => {
    if (!isHub) setMsgs(mockExtras[t.id]?.chat ?? []);
    else setMsgs([]);
  }, [t.id, isHub]);

  // hub 模式：running 时建立 ACP 连接
  useEffect(() => {
    if (!isHub || !canChat || !t.workspacePath) return;
    setConn('connecting');
    setConnErr('');
    streamIdx.current = -1;
    const client = new AcpClient(t.id, {
      onUpdate: (p) => {
        const u = p.update;
        const chunk =
          (u['content'] as { text?: string } | undefined)?.text ?? (u['text'] as string | undefined) ?? '';
        if (u.sessionUpdate === 'agent_message_chunk' && chunk) {
          setMsgs((m) => {
            if (streamIdx.current >= 0 && m[streamIdx.current]?.role === 'agent') {
              const copy = [...m];
              copy[streamIdx.current] = { ...copy[streamIdx.current], text: copy[streamIdx.current].text + chunk };
              return copy;
            }
            streamIdx.current = m.length;
            return [...m, { role: 'agent', text: chunk, time: nowHm() }];
          });
        } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          const title = (u['title'] as string | undefined) ?? (u['toolCallId'] as string | undefined) ?? 'tool';
          if (u.sessionUpdate === 'tool_call') {
            streamIdx.current = -1; // 工具调用后新起 agent 气泡
            setMsgs((m) => [...m, { role: 'agent', text: '', tool: title, time: nowHm() }]);
          }
        }
      },
      onError: (message) => {
        setConn('error');
        setConnErr(message);
      },
    });
    acp.current = client;
    client
      .connect(t.sessionId, t.workspacePath)
      .then(() => setConn('ready'))
      .catch((e: unknown) => {
        setConn('error');
        setConnErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      client.close();
      acp.current = null;
      setConn('idle');
    };
  }, [isHub, canChat, t.id, t.sessionId, t.workspacePath]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [msgs, taskHistory]);

  const send = () => {
    const v = text.trim();
    if (!v || !canChat || busy) return;
    setMsgs((m) => [...m, { role: 'user', via: 'Web', text: v, time: nowHm() }]);
    setText('');
    if (isHub) {
      if (conn !== 'ready' || !acp.current) return;
      streamIdx.current = -1;
      setBusy(true);
      acp.current
        .prompt(t.sessionId, v)
        .catch((e: unknown) => {
          setMsgs((m) => [...m, { role: 'agent', text: `（发送失败：${e instanceof Error ? e.message : String(e)}）`, time: nowHm() }]);
        })
        .finally(() => {
          setBusy(false);
          streamIdx.current = -1;
        });
    } else {
      // mock 模拟回复
      setTimeout(() => {
        setMsgs((m) => [
          ...m,
          { role: 'agent', text: '收到指令，已注入当前云端会话。我会在当前步骤完成后处理该请求，并同步写入 session 记录。', time: nowHm() },
        ]);
      }, 900);
    }
  };

  const rounds = extra?.rounds;
  const shown = [...taskHistory, ...msgs];

  return (
    <aside className="chat">
      <div className="chat-h">
        <div className="t">
          <i className="fa-solid fa-comments" /> 云端会话
          {canChat && conn === 'ready' && (
            <span className="live">
              <span className="dot" />
              LIVE
            </span>
          )}
          {canChat && isHub && conn === 'connecting' && (
            <span className="live" style={{ color: 'var(--warn)', background: 'rgba(245,176,77,.1)' }}>
              连接中…
            </span>
          )}
        </div>
        <div className="sess">
          <i className="fa-regular fa-file-lines" /> {t.sessionId}.jsonl
          {rounds !== undefined ? ` · 本地 ${rounds} 轮已接力` : ''}
        </div>
      </div>
      <div className="chat-body" ref={body}>
        <div className="sysline">
          <i className="fa-solid fa-flag" /> handoff_marker · 本地上下文已在云端恢复
        </div>
        {conn === 'error' && (
          <div className="sysline" style={{ color: 'var(--err)' }}>
            <i className="fa-solid fa-triangle-exclamation" /> ACP 连接失败：{connErr.slice(0, 80)}
          </div>
        )}
        {shown.length === 0 && (
          <div className="empty-hint" style={{ textAlign: 'center', padding: '24px 0' }}>
            云端会话尚未开始
          </div>
        )}
        {shown.map((c, i) => (
          <div className={`msg ${c.role} fade-in`} key={i}>
            <div className="av">
              <i className={`fa-solid ${c.role === 'user' ? 'fa-user' : 'fa-robot'}`} />
            </div>
            <div className="bd">
              <div className="who">
                {c.role === 'user' ? '我' : 'Cloud Agent'}
                {c.via && <span className="via">via {c.via}</span>}
                {c.time ? ` · ${c.time}` : ''}
              </div>
              <div className="bubble">
                {c.text || (busy && i === shown.length - 1 && c.role === 'agent' ? '…' : c.text)}
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
              placeholder={
                isHub && conn !== 'ready'
                  ? conn === 'error'
                    ? 'ACP 连接失败，无法对话'
                    : '正在连接云端会话…'
                  : '向云端 Agent 追加指令，将写入云端 session 并随返回包合并回本地…'
              }
              value={text}
              disabled={isHub && conn !== 'ready'}
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
                {busy ? (
                  <>
                    <i className="fa-solid fa-circle-notch fa-spin" /> Agent 处理中…
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-mobile-screen" /> Enter 发送 · Shift+Enter 换行
                  </>
                )}
              </span>
              <button className="send" onClick={send} disabled={busy || (isHub && conn !== 'ready')}>
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
