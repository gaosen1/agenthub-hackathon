/**
 * 设置视图（S19）。真实数据 GET/PATCH /api/settings。
 * - webhook 加密落库，界面只显示掩码；「测试」按钮走服务端真实连通性反馈；
 * - 「本地缓存清理」是 CLI 本机行为 → 只读说明 + 可复制命令。
 * （Chat 消息同步、API Token 轮换已按用户决策下线：前者无可行挂点，后者无人关心）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AuthRequiredError } from '../api/client.js';
import { fetchSettings, patchSettings, testWebhook } from '../api/settings.js';
import { Card } from '../components/ui/Card.js';
import { FormRow, Switch, TagChip } from '../components/ui/FormRow.js';

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
);

export function SettingsView() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const [webhookInput, setWebhookInput] = useState('');
  const [showWebhook, setShowWebhook] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: patchSettings,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const test = useMutation({
    mutationFn: () => testWebhook(webhookInput || undefined),
    onSuccess: () => setTestMsg('连通性测试成功，钉钉群应已收到测试消息。'),
    onError: (e) => setTestMsg(`测试失败：${e instanceof Error ? e.message : String(e)}`),
  });

  const copyCmd = (cmd: string) => void navigator.clipboard.writeText(cmd);

  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-h">
          <div className="v-icon">
            <GearIcon />
          </div>
          <div>
            <h1>设置</h1>
            <div className="sub">Hub 连接 · 通知集成 · CLI 本机配置</div>
          </div>
        </div>

        {error instanceof AuthRequiredError ? (
          <Card>
            <div className="empty-hint">未登录，请点击右上角登录后管理设置。</div>
          </Card>
        ) : error ? (
          <Card>
            <div className="empty-hint">
              加载失败：{error instanceof Error ? error.message : String(error)}{' '}
              <button type="button" className="link-btn" onClick={() => void qc.invalidateQueries({ queryKey: ['settings'] })}>
                重试
              </button>
            </div>
          </Card>
        ) : isLoading || !data ? (
          <Card>
            <div className="empty-hint">加载中…</div>
          </Card>
        ) : (
          <>
            <Card title="通知集成" hint="状态变更推送到钉钉群">
              <FormRow label="任务状态通知" hint="running / done / failed / expired / cancelled 时推送">
                <Switch
                  label="任务状态通知"
                  checked={data.settings.notifyStatusChange}
                  disabled={patch.isPending}
                  onChange={(v) => patch.mutate({ notifyStatusChange: v })}
                />
                <TagChip>{data.settings.notifyStatusChange ? '开' : '关'}</TagChip>
              </FormRow>
              <FormRow
                label="钉钉群 Webhook"
                hint={data.settings.webhook.configured ? `已配置：${data.settings.webhook.masked}` : '群设置 → 机器人 → 自定义 Webhook'}
              >
                <input
                  className="fi"
                  type={showWebhook ? 'text' : 'password'}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                  value={webhookInput}
                  onChange={(e) => setWebhookInput(e.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="btn" onClick={() => setShowWebhook((s) => !s)}>
                  {showWebhook ? '隐藏' : '显示'}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!webhookInput || patch.isPending}
                  onClick={() => patch.mutate({ webhook: webhookInput })}
                >
                  保存
                </button>
                <button type="button" className="btn" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? '测试中…' : '测试'}
                </button>
                {testMsg && <span className="mono">{testMsg}</span>}
              </FormRow>
            </Card>

            <Card title="Hub 服务端" hint="只读，来自环境变量与真实配置">
              <FormRow label="Hub 地址">
                <span className="mono">{data.server.hubUrl ?? '未配置（同源）'}</span>
              </FormRow>
              <FormRow label="OSS Bucket">
                <span className="mono">{data.server.ossBucket ?? '未配置'}</span>
                <span className="mono">{data.server.ossRegion ?? ''}</span>
              </FormRow>
              <FormRow label="签名 URL 有效期">
                <span className="mono">{Math.round(data.server.signedUrlTtlSeconds / 60)} 分钟</span>
              </FormRow>
              <FormRow label="Sandbox 镜像">
                <span className="mono">{data.server.sandboxImage}</span>
              </FormRow>
              <FormRow label="编排后端">
                <span className="mono">{data.server.backend === 'aone' ? 'Aone 沙箱（弹内算力）' : 'K8s（ACK/ACS）'}</span>
              </FormRow>
              <FormRow label="任务静默容忍" hint="执行期卡死检测语义，非寿命上限；活跃自动续命">
                <span className="mono">
                  {data.server.defaultTimeoutMinutes >= 60
                    ? `${Math.round(data.server.defaultTimeoutMinutes / 60)} 小时`
                    : `${data.server.defaultTimeoutMinutes} 分钟`}
                </span>
              </FormRow>
              <FormRow label="空闲回收 TTL" hint="交互会话 / Bot 驻留期空闲超过即回收">
                <span className="mono">{data.server.idleTtlMinutes} 分钟</span>
              </FormRow>
            </Card>

            <Card title="CLI 本机配置" hint="服务端管不到本机行为，这里给可复制命令">
              <div className="cmd">
                <span className="dollar">$</span> ah config list
                <button type="button" className="copy" onClick={() => copyCmd('ah config list')}>
                  复制
                </button>
              </div>
              <div className="cmd">
                <span className="dollar">$</span> ah config set includeUntracked true
                <button type="button" className="copy" onClick={() => copyCmd('ah config set includeUntracked true')}>
                  复制
                </button>
              </div>
            </Card>
          </>
        )}
      </div>
    </section>
  );
}
