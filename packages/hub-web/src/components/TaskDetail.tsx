import { useEffect, useMemo, useRef } from 'react';
import type { HandoffDetail, SandboxEvent } from '@agenthub/shared/contracts';
import { STEPS, TERMINAL_BAD, fmtTime, stepIndexOf } from '../statusMeta.js';
import { cancelHandoff, dataSource } from '../api/client.js';
import { useHandoffEvents } from '../api/hooks.js';
import { mockExtras } from '../api/mock.js';

interface Props {
  detail: HandoffDetail;
  onOpenPull: () => void;
}

function copyText(text: string, el: HTMLElement) {
  void navigator.clipboard.writeText(text).then(() => {
    const orig = el.innerHTML;
    el.innerHTML = '<i class="fa-solid fa-check" style="color:var(--ok)"></i> 已复制';
    setTimeout(() => {
      el.innerHTML = orig;
    }, 1200);
  });
}

export function TaskDetail({ detail: t, onOpenPull }: Props) {
  const extra = mockExtras[t.id];
  const logBox = useRef<HTMLDivElement>(null);
  const stepIdx = stepIndexOf(t.status, t.timeline);
  const isBad = TERMINAL_BAD.includes(t.status);
  const isActive = t.status === 'running' || t.status === 'queued' || t.status === 'provisioning';

  // 真 Hub：日志从 events 接口轮询（kind=log → SandboxEvent JSON）；mock：用样本日志
  const { data: eventsData } = useHandoffEvents(t.id, dataSource === 'hub');
  const logs = useMemo(() => {
    if (dataSource !== 'hub') return extra?.logs ?? [];
    return (eventsData?.items ?? [])
      .filter((e) => e.kind === 'log')
      .map((e) => {
        try {
          const ev = JSON.parse(e.payload) as SandboxEvent;
          return { id: e.id, t: fmtTime(ev.t), tag: ev.tag, c: ev.c };
        } catch {
          return { id: e.id, t: fmtTime(e.at), tag: 'info' as const, c: e.payload };
        }
      });
  }, [eventsData, extra]);

  const timeAt = (key: string): string => {
    const e = t.timeline.find((x) => x.status === key);
    return e ? fmtTime(e.at) : '';
  };

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [t.id, logs.length]);

  const stepState = (i: number): string => {
    if (isBad) return i < stepIdx ? 'done' : i === stepIdx ? 'fail' : '';
    if (i < stepIdx) return 'done';
    if (i === stepIdx) return t.status === 'done' ? 'now st-done' : 'now';
    return '';
  };

  return (
    <div className="fade-in" key={t.id}>
      <div className="d-head">
        <div className="t-icon">
          <i className="fa-solid fa-arrows-turn-to-dots" />
        </div>
        <div>
          <h1>{t.task ?? extra?.summary ?? t.agentName}</h1>
          <div className="sub">
            <span>
              <i className="fa-solid fa-folder-tree" />
              {t.agentName}
            </span>
            <span>
              <i className="fa-solid fa-code-branch" />
              {t.branch}
            </span>
            <span>
              <i className="fa-solid fa-fingerprint" />
              <code>{t.id}</code>
            </span>
            <span>
              <i className="fa-solid fa-code-commit" />
              base <code>{t.baseCommit.slice(0, 7)}</code>
            </span>
          </div>
        </div>
        <div className="d-actions">
          {isActive && (
            <button className="btn danger" onClick={() => void cancelHandoff(t.id)}>
              <i className="fa-solid fa-ban" /> 取消
            </button>
          )}
          {(t.status === 'done' || isBad) && (
            <button className="btn primary" onClick={onOpenPull}>
              <i className="fa-solid fa-download" /> pull 指引
            </button>
          )}
        </div>
      </div>

      {/* stepper */}
      <div className="stepper">
        {STEPS.map((s, i) => (
          <span key={s.key} style={{ display: 'contents' }}>
            <div className={`step ${stepState(i)}`}>
              <div className="ic">
                <i className={isBad && i === stepIdx ? 'fa-solid fa-xmark' : s.icon} />
              </div>
              <div className="lb">{isBad && i === stepIdx ? t.status : s.label}</div>
              <div className="tm">{timeAt(s.key) || (isBad && i === stepIdx ? fmtTime(t.updatedAt) : '')}</div>
            </div>
            {i < STEPS.length - 1 && <div className={`step-line ${i < stepIdx ? 'done' : ''}`} />}
          </span>
        ))}
      </div>

      {/* 统计卡 */}
      <div className="grid4">
        <div className="stat">
          <div className="k">
            <i className="fa-solid fa-cube" /> Sandbox
          </div>
          <div className="v" style={{ fontSize: 13, lineHeight: '32px' }}>
            {extra?.sandbox ?? '—'}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="fa-regular fa-clock" /> 云端执行时长
          </div>
          <div className="v">
            {t.result ? `${Math.floor(t.result.elapsedSeconds / 60)}m ${t.result.elapsedSeconds % 60}s` : (extra?.elapsed ?? '—')}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="fa-solid fa-coins" /> Token 用量
          </div>
          <div className="v">
            {t.result?.tokensUsed ? `${(t.result.tokensUsed / 1000).toFixed(1)}k` : (extra?.tokens ?? '—')}
          </div>
        </div>
        <div className="stat">
          <div className="k">
            <i className="fa-solid fa-box-archive" /> 输入 / 返回包
          </div>
          <div className="v" style={{ fontSize: 14, lineHeight: '30px' }}>
            {extra?.inputPkg ?? '—'} <small>/</small> {extra?.outputPkg ?? '—'}
          </div>
        </div>
      </div>

      {/* pull 指引卡（done） */}
      {t.status === 'done' && (
        <div className="card pull-guide">
          <div className="card-h">
            <i className="fa-solid fa-circle-check" /> 任务完成 — 拉回本地合并
            <span className="hint">返回包 {extra?.outputPkg ?? ''} · OSS 7 天后自动清理</span>
          </div>
          <div className="card-b">
            <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.6 }}>
              在本地仓库目录执行以下命令，AgentHub 将自动完成{' '}
              <b style={{ color: 'var(--tx)' }}>git 代码合并</b> 与{' '}
              <b style={{ color: 'var(--tx)' }}>jsonl 会话时间线合并</b>，之后可在 Qwen Code 中无缝续聊。
            </div>
            <div className="cmd">
              <span className="dollar">$</span> agenthub pull {t.id}
              <span className="copy" title="复制" onClick={(e) => copyText(`agenthub pull ${t.id}`, e.currentTarget)}>
                <i className="fa-regular fa-copy" />
              </span>
            </div>
            <div className="merge-note">
              <span className="mi">
                <i className="fa-solid fa-code-merge" /> result.bundle → {t.result?.commitCount ?? 0} 个 commit 合入 {t.branch}
              </span>
              <span className="mi">
                <i className="fa-solid fa-file-lines" /> 云端会话增量 → 合并至 {t.sessionId}.jsonl
              </span>
              <span className="mi">
                <i className="fa-solid fa-shield-halved" /> 合并前自动备份，可回滚
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 失败原因卡 */}
      {isBad && (
        <div className="card" style={{ borderColor: 'rgba(240,97,109,.35)' }}>
          <div className="card-h">
            <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--err)' }} /> 失败原因
            <span className="hint">{extra?.outputPkg ? `部分成果已打包（${extra.outputPkg}）` : ''}</span>
          </div>
          <div className="card-b" style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.7 }}>
            {t.result?.error ?? extra?.failReason ?? '任务异常终止'}
            {t.downloadUrl && (
              <>
                {' '}可执行{' '}
                <code style={{ fontFamily: 'var(--mono)', background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4, color: 'var(--tx)' }}>
                  agenthub pull {t.id}
                </code>{' '}
                取回部分成果。
              </>
            )}
          </div>
        </div>
      )}

      {/* commit 列表 */}
      <div className="card">
        <div className="card-h">
          <i className="fa-solid fa-code-commit" /> 云端产生的 Commit
          <span className="hint">result.bundle 增量 · base {t.baseCommit.slice(0, 7)}</span>
        </div>
        <div className="card-b">
          {extra && extra.commits.length > 0 ? (
            extra.commits.map((c) => (
              <div className="commit" key={c.hash}>
                <span className="hash">{c.hash}</span>
                <div>
                  <div className="msg">{c.msg}</div>
                  <div className="files" style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3, fontFamily: 'var(--mono)' }}>
                    {c.files} · <span style={{ color: 'var(--ok)' }}>{c.add}</span>{' '}
                    <span style={{ color: 'var(--err)' }}>{c.del}</span>
                  </div>
                </div>
                <span className="who">
                  <i className="fa-solid fa-robot" />
                  cloud agent · {c.time}
                </span>
              </div>
            ))
          ) : (
            <div className="empty-hint">云端尚未产生 commit</div>
          )}
        </div>
      </div>

      {/* 执行日志 */}
      <div className="card">
        <div className="card-h">
          <i className="fa-solid fa-terminal" /> 执行日志
          <span className="hint">{t.status === 'running' ? '实时流式回传' : '归档日志'}</span>
        </div>
        <div className="logs" ref={logBox}>
          {logs.map((l) => (
            <div className="log-line" key={l.id}>
              <span className="t">{l.t}</span>
              <span className={`tag ${l.tag}`}>[{l.tag.toUpperCase()}]</span>
              <span className="c">{l.c}</span>
            </div>
          ))}
          {t.status === 'running' && (
            <div className="log-line">
              <span className="t">&nbsp;</span>
              <span className="tag sys" />
              <span className="c">
                <span className="cursor" />
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
