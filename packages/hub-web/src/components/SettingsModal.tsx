import { useEffect, useState } from 'react';
import { getModelConfig, setModelConfig } from '../api/client.js';

/** 模型凭证设置弹窗：per-user 隔离的 API Key / Base URL / Model 配置 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://dashscope.aliyuncs.com/compatible-mode/v1');
  const [model, setModel] = useState('qwen3-coder-plus');
  const [hasKey, setHasKey] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

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
    if (!apiKey.trim() && !hasKey) {
      setErr('API Key 不能为空');
      return;
    }
    if (!baseUrl.trim() || !model.trim()) {
      setErr('Base URL 和模型名不能为空');
      return;
    }
    setBusy(true);
    setErr('');
    setSaved(false);
    try {
      // 已有 key 且 key 框为空 = 不修改 key，只更新 baseUrl/model
      const keyToSubmit = apiKey.trim() || undefined;
      if (keyToSubmit) {
        await setModelConfig(keyToSubmit, baseUrl.trim(), model.trim());
      } else {
        // 只更新 baseUrl/model，需要重新提交完整表单
        // 由于 API 要求 apiKey 必填，这里提示用户需要输入 key
        setErr('如需修改 Base URL 或模型，请重新输入 API Key');
        setBusy(false);
        return;
      }
      setHasKey(true);
      setApiKey('');
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
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
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 11, color: 'var(--tx3)' }}>
            凭证加密存储于 hub-server，创建 sandbox 时通过 K8s Secret 注入
          </div>
        </div>
      </div>
    </div>
  );
}
