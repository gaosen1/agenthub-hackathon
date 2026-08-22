/**
 * 云端会话面板：qwen-code 原生 Web Shell 完全承载（iframe 替代自定义聊天 UI）。
 * - serve 以 --allow-origin <hub 源> 启动（runner 注入 AGENTHUB_WEB_ORIGIN），shell 可合法被 iframe；
 * - 会话历史回放 / 流式输出 / 模式与模型切换均由 shell 原生提供；刷新时 shell 自行 session/load 重放；
 * - 不可用时诚实空态（非 running / bot 载体 / hub 与浏览器不同机），不摆假数据。
 */
import { useEffect, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { fetchShellUrl } from '../api/client.js';

const CHAT_W_MIN = 280;
const CHAT_W_MAX = 640;
const clampW = (w: number): number => Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, w));

export function ChatPanel({ detail }: { detail: HandoffDetail }) {
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

  // status 变化（provisioning→running→终态）时重新取入口
  useEffect(() => {
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
  }, [detail.id, detail.status]);

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
          <span className="via">qwen-code Web Shell</span>
        </div>
        <div className="sess">
          <i className="fa-regular fa-file-lines" /> {detail.sessionId}.jsonl
        </div>
      </div>
      {shell?.reachable ? (
        <iframe className="shell-frame" src={shell.url} title="Qwen Code Web Shell" />
      ) : (
        <div className="shell-empty">
          {err
            ? `云端会话不可用：${err}`
            : shell
              ? 'Web Shell 不可直达：需 hub 与浏览器同机（port-forward），或 hub 部署在集群内'
              : '正在连接云端会话…'}
        </div>
      )}
    </aside>
  );
}
