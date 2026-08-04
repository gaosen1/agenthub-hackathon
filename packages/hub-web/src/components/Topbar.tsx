import { dataSource } from '../api/client.js';

export function Topbar() {
  const isHub = dataSource === 'hub';
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">
          <i className="fa-solid fa-arrows-turn-to-dots" />
        </div>
        AgentHub <small>本地 Session 云端接力</small>
      </div>
      <div className="right">
        <div className="conn">
          <span className={`dot ${isHub ? '' : 'mock'}`} />
          {isHub ? 'Hub 已连接' : 'Mock 数据 · Hub 未连接'}
        </div>
        <div className="avatar">
          <i className="fa-solid fa-user" />
        </div>
      </div>
    </header>
  );
}
