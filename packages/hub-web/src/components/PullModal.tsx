import { useEffect } from 'react';
import type { HandoffDetail } from '@agenthub/shared/contracts';
import { mockExtras } from '../api/mock.js';

function copyText(text: string, el: HTMLElement) {
  void navigator.clipboard.writeText(text).then(() => {
    const orig = el.innerHTML;
    el.innerHTML = '<i class="fa-solid fa-check" style="color:var(--ok)"></i> 已复制';
    setTimeout(() => {
      el.innerHTML = orig;
    }, 1200);
  });
}

export function PullModal({ detail: t, onClose }: { detail: HandoffDetail; onClose: () => void }) {
  const extra = mockExtras[t.id];
  const commitCount = t.result?.commitCount ?? extra?.commits.length ?? 0;
  const isDone = t.status === 'done';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mergeLine = isDone
    ? `${commitCount} 个云端 commit 合入 ${t.branch}。本地无新提交时 fast-forward；有分叉时执行 merge，冲突保留标记并提示，也可加 --branch 落到独立分支。`
    : `${commitCount} 个 WIP commit（任务失败前产生的部分成果）合入 ${t.branch}，建议加 --branch 落到独立分支审查后再合并。`;

  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-h">
          <div className="mh-icon">
            <i className="fa-solid fa-download" />
          </div>
          <div>
            <div className="mh-t">Pull 指引 · 拉回云端成果</div>
            <div className="mh-s">
              {t.id} · {t.agentName} · {t.branch}
              {extra?.outputPkg ? ` · 返回包 ${extra.outputPkg}` : ''}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <div className="modal-b">
          <div className="pstep" style={{ borderBottom: '1px dashed var(--line)' }}>
            <div className="num" style={{ background: 'rgba(245,176,77,.12)', color: 'var(--warn)' }}>
              <i className="fa-solid fa-exclamation" style={{ fontSize: 10 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="pt">
                <i className="fa-solid fa-clipboard-check" style={{ color: 'var(--warn)' }} /> 前置检查
              </div>
              <div className="pd">
                本地工作区存在未提交变更时，pull 会先提示 <code>stash</code> 或 <code>commit</code>，避免合并冲突。
              </div>
            </div>
          </div>
          <div className="cmd" style={{ margin: '16px 0 0' }}>
            <span className="dollar">$</span> agenthub pull {t.id}
            <span className="copy" onClick={(e) => copyText(`agenthub pull ${t.id}`, e.currentTarget)}>
              <i className="fa-regular fa-copy" />
            </span>
          </div>
          <div className="opt-row">
            <span className="opt-chip">
              <b>--branch</b> agenthub/{t.id} · 落到独立分支再手动合并
            </span>
          </div>
          <div style={{ height: 6 }} />
          <div className="pstep">
            <div className="num">1</div>
            <div style={{ minWidth: 0 }}>
              <div className="pt">
                <i className="fa-solid fa-cloud-arrow-down" /> 下载返回包
              </div>
              <div className="pd">
                Hub 校验归属后签发限时 URL（30 分钟有效），从 OSS 拉取 <code>output.tar.gz</code>，本地校验包完整性。
              </div>
            </div>
          </div>
          <div className="pstep">
            <div className="num">2</div>
            <div style={{ minWidth: 0 }}>
              <div className="pt">
                <i className="fa-solid fa-code-merge" /> 代码合并 <span className="mono">result.bundle → {t.branch}</span>
              </div>
              <div className="pd">{mergeLine}</div>
            </div>
          </div>
          <div className="pstep">
            <div className="num">3</div>
            <div style={{ minWidth: 0 }}>
              <div className="pt">
                <i className="fa-solid fa-file-lines" /> 会话时间线合并 <span className="mono">{t.sessionId}.jsonl</span>
              </div>
              <div className="pd">
                以 <code>handoff_marker</code> 为锚点定位共同前缀，云端会话增量按时间线拼接，云端消息打{' '}
                <code>agenthub_source: cloud</code> 标记；合并前自动备份 <code>.bak</code>，任何失败可回滚。
              </div>
            </div>
          </div>
          <div className="pstep">
            <div className="num">4</div>
            <div style={{ minWidth: 0 }}>
              <div className="pt">
                <i className="fa-solid fa-comments" /> 本地无缝续聊
              </div>
              <div className="pd">
                执行 <code>qwen --resume</code> 打开会话，云端执行过程（含远程 Chat 指令）完整可见，可直接继续追问。
              </div>
            </div>
          </div>
          <div className="merge-note" style={{ marginTop: 16 }}>
            <span className="mi">
              <i className="fa-solid fa-repeat" /> 重复 pull 幂等，不产生重复合并
            </span>
            <span className="mi">
              <i className="fa-solid fa-shield-halved" /> 合并失败自动回滚
            </span>
            <span className="mi">
              <i className="fa-regular fa-clock" /> 返回包 7 天后过期
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
