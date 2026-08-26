/**
 * OSS 对象存储视图（S15）。真实数据 GET /api/oss，不做 mock 回退。
 * 视觉遵循 design-system/agenthub/MASTER.md：内联 SVG 图标、等宽数据列、
 * 扁平发丝线、空态/未配置/未登录/错误齐备，不摆假值。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { OssObjectDto } from '@agenthub/shared/contracts';
import { AuthRequiredError } from '../api/client.js';
import { fetchOss, signOss } from '../api/oss.js';
import { Card } from '../components/ui/Card.js';
import { DataTable, type Column } from '../components/ui/DataTable.js';
import { TagChip } from '../components/ui/FormRow.js';
import { StatGrid, formatBytes } from '../components/ui/StatGrid.js';
import { fmtHm } from '../statusMeta.js';

const DbIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export function OssView() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['oss'], queryFn: () => fetchOss() });
  const refresh = useMutation({
    mutationFn: () => fetchOss(true),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['oss'] }),
  });
  const copy = useMutation({
    mutationFn: async (key: string) => {
      const url = await signOss(key);
      await navigator.clipboard.writeText(url);
      return key;
    },
    onSuccess: (key) => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    },
  });

  const columns: Column<OssObjectDto>[] = [
    { key: 'key', header: '对象 Key', render: (o) => <span className="mono">{o.key}</span> },
    { key: 'dir', header: '方向', render: (o) => <TagChip>{o.direction === 'input' ? '输入包' : '返回包'}</TagChip> },
    {
      key: 'size',
      header: '大小',
      render: (o) => {
        if (o.expired) return <span className="mono" style={{ color: 'var(--tx3)' }}>—</span>;
        const b = formatBytes(o.size ?? 0);
        return (
          <span className="mono">
            {b.value} <small style={{ color: 'var(--tx2)' }}>{b.unit}</small>
          </span>
        );
      },
    },
    { key: 'at', header: '上传时间', render: (o) => <span className="mono">{o.uploadedAt ? fmtHm(o.uploadedAt) : '—'}</span> },
    {
      key: 'state',
      header: '状态',
      render: (o) =>
        o.expired ? (
          <span className="badge b-failed">已过期清理</span>
        ) : o.partial ? (
          <span className="badge b-queued">部分成果</span>
        ) : (
          <span className="badge b-done">在库</span>
        ),
    },
    {
      key: 'actions',
      header: '操作',
      render: (o) => (
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="link-btn"
            disabled={o.expired || copy.isPending}
            onClick={() => copy.mutate(o.key)}
          >
            <CopyIcon />
            {copied === o.key ? '已复制' : '复制签名链接'}
          </button>
          <Link className="link-btn mono" to={`/tasks/${o.handoffId}`}>
            {o.handoffId}
          </Link>
        </span>
      ),
    },
  ];

  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-h">
          <div className="v-icon">
            <DbIcon />
          </div>
          <div>
            <h1>OSS 对象存储</h1>
            <div className="sub">输入包 / 返回包的唯一数据通道 · 依赖缓存、warm bundle 与 bot 快照同桶存储（本面板仅列 handoff 包）</div>
          </div>
        </div>

        {error instanceof AuthRequiredError ? (
          <Card>
            <div className="empty-hint">未登录，请点击右上角登录后查看 OSS 对象。</div>
          </Card>
        ) : error ? (
          <Card>
            <div className="empty-hint">
              加载失败：{error instanceof Error ? error.message : String(error)}{' '}
              <button type="button" className="link-btn" onClick={() => void qc.invalidateQueries({ queryKey: ['oss'] })}>
                重试
              </button>
            </div>
          </Card>
        ) : isLoading || !data ? (
          <Card>
            <div className="empty-hint">加载中…</div>
          </Card>
        ) : !data.configured ? (
          <Card>
            <div className="empty-hint">
              OSS 未配置：缺少 OSS_BUCKET / OSS_AK / OSS_SK 或 HUB_NO_OSS=1。面板不显示假数据。
            </div>
          </Card>
        ) : (
          <>
            <StatGrid
              items={[
                (() => {
                  const b = formatBytes(data.stats.totalBytes);
                  return { icon: 'fa-solid fa-weight-hanging', label: '在库总占用', value: b.value, unit: b.unit };
                })(),
                { icon: 'fa-solid fa-cubes', label: '在库对象数', value: String(data.stats.objectCount) },
                { icon: 'fa-solid fa-arrow-up-from-bracket', label: '今日上传', value: String(data.stats.uploadedToday) },
                {
                  icon: 'fa-solid fa-hourglass-half',
                  label: '生命周期',
                  value: data.lifecycleDays === null ? '—' : String(data.lifecycleDays),
                  unit: data.lifecycleDays === null ? undefined : '天',
                },
              ]}
            />
            <Card
              title="包对象"
              hint={
                <button type="button" className="link-btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                  {refresh.isPending ? '对账中…' : '与 OSS 对账（refresh）'}
                </button>
              }
              padded={false}
            >
              <DataTable
                columns={columns}
                rows={data.items}
                rowKey={(o) => o.key}
                empty="还没有任何包对象。在本地仓库执行 ah push 后，输入包会出现在这里。"
              />
            </Card>
            <Card title="签名 URL">
              <div className="empty-hint">
                签名有效期 {Math.round(data.signedUrlTtlSeconds / 60)} 分钟；「复制签名链接」生成的 URL 过期需重新复制。
              </div>
            </Card>
          </>
        )}
      </div>
    </section>
  );
}
