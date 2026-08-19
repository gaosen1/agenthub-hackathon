/**
 * Sandbox runner 控制面（spec §4.3，端口 8080）
 * 下载还原 / 打包上传 / 拉起 qwen serve / 路由绑定。X-Runner-Token 认证。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { RunnerBindReqSchema, RunnerLoadReqSchema, RunnerSnapshotReqSchema, getWorkspaceScopeDirName, type RunnerHealthzResp } from '@agenthub/shared';
import { allLogs, appendLog, logsAfter, state } from './state.js';
import { runTask, startServe, stopServe, waitServeReady } from './qwen.js';
import {
  buildOutput,
  downloadTo,
  listChats,
  qwenHome,
  restoreContext,
  rewriteRoute,
  unpackInput,
  uploadTo,
} from './context.js';
import type { HandoffManifest } from '@agenthub/shared';

/** qwen serve daemon 使用 SHA256(workspacePath) 前 16 位作为目录名 */
function daemonWsHash(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 16);
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
        await downloadTo(body.inputUrl, tarball);
        manifest = await unpackInput(tarball, staging);
        state.loadedHandoffId = manifest.handoffId;
        appendLog('sys', `restoring workspace ${manifest.workspacePath} (${manifest.wsHash})`);
        await restoreContext(staging, manifest);

        if (state.mode === 'bot') {
          const botName = process.env.BOT_NAME ?? 'bot';
          const { writeChannelsConfig } = await import('./context.js');
          await writeChannelsConfig(qwenHome(), botName, manifest.workspacePath);
          if (body.bindChatId) {
            const dHash = daemonWsHash(manifest.workspacePath);
            appendLog('sys', `binding chat ${body.bindChatId} -> session ${manifest.sessionId} (wsHash=${dHash})`);
            await rewriteRoute(qwenHome(), dHash, botName, body.bindChatId, manifest.sessionId, manifest.workspacePath);
          }
          // task 与载体正交（spec §1）：bot 带 task 也先 headless 续跑，完成后再起 serve 供群内对话
          if (body.task) {
            const code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
            state.taskDone = true;
            if (code !== 0) state.lastError = `task relay failed (exit ${code})`;
            appendLog(code === 0 ? 'ok' : 'err', `task relay finished (exit ${code})`);
          }
          await startServe({ mode: 'bot', workspacePath: manifest.workspacePath, botName });
          await waitServeReady('bot');
          state.serveReady = true;
          appendLog('ok', 'bot serve ready (dingtalk stream connected on qwen side)');
          return;
        }

        // web 模式：先执行任务接力（如有），完成后拉起 serve 供继续对话
        if (body.task) {
          const code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
          state.taskDone = true;
          if (code !== 0) state.lastError = `task relay failed (exit ${code})`;
          appendLog(code === 0 ? 'ok' : 'err', `task relay finished (exit ${code})`);
        }
        await startServe({ mode: 'web', workspacePath: manifest.workspacePath, serveToken });
        await waitServeReady('web');
        state.serveReady = true;
        appendLog('ok', 'qwen serve ready');
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
    // 在 stopServe 之前先通过 daemon API 创建 session（daemon 仍在运行）
    // daemon 不接受自定义 sessionId，总是返回随机 UUID
    let sessionId = body.sessionId;
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
    await stopServe();
    await rewriteRoute(qwenHome(), ws, botName, body.chatId, sessionId, cwd);
    await startServe({ mode: 'bot', workspacePath: cwd, botName });
    await waitServeReady('bot');
    appendLog('ok', `rebound chat ${body.chatId} -> session ${sessionId}`);
    return reply.send({ ok: true, sessionId });
  });

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
