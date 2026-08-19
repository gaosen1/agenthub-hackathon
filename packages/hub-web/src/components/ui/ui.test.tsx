/**
 * UI 原子组件（S4）。三个新面板共用，重点验证受控开关与表格空态。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Card, ViewHeader } from './Card.js';
import { DataTable } from './DataTable.js';
import { FormRow, Switch, TagChip } from './FormRow.js';
import { StatGrid, formatBytes, formatDuration } from './StatGrid.js';

describe('Switch', () => {
  it('受控渲染 aria-checked 并回调取反值', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="状态变更推送" />);

    const sw = screen.getByRole('switch', { name: '状态变更推送' });
    expect(sw).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('由调用方持有状态，点击后视图跟随', async () => {
    function Host() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="Chat 同步" />;
    }
    render(<Host />);
    const sw = screen.getByRole('switch');

    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('disabled 时不触发回调（用于「计划中」的开关）', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} disabled label="Chat 同步" />);

    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

interface Row {
  id: string;
  pod: string;
}

describe('DataTable', () => {
  const columns = [
    { key: 'pod', header: '实例', render: (r: Row) => r.pod },
    { key: 'id', header: 'Handoff', render: (r: Row) => r.id },
  ];

  it('渲染表头与行', () => {
    render(
      <DataTable
        columns={columns}
        rows={[{ id: 'hf-9f3a2c', pod: 'ah-web-9f3a2c' }]}
        rowKey={(r) => r.id}
        empty="暂无实例"
      />,
    );

    expect(screen.getByRole('columnheader', { name: '实例' })).toBeInTheDocument();
    expect(screen.getByText('ah-web-9f3a2c')).toBeInTheDocument();
  });

  it('空数据时给调用方指定的空态文案，而不是渲染空表格', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} empty="近 24 小时无实例" />);

    expect(screen.getByText('近 24 小时无实例')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('FormRow / Card / ViewHeader / StatGrid', () => {
  it('FormRow 渲染标签、副说明与控件', () => {
    render(
      <FormRow label="任务超时上限" hint="到期强制 packaging 并回收 Sandbox">
        <span>30 分钟</span>
      </FormRow>,
    );

    expect(screen.getByText('任务超时上限')).toBeInTheDocument();
    expect(screen.getByText('到期强制 packaging 并回收 Sandbox')).toBeInTheDocument();
    expect(screen.getByText('30 分钟')).toBeInTheDocument();
  });

  it('Card 的 padded=false 用于贴边表格', () => {
    const { container } = render(
      <Card title="包对象" padded={false}>
        <table />
      </Card>,
    );
    expect(container.querySelector('.card-b')).toBeNull();
  });

  it('ViewHeader 渲染 h1 与副标题', () => {
    render(<ViewHeader icon="fa-cube" title="Sandbox 调度层" sub="ACK 集群 · ACS 弹性算力" />);

    expect(screen.getByRole('heading', { name: 'Sandbox 调度层' })).toBeInTheDocument();
    expect(screen.getByText('ACK 集群 · ACS 弹性算力')).toBeInTheDocument();
  });

  it('StatGrid 渲染数值与单位', () => {
    render(<StatGrid items={[{ icon: 'fa-play', label: '运行中', value: 1 }, { icon: 'fa-clock', label: '24h 累计执行', value: 47, unit: 'min' }]} />);

    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('min')).toBeInTheDocument();
  });
});

describe('展示层单位换算', () => {
  it.each([
    [0, '0', 'B'],
    [512, '512', 'B'],
    [1024, '1.0', 'KB'],
    [224395264, '214', 'MB'],
    [1610612736, '1.5', 'GB'],
  ])('formatBytes(%i) → %s %s', (bytes, value, unit) => {
    expect(formatBytes(bytes)).toEqual({ value, unit });
  });

  it.each([
    [null, '—'],
    [45, '45s'],
    [760, '12m 40s'],
    [3960, '1h 06m'],
  ])('formatDuration(%s) → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
