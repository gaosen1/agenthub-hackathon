/**
 * Handoff 任务视图（design.md §5.4 F-12，UI 以 docs/prototype.html 为准）
 * 三栏布局——任务列表 · 任务详情（STEPS/日志/commit）· Chat 面板
 * 数据：真 Hub /api 优先，不可达自动回退 mock（spec §7 CP-3 先 mock 验收再联调）
 *
 * 当前选中任务来自路由参数 `/tasks/:id`，而不是组件内的 state——
 * 这样 hub-server 返回的 webUrl 才能深链到正确的任务。
 */
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useHandoffDetail, useHandoffs } from '../api/hooks.js';
import { archiveHandoff, deleteHandoff, useDataSource } from '../api/client.js';
import { TaskList } from '../components/TaskList.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { PullModal } from '../components/PullModal.js';

export function TasksView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dataSource = useDataSource();
  const [showArchived, setShowArchived] = useState(false);
  const { data: listData } = useHandoffs(showArchived);
  const items = listData?.items ?? [];
  const [pullOpen, setPullOpen] = useState(false);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['handoffs'] });

  const handleArchive = async (id: string, archived: boolean) => {
    try {
      await archiveHandoff(id, archived);
    } finally {
      refresh();
    }
  };
  const handleDelete = async (id: string) => {
    try {
      await deleteHandoff(id);
    } finally {
      refresh();
    }
  };

  const currentId = id ?? null;
  const { data: detail } = useHandoffDetail(currentId);

  // 列表已加载且当前选中任务不在其中（被删除/清理/列表空）→ 回列表页：
  // react-query 在 404 后仍保留旧 detail，不跳走会渲染幽灵详情 + 404 轮询循环（hf-9f3a2c 事故）
  const listLoaded = listData !== undefined;
  if (listLoaded && currentId !== null && !items.some((i) => i.id === currentId)) {
    return <Navigate to="/tasks" replace />;
  }

  // URL 没指定任务 → 落到第一个
  const first = items[0];
  if (first && currentId === null) {
    return <Navigate to={`/tasks/${first.id}`} replace />;
  }

  return (
    <div className="main">
      <TaskList
        items={items}
        currentId={currentId}
        onSelect={(next) => navigate(`/tasks/${next}`)}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onArchive={handleArchive}
        onDelete={handleDelete}
      />
      <section className="detail">
        <div className="detail-inner">
          {detail ? (
            <TaskDetail detail={detail} onOpenPull={() => setPullOpen(true)} />
          ) : (
            <div className="empty-hint" style={{ padding: 40, textAlign: 'center' }}>
              {dataSource === 'unauth'
                ? 'Hub 已连接但未登录，请点击右上角登录'
                : items.length === 0
                  ? '暂无 handoff 任务，本地执行 agenthub push 创建'
                  : '加载中…'}
            </div>
          )}
        </div>
      </section>
      {detail ? <ChatPanel detail={detail} /> : <aside className="chat" />}
      {pullOpen && detail && <PullModal detail={detail} onClose={() => setPullOpen(false)} />}
    </div>
  );
}
