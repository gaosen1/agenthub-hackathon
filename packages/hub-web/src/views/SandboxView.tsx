/**
 * Sandbox 调度层视图（原型 docs/prototype.html §view-sandbox）
 *
 * 原型里这一页的数值全是编的，此处逐项换成真源（见 GET /api/sandboxes）：
 * - 副标题的「E2B 临时执行环境」→ 本项目实际是 ACK 集群 + ACS 弹性算力
 * - `sb-e2b-7d21` → 真实 pod 名 `ah-web-<6hex>` / `ah-bot-<id>-<name>`
 * - `qwen-code:v1.4.2` → SANDBOX_IMAGE
 * - 「已发布」badge / 构建日期 → 没有真实来源，不渲染
 * - 「回收与超时策略」四条文案 → Worker 的真实配置
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SandboxInstance, SandboxListResp } from '@agenthub/shared/contracts';
import { fetchSandboxes } from '../api/sandbox.js';
import { AuthRequiredError } from '../api/client.js';
import { Card, ViewHeader } from '../components/ui/Card.js';
import { DataTable, type Column } from '../components/ui/DataTable.js';
import { StatGrid, formatDuration } from '../components/ui/StatGrid.js';
import { TagChip } from '../components/ui/FormRow.js';
import { fmtHm } from '../statusMeta.js';

const SANDBOX_STATUS_META: Record<SandboxInstance['status'], { label: string; cls: string; icon: string }> = {
  provisioning: { label: '创建中', cls: 'b-packaging', icon: 'fa-solid fa-cube' },
  running: { label: '运行中', cls: 'b-running', icon: 'fa-solid fa-circle-notch' },
  reclaimed: { label: '已回收', cls: '', icon: 'fa-solid fa-box-archive' },
  failed: { label: '失败', cls: 'b-failed', icon: 'fa-solid fa-xmark' },
  lost: { label: '已丢失', cls: 'b-failed', icon: 'fa-solid fa-unlink' },
};

/** 回收原因用中文短语说明，避免面板上出现裸枚举 */
const REASON_LABEL: Record<NonNullable<SandboxInstance['reclaimReason']>, string> = {
  'task-done': '任务完成',
  'task-failed': '任务失败',
  expired: '超时回收',
  cancelled: '已取消',
  'pod-failed': 'Pod 启动失败',
  'load-failed': '输入包加载失败',
  'pod-lost': 'Pod 丢失',
  'bot-deleted': 'Bot 已删除',
  orphan: '孤儿清理',
  'crash-recover': '重启对账丢失',
};

function StatusBadge({ s }: { s: SandboxInstance }) {
  const meta = SANDBOX_STATUS_META[s.status];
  return (
    <span className={`badge ${meta.cls}`} style={meta.cls ? undefined : { background: 'var(--bg4)', color: 'var(--tx3)' }}>
      <i className={meta.icon} />
      {meta.label}
    </span>
  );
}

const columns: Column<SandboxInstance>[] = [
  { key: 'pod', header: '实例', render: (s) => <span className="mono">{s.podName}</span> },
  {
    key: 'kind',
    header: '载体',
    render: (s) => <TagChip>{s.kind === 'bot' ? '钉钉常驻' : 'Web 临时'}</TagChip>,
  },
  { key: 'status', header: '状态', render: (s) => <StatusBadge s={s} /> },
  {
    key: 'handoff',
    header: '关联 Handoff',
    render: (s) =>
      s.handoffId ? (
        <Link className="link-btn mono" to={`/tasks/${s.handoffId}`}>
          {s.handoffId}
        </Link>
      ) : (
        // bot pod 顺序服务多个 handoff，没有固定归属
        <span className="mono" style={{ color: 'var(--tx3)' }}>
          —
        </span>
      ),
  },
  { key: 'created', header: '创建时间', render: (s) => fmtHm(s.createdAt) },
  { key: 'duration', header: '执行时长', render: (s) => <span className="mono">{formatDuration(s.durationSeconds)}</span> },
  {
    key: 'reason',
    header: '结束原因',
    render: (s) =>
      s.reclaimReason ? (
        <span title={s.lastError ?? undefined}>{REASON_LABEL[s.reclaimReason]}</span>
      ) : (
        <span style={{ color: 'var(--tx3)' }}>—</span>
      ),
  },
];

