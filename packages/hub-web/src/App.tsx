/**
 * Web 任务面板（design.md §5.4 F-12，UI 以 docs/prototype.html 为准）
 * 三栏布局——任务列表 · 任务详情（STEPS/日志/commit）· Chat 面板
 * 数据：真 Hub /api 优先，不可达自动回退 mock（spec §7 CP-3 先 mock 验收再联调）
 */
import { useEffect, useState } from 'react';
import { useHandoffDetail, useHandoffs } from './api/hooks.js';
import { Topbar } from './components/Topbar.js';
import { TaskList } from './components/TaskList.js';
import { TaskDetail } from './components/TaskDetail.js';
import { ChatPanel } from './components/ChatPanel.js';
import { PullModal } from './components/PullModal.js';

export function App() {
  const { data: listData } = useHandoffs();
  const items = listData?.items ?? [];
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [pullOpen, setPullOpen] = useState(false);

  // 首次加载后默认选中第一个任务
  useEffect(() => {
    if (currentId === null && items.length > 0) setCurrentId(items[0].id);
  }, [currentId, items]);

  const { data: detail } = useHandoffDetail(currentId);

  return (
    <div className="app">
      <Topbar />
      <div className="main">
        <TaskList items={items} currentId={currentId} onSelect={setCurrentId} />
        <section className="detail">
          <div className="detail-inner">
            {detail ? (
              <TaskDetail detail={detail} onOpenPull={() => setPullOpen(true)} />
            ) : (
              <div className="empty-hint" style={{ padding: 40, textAlign: 'center' }}>
                {items.length === 0 ? '暂无 handoff 任务，本地执行 agenthub push 创建' : '加载中…'}
              </div>
            )}
          </div>
        </section>
        {detail ? <ChatPanel detail={detail} /> : <aside className="chat" />}
      </div>
      {pullOpen && detail && <PullModal detail={detail} onClose={() => setPullOpen(false)} />}
    </div>
  );
}
