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
import { codeServerInstalled, ensureIde, ideStatus } from './ide.js';
import { runTask, runTaskViaServe, startServe, stopServe, waitServeReady } from './qwen.js';
import { startShellProxy } from './shell-proxy.js';
import {
  buildDepsCache,
  buildOutput,
  downloadTo,
  extractDepsCache,
  listChats,
  qwenHome,
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
 * 自动绑定监听器：bot 模式下 /load 完成后启动，
 * 轮询 daemon 的 observed-contacts.json，发现新 chatId 时自动 fork session 并写路由。
 * 每个群从同一份 pushed session 开始，但各自独立演进（perChat 隔离）。
 */
let autoBinderTimer: ReturnType<typeof setInterval> | undefined;
function startAutoBinder(pushedSessionId: string, workspacePath: string, botName: string): void {
  const dHash = daemonWsHash(workspacePath);
  const home = qwenHome();
  const boundChatIds = new Set<string>();

  autoBinderTimer = setInterval(async () => {
    if (!manifest || state.mode !== 'bot') {
      if (autoBinderTimer) clearInterval(autoBinderTimer);
      return;
    }
    try {
      const chats = await listChats(home, dHash);
      for (const chat of chats) {
        const chatId = chat.chatId;
        if (boundChatIds.has(chatId)) continue;
        // 跳过 push 时已绑定的 chatId（如果有的话）
        boundChatIds.add(chatId);

        // fork session：复制 pushed session 到新文件
        const srcSession = join(home, 'projects', manifest.wsHash, 'chats', `${pushedSessionId}.jsonl`);
        if (!existsSync(srcSession)) continue;

        const forkedId = randomUUID();
        const forkPath = join(home, 'projects', manifest.wsHash, 'chats', `${forkedId}.jsonl`);
        await forkSessionFile(srcSession, forkPath, forkedId);

        // 写路由后必须重启 serve，daemon 才能在启动时 lazy-reload routes.json
        await stopServe();
        await rewriteRoute(home, dHash, botName, chatId, forkedId, workspacePath);
        await startServe({ mode: 'bot', workspacePath, botName });
        await waitServeReady('bot');
        appendLog('ok', `auto-bind: chat ${chatId} -> forked session ${forkedId} (serve restarted)`);
      }
    } catch {
      // 轮询失败，下次重试
    }
  }, 3000);
  autoBinderTimer.unref();
  appendLog('sys', `auto-binder started (pushed session ${pushedSessionId}, wsHash=${dHash})`);
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
          // task 与载体正交（spec §1）：bot 带 task 也先 headless 续跑，完成后再起 serve 供群内对话
          if (body.task) {
            const code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
            state.taskDone = true;
            if (code !== 0) state.lastError = `task relay failed (exit ${code})`;
            appendLog(code === 0 ? 'ok' : 'err', `task relay finished (exit ${code})`);
          }
          // 在 serve 启动前重绑所有现有群路由，daemon 启动时 lazy-reload routes.json 即生效
          const dHash = daemonWsHash(manifest.workspacePath);
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
          await startServe({ mode: 'bot', workspacePath: manifest.workspacePath, botName });
          await waitServeReady('bot');
          state.serveReady = true;
          appendLog('ok', 'bot serve ready (dingtalk stream connected on qwen side)');
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
        // 8082 头部改写代理：剥 serve 的 frame-ancestors 'none'，侧栏 iframe 可达
        startShellProxy(8081, 8082);
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
    await startServe({ mode: 'bot', workspacePath: cwd, botName });
    await waitServeReady('bot');
    appendLog('ok', `rebound chat ${body.chatId} -> session ${sessionId}`);
    return reply.send({ ok: true, sessionId });
  });

  app.get('/logs', async (req, reply) => {
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return reply.send(logsAfter(after));
  });

  // Web IDE：按需从 NAS 共享层拉起 code-server（:8083）打开当前工作区，幂等
  app.post('/ide/ensure', async (_req, reply) => {
    const ws = manifest?.workspacePath ?? botWorkspace?.workspacePath;
    if (!ws) return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'no workspace loaded' } });
    if (!codeServerInstalled()) {
      return reply.status(409).send({ error: { code: 'ERR_NOT_READY', message: 'code-server not preinstalled on shared layer' } });
    }
    const st = await ensureIde(ws);
    if (!st.ready) return reply.status(502).send({ error: { code: 'ERR_RUNNER', message: st.error ?? 'code-server start failed' } });
    return reply.send(st);
  });

  app.get('/ide/status', async () => ideStatus());

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
      // bot 模式：自动写 settings.json + 启动 qwen serve（无需 /load）
      if (state.mode === 'bot') {
        const botName = process.env.BOT_NAME ?? 'bot';
        const workspacePath = process.env.BOT_WORKSPACE ?? join(WORK_ROOT, 'bot-workspace');
        void (async () => {
          try {
            await fs.mkdir(workspacePath, { recursive: true });
            // 初始化 git 仓库（无 handoff 时从空仓库开始）
            await exec('git', ['init', '-b', 'main', workspacePath]).catch(() => undefined);
            const { writeChannelsConfig } = await import('./context.js');
            await writeChannelsConfig(qwenHome(), botName, workspacePath);
            botWorkspace = { workspacePath, wsHash: daemonWsHash(workspacePath), botName };
            appendLog('sys', `bot auto-start: channels config written for ${botName}`);
            await startServe({ mode: 'bot', workspacePath, botName });
            await waitServeReady('bot');
            state.serveReady = true;
            appendLog('ok', 'bot serve ready (dingtalk stream connected)');
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
