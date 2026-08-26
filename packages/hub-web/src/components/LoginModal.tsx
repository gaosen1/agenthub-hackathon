import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { login } from '../api/client.js';

/** 登录/注册弹窗：成功后写 localStorage token 并刷新全部查询 */
export function LoginModal({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const submit = async () => {
    if (!username.trim() || !password) {
      setErr('用户名和密码不能为空');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await login(username.trim(), password, isRegister);
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败');
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
      <div className="modal" style={{ width: 380 }}>
        <div className="modal-h">
          <div className="mh-icon" style={{ background: 'rgba(74,222,128,.1)', color: 'var(--brand)' }}>
            <i className="fa-solid fa-user" />
          </div>
          <div>
            <div className="mh-t">{isRegister ? '注册' : '登录'} AgentHub</div>
            <div className="mh-s">连接 Hub 控制面</div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-b" style={{ paddingTop: 18 }}>
          <input
            className="fi"
            style={{ maxWidth: 'none', marginBottom: 10, width: '100%' }}
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            className="fi"
            style={{ maxWidth: 'none', marginBottom: 14, width: '100%' }}
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {err && (
            <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 12 }}>
              <i className="fa-solid fa-circle-exclamation" /> {err}
            </div>
          )}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : isRegister ? '注册并登录' : '登录'}
          </button>
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: 'var(--tx3)' }}>
            {isRegister ? '已有账号？' : '没有账号？'}
            <button
              className="link-btn"
              style={{ marginLeft: 6 }}
              onClick={() => {
                setIsRegister(!isRegister);
                setErr('');
              }}
            >
              {isRegister ? '去登录' : '去注册'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
