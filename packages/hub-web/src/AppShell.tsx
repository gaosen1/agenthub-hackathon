/**
 * 应用外壳：顶栏 + 路由出口。
 * `.app` 是 56px 顶栏 + 1fr 内容的两行 grid；内容区由各视图自己决定布局
 * （Handoff 任务用三栏 `.main`，其余用单栏 `.view`）。
 */
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Topbar } from './components/Topbar.js';
import { LoginModal } from './components/LoginModal.js';

export function AppShell() {
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <div className="app">
      <Topbar onLogin={() => setLoginOpen(true)} />
      <Outlet />
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
