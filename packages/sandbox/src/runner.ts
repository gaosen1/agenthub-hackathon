/**
 * Sandbox runner 控制面（spec §4.3，端口 8080）
 * 下载还原 / 打包上传 / 拉起 qwen serve / 路由绑定。X-Runner-Token 认证。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { RunnerBindReqSchema, RunnerLoadReqSchema, RunnerSnapshotReqSchema, computeLockHash, getWorkspaceScopeDirName, type RunnerHealthzResp } from '@agenthub/shared';
import { allLogs, appendLog, logsAfter, state, touchActivity } from './state.js';
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
  routesPath,
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
 * 自动绑定监听器：bot 模式下发现新聊天写路由（写后重启 serve，daemon 启动时才 lazy-reload routes.json）。
 * - 群聊：轮询 listChats（routes.json ∪ observed-contacts）；
 * - DM 单聊：daemon 不为 DM 写路由、observed 也只有 user 无 chatId，
 *   故从 runner 日志的 isGroup=false 消息行提取 senderId/conversationId 发现 DM 聊天；
 * - 绑定目标统一为 pushed session（bot 载体=单上下文交互单元，群/DM 只是同一任务的不同入口）；
 *   裸 bot（无 /load）才 ACP 新建 session；
 * - 启动时 seed 已有路由的聊天，避免 /load 后重复重绑+重启 serve
 *   （重启会断流并掐掉在途回复——群聊「已读不回」事故根因）。
 */
