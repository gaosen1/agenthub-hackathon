import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HandoffDetail, HandoffEventsResp, SandboxEvent } from '@agenthub/shared/contracts';
import { fetchHandoffEvents, useDataSource } from '../api/client.js';
import { AcpClient } from '../api/acpClient.js';
import type { AcpCaps } from '../api/acpClient.js';
import { useHandoffEvents, useHandoffs } from '../api/hooks.js';
import { mockExtras } from '../api/mock.js';
import type { ChatMsg } from '../api/mock.js';
import { Markdown } from './Markdown.js';

const nowHm = (): string => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

/** 新图标一律内联 SVG（MASTER §0）：Lucide 风格 1.5px 描边 */
const IconSend = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22 11 13 2 9 22 2z" />
  </svg>
);
const IconSpinner = () => (
  <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const CHAT_W_MIN = 280;
const CHAT_W_MAX = 640;
const clampW = (w: number): number => Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, w));

const chatStoreKey = (id: string): string => `agenthub.chat.${id}`;

/** 刷新恢复：SSE 重连只补未交付的 live 事件（qwen serve 不全量重放历史），故对话快照走 sessionStorage */
function restoreMsgs(id: string): ChatMsg[] {
  try {
    const raw = sessionStorage.getItem(chatStoreKey(id));
    if (raw) return JSON.parse(raw) as ChatMsg[];
  } catch {
    /* 隐私模式等忽略 */
  }
  return [];
}

/** task 指令 + runner [task] relay 行合并成卡片（当前与历史 handoff 共用） */
function relayCards(task: string | null | undefined, items: HandoffEventsResp['items']): ChatMsg[] {
  const out: ChatMsg[] = [];
  if (task) out.push({ role: 'user', via: 'push --task', text: task, time: '' });
  for (const e of items) {
    if (e.kind !== 'log') continue;
    try {
      const ev = JSON.parse(e.payload) as SandboxEvent;
      if (ev.tag === 'info' && ev.c.startsWith('[task] ')) {
        // runner 按行拆日志；连续的 relay 行属于同一条回答，合并成单卡完整渲染
        const last = out[out.length - 1];
        if (last && last.role === 'agent' && last.via === 'task relay') {
          last.text += `\n${ev.c.slice(7)}`;
        } else {
          out.push({ role: 'agent', via: 'task relay', text: ev.c.slice(7), time: '' });
        }
      }
    } catch {
      /* 非 JSON 日志跳过 */
    }
  }
  return out;
}

/**
 * 云端会话面板。
 * hub 模式（CP-3）：ACP over HTTP 薄客户端（spec §4.4）——initialize → session/load →
 * SSE 收流渲染 session/update，多轮 session/prompt。
 * mock 模式：本地状态模拟回复（离线 UI 验收用）。
 */
