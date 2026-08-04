/**
 * hub-server 应用工厂（spec §4.2）
 * buildApp 注入 db/signer 以便测试；index.ts 负责生产装配。
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import {
  AuthReqSchema,
  CreateHandoffReqSchema,
  TERMINAL_STATES,
  type CreateHandoffResp,
  type HandoffDetail,
  type HandoffStatus,
  type HandoffSummary,
} from '@agenthub/shared';
import type { DB } from './db.js';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './auth.js';
import { ossKeyOf, type OssSigner } from './oss.js';
import { ApiFail, assertTransition, fail } from './state.js';

export interface AppOptions {
  db: DB;
  signer: OssSigner;
  secret: string;
  webBaseUrl?: string;
}

interface HandoffRow {
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
  base_commit: string;
  branch: string;
  output_oss_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();
const newHandoffId = () => `hf-${randomBytes(3).toString('hex')}`;

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db, signer, secret } = opts;
  const webBaseUrl = opts.webBaseUrl ?? 'http://localhost:4180';
  const app = Fastify({ logger: false });

  // ── 统一错误输出（spec §2）─────────────────────────────
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiFail) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'ERR_VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    app.log?.error?.(err);
    return reply.status(500).send({ error: { code: 'ERR_STATE', message: 'internal error' } });
  });

  // ── 状态流转（写库 + 时间线，同事务）──────────────────
  const setStatus = (h: HandoffRow, to: HandoffStatus, error?: string) => {
    assertTransition(h.status, to);
    const at = now();
    db.prepare('UPDATE handoffs SET status=?, error=COALESCE(?, error), updated_at=? WHERE id=?').run(to, error ?? null, at, h.id);
    db.prepare('INSERT INTO handoff_events (handoff_id, at, kind, payload) VALUES (?,?,?,?)').run(h.id, at, 'status', to);
    h.status = to;
  };

  const recordStatus = (id: string, status: HandoffStatus, at: string) => {
    db.prepare('INSERT INTO handoff_events (handoff_id, at, kind, payload) VALUES (?,?,?,?)').run(id, at, 'status', status);
  };

  // ── 认证 ──────────────────────────────────────────────
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password } = AuthReqSchema.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exists) throw fail(400, 'ERR_VALIDATION', 'username already taken');
    const info = db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
      .run(username, await hashPassword(password), now());
    const uid = Number(info.lastInsertRowid);
    return reply.status(201).send({ token: signJwt({ uid, sub: username }, secret), user: { id: uid, username } });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = AuthReqSchema.parse(req.body);
    const row = db.prepare('SELECT id, password_hash FROM users WHERE username=?').get(username) as
      | { id: number; password_hash: string }
      | undefined;
    if (!row || !(await verifyPassword(row.password_hash, password))) {
      throw fail(401, 'ERR_AUTH', 'invalid username or password');
    }
    return reply.send({ token: signJwt({ uid: row.id, sub: username }, secret), user: { id: row.id, username } });
  });

  // ── JWT 守卫 ──────────────────────────────────────────
  const requireAuth = (req: FastifyRequest): { uid: number } => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = token ? verifyJwt(token, secret) : null;
    if (!payload) throw fail(401, 'ERR_AUTH', 'missing or invalid token');
    return { uid: payload.uid };
  };

  const ownHandoff = (req: FastifyRequest): HandoffRow => {
    const { uid } = requireAuth(req);
    const id = (req.params as { id: string }).id;
    const row = db.prepare('SELECT * FROM handoffs WHERE id=?').get(id) as HandoffRow | undefined;
    if (!row) throw fail(404, 'ERR_NOT_FOUND', `handoff ${id} not found`);
    if (row.user_id !== uid) throw fail(403, 'ERR_FORBIDDEN', 'handoff belongs to another user');
    return row;
  };

  const toSummary = (h: HandoffRow): HandoffSummary => ({
    id: h.id,
    agentName: h.agent_name,
    status: h.status,
    kind: h.kind,
    branch: h.branch,
    baseCommit: h.base_commit,
    sessionId: h.session_id,
    ...(h.task ? { task: h.task } : {}),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  });

  // ── Handoff ───────────────────────────────────────────
  app.post('/api/handoffs', async (req, reply) => {
    const { uid } = requireAuth(req);
    const body = CreateHandoffReqSchema.parse(req.body);
    if (body.kind === 'bot' && !body.botId) throw fail(400, 'ERR_VALIDATION', 'botId required for kind=bot');
    const id = newHandoffId();
    const at = now();
    const inputKey = ossKeyOf(uid, id, 'input.tar.gz');
    db.prepare(
      `INSERT INTO handoffs (id, user_id, agent_name, workspace_path, ws_hash, session_id, task, timeout_minutes,
        status, kind, bot_id, bind_chat_id, base_commit, branch, input_oss_key, created_at, updated_at, last_active_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, uid, body.agentName, body.workspacePath, body.wsHash, body.sessionId, body.task ?? null,
      body.timeoutMinutes, 'created', body.kind, body.botId ?? null, body.bindChatId ?? null,
      body.baseCommit, body.branch, inputKey, at, at, at,
    );
    recordStatus(id, 'created', at);
    let uploadUrl: string;
    try {
      uploadUrl = await signer.signPut(inputKey);
    } catch (e) {
      throw fail(502, 'ERR_OSS', `sign upload url failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const resp: CreateHandoffResp = { handoffId: id, uploadUrl, webUrl: `${webBaseUrl}/tasks/${id}` };
    return reply.status(201).send(resp);
  });

  app.post('/api/handoffs/:id/uploaded', async (req, reply) => {
    const h = ownHandoff(req);
    setStatus(h, 'uploaded');
    setStatus(h, 'queued');
    return reply.send({ status: h.status });
  });

  app.get('/api/handoffs/:id', async (req, reply) => {
    const h = ownHandoff(req);
    const timeline = (db
      .prepare("SELECT at, payload FROM handoff_events WHERE handoff_id=? AND kind='status' ORDER BY id")
      .all(h.id) as Array<{ at: string; payload: string }>).map((e) => ({ status: e.payload as HandoffStatus, at: e.at }));
    const detail: HandoffDetail = { ...toSummary(h), timeline, ...(h.error ? { error: h.error } : {}) };
    if (TERMINAL_STATES.includes(h.status) && h.output_oss_key) {
      try {
        detail.downloadUrl = await signer.signGet(h.output_oss_key);
      } catch {
        // 下载 URL 签发失败不阻塞详情展示
      }
    }
    return reply.send(detail);
  });

  app.get('/api/handoffs', async (req, reply) => {
    const { uid } = requireAuth(req);
    const q = req.query as { agentName?: string; status?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = db
      .prepare(
        `SELECT * FROM handoffs WHERE user_id=@uid
         AND (@agent IS NULL OR agent_name=@agent)
         AND (@status IS NULL OR status=@status)
         ORDER BY created_at DESC LIMIT @limit`,
      )
      .all({ uid, agent: q.agentName ?? null, status: q.status ?? null, limit }) as HandoffRow[];
    return reply.send({ items: rows.map(toSummary) });
  });

  app.get('/api/handoffs/:id/events', async (req, reply) => {
    const h = ownHandoff(req);
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    const rows = db
      .prepare('SELECT id, at, kind, payload FROM handoff_events WHERE handoff_id=? AND id>? ORDER BY id LIMIT 500')
      .all(h.id, after) as Array<{ id: number; at: string; kind: string; payload: string }>;
    return reply.send({ items: rows, nextAfter: rows.length ? rows[rows.length - 1]!.id : after });
  });

  app.post('/api/handoffs/:id/cancel', async (req, reply) => {
    const h = ownHandoff(req);
    if (TERMINAL_STATES.includes(h.status)) {
      throw fail(409, 'ERR_STATE', `handoff already ${h.status}`);
    }
    // 排队前直接终态；执行中标记 cancelled，Worker 兜底 packaging 部分成果（D2 接入）
    setStatus(h, 'cancelled', 'cancelled by user');
    return reply.send({ status: h.status });
  });

  app.post('/api/handoffs/:id/pull-intent', async (req, reply) => {
    const h = ownHandoff(req);
    if (!TERMINAL_STATES.includes(h.status)) {
      throw fail(409, 'ERR_NOT_READY', `handoff is ${h.status}`);
    }
    if (!h.output_oss_key) throw fail(409, 'ERR_NOT_READY', 'output package not available');
    let downloadUrl: string;
    try {
      downloadUrl = await signer.signGet(h.output_oss_key);
    } catch (e) {
      throw fail(502, 'ERR_OSS', `sign download url failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return reply.send({ downloadUrl });
  });

  return app;
}