let autoBinderTimer: ReturnType<typeof setInterval> | undefined;
/** binder 状态（/debug/state 埋点可见） */
const binderState = { seeded: 0, bound: [] as string[], lastTick: '' };
function startAutoBinder(pushedSessionId: string | undefined, workspacePath: string, botName: string): void {
  if (autoBinderTimer) clearInterval(autoBinderTimer);
  const dHash = daemonWsHash(workspacePath);
  const home = qwenHome();
  const boundChatIds = new Set<string>();
  void listChats(home, dHash)
    .then((cs) => {
      for (const c of cs) boundChatIds.add(c.chatId);
      binderState.seeded = boundChatIds.size;
      binderState.bound = [...boundChatIds];
      appendLog('sys', `auto-binder seeded ${binderState.seeded} known chat(s)`);
    })
    .catch(() => undefined);
  let logCursor = 0;
  /** 日志发现但尚未绑定的聊天（busy 推迟后不能丢，游标已前进） */
  const awaiting: Array<{ chatId: string; senderIds: string[]; isGroup: boolean }> = [];

  autoBinderTimer = setInterval(async () => {
    if (state.mode !== 'bot') {
      if (autoBinderTimer) clearInterval(autoBinderTimer);
      return;
    }
    try {
      // DM/群发现：扫全量日志增量（含 binder 启动前的消息）。
      // observed-contacts 只记 user 不记 group，listChats 拿不到群的三段式 key（user scope 只认三段式），
      // 故从消息行提取 senderId/conversationId 是唯一可靠来源。
      const logs = allLogs();
      for (let i = logCursor; i < logs.length; i++) {
        const c = logs[i]!.c;
        const isGroup = c.includes('isGroup=true') ? true : c.includes('isGroup=false') ? false : undefined;
        if (isGroup === undefined) continue;
        const cid = /conversationId=(\S+)/.exec(c)?.[1];
        // daemon 路由 key 的 senderId 用 staffId（见 daemon 自写路由），原始 senderId 是 $:LWCP token
        const sid = /senderStaffId=(\S+)/.exec(c)?.[1] ?? /senderId=(\S+)/.exec(c)?.[1];
        if (cid && sid && !boundChatIds.has(cid) && !awaiting.some((a) => a.chatId === cid)) {
          awaiting.push({ chatId: cid, senderIds: [sid], isGroup });
        }
      }
      logCursor = logs.length;

      // daemon 忙窗口（有 enqueued 未 completed 的 prompt）不重启 serve，掐在途回复=已读不回；
      // 路由发现照记，下一 tick 再重启生效
      let lastEnq = -1;
      let lastDone = -1;
      for (let i = logs.length - 1; i >= 0 && (lastEnq < 0 || lastDone < 0); i--) {
        if (lastEnq < 0 && logs[i]!.c.includes('prompt enqueued')) lastEnq = i;
        if (lastDone < 0 && logs[i]!.c.includes('turn completed')) lastDone = i;
      }
      const busy = lastEnq >= 0 && lastEnq > lastDone;

      const chats = await listChats(home, dHash);
      const pending: Array<{ chatId: string; senderIds?: string[]; isGroup?: boolean }> = [
        ...chats.map((c) => ({ chatId: c.chatId })),
        ...awaiting,
      ];
      for (const t of pending) {
        if (boundChatIds.has(t.chatId)) continue;
        if (busy) continue; //  defer：daemon 在途回复优先，下一 tick 重试
        boundChatIds.add(t.chatId);
        const ai = awaiting.findIndex((a) => a.chatId === t.chatId);
        if (ai >= 0) awaiting.splice(ai, 1);
        binderState.bound = [...boundChatIds];
        binderState.lastTick = new Date().toISOString();
        const sessionId = pushedSessionId ?? (await newSessionViaServe(workspacePath, serveToken));
        await stopServe();
        await rewriteRoute(home, dHash, botName, t.chatId, sessionId, workspacePath, { senderIds: t.senderIds, isGroup: t.isGroup });
        await startServe({ mode: 'bot', workspacePath, botName, serveToken });
        await waitServeReady('bot');
        appendLog('ok', `auto-bind: chat ${t.chatId.slice(0, 12)} (dm=${t.isGroup === false}) -> session ${sessionId.slice(0, 8)} (serve restarted)`);
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

/** qwen serve daemon 的工具注册不读 settings tools.exclude（daemon chunk 零引用，实测活沙箱配置写入正确仍被反问），
 * 设置层禁用对 serve 路径无效；relay 层在任务文本追加无人值守约束，模型自主避开 ask_user_question（反问挂 5 分钟被 cancel 后 turn 直接结束） */
const UNATTENDED_TASK_SUFFIX =
  '\n\n[AgentHub 无人值守接力约束] 本环境无人应答：禁止使用 ask_user_question 工具；需要确认时按最合理假设自主推进，并在最终总结中说明假设。';

/** 最近活动时间：控制面打点 ∨ daemon session 文件 mtime。
 * 钉钉消息直达 daemon，runner/hub 都看不见；但每轮会话都追加写 chats/*.jsonl，
 * mtime 是唯一的会话活动信号（bot 驻留期空闲 TTL 判据，hf-0dc37c 硬超时误杀修复） */
async function lastActivityAt(): Promise<string | undefined> {
  let ms = state.lastActivityAt ? Date.parse(state.lastActivityAt) : 0;
  const projects = join(qwenHome(), 'projects');
  for (const shard of await fs.readdir(projects).catch(() => [] as string[])) {
    const chats = join(projects, shard, 'chats');
    for (const f of await fs.readdir(chats).catch(() => [] as string[])) {
      const st = await fs.stat(join(chats, f)).catch(() => undefined);
      if (st && st.mtimeMs > ms) ms = st.mtimeMs;
    }
  }
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

let manifest: HandoffManifest | undefined;
// 裸 bot（无 /load）场景：daemon 的 Bearer 凭证就是编排层注入的 QWEN_SERVER_TOKEN（startServe 透传 env），
// 直接作为缺省值——否则 waker 唤醒时 runPromptCollect 无 token 连 daemon 被 401 拒（唤醒失败 acp-prompt 500 事故）
let serveToken: string | undefined = process.env.QWEN_SERVER_TOKEN || undefined;
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

  app.get('/healthz', async (): Promise<RunnerHealthzResp & { taskDone: boolean }> => {
    const act = await lastActivityAt();
    return {
      ok: true,
      mode: state.mode,
      serveReady: state.serveReady,
      taskDone: state.taskDone,
      ...(state.loadedHandoffId ? { loadedHandoffId: state.loadedHandoffId } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(act ? { lastActivityAt: act } : {}),
    };
  });

  // 唤醒 relay：hub 跨 Aone 网关跑 ACP 会丢 SSE 应答帧（GET /acp 400），
  // 由 runner 在沙箱内 loopback 代跑并收集全文返回
  app.post('/acp-prompt', async (req) => {
    touchActivity();
    const body = (req.body ?? {}) as { question?: string; cwd?: string };
    const ws = body.cwd ?? state.workspacePath ?? botWorkspace?.workspacePath ?? join(WORK_ROOT, 'bot-workspace');
    const answer = await runPromptCollect(ws, body.question ?? '', 5 * 60_000, serveToken);
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
    touchActivity();

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
          // 埋点：/load 后路由表全量落日志，便于排查钉钉路由归属
          try {
            const rj = JSON.parse(await fs.readFile(routesPath(qwenHome(), dHash), 'utf8')) as Record<string, { sessionId?: string }>;
            const dump = Object.entries(rj).map(([k, v]) => `${k} -> ${(v.sessionId ?? '?').slice(0, 8)}`).join(' | ');
            appendLog('sys', `routes after /load rebind: ${dump || '(empty)'}`);
          } catch {
            appendLog('sys', 'routes after /load rebind: (none)');
          }
          // serve 先起：钉钉流与 Web Shell 立即可用；task 走 serve ACP 流式执行，外部端可实时观看。
          // 重试容忍：旧 serve 的钉钉 stream 释放有竞态（同 clientId 互踢），channel worker 可能
          // 首启退出（hf-aa7245 事故：task 未跑、群消息丢）；退避重试 3 次。
          for (let attempt = 1; ; attempt++) {
            try {
              await startServe({ mode: 'bot', workspacePath: manifest.workspacePath, botName, serveToken });
              await waitServeReady('bot');
              break;
            } catch (e) {
              if (attempt >= 3) throw e;
              appendLog('sys', `serve start attempt ${attempt} failed (${e instanceof Error ? e.message : String(e)}); retry in 3s (dingtalk stream release grace)`);
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          state.serveReady = true;
          state.lastError = undefined; // 裸启动等历史错误不污染本次 handoff
          appendLog('ok', 'bot serve ready (dingtalk stream connected on qwen side)');
          // task 经 serve ACP 流式执行（侧栏 Web Shell 实时可见）；serve 路径不可用时回退 headless 续跑
          if (body.task) {
            const taskText = body.task + UNATTENDED_TASK_SUFFIX;
            let code: number;
            try {
              code = await runTaskViaServe(manifest.workspacePath, manifest.sessionId, taskText, serveToken);
            } catch (e) {
              appendLog('sys', `serve task path unavailable (${e instanceof Error ? e.message : String(e)}); fallback headless`);
              code = await runTask(manifest.workspacePath, manifest.sessionId, taskText);
            }
            // turn 结束 ≠ 任务结束：模型派发后台代理（探索/子任务）后 turn 立即返回，session 仍在 daemon
            // 里续写——此刻判完会 premature 推「完成」且真终态无人推送（hf-c70fd4 事故：12:54 报完成 0 commit，
            // 真完工 13:07 两个 commit 无推送）。判据：session jsonl mtime 连续 120s 无新写才算真结束
            if (code === 0) {
              const sessJsonl = join(qwenHome(), 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`);
              let lastM = await fs.stat(sessJsonl).then((s) => s.mtimeMs).catch(() => 0);
              let quietSince = Date.now();
              if (lastM > 0) appendLog('sys', 'task turn returned; waiting for session quiescence (background agents)');
              while (lastM > 0 && Date.now() - quietSince < 120_000) {
                await new Promise((r) => setTimeout(r, 10_000));
                touchActivity();
                const m = await fs.stat(sessJsonl).then((s) => s.mtimeMs).catch(() => lastM);
                if (m > lastM) {
                  lastM = m;
                  quietSince = Date.now();
                }
              }
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
        // 覆盖还原的本地模型配置（可能指向办公网端点，Pod 不可达）；带 task 的接力属无人值守，剔除交互式提问工具
        await writeCloudModelConfig(qwenHome(), { unattended: Boolean(body.task) });
        await startServe({ mode: 'web', workspacePath: manifest.workspacePath, serveToken });
        await waitServeReady('web');
        state.serveReady = true;
        state.lastError = undefined;
        appendLog('ok', 'qwen serve ready');
        if (body.task) {
          const taskText = body.task + UNATTENDED_TASK_SUFFIX;
          let code: number;
          try {
            code = await runTaskViaServe(manifest.workspacePath, manifest.sessionId, taskText, serveToken);
          } catch (e) {
            appendLog('sys', `serve task path unavailable (${e instanceof Error ? e.message : String(e)}); fallback headless`);
            code = await runTask(manifest.workspacePath, manifest.sessionId, taskText);
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
    touchActivity();
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

  // 埋点：路由/observed/pushed session 尾部/binder 状态全量现场，排查钉钉路由归属用
  app.get('/debug/state', async (_req, reply) => {
    const home = qwenHome();
    const daemonDir = join(home, 'channels', 'daemon');
    const routes: Record<string, unknown> = {};
    const observed: Record<string, unknown> = {};
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(daemonDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      /* 无 daemon 目录 */
    }
    for (const dir of dirs) {
      try {
        routes[dir] = JSON.parse(await fs.readFile(join(daemonDir, dir, 'routes.json'), 'utf8'));
      } catch {
        routes[dir] = null;
      }
      try {
        const o = JSON.parse(await fs.readFile(join(daemonDir, dir, 'observed-contacts.json'), 'utf8')) as { observations?: Array<Record<string, unknown>> };
        observed[dir] = o.observations ?? [];
      } catch {
        observed[dir] = null;
      }
    }
    let sessionTail: unknown[] = [];
    if (manifest) {
      try {
        const raw = await fs.readFile(join(home, 'projects', manifest.wsHash, 'chats', `${manifest.sessionId}.jsonl`), 'utf8');
        sessionTail = raw
          .trim()
          .split('\n')
          .slice(-10)
          .map((l) => {
            try {
              const r = JSON.parse(l) as Record<string, unknown>;
              const content = r.content as unknown;
              return { type: r.type, text: (typeof content === 'string' ? content : JSON.stringify(content) ?? '').slice(0, 80) };
            } catch {
              return null;
            }
          });
      } catch {
        sessionTail = ['(no pushed session file)'];
      }
    }
    return reply.send({
      binder: binderState,
      routes,
      observed,
      sessionTail,
      manifest: manifest ? { sessionId: manifest.sessionId, wsHash: manifest.wsHash, workspacePath: manifest.workspacePath } : null,
    });
  });

  // bot：绑定指定群/DM 到 session（创建 session → 停 serve → 改路由 → 重启，spec §8.2）
  // senderId/isGroup 可选：群/DM 的三段式路由 key 需要 senderId（observed 不记 group，operator 后门）
  app.post('/bind', async (req, reply) => {
    touchActivity();
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
    await rewriteRoute(qwenHome(), daemonWsHash(cwd), botName, body.chatId, sessionId, cwd, {
      ...(body.senderId ? { senderIds: [body.senderId] } : {}),
      ...(body.isGroup !== undefined ? { isGroup: body.isGroup } : {}),
    });
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
            // bot 无 /load：模型配置同样须用注入的 OPENAI_* env 覆盖，否则 qwen 落默认提供商挂起（唤醒 #2 超时事故）；
            // 钉钉侧无法回答交互式提问（permission 挂起 5 分钟静默失败，hf-0dc37c 事故），剔除 ask_user_question
            await writeCloudModelConfig(qwenHome(), { unattended: true });
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
            // 裸启动被 waker 占流等瞬态失败不污染 handoff（已加载时 lastError 会误杀 running handoff，hf-dc6913 事故）；
            // 无 handoff 时周期重试，等 waker 交棒后自愈
            const msg = e instanceof Error ? e.message : String(e);
            appendLog('err', `bot auto-start failed: ${msg}`);
            if (!state.loadedHandoffId) {
              state.lastError = msg;
              setTimeout(() => {
                if (state.loadedHandoffId || state.mode !== 'bot') return;
                appendLog('sys', 'bot auto-start retry');
                void (async () => {
                  try {
                    const retryWs = botWorkspace?.workspacePath ?? defaultWs;
                    await startServe({ mode: 'bot', workspacePath: retryWs, botName });
                    await waitServeReady('bot');
                    state.serveReady = true;
                    state.lastError = undefined;
                    appendLog('ok', 'bot serve ready (retry, dingtalk stream connected)');
                  } catch (e2) {
                    if (!state.loadedHandoffId) state.lastError = e2 instanceof Error ? e2.message : String(e2);
                  }
                })();
              }, 20_000);
            }
          }
        })();
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