function TemplateCard({ template }: { template: NonNullable<SandboxListResp['template']> }) {
  return (
    <Card icon="fa-layer-group" title="Sandbox 模板" hint={`namespace ${template.namespace}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="mono" style={{ color: 'var(--brand)', fontSize: 13, wordBreak: 'break-all' }}>
          {template.image}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx3)' }}>
          基础镜像 {template.baseImage} · {template.acs ? 'ACS 弹性算力' : '常规节点'}
        </span>
      </div>
      <div style={{ marginBottom: 12 }}>
        {template.toolchain.map((t) => (
          <TagChip key={t}>{t}</TagChip>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.9 }}>
        <div>
          <i className="fa-solid fa-microchip" style={{ color: 'var(--info)', width: 20 }} />
          单实例 {template.resources.cpu} core / {template.resources.memory}，
          runner :{template.ports.runner} · qwen serve :{template.ports.serve}
        </div>
        <div>
          <i className="fa-solid fa-shield-halved" style={{ color: 'var(--ok)', width: 20 }} />
          镜像不含任何凭证：模型 API Key 由 Worker 创建时以 Secret 注入，
          OSS 访问仅用 Hub 签发的限时签名 URL
        </div>
      </div>
    </Card>
  );
}

function PolicyCard({ policy }: { policy: SandboxListResp['policy'] }) {
  const mins = (ms: number) => Math.round(ms / 60_000);
  return (
    <Card icon="fa-stopwatch" title="回收与超时策略" hint="取自 Worker 实际配置">
      <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 2.1 }}>
        <div>
          <i className="fa-solid fa-circle-check" style={{ color: 'var(--ok)', width: 20 }} />
          任务进入终态后立即销毁实例
          {policy.taskLingerMinutes > 0 && `（task 完成后留驻 ${policy.taskLingerMinutes} 分钟供继续对话）`}
        </div>
        <div>
          <i className="fa-solid fa-hourglass-end" style={{ color: 'var(--warn)', width: 20 }} />
          任务执行期默认 {policy.defaultTimeoutMinutes} 分钟硬超时（push 时可按任务覆盖）；task 完成后时钟停摆，bot 转活跃度驱动的空闲回收
        </div>
        <div>
          <i className="fa-regular fa-clock" style={{ color: 'var(--cyan)', width: 20 }} />
          交互式会话空闲 {policy.idleTtlMinutes} 分钟后回收
        </div>
        <div>
          <i className="fa-solid fa-rotate" style={{ color: 'var(--info)', width: 20 }} />
          Worker 每 {policy.workerIntervalMs / 1000} 秒推进一轮；重启时对账实例与集群实况，
          丢失的记为 lost 而非停留在运行中
        </div>
        <div>
          <i className="fa-solid fa-broom" style={{ color: 'var(--tx3)', width: 20 }} />
          每 {mins(policy.orphanIntervalMs)} 分钟清理无关联任务的孤儿 Pod
        </div>
      </div>
    </Card>
  );
}

export function SandboxView() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['sandboxes'],
    queryFn: () => fetchSandboxes(24),
    refetchInterval: 5000,
    retry: false,
  });

  const header = (
    <ViewHeader
      icon="fa-cube"
      title="Sandbox 调度层"
      sub="ACK 集群 · ACS 弹性算力 · 任务级生命周期 · 用完即毁"
    />
  );

  if (error) {
    return (
      <section className="view">
        <div className="view-inner">
          {header}
          <Card>
            <div className="empty-hint">
              {error instanceof AuthRequiredError ? '未登录，请点击右上角登录后查看' : `加载失败：${(error as Error).message}`}
            </div>
          </Card>
        </div>
      </section>
    );
  }

  return (
    <section className="view">
      <div className="view-inner">
        {header}

        <StatGrid
          items={[
            { icon: 'fa-play', label: '运行中', value: data?.stats.running ?? '—' },
            { icon: 'fa-box-archive', label: `${data?.windowHours ?? 24}h 内已回收`, value: data?.stats.reclaimedInWindow ?? '—' },
            { icon: 'fa-layer-group', label: '可用模板', value: data?.stats.templates ?? '—' },
            {
              icon: 'fa-clock',
              label: `${data?.windowHours ?? 24}h 累计执行`,
              value: data ? Math.round(data.stats.execSecondsInWindow / 60) : '—',
              unit: 'min',
            },
          ]}
        />

        {data && !data.configured && (
          <Card icon="fa-triangle-exclamation" title="编排未启用">
            <div className="empty-hint">
              当前 hub-server 未接入 K8s（HUB_NO_K8S=1 或 kubeconfig 不可用），
              无法创建云端实例。下方仅显示历史记录与生效中的策略。
            </div>
          </Card>
        )}

        {data?.template && <TemplateCard template={data.template} />}

        <Card
          icon="fa-server"
          title="实例记录"
          hint={data ? `近 ${data.windowHours} 小时 · ${data.items.length} 个` : undefined}
          padded={false}
        >
          <DataTable
            columns={columns}
            rows={data?.items ?? []}
            rowKey={(s) => `${s.podName}-${s.createdAt}`}
            empty={isLoading ? '加载中…' : `近 ${data?.windowHours ?? 24} 小时内没有 Sandbox 实例`}
          />
        </Card>

        {data && <PolicyCard policy={data.policy} />}
      </div>
    </section>
  );
}
