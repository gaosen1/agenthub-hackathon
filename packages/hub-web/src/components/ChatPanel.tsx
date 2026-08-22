/**
 * 云端会话面板：
 * - running：qwen-code 原生 Web Shell 完全承载（iframe；serve 以 --allow-origin 启动，
 *   shell 可合法被 iframe；流式输出/模式切换/session 重放均由 shell 原生提供）；
 * - 终态（done/failed/…）：serve 已随任务结束停止，shell 不复存在——回退只读历史回放：
 *   hub 事件流里的 task 指令 + runner [task] relay 日志渲染成卡片，
 *   并支持同 session 历次 handoff 逐块向上加载。不摆假数据，无记录时诚实说明。
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HandoffDetail, HandoffEventsResp, SandboxEvent } from '@agenthub/shared/contracts';
import { fetchHandoffEvents, fetchShellUrl, useDataSource } from '../api/client.js';
import { useHandoffEvents, useHandoffs } from '../api/hooks.js';
import type { ChatMsg } from '../api/mock.js';
import { Markdown } from './Markdown.js';

const CHAT_W_MIN = 280;
const CHAT_W_MAX = 640;
const clampW = (w: number): number => Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, w));

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

/** 终态 handoff 的只读历史回放（hub 事件流 + 同 session 历次 handoff） */
function HistoryView({ detail }: { detail: HandoffDetail }) {
  const isHub = useDataSource() === 'hub';
  const { data: eventsData } = useHandoffEvents(detail.id, isHub);
  const cards = useMemo<ChatMsg[]>(
    () => (isHub ? relayCards(detail.task, eventsData?.items ?? []) : []),
    [isHub, detail.task, eventsData],
  );

  // 「加载更多」：同 session 的历次 handoff 对话作为更以前的历史，逐块向上加载
  const { data: listData } = useHandoffs();
  const priorHandoffs = useMemo(() => {
    const all = listData?.items ?? [];
    return all
      .filter((h) => h.sessionId === detail.sessionId && h.createdAt < detail.createdAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [listData, detail.sessionId, detail.createdAt]);
  const [blocks, setBlocks] = useState<Array<{ id: string; label: string; cards: ChatMsg[] }>>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setBlocks([]), [detail.id]);

  const loadMore = async (): Promise<void> => {
    const next = priorHandoffs[blocks.length];
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
      const bc = relayCards(next.task, items);
      if (bc.length === 0) {
        bc.push({ role: 'agent', via: 'task relay', text: '该 handoff 无文本记录（交互聊天不入事件流，完整对话见本地 session）', time: '' });
      }
      setBlocks((b) => [...b, { id: next.id, label: `${next.id} · ${next.createdAt.slice(11, 16)}`, cards: bc }]);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="chat-body">
      {isHub && priorHandoffs.length > blocks.length && (
        <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
          加载更以前的历史 · 还有 {priorHandoffs.length - blocks.length} 次 handoff
        </button>
      )}
      {[...blocks].reverse().map((b) => (
        <div key={b.id}>
          <div className="sysline">
            <i className="fa-solid fa-flag" /> handoff {b.label} · 更以前的历史
          </div>
          {b.cards.map((c, i) => renderMsg(c, `${b.id}-${i}`))}
        </div>
      ))}
      {cards.length === 0 ? (
        <div className="empty-hint" style={{ textAlign: 'center', padding: '24px 0' }}>
          {isHub ? '该 handoff 无文本记录（交互聊天不入事件流，完整对话见本地 session）' : '云端会话尚未开始'}
        </div>
      ) : (
        cards.map((c, i) => renderMsg(c, i))
      )}
    </div>
  );
}

export function ChatPanel({ detail }: { detail: HandoffDetail }) {
  const isRunning = detail.status === 'running';
  const isBot = detail.kind === 'bot';
  const [chatW, setChatW] = useState<number>(() => {
    const v = Number(localStorage.getItem('agenthub.chatW'));
    return Number.isFinite(v) && v >= CHAT_W_MIN ? clampW(v) : 380;
  });
  const [shell, setShell] = useState<{ url: string; reachable: boolean } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', `${chatW}px`);
    try {
      localStorage.setItem('agenthub.chatW', String(chatW));
    } catch {
      /* 忽略 */
    }
  }, [chatW]);

  // running 且 status 变化时取 shell 入口；终态不请求（serve 已停，入口必 409）；
  // bot 载体不请求（shell-url 仅 web 载体，对话面在钉钉群）
  useEffect(() => {
    if (!isRunning || isBot) return;
    let alive = true;
    setShell(null);
    setErr('');
    fetchShellUrl(detail.id)
      .then((r) => {
        if (alive) setShell(r);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [detail.id, detail.status, isRunning, isBot]);

  // port-forward 可能中途死掉（hub 重启/瞬断）：no-cors 探针拒绝即重取入口换 src
  useEffect(() => {
    if (!shell?.reachable) return;
    const timer = setInterval(() => {
      fetch(shell.url, { mode: 'no-cors' }).catch(() => {
        fetchShellUrl(detail.id)
          .then((r) => {
            if (r.reachable && r.url !== shell.url) setShell(r);
          })
          .catch(() => undefined);
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [shell, detail.id]);

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
          <span className="via">{isRunning ? (isBot ? 'DingTalk Bot 载体' : 'qwen-code Web Shell') : '历史回放（只读）'}</span>
        </div>
        <div className="sess">
          <i className="fa-regular fa-file-lines" /> {detail.sessionId}.jsonl
        </div>
      </div>
      {isRunning ? (
        isBot ? (
          <div className="shell-empty">
            Bot 载体：task 先 headless 执行（期间机器人在群内静默），完成后钉钉流自动连接并重绑群会话，
            届时在内部群 @机器人 即可基于云端工作区对话。Web Shell 目前仅支持 web 载体，执行进度见左侧执行日志。
          </div>
        ) : shell?.reachable ? (
          <iframe className="shell-frame" src={shell.url} title="Qwen Code Web Shell" />
        ) : (
          <div className="shell-empty">
            {err
              ? `云端会话不可用：${err}`
              : shell
                ? 'Web Shell 不可直达：需 hub 与浏览器同机（port-forward），或 hub 部署在集群内'
                : '正在连接云端会话…'}
          </div>
        )
      ) : (
        <HistoryView detail={detail} />
      )}
    </aside>
  );
}
