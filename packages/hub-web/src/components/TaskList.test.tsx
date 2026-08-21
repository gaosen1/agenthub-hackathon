/**
 * TaskList 归档/删除操作：终态行才有操作区；删除两步确认；归档态显示取消归档图标。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HandoffSummary } from '@agenthub/shared/contracts';
import { TaskList } from './TaskList.js';

const base = {
  agentName: 'demo',
  kind: 'web' as const,
  branch: 'main',
  baseCommit: 'abc',
  sessionId: 's',
  createdAt: '2026-08-21T00:00:00Z',
  updatedAt: '2026-08-21T00:00:00Z',
  archived: false,
};
const done: HandoffSummary = { ...base, id: 'hf-done1', status: 'done' };
const running: HandoffSummary = { ...base, id: 'hf-run1', status: 'running' };

const noop = () => undefined;

describe('TaskList 归档/删除', () => {
  it('终态行显示归档按钮，点击回调 (id, true)', () => {
    const onArchive = vi.fn();
    render(
      <TaskList items={[done, running]} currentId={null} onSelect={noop} showArchived={false} onToggleArchived={noop} onArchive={onArchive} onDelete={noop} />,
    );
    fireEvent.click(screen.getByTitle('归档'));
    expect(onArchive).toHaveBeenCalledWith('hf-done1', true);
  });

  it('删除两步确认；非终态行无操作区', () => {
    const onDelete = vi.fn();
    render(
      <TaskList items={[done, running]} currentId={null} onSelect={noop} showArchived={false} onToggleArchived={noop} onArchive={noop} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByTitle('删除（两步确认）'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认？'));
    expect(onDelete).toHaveBeenCalledWith('hf-done1');
    // running 行没有归档按钮 → 全页仅 done 行一个
    expect(screen.getAllByTitle('归档')).toHaveLength(1);
  });

  it('已归档行显示取消归档图标', () => {
    render(
      <TaskList items={[{ ...done, archived: true }]} currentId={null} onSelect={noop} showArchived onToggleArchived={noop} onArchive={noop} onDelete={noop} />,
    );
    expect(screen.getByTitle('取消归档')).toBeTruthy();
  });
});

describe('TaskList 运行态 icon', () => {
  it('running 行显示旋转 icon，终态行不显示', () => {
    render(
      <TaskList items={[done, running]} currentId={null} onSelect={noop} showArchived={false} onToggleArchived={noop} onArchive={noop} onDelete={noop} />,
    );
    expect(screen.getAllByTitle('会话运行中（SSE 流活跃）')).toHaveLength(1);
  });
});
