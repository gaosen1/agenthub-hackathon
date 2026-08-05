/**
 * hub-server 应用工厂（spec §4.2）
 * buildApp 注入 db/signer/sandbox 依赖以便测试；index.ts 负责生产装配。
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import {
  AuthReqSchema,
  BindChatReqSchema,
  CreateBotReqSchema,
  CreateHandoffReqSchema,
  TERMINAL_STATUSES,
  type Bot,
  type CreateHandoffResp,
  type HandoffDetail,
  type HandoffResult,
  type HandoffStatus,
  type HandoffSummary,
} from '@agenthub/shared';
import type { DB } from './db.js';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './auth.js';
import { ossKeyOf, type OssSigner } from './oss.js';
import { ApiFail, fail } from './state.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import {
  getBot,
  nowIso,
  patchHandoff,
  recordEvent,
  recordSandboxCreate,
  recordSandboxReady,
  recordSandboxReclaim,
  setStatus,
  type BotRow,
  type HandoffRow,
} from './store.js';
import { RunnerClient } from './runner-client.js';
import type { SandboxConnector } from './connector.js';
import type { PodOrchestrator } from './k8s.js';
import type { Worker } from './worker.js';

export interface SandboxDeps {
  connector: SandboxConnector;
  orchestrator: PodOrchestrator;
  namespace: string;
  /** sandbox 镜像，写入 sandbox 历史行的 image 列 */
  image: string;
  worker?: Worker;
}

export interface AppOptions {
  db: DB;
  signer: OssSigner;
  secret: string;
  webBaseUrl?: string;
  sandbox?: SandboxDeps;
  /** hub-web 构建产物目录，存在则静态托管（spec §4.1 组件表） */
  webDistDir?: string;
}

const newHandoffId = () => `hf-${randomBytes(3).toString('hex')}`;
const newToken = () => randomBytes(24).toString('base64url');

