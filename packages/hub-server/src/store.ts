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
  input_size: number | null;
  output_size: number | null;
  input_uploaded_at: string | null;
  output_uploaded_at: string | null;
  input_expired: number;
  output_expired: number;
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

// ── per-user 模型凭证 ──────────────────────────────────
export interface UserModelConfig {
  model_api_key_enc: string | null;
  model_base_url: string | null;
  model_name: string | null;
}

export const getUserModelConfig = (db: DB, uid: number): UserModelConfig | undefined =>
  db.prepare('SELECT model_api_key_enc, model_base_url, model_name FROM users WHERE id=?').get(uid) as
    | UserModelConfig
    | undefined;

export function setUserModelConfig(
  db: DB,
  uid: number,
  enc: string,
  baseUrl: string,
  model: string,
): void {
  db.prepare('UPDATE users SET model_api_key_enc=?, model_base_url=?, model_name=? WHERE id=?').run(
    enc,
    baseUrl,
    model,
    uid,
  );
}

// ── sandbox 实例历史（S5）──────────────────────────────────
// 不变量：所有更新只作用于「当前开着的那一行」（status IN provisioning/running），
// 因为 bot pod 名会在重建时复用；从未 ready 的实例 duration_seconds 保持 NULL。
export type SandboxKind = 'web' | 'bot';
export type SandboxStatus = 'provisioning' | 'running' | 'reclaimed' | 'failed' | 'lost';
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
  kind: SandboxKind;
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

export function recordSandboxCreate(
  db: DB,
  s: { podName: string; userId: number; kind: SandboxKind; image: string; namespace: string; handoffId?: string | null; botId?: number | null },
): void {
  db
    .prepare(
      `INSERT INTO sandboxes (pod_name, user_id, kind, handoff_id, bot_id, image, namespace, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(s.podName, s.userId, s.kind, s.handoffId ?? null, s.botId ?? null, s.image, s.namespace, 'provisioning', nowIso());
}

export function recordSandboxReady(db: DB, podName: string): void {
  db.prepare("UPDATE sandboxes SET status='running', ready_at=? WHERE pod_name=? AND status='provisioning'").run(nowIso(), podName);
}

/** reason → 终态映射（S6） */
export const reclaimStatus = (reason: ReclaimReason): SandboxStatus =>
  reason === 'pod-failed' || reason === 'load-failed' || reason === 'task-failed'
    ? 'failed'
    : reason === 'pod-lost' || reason === 'crash-recover'
      ? 'lost'
      : 'reclaimed';

export function recordSandboxReclaim(
  db: DB,
  podName: string,
  status: SandboxStatus,
  reason: ReclaimReason,
  lastError?: string,
): void {
  const at = nowIso();
  db.prepare(
    `UPDATE sandboxes SET status=?, reclaim_reason=?, ended_at=?, last_error=COALESCE(?, last_error),
       duration_seconds = CASE WHEN ready_at IS NOT NULL
         THEN CAST(ROUND((julianday(?) - julianday(ready_at)) * 86400) AS INTEGER) ELSE NULL END
     WHERE pod_name=? AND status IN ('provisioning','running')`,
  ).run(status, reason, at, lastError ?? null, at, podName);
}

// ── per-user 设置（S16）───────────────────────────────
export const getSettings = (db: DB, uid: number): Record<string, string> => {
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id=?').all(uid) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};

export function setSetting(db: DB, uid: number, key: string, value: string): void {
  db
    .prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(uid, key, value, nowIso());
}

/** 重启对账收养（S8）：保留 Pod 真实启动时间，不把已跑半小时的 Pod 报成刚创建 */
export function adoptSandbox(
  db: DB,
  s: {
    podName: string;
    userId: number;
    kind: SandboxKind;
    image: string;
    namespace: string;
    handoffId?: string | null;
    botId?: number | null;
    startedAt?: string;
    running: boolean;
  },
): void {
  const created = s.startedAt ?? nowIso();
  db
    .prepare(
      `INSERT INTO sandboxes (pod_name, user_id, kind, handoff_id, bot_id, image, namespace, status, created_at, ready_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      s.podName,
      s.userId,
      s.kind,
      s.handoffId ?? null,
      s.botId ?? null,
      s.image,
      s.namespace,
      s.running ? 'running' : 'provisioning',
      created,
      s.running ? created : null,
    );
}
