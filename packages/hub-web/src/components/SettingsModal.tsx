import { useEffect, useState } from 'react';
import { getModelConfig, setModelConfig, testModelConfig } from '../api/client.js';

/** 常用 provider 预设：一键填充 baseUrl + 默认模型 */
const PROVIDER_PRESETS = [
  { name: 'IdeaLab（内网）', baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1', model: 'qwen3.8-max' },
  { name: 'Token Plan', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.6-flash' },
  { name: 'DashScope 公网', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
];

/** 模型凭证设置弹窗：per-user 隔离的 API Key / Base URL / Model 配置，provider 频繁切换场景 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://dashscope.aliyuncs.com/compatible-mode/v1');
  const [model, setModel] = useState('qwen3-coder-plus');
  const [hasKey, setHasKey] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void getModelConfig()
      .then((cfg) => {
        setHasKey(cfg.hasKey);
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl);
        if (cfg.model) setModel(cfg.model);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      setErr('Base URL 和模型名不能为空');
      return;
    }
    if (!apiKey.trim() && !hasKey) {
      setErr('API Key 不能为空');
      return;
    }
    setBusy(true);
    setErr('');
    setSaved(false);
    try {
      // key 留空 = 保留已存密钥，仅切换 baseUrl/model（服务端支持）
      await setModelConfig(baseUrl.trim(), model.trim(), apiKey.trim() || undefined);
      setHasKey(true);
      setApiKey('');
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg('');
    try {
      const r = await testModelConfig({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setTestMsg(r.ok ? `✓ 连通（${r.latencyMs}ms）` : `✗ ${r.error ?? '连通失败'}`);
    } catch (e) {
      setTestMsg(`✗ ${e instanceof Error ? e.message : '测试失败'}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width: 440 }}>
        <div className="modal-h">
          <div className="mh-icon" style={{ background: 'rgba(109,124,255,.12)', color: 'var(--brand)' }}>
            <i className="fa-solid fa-key" />
          </div>
          <div>
            <div className="mh-t">模型凭证配置</div>
            <div className="mh-s">每个用户独立隔离，不与他人共享</div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-b" style={{ paddingTop: 18 }}>
          {hasKey && (
            <div style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 10 }}>
              <i className="fa-solid fa-circle-check" /> 已配置 API Key（如需更新请在下方输入新值）
            </div>
          )}
          <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>DashScope API Key</label>
          <input
            className="fi"
            style={{ maxWidth: 'none', marginBottom: 10, width: '100%' }}
            type="password"
            placeholder={hasKey ? '••••（已配置，留空不修改）' : 'sk-...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>API Base URL</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.name}
                className="btn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => {
                  setBaseUrl(p.baseUrl);
                  setModel(p.model);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <input
            className="fi"
            style={{ maxWidth: 'none', marginBottom: 10, width: '100%' }}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <label style={{ fontSize: 12, color: 'var(--tx3)', display: 'block', marginBottom: 4 }}>模型名</label>
          <input
            className="fi"
            style={{ maxWidth: 'none', marginBottom: 14, width: '100%' }}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          {err && (
            <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>
              <i className="fa-solid fa-circle-exclamation" /> {err}
            </div>
          )}
          {saved && (
            <div style={{ color: 'var(--ok)', fontSize: 12, marginBottom: 12 }}>
              <i className="fa-solid fa-circle-check" /> 已保存，下次创建 sandbox 时生效
            </div>
          )}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => void test()} disabled={testing}>
            {testing ? '测试中…' : '测试连通性'}
          </button>
          {testMsg && (
            <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, color: testMsg.startsWith('✓') ? 'var(--ok)' : 'var(--err)' }}>{testMsg}</div>
          )}
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'var(--tx3)' }}>
            凭证加密存储于 hub-server，创建 sandbox 时通过 K8s Secret 注入
          </div>
        </div>
      </div>
    </div>
  );
}
