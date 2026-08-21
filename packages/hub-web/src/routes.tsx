import { Navigate, createBrowserRouter, type RouteObject } from 'react-router-dom';
import { AppShell } from './AppShell.js';
import { TasksView } from './views/TasksView.js';
import { SandboxView } from './views/SandboxView.js';
import { OssView } from './views/OssView.js';
import { SettingsView } from './views/SettingsView.js';
import { IdeView } from './views/IdeView.js';

/**
 * 路由表。`/tasks/:id` 是对外契约——hub-server 创建 handoff 时返回的
 * `webUrl = <base>/tasks/<id>`，此前没有任何前端代码消费它（SPA fallback 能返回
 * index.html，所以链接打得开但渲染的是错误的任务）。这里让它真正生效。
 */
export const routes: RouteObject[] = [
  // Web IDE 全屏视图：不进 AppShell，独占整个视口
  { path: '/tasks/:id/ide', element: <IdeView /> },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Navigate to="/tasks" replace /> },
      { path: '/tasks', element: <TasksView /> },
      { path: '/tasks/:id', element: <TasksView /> },
      { path: '/sandbox', element: <SandboxView /> },
      { path: '/oss', element: <OssView /> },
      { path: '/settings', element: <SettingsView /> },
      { path: '*', element: <Navigate to="/tasks" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
