/**
 * Sandbox runner 控制面（spec §4.3，端口 8080）
 * 下载还原 / 打包上传 / 拉起 qwen serve / 路由绑定。X-Runner-Token 认证。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BindReqSchema, LoadReqSchema, SnapshotReqSchema, type HealthzResponse } from '@agenthub/shared';
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

const WORK_ROOT = process.env.RUNNER_WORK_DIR ?? join(tmpdir(), 'agenthub-runner');

let manifest: HandoffManifest | undefined;
let serveToken: string | undefined;
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

  app.get('/healthz', async (): Promise<HealthzResponse & { taskDone: boolean }> => ({
    ok: true,
    mode: state.mode,
    serveReady: state.serveReady,
    taskDone: state.taskDone,
    ...(state.loadedHandoffId ? { loadedHandoffId: state.loadedHandoffId } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  }));

  // 下载还原 →（bot）注入 channel 配置/绑定 →（task）headless 续跑 → 拉起 serve
  app.post('/load', async (req, reply) => {
    const body = LoadReqSchema.parse(req.body);
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
            appendLog('sys', `binding chat ${body.bindChatId} -> session ${manifest.sessionId}`);
            await rewriteRoute(qwenHome(), manifest.wsHash, botName, body.bindChatId, manifest.sessionId, manifest.workspacePath);
          }
          // task 与载体正交（spec §1）：bot 带 task 也先 headless 续跑，完成后再起 serve 供群内对话
          if (body.task) {
            const code = await runTask(manifest.workspacePath, manifest.sessionId, body.task);
            state.taskDone = true;
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
    const body = SnapshotReqSchema.parse(req.body);
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
    if (!manifest) return reply.send({ items: [] });
    return reply.send({ items: await listChats(qwenHome(), manifest.wsHash) });
  });

  // bot：绑定指定群到 session（停 serve → 改路由 → 重启，spec §8.2）
  app.post('/bind', async (req, reply) => {
    const body = BindReqSchema.parse(req.body);
    if (state.mode !== 'bot' || !manifest) {
      return reply.status(409).send({ error: { code: 'ERR_STATE', message: 'bind requires loaded bot mode' } });
    }
    const botName = process.env.BOT_NAME ?? 'bot';
    await stopServe();
    await rewriteRoute(qwenHome(), manifest.wsHash, botName, body.chatId, body.sessionId, manifest.workspacePath);
    await startServe({ mode: 'bot', workspacePath: manifest.workspacePath, botName });
    await waitServeReady('bot');
    appendLog('ok', `rebound chat ${body.chatId} -> session ${body.sessionId}`);
    return reply.send({ ok: true });
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
  buildRunner()
    .listen({ port: PORT, host: '0.0.0.0' })
    .then(() => appendLog('sys', `runner listening on :${PORT} (mode=${state.mode})`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
