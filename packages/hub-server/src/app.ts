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
  ModelConfigReqSchema,
  TERMINAL_STATUSES,
  type Bot,
  type CreateHandoffResp,
  type HandoffDetail,
  type HandoffResult,
  type HandoffStatus,
  type HandoffSummary,
  type SandboxPolicy,
} from '@agenthub/shared';
import type { DB } from './db.js';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './auth.js';
import { ossKeyOf, type OssSigner } from './oss.js';
import { ApiFail, fail } from './state.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getBot, getUserModelConfig, nowIso, patchHandoff, recordEvent, recordSandboxCreate, recordSandboxReady, recordSandboxReclaim, setUserModelConfig, setStatus, type BotRow, type HandoffRow, type SandboxRow } from './store.js';
import { userModelSecret } from './db.js';
import { RunnerClient } from './runner-client.js';
import type { SandboxConnector } from './connector.js';
import { SANDBOX_PORTS, SANDBOX_RESOURCES, SANDBOX_TEMPLATE, sandboxImage, type PodOrchestrator } from './k8s.js';
import { DEFAULT_ORPHAN_INTERVAL_MS, DEFAULT_WORKER_INTERVAL_MS, type Worker } from './worker.js';

export interface SandboxDeps {
  connector: SandboxConnector;
  orchestrator: PodOrchestrator;
  namespace: string;
  worker?: Worker;
  /** 建 Pod 镜像（缺省 SANDBOX_IMAGE / 默认镜像） */
  image?: string;
  /** ACS 弹性算力开关（面板模板展示用） */
  acs?: boolean;
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

/** 未配置编排时的缺省策略：与实现一致的默认值，面板照样渲染（S9） */
const defaultPolicy = (): SandboxPolicy => ({
  defaultTimeoutMinutes: 30,
  idleTtlMinutes: 120,
  taskLingerMinutes: Number(process.env.TASK_LINGER_MINUTES ?? 30),
  orphanIntervalMs: DEFAULT_ORPHAN_INTERVAL_MS,
  workerIntervalMs: DEFAULT_WORKER_INTERVAL_MS,
});

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

