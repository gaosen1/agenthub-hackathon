/**
 * handoff 存取与状态流转（app 与 worker 共用）
 */
import type { HandoffStatus } from '@agenthub/shared';
import type { DB } from './db.js';
import { assertTransition } from './state.js';

export interface HandoffRow {
  id: string;
  user_id: number;
  agent_name: string;
  workspace_path: string;
  ws_hash: string;
  session_id: string;
  task: string | null;
  timeout_minutes: number;
  status: HandoffStatus;
  kind: 'web' | 'bot';
  bot_id: number | null;
  bind_chat_id: string | null;
  pod_name: string | null;
  serve_token: string | null;
  runner_token: string | null;
  base_commit: string;
  branch: string;
  input_oss_key: string | null;
  output_oss_key: string | null;
  terminal_target: string | null;
  result_manifest: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

export interface BotRow {
  id: number;
  user_id: number;
  name: string;
  client_id: string;
  client_secret_enc: string;
  pod_name: string | null;
  runner_token: string | null;
  status: 'creating' | 'running' | 'error' | 'deleted';
  current_handoff_id: string | null;
  created_at: string;
}

export const nowIso = () => new Date().toISOString();

export const getHandoff = (db: DB, id: string): HandoffRow | undefined =>
  db.prepare('SELECT * FROM handoffs WHERE id=?').get(id) as HandoffRow | undefined;

export const listByStatus = (db: DB, status: HandoffStatus): HandoffRow[] =>
  db.prepare('SELECT * FROM handoffs WHERE status=?').all(status) as HandoffRow[];

export function recordEvent(db: DB, handoffId: string, kind: 'status' | 'log', payload: string): void {
  db.prepare('INSERT INTO handoff_events (handoff_id, at, kind, payload) VALUES (?,?,?,?)').run(handoffId, nowIso(), kind, payload);
}

/** 校验并落库一次状态流转（同时写时间线） */
export function setStatus(db: DB, h: HandoffRow, to: HandoffStatus, error?: string): void {
  assertTransition(h.status, to);
  const at = nowIso();
  db.prepare('UPDATE handoffs SET status=?, error=COALESCE(?, error), updated_at=? WHERE id=?').run(to, error ?? null, at, h.id);
  recordEvent(db, h.id, 'status', to);
  h.status = to;
  h.updated_at = at;
}

export function patchHandoff(db: DB, id: string, fields: Partial<Record<keyof HandoffRow, unknown>>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE handoffs SET ${sets}, updated_at=@__now WHERE id=@__id`).run({ ...fields, __now: nowIso(), __id: id });
}

/** 某状态首次进入时间（时间线里查），用于硬超时计算 */
export function statusEnteredAt(db: DB, handoffId: string, status: HandoffStatus): string | undefined {
  const row = db
    .prepare("SELECT at FROM handoff_events WHERE handoff_id=? AND kind='status' AND payload=? ORDER BY id LIMIT 1")
    .get(handoffId, status) as { at: string } | undefined;
  return row?.at;
}

export const getBot = (db: DB, id: number): BotRow | undefined =>
  db.prepare('SELECT * FROM bots WHERE id=?').get(id) as BotRow | undefined;

// ---------- sandbox 实例历史（S5） ----------

export type SandboxStatus = 'provisioning' | 'running' | 'reclaimed' | 'failed' | 'lost';

/** 回收原因。用于面板上区分「正常收尾」与「异常丢失」，不要塞自由文本。 */
export type ReclaimReason =
  | 'task-done'
  | 'task-failed'
  | 'expired'
  | 'cancelled'
  | 'pod-failed'
  | 'load-failed'
  | 'pod-lost'
  | 'bot-deleted'
  | 'orphan'
  | 'crash-recover';

export interface SandboxRow {
  id: number;
  pod_name: string;
  user_id: number;
  kind: 'web' | 'bot';
  handoff_id: string | null;
  bot_id: number | null;
  image: string;
  namespace: string;
  status: SandboxStatus;
  created_at: string;
  ready_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  reclaim_reason: ReclaimReason | null;
  last_error: string | null;
}

/** 未结束的行；pod 名会被 bot 重建复用，所以一切更新都只认「当前开着的那一行」 */
const OPEN_STATUSES = "('provisioning','running')";

export function recordSandboxCreate(
  db: DB,
  s: {
    podName: string;
    userId: number;
    kind: 'web' | 'bot';
    image: string;
    namespace: string;
    handoffId?: string | null;
    botId?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO sandboxes (pod_name, user_id, kind, handoff_id, bot_id, image, namespace, status, created_at)
     VALUES (@podName, @userId, @kind, @handoffId, @botId, @image, @namespace, 'provisioning', @at)`,
  ).run({ ...s, handoffId: s.handoffId ?? null, botId: s.botId ?? null, at: nowIso() });
}

export function recordSandboxReady(db: DB, podName: string): void {
  db.prepare(
    `UPDATE sandboxes SET status='running', ready_at=? WHERE pod_name=? AND status='provisioning'`,
  ).run(nowIso(), podName);
}

/**
 * 关闭一行。执行时长按 ready_at → ended_at 计；从未 ready 的实例
 * duration_seconds 保持 NULL——它没真正跑过任何东西，不该退化成 created_at 计时。
 */
export function recordSandboxReclaim(
  db: DB,
  podName: string,
  status: Extract<SandboxStatus, 'reclaimed' | 'failed' | 'lost'>,
  reason: ReclaimReason,
  error?: string,
): void {
  db.prepare(
    `UPDATE sandboxes
        SET status=@status,
            ended_at=@at,
            duration_seconds = CASE WHEN ready_at IS NOT NULL
              THEN CAST(ROUND((julianday(@at) - julianday(ready_at)) * 86400) AS INTEGER) END,
            reclaim_reason=@reason,
            last_error=COALESCE(@error, last_error)
      WHERE pod_name=@podName AND status IN ${OPEN_STATUSES}`,
  ).run({ podName, status, reason, error: error ?? null, at: nowIso() });
}
