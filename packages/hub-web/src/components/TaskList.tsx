import { useMemo, useState } from 'react';
import type { HandoffSummary } from '@agenthub/shared/contracts';
import { STATUS_META, TERMINAL_BAD, fmtHm } from '../statusMeta.js';
import { mockExtras } from '../api/mock.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '执行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
] as const;

interface Props {
  items: HandoffSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ items, currentId, onSelect }: Props) {
  const [kw, setKw] = useState('');
  const [filter, setFilter] = useState<string>('all');

  const list = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return items.filter((t) => {
      const okFilter =
        filter === 'all' ||
        (filter === 'failed' ? TERMINAL_BAD.includes(t.status) : t.status === filter);
      const text = `${t.agentName} ${t.task ?? ''}`.toLowerCase();
      return okFilter && (!k || text.includes(k));
    });
  }, [items, kw, filter]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h2>
          <i className="fa-solid fa-clock-rotate-left" /> Handoff 列表{' '}
          <span className="count">{items.length}</span>
        </h2>
      </div>
      <div className="search">
        <i className="fa-solid fa-magnifying-glass" />
        <input
          type="text"
          placeholder="搜索仓库 / 任务…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="task-list">
        {list.length === 0 && (
          <div className="empty-hint" style={{ padding: 16 }}>
            无匹配任务
          </div>
        )}
        {list.map((t) => {
          const m = STATUS_META[t.status];
          const rounds = mockExtras[t.id]?.rounds;
          return (
            <div
              key={t.id}
              className={`task-item ${t.id === currentId ? 'active' : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <div className="row1">
                <span className="repo">
                  <i className="fa-solid fa-folder-tree" /> {t.agentName}
                </span>
                <span className={`badge ${m.cls}`}>
                  <i className={m.icon} />
                  {m.label}
                </span>
              </div>
              <div className="summary">{t.task ?? '（交互接力：无预设指令）'}</div>
              <div className="meta">
                <span>
                  <i className="fa-solid fa-code-branch" />
                  {t.branch}
                </span>
                {rounds !== undefined && (
                  <span>
                    <i className="fa-regular fa-comments" />
                    {rounds} 轮
                  </span>
                )}
                <span>
                  <i className="fa-regular fa-clock" />
                  {fmtHm(t.createdAt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        本地推送新任务：<code>agenthub push --task "…"</code>
      </div>
    </aside>
  );
}
