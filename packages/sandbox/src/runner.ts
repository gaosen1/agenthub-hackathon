/**
 * Sandbox runner 控制面（spec §4.3，端口 8080）
 * 下载还原 / 打包上传 / 拉起 qwen serve / 路由绑定。X-Runner-Token 认证。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { RunnerBindReqSchema, RunnerLoadReqSchema, RunnerSnapshotReqSchema, computeLockHash, getWorkspaceScopeDirName, type RunnerHealthzResp } from '@agenthub/shared';
import { allLogs, appendLog, logsAfter, state } from './state.js';
import { runTask, runTaskViaServe, newSessionViaServe, runPromptCollect, startServe, stopServe, waitServeReady } from './qwen.js';
import { startShellProxy } from './shell-proxy.js';
import { ensureIde, ideStatus } from './ide.js';
import { notifyGroups } from './dingtalk.js';
import { restoreBotSnapshot, uploadBotSnapshot } from './bot-snapshot.js';
import {
  buildDepsCache,
  buildOutput,
  downloadTo,
  extractDepsCache,
  listChats,
  qwenHome,
  rebindRoutes,
  restoreContext,
  rewriteRoute,
  unpackInput,
  uploadTo,
  writeCloudModelConfig,
} from './context.js';
import type { HandoffManifest } from '@agenthub/shared';

/** qwen serve daemon 使用 SHA256(workspacePath) 前 16 位作为目录名 */
function daemonWsHash(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 16);
}

/**
 * task 终态群推总结：状态 + task + 新增 commit 数 + agent 最后一条回复摘取。
 * 摘要来源 session jsonl 的最后一条 assistant 记录（headless/serve 两路径通用）。
 */