  // ── 守卫 ──────────────────────────────────────────────────
  const requireAuth = (req: FastifyRequest): { uid: number } => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = token ? verifyJwt(token, secret) : null;
    if (!payload) throw fail(401, 'ERR_AUTH', 'missing or invalid token');
    return { uid: payload.uid };
  };

  // ── 模型凭证（per-user 隔离）───────────────────────────
  app.put('/api/account/model', async (req, reply) => {
    const { uid } = requireAuth(req);
    const body = ModelConfigReqSchema.parse(req.body);
    const enc = encryptSecret(body.apiKey, secret);
    setUserModelConfig(db, uid, enc, body.baseUrl, body.model);
    return reply.send({ ok: true });
  });

  app.get('/api/account/model', async (req, reply) => {
    const { uid } = requireAuth(req);
    const mc = getUserModelConfig(db, uid);
    return reply.send({
      hasKey: !!mc?.model_api_key_enc,
      ...(mc?.model_base_url ? { baseUrl: mc.model_base_url } : {}),
      ...(mc?.model_name ? { model: mc.model_name } : {}),
    });
  });

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
    // Web 端 ChatPanel 依赖 workspacePath 作为 ACP session/load 的 cwd；缺失会导致聊天永远“连接中”
    ...(h.workspace_path ? { workspacePath: h.workspace_path } : {}),
    ...(h.task ? { task: h.task } : {}),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  });

  const needSandbox = (): SandboxDeps => {
    if (!sandbox) throw fail(502, 'ERR_K8S', 'sandbox orchestration not configured');
    return sandbox;
  };

  /** 确保 per-user 模型凭证 Secret 存在，返回 secretRefs 数组（有用户配置则用 per-user，否则回退共享 agenthub-model） */
  const ensureModelSecret = async (uid: number): Promise<string[]> => {
    const mc = getUserModelConfig(db, uid);
    if (mc?.model_api_key_enc) {
      const sb = needSandbox();
      const apiKey = decryptSecret(mc.model_api_key_enc, secret);
      const secName = userModelSecret(uid);
      await sb.orchestrator.createSecret(secName, {
        OPENAI_API_KEY: apiKey,
        DASHSCOPE_API_KEY: apiKey,
        ...(mc.model_base_url ? { OPENAI_BASE_URL: mc.model_base_url } : {}),
        ...(mc.model_name ? { OPENAI_MODEL: mc.model_name } : {}),
      });
      return [secName];
    }
    // 回退：用户未配模型凭证时用集群共享 Secret（向后兼容）
    return ['agenthub-model'];
  };

  const runnerOfBot = async (bot: BotRow): Promise<RunnerClient> => {
    const sb = needSandbox();
    if (!bot.pod_name) throw fail(409, 'ERR_NOT_READY', 'bot sandbox not provisioned');
    // Deployment 重建后 Pod 名变化，用 label 动态查找实际 Pod
    const podName = (await sb.orchestrator.findPodNameByLabel({ 'agenthub/bot': String(bot.id) })) ?? bot.pod_name;
    const base = await sb.connector.getBaseUrl({ namespace: sb.namespace, podName }, 8080);
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
      const slug = body.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
      const deployName = `ah-bot-${id}-${slug}`;
      const runnerToken = newToken();
      // 先落历史行再建 Pod：建不出来的实例也要在面板上看得见（S6）
      recordSandboxCreate(db, {
        podName: deployName,
        userId: uid,
        kind: 'bot',
        image: sandbox.image ?? sandboxImage(),
        namespace: sandbox.namespace,
        botId: id,
      });
      try {
        const modelRefs = await ensureModelSecret(uid);
        await sandbox.orchestrator.createSecret(`bot-${id}`, {
          DINGTALK_CLIENT_ID: body.clientId,
          DINGTALK_CLIENT_SECRET: decryptSecret(encryptSecret(body.clientSecret, secret), secret),
        });
        // bot 用 Deployment（非 raw Pod）：ACS 驱逐后自动重建
        await sandbox.orchestrator.createDeployment({
          podName: deployName,
          mode: 'bot',
          env: { RUNNER_TOKEN: runnerToken, BOT_NAME: body.name },
          secretRefs: [...modelRefs, `bot-${id}`],
          labels: { 'agenthub/kind': 'bot', 'agenthub/owner': String(uid), 'agenthub/bot': String(id) },
        });
        db.prepare("UPDATE bots SET pod_name=?, runner_token=?, status='running' WHERE id=?").run(deployName, runnerToken, id);
        recordSandboxReady(db, deployName);
      } catch (e) {
        db.prepare("UPDATE bots SET status='error' WHERE id=?").run(id);
        const m = e instanceof Error ? e.message : String(e);
        recordSandboxReclaim(db, deployName, 'failed', 'pod-failed', m);
        throw fail(502, 'ERR_K8S', `bot sandbox create failed: ${m}`);
      }
    }
    return reply.status(201).send(toBot(getBot(db, id)!));
  });

  app.delete('/api/bots/:id', async (req, reply) => {
    const bot = ownBot(req);
    if (sandbox) {
      if (bot.pod_name) {
        const podName = (await sandbox.orchestrator.findPodNameByLabel({ 'agenthub/bot': String(bot.id) })) ?? bot.pod_name;
        if (podName !== bot.pod_name) await sandbox.connector.dispose({ namespace: sandbox.namespace, podName }).catch(() => undefined);
        await sandbox.connector.dispose({ namespace: sandbox.namespace, podName: bot.pod_name }).catch(() => undefined);
        await sandbox.orchestrator.deleteDeployment(bot.pod_name).catch(() => undefined);
      }
      await sandbox.orchestrator.deleteSecret(`bot-${bot.id}`).catch(() => undefined);
    }
    if (bot.pod_name) recordSandboxReclaim(db, bot.pod_name, 'reclaimed', 'bot-deleted');
    // 软删时重命名，腾出 UNIQUE(user_id,name)，允许同名重建
    db.prepare("UPDATE bots SET status='deleted', pod_name=NULL, name=name||'.deleted.'||id WHERE id=?").run(bot.id);
    return reply.status(204).send();
  });

  // ── Sandbox 面板（S9）：历史行 + 模板 + 真实策略，恒带 WHERE user_id ──
  app.get('/api/sandboxes', async (req) => {
    const { uid } = requireAuth(req);
    const raw = Number((req.query as Record<string, string> | undefined)?.windowHours);
    const windowHours = Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 720) : 24;
    const rows = db
      .prepare(
        `SELECT * FROM sandboxes WHERE user_id=? AND (status IN ('provisioning','running') OR ended_at > datetime('now', ?))
         ORDER BY created_at DESC`,
      )
      .all(uid, `-${windowHours} hours`) as SandboxRow[];
    const now = Date.now();
    // SQLite datetime() 产出无时区后缀的 UTC 串，统一按 UTC 解析，避免本地时区偏移
    const parseTs = (s: string) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    const isOpen = (r: SandboxRow) => r.status === 'provisioning' || r.status === 'running';
    const items = rows.map((r) => ({
      podName: r.pod_name,
      kind: r.kind,
      handoffId: r.handoff_id,
      botId: r.bot_id,
      image: r.image,
      status: r.status,
      createdAt: r.created_at,
      readyAt: r.ready_at,
      endedAt: r.ended_at,
      durationSeconds: r.duration_seconds,
      reclaimReason: r.reclaim_reason,
      lastError: r.last_error,
    }));
    // 累计执行时长把仍在运行的实例算进去，否则跑了半小时的 sandbox 会报 0
    const execSecondsInWindow = rows.reduce((sum, r) => {
      if (isOpen(r)) return sum + (r.ready_at ? Math.max(0, Math.floor((now - parseTs(r.ready_at)) / 1000)) : 0);
      return sum + (r.duration_seconds ?? 0);
    }, 0);
    const running = (db.prepare("SELECT COUNT(*) c FROM sandboxes WHERE user_id=? AND status IN ('provisioning','running')").get(uid) as { c: number }).c;
    const configured = !!sandbox;
    return {
      configured,
      windowHours,
      items,
      stats: {
        running,
        reclaimedInWindow: rows.filter((r) => !isOpen(r)).length,
        templates: configured ? 1 : 0,
        execSecondsInWindow,
      },
      template: configured
        ? {
            image: sandbox!.image ?? sandboxImage(),
            namespace: sandbox!.namespace,
            baseImage: SANDBOX_TEMPLATE.baseImage,
            qwenVersion: SANDBOX_TEMPLATE.qwenVersion,
            toolchain: [...SANDBOX_TEMPLATE.toolchain],
            resources: { ...SANDBOX_RESOURCES },
            ports: { ...SANDBOX_PORTS },
            acs: sandbox!.acs ?? true,
          }
        : null,
      policy: sandbox?.worker ? sandbox.worker.policy() : defaultPolicy(),
    };
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
