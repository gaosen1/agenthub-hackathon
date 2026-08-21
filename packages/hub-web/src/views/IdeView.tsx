/**
 * Web IDE 全屏视图（/tasks/:id/ide）：
 * 进入即 POST ensure 拉起沙箱内 code-server（NAS 预置，秒级），
 * 就绪后 iframe 加载代理路径（鉴权靠 ensure 下发的 HttpOnly Cookie）。
 * 不进 AppShell——IDE 需要整个视口。
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AuthRequiredError, ensureIde, ideProxyUrl } from '../api/client.js';

type Phase = 'loading' | 'ready' | 'error';

export function IdeView() {
  const { id } = useParams<{ id: string }>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setPhase('loading');
    ensureIde(id)
      .then(() => !cancelled && setPhase('ready'))
      .catch((e: unknown) => {
        if (cancelled) return;
        setErrMsg(e instanceof AuthRequiredError ? '未登录或 token 失效，请返回任务页登录后再试' : e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const nasMissing = /not preinstalled|shared layer/i.test(errMsg);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 14px',
          borderBottom: '1px solid var(--bd)',
          background: 'var(--bg2)',
          flex: 'none',
        }}
      >
        <Link className="btn" to={`/tasks/${id}`}>
          <i className="fa-solid fa-arrow-left" /> 返回任务
        </Link>
        <span style={{ fontSize: 13, color: 'var(--tx2)' }}>
          <i className="fa-solid fa-code" style={{ color: 'var(--brand)', marginRight: 6 }} />
          Web IDE · <code className="mono">{id}</code>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx3)' }}>
          code-server · 目录为云端工作区 · 终端可用
        </span>
      </div>

      {phase === 'loading' && (
        <div className="empty-hint" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <i className="fa-solid fa-circle-notch fa-spin" style={{ marginRight: 8 }} />
          正在启动沙箱内的 code-server…
        </div>
      )}

      {phase === 'error' && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ maxWidth: 520 }}>
            <div className="card-h">
              <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--warn)' }} /> IDE 不可用
            </div>
            <div className="card-b" style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.8 }}>
              {nasMissing ? (
                <>
                  集群 NAS 共享层尚未预置 code-server。请联系管理员执行
                  <code className="mono" style={{ margin: '0 4px' }}>deploy/k8s/30-nas-seed-job.yaml</code>
                  完成一次性播种后重试。
                </>
              ) : (
                errMsg
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'ready' && id && (
        <iframe
          title="Web IDE"
          src={ideProxyUrl(id)}
          style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }}
        />
      )}
    </div>
  );
}