async function notifyTaskSummary(
  manifest: HandoffManifest,
  task: string,
  exitCode: number,
  chats: Array<{ chatId: string }>,
): Promise<void> {
  const ok = exitCode === 0;
  const base = manifest.repo.baseCommit;
  let commits = '';
  try {
    const { stdout } = await exec('git', ['-C', manifest.workspacePath, 'rev-list', '--count', `${base}..HEAD`]);
    commits = stdout.trim();
  } catch {
    /* 无 git 信息则省略 */
  }
  let summary = '';
  try {
    const jsonl = join(qwenHome(), 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`);
    const lines = (await fs.readFile(jsonl, 'utf8')).split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && !summary; i--) {
      try {
        const e = JSON.parse(lines[i]!) as { type?: string; message?: { parts?: Array<{ text?: string }> } };
        if (e.type === 'assistant') summary = (e.message?.parts?.map((p) => p.text ?? '').join('') ?? '').slice(0, 400);
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 无 session 文件则省略摘要 */
  }
  const title = ok ? '✅ 云端任务完成' : '❌ 云端任务失败';
  const text = [
    title,
    '',
    `**task**: ${task.slice(0, 200)}`,
    `**handoff**: ${manifest.handoffId}`,
    ...(commits ? [`**commits**: 新增 ${commits} 个（base ${base.slice(0, 7)}）`] : []),
    ...(summary ? ['', `**摘要**: ${summary}`] : []),
  ].join('\n');
  await notifyGroups(chats, title, text);
}

/**
 * fork session：复制 pushed session 并把每条记录的 sessionId 重写为新 id。
 * daemon load 时校验 transcript 只能有单一 session id；若直接 copy，
 * 旧记录带原 id、daemon 追加的新记录带 fork id，重启后 reload 必然 500。
 */
async function forkSessionFile(src: string, dest: string, forkedId: string): Promise<void> {
  const raw = await fs.readFile(src, 'utf8');
  const out = raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec['sessionId']) rec['sessionId'] = forkedId;
        return JSON.stringify(rec);
      } catch {
        return line;
      }
    })
    .join('\n');
  await fs.writeFile(dest, out);
}

/**
 * 自动绑定监听器：bot 模式下轮询 daemon 的 observed-contacts.json，发现新 chatId 时写路由。
 * 有 pushed session（push --bot）→ 每群 fork 同一份历史各自演进；
 * 裸 bot（无 /load）→ 每群 ACP 新建 session。绑定后重启 serve 使 routes 生效。
 */
let autoBinderTimer: ReturnType<typeof setInterval> | undefined;
function startAutoBinder(pushedSessionId: string | undefined, workspacePath: string, botName: string): void {
  if (autoBinderTimer) clearInterval(autoBinderTimer);
  const dHash = daemonWsHash(workspacePath);
  const home = qwenHome();
  const boundChatIds = new Set<string>();

  autoBinderTimer = setInterval(async () => {
    if (state.mode !== 'bot') {
      if (autoBinderTimer) clearInterval(autoBinderTimer);
      return;
    }
    try {
      const chats = await listChats(home, dHash);
      for (const chat of chats) {
        const chatId = chat.chatId;
        if (boundChatIds.has(chatId)) continue;
        boundChatIds.add(chatId);

        let sessionId: string;
        if (pushedSessionId && manifest) {
          // fork session：复制 pushed session 到新文件
          const srcSession = join(home, 'projects', manifest.wsHash, 'chats', `${pushedSessionId}.jsonl`);
          if (!existsSync(srcSession)) {
            boundChatIds.delete(chatId);
            continue;
          }
          const forkedId = randomUUID();
          const forkPath = join(home, 'projects', manifest.wsHash, 'chats', `${forkedId}.jsonl`);
          await forkSessionFile(srcSession, forkPath, forkedId);
          sessionId = forkedId;
        } else {
          sessionId = await newSessionViaServe(workspacePath);
        }

        // 写路由后必须重启 serve，daemon 才能在启动时 lazy-reload routes.json
        await stopServe();
        await rewriteRoute(home, dHash, botName, chatId, sessionId, workspacePath);
        await startServe({ mode: 'bot', workspacePath, botName, serveToken });
        await waitServeReady('bot');
        appendLog('ok', `auto-bind: chat ${chatId} -> session ${sessionId.slice(0, 8)} (serve restarted)`);
      }
    } catch {
      // 轮询失败，下次重试
    }
  }, 3000);
  autoBinderTimer.unref();
  appendLog('sys', `auto-binder started (pushed=${pushedSessionId ?? 'none'}, wsHash=${dHash})`);
}

const exec = promisify(execCb);
const WORK_ROOT = process.env.RUNNER_WORK_DIR ?? join(tmpdir(), 'agenthub-runner');

let manifest: HandoffManifest | undefined;
let serveToken: string | undefined;
let botWorkspace: { workspacePath: string; wsHash: string; botName: string } | undefined;
let startedAt = Date.now();

export function buildRunner(): FastifyInstance {
  const app = Fastify({ logger: false });
  const expectToken = process.env.RUNNER_TOKEN;

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return; // 就绪探针免鉴权
    if (expectToken && req.headers['x-runner-token'] !== expectToken) {
      return reply.status(401).send({ error: { code: 'ERR_AUTH', message: 'bad runner token' } });
    }
  });

  app.get('/healthz', async (): Promise<RunnerHealthzResp & { taskDone: boolean }> => ({
    ok: true,
    mode: state.mode,
    serveReady: state.serveReady,
    taskDone: state.taskDone,
    ...(state.loadedHandoffId ? { loadedHandoffId: state.loadedHandoffId } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  }));

  // 唤醒 relay：hub 跨 Aone 网关跑 ACP 会丢 SSE 应答帧（GET /acp 400），
  // 由 runner 在沙箱内 loopback 代跑并收集全文返回
  app.post('/acp-prompt', async (req) => {
    const body = (req.body ?? {}) as { question?: string; cwd?: string };
    const ws = body.cwd ?? state.workspacePath ?? botWorkspace?.workspacePath ?? join(WORK_ROOT, 'bot-workspace');
    const answer = await runPromptCollect(ws, body.question ?? '');
    return { answer };
  });

  // 下载还原 →（bot）注入 channel 配置/绑定 →（task）headless 续跑 → 拉起 serve
  app.post('/load', async (req, reply) => {
    const body = RunnerLoadReqSchema.parse(req.body);
    if (state.loading) return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'load in progress' } });
    state.loading = true;
    state.serveReady = false;
    state.taskDone = false;
    state.lastError = undefined;
    serveToken = body.serveToken;
    startedAt = Date.now();

    void (async () => {
      try {
        await stopServe();
        const tarball = join(WORK_ROOT, 'input.tar.gz');
        const staging = join(WORK_ROOT, 'staging');
        appendLog('sys', 'downloading input package');
        // S19：依赖缓存与输入包并行下载，还原后解压，免重复安装依赖
        const depsTar = join(WORK_ROOT, 'deps-cache.tar.gz');
        const depsDl = body.depsCacheUrl
          ? downloadTo(body.depsCacheUrl, depsTar)
              .then(() => true)
              .catch(() => {
                appendLog('info', 'deps cache download failed, will reinstall');
                return false;
              })
          : Promise.resolve(false);
        // S20：warm 全量 bundle 并行下载（delta 模式的合成基）
        const warmBundle = join(WORK_ROOT, 'warm.bundle');
        const warmDl = body.warmBundleUrl
          ? downloadTo(body.warmBundleUrl, warmBundle)
              .then(() => warmBundle)
              .catch(() => {
                appendLog('info', 'warm bundle download failed');
                return undefined;
              })
          : Promise.resolve<string | undefined>(undefined);
        await downloadTo(body.inputUrl, tarball);
        manifest = await unpackInput(tarball, staging);
        state.loadedHandoffId = manifest.handoffId;
        state.workspacePath = manifest.workspacePath;
        appendLog('sys', `restoring workspace ${manifest.workspacePath} (${manifest.wsHash})`);
        await restoreContext(staging, manifest, await warmDl);
        if (await depsDl) {
          try {
            await extractDepsCache(depsTar, manifest.workspacePath);
            appendLog('ok', 'deps cache restored (node_modules)');
          } catch (e) {
            appendLog('err', `deps cache extract failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (state.mode === 'bot') {
          const botName = process.env.BOT_NAME ?? 'bot';
          const { writeChannelsConfig } = await import('./context.js');
          await writeChannelsConfig(qwenHome(), botName, manifest.workspacePath);
          // 在 serve 启动前重绑路由：daemon 既有路由（含 DM 三段式 key）直接改绑 pushed session，写入当前 hash 目录
          const dHash = daemonWsHash(manifest.workspacePath);
          const rebound = await rebindRoutes(qwenHome(), dHash, botName, manifest.sessionId, manifest.workspacePath);
          if (rebound > 0) appendLog('ok', `auto-rebind ${rebound} daemon route(s) -> session ${manifest.sessionId.slice(0, 8)}`);
          // observed 里仅有群记录、尚无路由的聊天：补绑
          const existingChats = await listChats(qwenHome(), dHash);
          for (const chat of existingChats) {
            await rewriteRoute(qwenHome(), dHash, botName, chat.chatId, manifest.sessionId, manifest.workspacePath);
            appendLog('ok', `auto-rebind chat ${chat.chatId} -> session ${manifest.sessionId.slice(0, 8)}`);
          }
          // 如果 push 时显式指定了 --chat 且不在现有列表中，也绑定
          if (body.bindChatId && !existingChats.some(c => c.chatId === body.bindChatId)) {
            await rewriteRoute(qwenHome(), dHash, botName, body.bindChatId, manifest.sessionId, manifest.workspacePath);
            appendLog('ok', `explicit bind chat ${body.bindChatId} -> session ${manifest.sessionId.slice(0, 8)}`);
          }
          // serve 先起：钉钉流与 Web Shell 立即可用；task 走 serve ACP 流式执行，外部端可实时观看
          await startServe({ mode: 'bot', workspacePath: manifest.workspacePath, botName, serveToken });
          await waitServeReady('bot');
          state.serveReady = true;
          appendLog('ok', 'bot serve ready (dingtalk stream connected on qwen side)');
          // task 经 serve ACP 流式执行（侧栏 Web Shell 实时可见）；serve 路径不可用时回退 headless 续跑
          if (body.task) {
            let code: number;
            try {
              code = await runTaskViaServe(manifest.workspacePath, manifest.sessionId, body.task, serveToken);
            } catch (e) {
              appendLog('sys', `serve task path unavailable (${e instanceof Error ? e.message : String(e)}); fallback headless`);
              code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
            }
            state.taskDone = true;
            if (code !== 0) state.lastError = `task relay failed (exit ${code})`;
            appendLog(code === 0 ? 'ok' : 'err', `task relay finished (exit ${code})`);
            // 终态主动推群总结（钉钉 OpenAPI；未配置凭证/无绑定群时静默 no-op）
            // 终态时重取群列表：任务期间新 @ 绑定的群也要收到总结
            const notifyChats = await listChats(qwenHome(), dHash);
            if (body.bindChatId && !notifyChats.some((c) => c.chatId === body.bindChatId)) {
              notifyChats.push({ chatId: body.bindChatId });
            }
            void notifyTaskSummary(manifest, body.task, code, notifyChats);
          }
          // 启动自动绑定监听器：新群 @机器人 时自动 fork session 并写路由
          startAutoBinder(manifest.sessionId, manifest.workspacePath, botName);
          return;
        }

        // web 模式：serve 先起（侧栏/web-shell 立即可连），任务经 serve ACP 流式执行（盲点修复）；
        // serve 路径不可用时回退 headless 续跑
        // 覆盖还原的本地模型配置（可能指向办公网端点，Pod 不可达）
        await writeCloudModelConfig(qwenHome());
        await startServe({ mode: 'web', workspacePath: manifest.workspacePath, serveToken });
        await waitServeReady('web');
        state.serveReady = true;
        appendLog('ok', 'qwen serve ready');
        if (body.task) {
          let code: number;
          try {
            code = await runTaskViaServe(manifest.workspacePath, manifest.sessionId, body.task, serveToken);
          } catch (e) {
            appendLog('sys', `serve task path unavailable (${e instanceof Error ? e.message : String(e)}); fallback headless`);
            code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
          }
          state.taskDone = true;
          if (code !== 0) state.lastError = `task relay failed (exit ${code})`;
          appendLog(code === 0 ? 'ok' : 'err', `task relay finished (exit ${code})`);
        }
      } catch (e) {
        state.lastError = e instanceof Error ? e.message : String(e);
        appendLog('err', `load failed: ${state.lastError}`);
      } finally {
        state.loading = false;
      }
    })();

    return reply.status(202).send({ accepted: true });
  });

  // 现场打包上传返回包
  app.post('/snapshot', async (req, reply) => {
    const body = RunnerSnapshotReqSchema.parse(req.body);
    if (!manifest) return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'nothing loaded' } });
    appendLog('sys', 'packaging output');
    const { tarball, manifest: outManifest } = await buildOutput(manifest, {
      workDir: join(WORK_ROOT, 'output'),
      logs: allLogs(),
      status: state.lastError ? 'failed' : 'done',
      startedAt,
      ...(state.lastError ? { error: state.lastError } : {}),
    });
    await uploadTo(body.outputUrl, tarball);
    appendLog('ok', 'output uploaded');
    // S19 依赖缓存：node_modules 存在且未超 1.5GB 时上传快照 + sidecar，失败不致命
    if (body.depsCachePutUrl && body.depsSidecarPutUrl) {
      try {
        const depsTar = join(WORK_ROOT, `deps-${manifest.handoffId}.tar.gz`);
        if (await buildDepsCache(manifest.workspacePath, depsTar)) {
          const st = await fs.stat(depsTar);
          if (st.size > 1.5 * 1024 ** 3) {
            appendLog('info', 'deps cache over 1.5GB, skip');
          } else {
            await uploadTo(body.depsCachePutUrl, depsTar);
            const sidecar = join(WORK_ROOT, `deps-${manifest.handoffId}.json`);
            await fs.writeFile(
              sidecar,
              JSON.stringify({
                lockHash: computeLockHash(manifest.workspacePath),
                bytes: st.size,
                createdAt: new Date().toISOString(),
              }),
            );
            await uploadTo(body.depsSidecarPutUrl, sidecar);
            appendLog('ok', `deps cache uploaded (${Math.round(st.size / 1e6)}MB)`);
          }
        }
      } catch (e) {
        appendLog('err', `deps cache upload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // S20 warm 全量 bundle：快照 workspace --all，下次 push 只需传 delta
    if (body.warmBundlePutUrl && body.warmSidecarPutUrl) {
      try {
        const warm = join(WORK_ROOT, `warm-${manifest.handoffId}.bundle`);
        await exec('git', ['bundle', 'create', warm, '--all'], { cwd: manifest.workspacePath });
        await uploadTo(body.warmBundlePutUrl, warm);
        const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: manifest.workspacePath })).stdout.trim();
        const warmSidecar = join(WORK_ROOT, `warm-${manifest.handoffId}.json`);
        await fs.writeFile(warmSidecar, JSON.stringify({ head, createdAt: new Date().toISOString() }));
        await uploadTo(body.warmSidecarPutUrl, warmSidecar);
        appendLog('ok', 'warm bundle uploaded');
      } catch (e) {
        appendLog('err', `warm bundle upload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return reply.send({ manifest: outManifest });
  });

  // bot：已知群列表
  app.get('/chats', async (_req, reply) => {
    const wsHash = manifest?.wsHash ?? botWorkspace?.wsHash;
    if (!wsHash) return reply.send({ items: [] });
    return reply.send({ items: await listChats(qwenHome(), wsHash) });
  });

  // bot：绑定指定群到 session（创建 session → 停 serve → 改路由 → 重启，spec §8.2）
  app.post('/bind', async (req, reply) => {
    const body = RunnerBindReqSchema.parse(req.body);
    if (state.mode !== 'bot') {
      return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'bind requires bot mode' } });
    }
    const botName = process.env.BOT_NAME ?? 'bot';
    const ws = manifest?.wsHash ?? botWorkspace?.wsHash;
    const cwd = manifest?.workspacePath ?? botWorkspace?.workspacePath;
    if (!ws || !cwd) {
      return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'no workspace loaded' } });
    }
    // 如果请求体带了 sessionId 且对应的 session 文件已存在（/load 还原过），
    // 直接复用，不要让 daemon 新建空 session 覆盖掉对话历史。
    // 只有 session 文件不存在时才通过 daemon API 创建新 session。
    let sessionId = body.sessionId;
    const sessionFile = join(qwenHome(), 'projects', ws, 'chats', `${body.sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      try {
        const resp = await fetch('http://127.0.0.1:4170/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const created = await resp.json() as { sessionId?: string };
          if (created.sessionId) sessionId = created.sessionId;
        }
      } catch {
        // daemon 不可用或端口不对，用原始 sessionId
      }
    }
    await stopServe();
    // 路由必须写到 daemon 自己的 hash 目录（SHA256[:16]），写 manifest.wsHash 目录 daemon 不读
    await rewriteRoute(qwenHome(), daemonWsHash(cwd), botName, body.chatId, sessionId, cwd);
    await startServe({ mode: 'bot', workspacePath: cwd, botName, serveToken });
    await waitServeReady('bot');
    appendLog('ok', `rebound chat ${body.chatId} -> session ${sessionId}`);
    return reply.send({ ok: true, sessionId });
  });

  // ── Web IDE（code-server）控制面：hub 经此拉起/查询 :8083 ──
  app.post('/ide/ensure', async (_req, reply) => {
    if (!state.loadedHandoffId || !state.workspacePath) {
      return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'workspace not loaded' } });
    }
    const st = await ensureIde(state.workspacePath);
    state.ideReady = st.ready;
    if (!st.ready) {
      return reply.status(409).send({ error: { code: 'ERR_NOT_READY', message: st.error ?? 'ide not ready' } });
    }
    return reply.send(st);
  });

  app.get('/ide/status', async (_req, reply) => reply.send(ideStatus()));

  app.get('/logs', async (req, reply) => {
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return reply.send(logsAfter(after));
  });

  return app;
}

// 直接运行时启动（测试中仅 import buildRunner 不监听）
if (process.env.VITEST === undefined) {
  const PORT = Number(process.env.RUNNER_PORT ?? 8080);
  const app = buildRunner();
  app
    .listen({ port: PORT, host: '0.0.0.0' })
    .then(() => {
      appendLog('sys', `runner listening on :${PORT} (mode=${state.mode})`);
      // 日志持久化：周期全量上传 OSS（沙箱回收后 hub 从归档补取，避免死后日志丢）
      const logPutUrl = process.env.RUNNER_LOG_PUT_URL;
      if (logPutUrl) {
        const flushLogs = (): void => {
          void (async () => {
            const tmp = join(WORK_ROOT, 'runner-logs.jsonl');
            await fs.writeFile(tmp, allLogs().map((e) => JSON.stringify(e)).join('\n') + '\n').catch(() => undefined);
            await uploadTo(logPutUrl, tmp).catch(() => undefined);
          })();
        };
        flushLogs();
        setInterval(flushLogs, 60_000).unref?.();
      }
      // 启动期即起 8082 链：/__runner/ 暴露 runner API（Aone /load 先于 load 处理可达），
      // 根路径转发 serve（serve 起来前 502，属预期）
      startShellProxy(Number(process.env.AGENTHUB_SERVE_PORT ?? 8081), 8082, PORT);
      // bot 模式：自动写 settings.json + 启动 qwen serve（无需 /load）
      if (state.mode === 'bot') {
        const botName = process.env.BOT_NAME ?? 'bot';
        const defaultWs = process.env.BOT_WORKSPACE ?? join(WORK_ROOT, 'bot-workspace');
        void (async () => {
          try {
            // 外置存储：先还原快照（workspace+chats 跨沙箱续记忆），无快照/失败回退空仓库
            const workspacePath = await restoreBotSnapshot(process.env.BOT_SNAPSHOT_GET_URL, defaultWs);
            await fs.mkdir(workspacePath, { recursive: true });
            // 初始化 git 仓库（无 handoff 时从空仓库开始）
            await exec('git', ['init', '-b', 'main', workspacePath]).catch(() => undefined);
            const { writeChannelsConfig } = await import('./context.js');
            await writeChannelsConfig(qwenHome(), botName, workspacePath);
            // bot 无 /load：模型配置同样须用注入的 OPENAI_* env 覆盖，否则 qwen 落默认提供商挂起（唤醒 #2 超时事故）
            await writeCloudModelConfig(qwenHome());
            botWorkspace = { workspacePath, wsHash: daemonWsHash(workspacePath), botName };
            appendLog('sys', `bot auto-start: channels config written for ${botName}`);
            await startServe({ mode: 'bot', workspacePath, botName });
            await waitServeReady('bot');
            state.serveReady = true;
            appendLog('ok', 'bot serve ready (dingtalk stream connected)');
            // 删除式沙箱：立即回写一次 + 每 4 分钟周期快照（best-effort）
            const putUrl = process.env.BOT_SNAPSHOT_PUT_URL;
            const snap = (): void => {
              void uploadBotSnapshot(putUrl, botWorkspace?.workspacePath ?? workspacePath);
            };
            snap();
            setInterval(snap, 240_000);
            // 裸 bot 也要自动绑路由：新聊天 ACP 新建 session；push --bot 的 /load 会替换为 fork 模式 binder
            startAutoBinder(undefined, workspacePath, botName);
          } catch (e) {
            state.lastError = e instanceof Error ? e.message : String(e);
            appendLog('err', `bot auto-start failed: ${state.lastError}`);
          }
        })();
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
