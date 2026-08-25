/**
 * 云端会话面板（单 UI 架构）：qwen-code 原生 Web Shell 完全承载，不保留任何自研聊天 UI。
 * - running：iframe 直连沙箱 shell-proxy（8082），流式输出/模式切换/session 重放均由 shell 原生提供；
 * - 终态（done/failed/…）：沙箱已销毁，后端本地 replay serve 还原 session，侧栏继续原生 web shell 回放；
 * - 入口不可达/无返回包：诚实占位说明，不摆假数据。
 */
import { useEffect, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { fetchShellUrl } from '../api/client.js';

const CHAT_W_MIN = 280;
const CHAT_W_MAX = 640;
const clampW = (w: number): number => Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, w));

export function ChatPanel({ detail }: { detail: HandoffDetail }) {
  const isRunning = detail.status === 'running';
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

  // status 变化即取 shell 入口：running 走沙箱网关；终态走本地 replay serve（后端还原 session）；
  // queued 等非终态非 running 状态后端 409，err 占位即可
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
  }, [detail.id, detail.status, isRunning]);

  // 入口可能中途死掉（hub 重启/port-forward 瞬断），首探也可能撞上沙箱冷启动未就绪：
  // 周期重取 shell-url，reachable 翻转或 url 变化即更新（旧条件漏掉同 url 的 false→true 翻转，
  // 会永远卡在「不可直达」占位）；未达时加密轮询（冷启动窗口尽快翻转）
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      fetchShellUrl(detail.id)
        .then((r) => setShell((prev) => (prev && prev.url === r.url && prev.reachable === r.reachable ? prev : r)))
        .catch(() => undefined);
    }, shell?.reachable ? 8_000 : 3_000);
    return () => clearInterval(timer);
  }, [detail.id, isRunning, shell?.reachable]);

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
          <span className="via">{shell?.reachable ? (isRunning ? 'qwen-code Web Shell' : 'qwen-code Web Shell · 会话回放') : 'qwen-code Web Shell'}</span>
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
              ? isRunning
                ? 'Web Shell 启动中/暂不可达，正在重试（沙箱冷启动约需数秒；若持续如此：需 hub 与浏览器同机或 hub 部署在集群内）'
                : '该 handoff 无返回包，Web Shell 回放不可用'
              : '正在连接云端会话…'}
        </div>
      )}
    </aside>
  );
}
