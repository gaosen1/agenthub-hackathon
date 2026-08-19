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