export function ChatPanel({ detail: t }: { detail: HandoffDetail }) {
  const dataSource = useDataSource();
  const extra = mockExtras[t.id];
  const isHub = dataSource === 'hub';
  const canChat = t.status === 'running';

  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [conn, setConn] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');
  const [connErr, setConnErr] = useState('');
  const [caps, setCaps] = useState<AcpCaps | null>(null);
  const [switchErr, setSwitchErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatW, setChatW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('agenthub.chatW'));
      if (Number.isFinite(v) && v >= CHAT_W_MIN && v <= CHAT_W_MAX) return v;
    } catch {
      /* 隐私模式等忽略 */
    }
    return 360;
  });
  const body = useRef<HTMLDivElement>(null);
  const acp = useRef<AcpClient | null>(null);
  /** 流式中的 agent 气泡索引（-1 = 无进行中气泡） */
  const streamIdx = useRef(-1);

  // task 接力历史（真 Hub）：task 指令 + runner [task] 日志里的 agent 总结
  const { data: eventsData } = useHandoffEvents(t.id, isHub);
  const taskHistory = useMemo<ChatMsg[]>(
    () => (isHub ? relayCards(t.task, eventsData?.items ?? []) : []),
    [isHub, t.task, eventsData],
  );

  // 「加载更多」：同 session 的历次 handoff 对话作为更以前的历史，逐块向上加载
  const { data: listData } = useHandoffs();
  const priorHandoffs = useMemo(() => {
    const all = listData?.items ?? [];
    return all
      .filter((h) => h.sessionId === t.sessionId && h.createdAt < t.createdAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [listData, t.sessionId, t.createdAt]);
  const [historyBlocks, setHistoryBlocks] = useState<Array<{ id: string; label: string; cards: ChatMsg[] }>>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    const next = priorHandoffs[historyBlocks.length];
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const items: HandoffEventsResp['items'] = [];
      let after = 0;
      for (let p = 0; p < 10; p++) {
        const r = await fetchHandoffEvents(next.id, after);
        items.push(...r.items);
        after = r.nextAfter;
        if (r.items.length < 500) break;
      }
      const cards = relayCards(next.task, items);
      if (cards.length === 0) {
        cards.push({ role: 'agent', via: 'task relay', text: '该 handoff 无文本记录（交互聊天不入事件流，完整对话见本地 session）', time: '' });
      }
      setHistoryBlocks((b) => [...b, { id: next.id, label: `${next.id} · ${next.createdAt.slice(11, 16)}`, cards }]);
    } finally {
      setLoadingMore(false);
    }
  };

  // mock 模式：装载样本对话；hub 模式：刷新后恢复对话快照
  useEffect(() => {
    if (!isHub) setMsgs(mockExtras[t.id]?.chat ?? []);
    else setMsgs(restoreMsgs(t.id));
    setHistoryBlocks([]);
  }, [t.id, isHub]);

  // 对话快照随变持久化，供刷新/重进恢复
  useEffect(() => {
    if (!isHub) return;
    try {
      sessionStorage.setItem(chatStoreKey(t.id), JSON.stringify(msgs));
    } catch {
      /* 配额/隐私模式忽略 */
    }
  }, [msgs, t.id, isHub]);

  // hub 模式：running 时建立 ACP 连接
  useEffect(() => {
    if (!isHub || !canChat || !t.workspacePath) return;
    setConn('connecting');
    setConnErr('');
    setCaps(null);
    setSwitchErr('');
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
      .then((c) => {
        setCaps(c);
        setConn('ready');
        // 刷新恢复后若尾泡是 agent：续流无缝追加到同一气泡，不另起新泡
        setMsgs((m) => {
          streamIdx.current = m.length > 0 && m[m.length - 1]!.role === 'agent' ? m.length - 1 : -1;
          return m;
        });
      })
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
  }, [msgs, taskHistory, busy]);

  // 侧栏宽度：写 --chat-w 变量（.main 网格消费）+ localStorage 持久化
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', `${chatW}px`);
    try {
      localStorage.setItem('agenthub.chatW', String(chatW));
    } catch {
      /* 忽略 */
    }
  }, [chatW]);

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatW;
    const move = (ev: PointerEvent) => setChatW(clampW(startW + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onResizeKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setChatW((v) => clampW(v + 24));
    if (e.key === 'ArrowRight') setChatW((v) => clampW(v - 24));
  };

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

  const renderMsg = (c: ChatMsg, key: string | number) => (
    <div className={`msg ${c.role} fade-in`} key={key}>
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
          {c.role === 'agent' && c.text ? <Markdown text={c.text} /> : c.text}
          {c.tool && (
            <div className="tool-call">
              <i className="fa-solid fa-wrench" />
              {c.tool}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // 运行时切换 qwen code 模式 / 模型（ACP session/set_mode、session/set_model）
  const switchMode = (modeId: string) => {
    if (!acp.current) return;
    void acp.current
      .setMode(t.sessionId, modeId)
      .then(() => {
        setCaps((c) => (c ? { ...c, currentModeId: modeId } : c));
        setSwitchErr('');
      })
      .catch((e: unknown) => setSwitchErr(e instanceof Error ? e.message : String(e)));
  };
  const switchModel = (modelId: string) => {
    if (!acp.current) return;
    void acp.current
      .setModel(t.sessionId, modelId)
      .then(() => {
        setCaps((c) => (c ? { ...c, currentModelId: modelId } : c));
        setSwitchErr('');
      })
      .catch((e: unknown) => setSwitchErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <aside className="chat">
      <div
        className="chat-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话面板宽度"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
      />
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
        {isHub && conn === 'ready' && caps && (caps.modes.length > 0 || caps.models.length > 0) && (
          <div className="caps">
            {caps.modes.length > 0 && (
              <label>
                模式
                <select value={caps.currentModeId} onChange={(e) => switchMode(e.target.value)}>
                  {caps.modes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {caps.models.length > 0 && (
              <label>
                模型
                <select value={caps.currentModelId} onChange={(e) => switchModel(e.target.value)}>
                  {caps.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {switchErr && <span className="caps-err">{switchErr.slice(0, 60)}</span>}
          </div>
        )}
      </div>
      <div className="chat-body" ref={body}>
        {isHub && priorHandoffs.length > historyBlocks.length && (
          <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <IconSpinner /> : null} 加载更以前的历史 · 还有 {priorHandoffs.length - historyBlocks.length} 次 handoff
          </button>
        )}
        {[...historyBlocks].reverse().map((b) => (
          <div key={b.id}>
            <div className="sysline">
              <i className="fa-solid fa-flag" /> handoff {b.label} · 更以前的历史
            </div>
            {b.cards.map((c, i) => renderMsg(c, `${b.id}-${i}`))}
          </div>
        ))}
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
        {shown.map((c, i) => renderMsg(c, i))}
        {busy && streamIdx.current < 0 && (
          <div className="msg agent fade-in">
            <div className="av">
              <i className="fa-solid fa-robot" />
            </div>
            <div className="bd">
              <div className="who">Cloud Agent</div>
              <div className="bubble thinking">
                <span className="tdots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                思考中
              </div>
            </div>
          </div>
        )}
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
                    <IconSpinner /> Agent 处理中…
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-mobile-screen" /> Enter 发送 · Shift+Enter 换行
                  </>
                )}
              </span>
              <button
                className="send"
                onClick={send}
                disabled={busy || (isHub && conn !== 'ready')}
                title={busy ? '模型输出中' : '发送'}
              >
                {busy ? <IconSpinner /> : <IconSend />}
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
