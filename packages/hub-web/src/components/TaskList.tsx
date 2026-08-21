import { useMemo, useState } from 'react';
import type { HandoffSummary } from '@agenthub/shared/contracts';
import { STATUS_META, TERMINAL_BAD, fmtHm } from '../statusMeta.js';
import { mockExtras } from '../api/mock.js';

/** MASTER.md：新代码一律内联 SVG（1.5px 描边），不用 emoji/FA 字形 */
const ArchiveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
    <path d="M10 13h4" />
  </svg>
);
const UnarchiveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
    <path d="M12 17v-4m0 0-2 2m2-2 2 2" />
  </svg>
);
const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
  </svg>
);

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
  showArchived: boolean;
  onToggleArchived: () => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
}

export function TaskList({ items, currentId, onSelect, showArchived, onToggleArchived, onArchive, onDelete }: Props) {
  const [kw, setKw] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
        <button
          className={`chip ${showArchived ? 'active' : ''}`}
          style={{ marginLeft: 'auto' }}
          title="切换归档视图"
          onClick={onToggleArchived}
        >
          归档
        </button>
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
          const terminal = t.status === 'done' || TERMINAL_BAD.includes(t.status);
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
                {terminal && (
                  <span className="task-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      title={t.archived ? '取消归档' : '归档'}
                      onClick={() => onArchive(t.id, !t.archived)}
                    >
                      {t.archived ? <UnarchiveIcon /> : <ArchiveIcon />}
                    </button>
                    <button
                      className={confirmId === t.id ? 'danger' : ''}
                      title="删除（两步确认）"
                      onClick={() => {
                        if (confirmId === t.id) {
                          setConfirmId(null);
                          onDelete(t.id);
                        } else {
                          setConfirmId(t.id);
                        }
                      }}
                      onBlur={() => setConfirmId((c) => (c === t.id ? null : c))}
                    >
                      {confirmId === t.id ? '确认？' : <TrashIcon />}
                    </button>
                  </span>
                )}
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