/** ACP 代理转发的白名单请求头（spec §4.4） */
const ACP_FORWARD_HEADERS = ['content-type', 'accept', 'acp-connection-id', 'acp-session-id', 'last-event-id', 'x-qwen-event-epoch'];

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db, signer, secret, sandbox } = opts;
  const webBaseUrl = opts.webBaseUrl ?? 'http://localhost:4180';
  const app = Fastify({ logger: false });

  // ── 统一错误输出（spec §2）─────────────────────────────
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiFail) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'ERR_VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    app.log?.error?.(err);
    // logger 关闭时兼保底输出，避免 500 无痕可查
    console.error('[hub-server] unhandled error:', err);
    return reply.status(500).send({ error: { code: 'ERR_STATE', message: 'internal error' } });
  });

  app.get('/healthz', async () => ({ ok: true, service: 'hub-server' }));

  // 静态托管 hub-web 产物（部署只有一个服务）
  if (opts.webDistDir && existsSync(opts.webDistDir)) {
    void app.register(fastifyStatic, { root: opts.webDistDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback：非 /api 路径回 index.html
      if (!req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'ERR_NOT_FOUND', message: 'not found' } });
    });
  }

  // ── 认证 ──────────────────────────────────────────────
  app.post('/api/auth/register', async (req, reply) => {
    const { username, password } = AuthReqSchema.parse(req.body);
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exists) throw fail(400, 'ERR_VALIDATION', 'username already taken');
    const info = db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
      .run(username, await hashPassword(password), nowIso());
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

  // ── 守卫 ──────────────────────────────────────────────
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

  const ownBot = (req: FastifyRequest): BotRow => {
    const { uid } = requireAuth(req);
    const id = Number((req.params as { id: string }).id);
    const bot = getBot(db, id);
    if (!bot || bot.status === 'deleted') throw fail(404, 'ERR_NOT_FOUND', `bot ${id} not found`);
    if (bot.user_id !== uid) throw fail(403, 'ERR_FORBIDDEN', 'bot belongs to another user');
    return bot;
  };

  const toSummary = (h: HandoffRow): HandoffSummary => ({
    id: h.id,
    agentName: h.agent_name,
    status: h.status,
    kind: h.kind,
    branch: h.branch,
    baseCommit: h.base_commit,
    sessionId: h.session_id,
    workspacePath: h.workspace_path,
    ...(h.task ? { task: h.task } : {}),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  });

  const needSandbox = (): SandboxDeps => {
    if (!sandbox) throw fail(502, 'ERR_K8S', 'sandbox orchestration not configured');
    return sandbox;
  };

  const runnerOfBot = async (bot: BotRow): Promise<RunnerClient> => {
    const sb = needSandbox();
    if (!bot.pod_name) throw fail(409, 'ERR_NOT_READY', 'bot sandbox not provisioned');
    const base = await sb.connector.getBaseUrl({ namespace: sb.namespace, podName: bot.pod_name }, 8080);
    return new RunnerClient(base, bot.runner_token);
  };

  // ── Handoff ───────────────────────────────────────────
  app.post('/api/handoffs', async (req, reply) => {
    const { uid } = requireAuth(req);
    const body = CreateHandoffReqSchema.parse(req.body);
    if (body.kind === 'bot') {
      if (!body.botId) throw fail(400, 'ERR_VALIDATION', 'botId required for kind=bot');
      const bot = getBot(db, body.botId);
      if (!bot || bot.status === 'deleted') throw fail(404, 'ERR_NOT_FOUND', `bot ${body.botId} not found`);
      if (bot.user_id !== uid) throw fail(403, 'ERR_FORBIDDEN', 'bot belongs to another user');
    }
    const id = newHandoffId();
    const at = nowIso();
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
    recordEvent(db, id, 'status', 'created');
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
    setStatus(db, h, 'uploaded');
    setStatus(db, h, 'queued');
    return reply.send({ status: h.status });
  });

  app.get('/api/handoffs/:id', async (req, reply) => {
    const h = ownHandoff(req);
    const timeline = (db
      .prepare("SELECT at, payload FROM handoff_events WHERE handoff_id=? AND kind='status' ORDER BY id")
      .all(h.id) as Array<{ at: string; payload: string }>).map((e) => ({ status: e.payload as HandoffStatus, at: e.at }));
    const detail: HandoffDetail = { ...toSummary(h), timeline, ...(h.error ? { error: h.error } : {}) };
    if (TERMINAL_STATUSES.includes(h.status)) {
      if (h.result_manifest) {
        try {
          detail.result = (JSON.parse(h.result_manifest) as { result?: HandoffResult }).result;
        } catch {
          // 脏数据不阻塞详情
        }
      }
      if (h.output_oss_key) {
        try {
          detail.downloadUrl = await signer.signGet(h.output_oss_key);
        } catch {
          // 下载 URL 签发失败不阻塞详情展示
        }
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
    if (TERMINAL_STATUSES.includes(h.status)) {
      throw fail(409, 'ERR_STATE', `handoff already ${h.status}`);
    }
    if (h.status === 'running' && sandbox?.worker) {
      // 执行中：转打包收部分成果，target=cancelled
      patchHandoff(db, h.id, { terminal_target: 'cancelled' });
      setStatus(db, h, 'packaging', 'cancelled by user');
    } else {
      setStatus(db, h, 'cancelled', 'cancelled by user');
    }
    return reply.send({ status: h.status });
  });

  app.post('/api/handoffs/:id/pull-intent', async (req, reply) => {
    const h = ownHandoff(req);
    if (!TERMINAL_STATUSES.includes(h.status)) {
      // 交互接力收尾：running 时主动触发打包，客户端轮询详情等终态（spec §4.2 注）
      if (h.status === 'running' && sandbox?.worker?.requestPackaging(h.id)) {
        throw fail(409, 'ERR_NOT_READY', 'packaging started, poll status until done');
      }
      throw fail(409, 'ERR_NOT_READY', `handoff is ${h.status}`);
    }
    if (!h.output_oss_key) throw fail(409, 'ERR_NOT_READY', 'output package not available');
    let downloadUrl: string;
    try {
      downloadUrl = await signer.signGet(h.output_oss_key);
    } catch (e) {
      throw fail(502, 'ERR_OSS', `sign download url failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let manifest: unknown;
    if (h.result_manifest) {
      try {
        manifest = JSON.parse(h.result_manifest);
      } catch {
        // 无 manifest 时 CLI 从包内读
      }
    }
    return reply.send({ downloadUrl, ...(manifest !== undefined ? { manifest } : {}) });
  });

  // ── Chat 代理（spec §4.2）：透明反代 sandbox serve 的 /acp ──
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/api/handoffs/:id/chat/acp',
    handler: async (req, reply) => {
      const h = ownHandoff(req);
      if (h.kind !== 'web') throw fail(409, 'ERR_NOT_READY', 'chat proxy only for kind=web');
      if (h.status !== 'running') throw fail(409, 'ERR_NOT_READY', `handoff is ${h.status}`);
      const sb = needSandbox();
      if (!h.pod_name) throw fail(409, 'ERR_NOT_READY', 'sandbox not provisioned');
      patchHandoff(db, h.id, { last_active_at: nowIso() });

      const base = await sb.connector.getBaseUrl({ namespace: sb.namespace, podName: h.pod_name }, 8081);
      const headers: Record<string, string> = {};
      for (const name of ACP_FORWARD_HEADERS) {
        const v = req.headers[name];
        if (typeof v === 'string') headers[name] = v;
      }
      headers['authorization'] = `Bearer ${h.serve_token}`;

      let upstream: Response;
      try {
        upstream = await fetch(`${base}/acp`, {
          method: req.method,
          headers,
          ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
        });
      } catch (e) {
        throw fail(502, 'ERR_RUNNER', `serve unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }

      reply.hijack();
      const raw = reply.raw;
      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!['transfer-encoding', 'connection', 'keep-alive'].includes(k)) outHeaders[k] = v;
      });
      raw.writeHead(upstream.status, outHeaders);
      if (!upstream.body) {
        raw.end();
        return;
      }
      const reader = upstream.body.getReader();
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw.write(value);
        }
      };
      pump()
        .catch(() => undefined)
        .finally(() => raw.end());
      raw.on('close', () => void reader.cancel().catch(() => undefined));
    },
  });

  // ── Bots（spec §4.2）──────────────────────────────────
  const toBot = (b: BotRow): Bot => ({
    id: b.id,
    name: b.name,
    status: b.status,
    ...(b.pod_name ? { podName: b.pod_name } : {}),
    ...(b.current_handoff_id ? { currentHandoffId: b.current_handoff_id } : {}),
    createdAt: b.created_at,
  });

  app.get('/api/bots', async (req, reply) => {
    const { uid } = requireAuth(req);
    const rows = db.prepare("SELECT * FROM bots WHERE user_id=? AND status != 'deleted' ORDER BY id").all(uid) as BotRow[];
    return reply.send({ items: rows.map(toBot) });
  });

  app.post('/api/bots', async (req, reply) => {
    const { uid } = requireAuth(req);
    const body = CreateBotReqSchema.parse(req.body);
    const dup = db.prepare("SELECT id FROM bots WHERE user_id=? AND name=? AND status != 'deleted'").get(uid, body.name);
    if (dup) throw fail(400, 'ERR_VALIDATION', `bot "${body.name}" already exists`);
    const info = db
      .prepare('INSERT INTO bots (user_id, name, client_id, client_secret_enc, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(uid, body.name, body.clientId, encryptSecret(body.clientSecret, secret), 'creating', nowIso());
    const id = Number(info.lastInsertRowid);

    if (sandbox) {
      const podName = `ah-bot-${id}-${body.name}`.slice(0, 63);
      const runnerToken = newToken();
      try {
        await sandbox.orchestrator.createSecret(`bot-${id}`, {
          DINGTALK_CLIENT_ID: body.clientId,
          DINGTALK_CLIENT_SECRET: decryptSecret(encryptSecret(body.clientSecret, secret), secret),
        });
        // bot pod 常驻、永不经过 Worker.safeDeletePod，所以它的历史行由本路由自己维护。
        // 先落行再建 Pod：建不出来的实例也要在面板上看得见，而不是凭空消失。
        recordSandboxCreate(db, {
          podName,
          userId: uid,
          kind: 'bot',
          image: sandbox.image,
          namespace: sandbox.namespace,
          botId: id,
        });
        await sandbox.orchestrator.createPod({
          podName,
          mode: 'bot',
          env: { RUNNER_TOKEN: runnerToken, BOT_NAME: body.name },
          secretRefs: ['agenthub-model', `bot-${id}`],
          labels: { 'agenthub/kind': 'bot', 'agenthub/owner': String(uid), 'agenthub/bot': String(id) },
        });
        db.prepare("UPDATE bots SET pod_name=?, runner_token=?, status='running' WHERE id=?").run(podName, runnerToken, id);
        recordSandboxReady(db, podName);
      } catch (e) {
        recordSandboxReclaim(db, podName, 'failed', 'pod-failed', e instanceof Error ? e.message : String(e));
        db.prepare("UPDATE bots SET status='error' WHERE id=?").run(id);
        throw fail(502, 'ERR_K8S', `bot sandbox create failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return reply.status(201).send(toBot(getBot(db, id)!));
  });

  app.delete('/api/bots/:id', async (req, reply) => {
    const bot = ownBot(req);
    if (sandbox) {
      if (bot.pod_name) {
        recordSandboxReclaim(db, bot.pod_name, 'reclaimed', 'bot-deleted');
        await sandbox.connector.dispose({ namespace: sandbox.namespace, podName: bot.pod_name }).catch(() => undefined);
        await sandbox.orchestrator.deletePod(bot.pod_name).catch(() => undefined);
      }
      await sandbox.orchestrator.deleteSecret(`bot-${bot.id}`).catch(() => undefined);
    }
    db.prepare("UPDATE bots SET status='deleted', pod_name=NULL WHERE id=?").run(bot.id);
    return reply.status(204).send();
  });

  app.get('/api/bots/:id/chats', async (req, reply) => {
    const bot = ownBot(req);
    const runner = await runnerOfBot(bot);
    try {
      return reply.send(await runner.chats());
    } catch (e) {
      throw fail(502, 'ERR_RUNNER', `chats failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.post('/api/bots/:id/bind', async (req, reply) => {
    const bot = ownBot(req);
    const body = BindChatReqSchema.parse(req.body);
    const runner = await runnerOfBot(bot);
    try {
      return reply.send(await runner.bind(body));
    } catch (e) {
      throw fail(502, 'ERR_RUNNER', `bind failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return app;
}
