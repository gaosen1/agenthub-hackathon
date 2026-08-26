import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@agenthub/shared/contracts';
import { createBot, deleteBot, fetchBots } from '../api/client.js';

const STATUS_META: Record<Bot['status'], { color: string; label: string }> = {
  creating: { color: 'var(--warn, #d9a552)', label: '创建中' },
  running: { color: 'var(--ok)', label: '运行中' },
  error: { color: 'var(--err)', label: '异常' },
  deleted: { color: 'var(--tx3)', label: '已删除' },
};

/** 钉钉机器人管理弹窗：列表 + 创建（clientId/clientSecret 凭证）+ 删除 */
export function BotsModal({ onClose }: { onClose: () => void }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    void fetchBots()
      .then(setBots)
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  const submit = async () => {
    if (!name.trim() || !clientId.trim() || !clientSecret.trim()) {
      setErr('机器人名称、Client ID、Client Secret 均不能为空');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await createBot(name.trim(), clientId.trim(), clientSecret.trim());
      setName('');
      setClientId('');
      setClientSecret('');
      setShowForm(false);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (bot: Bot) => {
    if (!confirm(`删除机器人 "${bot.name}"？常驻 sandbox 与钉钉凭证 Secret 将一并回收。`)) return;
    setBusy(true);
    setErr('');
    try {
      await deleteBot(bot.id);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width: 480 }}>
        <div className="modal-h">
          <div className="mh-icon" style={{ background: 'rgba(74,222,128,.1)', color: 'var(--brand)' }}>
            <i className="fa-solid fa-robot" />
          </div>
          <div>
            <div className="mh-t">钉钉机器人</div>
            <div className="mh-s">凭证经 K8s Secret 注入常驻 sandbox，不落明文</div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-b" style={{ paddingTop: 16 }}>
          {loading ? (
            <div style={{ color: 'var(--tx3)', fontSize: 13, padding: '12px 0' }}>加载中…</div>
          ) : bots.length === 0 && !showForm ? (
            <div style={{ color: 'var(--tx3)', fontSize: 13, padding: '12px 0' }}>
              暂无机器人。创建后 Hub 会拉起常驻 sandbox，钉钉群 @ 机器人即可对话。
            </div>
          ) : (
            bots.map((bot) => {
              const meta = STATUS_META[bot.status];
              return (
                <div
                  key={bot.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: '1px solid var(--line, rgba(255,255,255,.08))',
                    borderRadius: 8,
                    marginBottom: 8,
                  }}
                >
                  <i className="fa-solid fa-robot" style={{ color: 'var(--brand)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{bot.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--tx3)' }}>
                      <span style={{ color: meta.color }}>● {meta.label}</span>
                      {bot.podName && <span style={{ marginLeft: 8 }}>pod: {bot.podName}</span>}
                      {bot.currentHandoffId && <span style={{ marginLeft: 8 }}>接力中: {bot.currentHandoffId}</span>}
                    </div>
                  </div>
                  <button className="icon-btn" title="删除机器人" disabled={busy} onClick={() => void remove(bot)}>
                    <i className="fa-solid fa-trash-can" />
                  </button>
                </div>
              );
            })
          )}

          {showForm ? (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line, rgba(255,255,255,.08))' }}>
              <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>机器人名称（channel 实例名）</label>
              <input
                className="fi"
                style={{ maxWidth: 'none', marginBottom: 10, width: '100%' }}
                placeholder="如 my-agent-bot"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>钉钉应用 Client ID (AppKey)</label>
              <input
                className="fi"
                style={{ maxWidth: 'none', marginBottom: 10, width: '100%' }}
                placeholder="dingxxxxxxxx"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>钉钉应用 Client Secret (AppSecret)</label>
              <input
                className="fi"
                style={{ maxWidth: 'none', marginBottom: 14, width: '100%' }}
                type="password"
                placeholder="凭证只入 K8s Secret，API 不回显"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
              {err && (
                <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>
                  <i className="fa-solid fa-circle-exclamation" /> {err}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void submit()} disabled={busy}>
                  {busy ? '创建中…（拉起常驻 sandbox）' : '创建机器人'}
                </button>
                <button className="btn" onClick={() => setShowForm(false)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              {err && (
                <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 10 }}>
                  <i className="fa-solid fa-circle-exclamation" /> {err}
                </div>
              )}
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 4 }} onClick={() => setShowForm(true)}>
                <i className="fa-solid fa-plus" /> 添加机器人
              </button>
            </>
          )}
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'var(--tx3)' }}>
            Secret 加密存 hub-server；建 sandbox 时以 bot-&lt;id&gt; Secret 注入，qwen 经 $ENV 引用读取
          </div>
        </div>
      </div>
    </div>
  );
}
