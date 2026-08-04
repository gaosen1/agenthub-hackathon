import { useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { clearToken, dataSource, getToken } from '../api/client.js';

const SOURCE_META = {
  hub: { cls: '', label: 'Hub 已连接' },
  mock: { cls: 'mock', label: 'Mock 数据 · Hub 未连接' },
  unauth: { cls: 'mock', label: 'Hub 可达 · 未登录' },
} as const;

const NAV = [
  { to: '/tasks', icon: 'fa-list-check', label: 'Handoff 任务' },
  { to: '/sandbox', icon: 'fa-cube', label: 'Sandbox' },
  { to: '/oss', icon: 'fa-database', label: 'OSS 存储' },
  { to: '/settings', icon: 'fa-gear', label: '设置' },
] as const;

export function Topbar({ onLogin }: { onLogin: () => void }) {
  const meta = SOURCE_META[dataSource];
  const qc = useQueryClient();
  const loggedIn = getToken() !== null && dataSource === 'hub';

  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">
          <i className="fa-solid fa-arrows-turn-to-dots" />
        </div>
        AgentHub <small>本地 Session 云端接力</small>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <i className={`fa-solid ${n.icon}`} /> {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="right">
        <div className="conn">
          <span className={`dot ${meta.cls}`} />
          {meta.label}
        </div>
        {loggedIn ? (
          <button
            className="icon-btn"
            title="登出"
            onClick={() => {
              clearToken();
              void qc.invalidateQueries();
            }}
          >
            <i className="fa-solid fa-right-from-bracket" />
          </button>
        ) : (
          <button className="btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={onLogin}>
            <i className="fa-solid fa-user" /> 登录
          </button>
        )}
      </div>
    </header>
  );
}
