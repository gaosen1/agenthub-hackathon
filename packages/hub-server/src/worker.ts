/**
 * Worker（spec §5.2 F-10 语义，实现于 hub-server 内）：
 * queued → 建 Pod → provisioning → runner /load → running → 完成/超时 → packaging → snapshot → 终态 → 回收
 * 另含：崩溃恢复扫描、孤儿 Pod 清理、空闲 TTL 与硬超时。
 */
import { randomBytes } from 'node:crypto';
import type { HandoffStatus, SandboxPolicy } from '@agenthub/shared';
import type { DB } from './db.js';
import type { OssSigner, OssClient } from './oss.js';
import { ossKeyOf, asOssClient, depsCacheKeyOf, depsSidecarKeyOf, warmBundleKeyOf, warmSidecarKeyOf } from './oss.js';
import { sandboxImage, type PodOrchestrator, type PodPhase, type SandboxPodInfo } from './k8s.js';
import type { PodRef, SandboxConnector } from './connector.js';
import { RunnerClient } from './runner-client.js';
import {
  adoptSandbox,
  getBot,
  getHandoff,
  getUserModelConfig,
  listByStatus,
  nowIso,
  patchHandoff,
  recordEvent,
  recordSandboxCreate,
  recordSandboxReady,
  recordSandboxReclaim,
  reclaimStatus,
  setStatus,
  statusEnteredAt,
  type HandoffRow,
  type ReclaimReason,
  type SandboxRow,
} from './store.js';
import { userModelSecret } from './db.js';
import { decryptSecret } from './crypto.js';
import type { Notifier } from './notifier.js';

export interface WorkerConfig {
  namespace: string;
  /** 交互 sandbox 空闲 TTL（分钟），默认 120 */
  idleTtlMinutes?: number;
  webBaseUrl?: string;
  /** 建 Pod 镜像（缺省 SANDBOX_IMAGE / 默认镜像），仅用于历史行展示 */
  image?: string;
}

export const DEFAULT_WORKER_INTERVAL_MS = 5000;
export const DEFAULT_ORPHAN_INTERVAL_MS = 600_000;

const token = () => randomBytes(24).toString('base64url');

export class Worker {
  private timer?: NodeJS.Timeout;
  private orphanTimer?: NodeJS.Timeout;
  private ticking = false;
  private workerIntervalMs = DEFAULT_WORKER_INTERVAL_MS;
  private orphanIntervalMs = DEFAULT_ORPHAN_INTERVAL_MS;
  /** runner 日志搬运游标（handoffId → nextAfter） */
  private readonly logCursors = new Map<string, number>();
  /** provision 瞬断重试计数（EBADF 等间歇网络错误不一次判死，与 hf-f4da72 同策略） */
  private readonly provisionRetries = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly orchestrator: PodOrchestrator,
    private readonly connector: SandboxConnector,
    private readonly signer: OssSigner,
    private readonly cfg: WorkerConfig,
    private readonly secret: string,
    private readonly notifier?: Notifier,
  ) {}

  start(intervalMs = DEFAULT_WORKER_INTERVAL_MS, orphanIntervalMs = DEFAULT_ORPHAN_INTERVAL_MS): void {
    this.workerIntervalMs = intervalMs;
    this.orphanIntervalMs = orphanIntervalMs;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    this.orphanTimer = setInterval(() => void this.cleanupOrphans().catch(() => undefined), orphanIntervalMs);
    this.orphanTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.orphanTimer) clearInterval(this.orphanTimer);
  }

  private podRef(podName: string): PodRef {
    return { namespace: this.cfg.namespace, podName };
  }

  private get image(): string {
    return this.cfg.image ?? sandboxImage();
  }

  /** 面板策略卡（S9）：真实配置，不是前端重述文案 */
  policy(): SandboxPolicy {
    return {
      defaultTimeoutMinutes: 1440,
      idleTtlMinutes: this.cfg.idleTtlMinutes ?? 30,
      taskLingerMinutes: Number(process.env.TASK_LINGER_MINUTES ?? 30),
      orphanIntervalMs: this.orphanIntervalMs,
      workerIntervalMs: this.workerIntervalMs,
    };
  }

  private async runnerOf(h: Pick<HandoffRow, 'kind' | 'bot_id' | 'pod_name' | 'runner_token'>): Promise<RunnerClient> {
    const podName = await this.resolvePodName(h);
    const base = await this.connector.getBaseUrl(this.podRef(podName), 8080);
    return new RunnerClient(base, h.runner_token);
  }

  /** bot 模式：Deployment 重建后 Pod 名变化，用 label 动态查找；web 模式直接用 pod_name */
  private async resolvePodName(h: Pick<HandoffRow, 'kind' | 'bot_id' | 'pod_name'>): Promise<string> {
    if (h.kind === 'bot' && h.bot_id) {
      const resolved = await this.orchestrator.findPodNameByLabel({ 'agenthub/bot': String(h.bot_id) });
      if (resolved) return resolved;
    }
    return h.pod_name!;
  }

  /** bot 模式用 label 查找实际 Pod phase；web 模式直接查 pod_name */
  private async resolvePodPhase(h: Pick<HandoffRow, 'kind' | 'bot_id' | 'pod_name'>): Promise<PodPhase> {
    if (h.kind === 'bot' && h.bot_id) {
      const actualPod = await this.orchestrator.findPodNameByLabel({ 'agenthub/bot': String(h.bot_id) });
      return actualPod ? await this.orchestrator.getPodPhase(actualPod) : 'gone';
    }
    return this.orchestrator.getPodPhase(h.pod_name!);
  }

  /** 确保 per-user 模型凭证 Secret 存在；用户未配则回退共享 agenthub-model */
  private async ensureModelSecret(uid: number): Promise<string[]> {
    const mc = getUserModelConfig(this.db, uid);
    if (mc?.model_api_key_enc) {
      const secName = userModelSecret(uid);
      const apiKey = decryptSecret(mc.model_api_key_enc, this.secret);
      await this.orchestrator.createSecret(secName, {
        OPENAI_API_KEY: apiKey,
        DASHSCOPE_API_KEY: apiKey,
        ...(mc.model_base_url ? { OPENAI_BASE_URL: mc.model_base_url } : {}),
        ...(mc.model_name ? { OPENAI_MODEL: mc.model_name } : {}),
      });
      return [secName];
    }
    return ['agenthub-model'];
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.handleQueued();
      await this.handleProvisioning();
      await this.handleRunning();
      await this.handlePackaging();
      // S18：状态变更通知单点驱动，失败不影响主流程
      await this.notifier?.notifyPending().catch(() => undefined);
    } finally {
      this.ticking = false;
    }
  }

  /** bot 沙箱 provision：创建路由 / push 接力自动唤醒 / 看门人唤醒 三路共用；成功落 running 并返回实际实例名。
   * 单飞 + 存活复用：并发唤醒（worker queued 路径与 waker 消息路径）会建出双沙箱、
   * token 被后写者覆盖 → 先醒者 /load 401（hf-0fc25f 事故）；实例还活着时直接复用。 */
  private waking = new Map<number, Promise<string>>();
  async wakeBot(botId: number): Promise<string> {
    const inflight = this.waking.get(botId);
    if (inflight) return inflight;
    const p = this.doWakeBot(botId).finally(() => this.waking.delete(botId));
    this.waking.set(botId, p);
    return p;
  }

  private async doWakeBot(botId: number): Promise<string> {
    const b = getBot(this.db, botId);
    if (!b) throw new Error(`bot ${botId} not found`);
    if (b.pod_name) {
      // 查询失败按 pending 保守处理：瞬断时误判 failed 会先删活实例再重建（双沙箱互抢 stream）
      const phase = await this.orchestrator.getPodPhase(b.pod_name).catch(() => 'pending' as PodPhase);
      if (phase === 'ready' || phase === 'pending') return b.pod_name;
      // 死实例先清再建：不清会累积孤儿沙箱，同 clientId 互抢钉钉 stream
      // （多沙箱抢流事故：DM 落旧沙箱回旧上下文、新沙箱收不到群消息）
      await this.orchestrator.deleteDeployment(b.pod_name).catch(() => undefined);
    }
    const slug = b.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
    const deployName = `ah-bot-${botId}-${slug}`;
    const runnerToken = token();
    // serve token：bot serve 以 --allow-origin '*' 承载 Web Shell，qwen 要求配 bearer token；
    // 随 Deployment env 注入，handoff 下发时复用同一 token 拼 #token=
    const serveToken = token();
    // 先落历史行再建 Pod：建不出来的实例也要在面板上看得见（S6）
    recordSandboxCreate(this.db, { podName: deployName, userId: b.user_id, kind: 'bot', image: this.image, namespace: this.cfg.namespace, botId });
    const modelRefs = await this.ensureModelSecret(b.user_id);
    await this.orchestrator.createSecret(`bot-${botId}`, {
      DINGTALK_CLIENT_ID: b.client_id,
      DINGTALK_CLIENT_SECRET: decryptSecret(b.client_secret_enc, this.secret),
    });
    // 外置快照：PUT 7d 有效（覆盖 24h TTL 内的周期回写），GET 随 provision 即用默认 TTL
    const snapEnv: Record<string, string> = {};
    if (asOssClient(this.signer)?.configured) {
      // key 跟 uid+name slug（不跟行 id）：DELETE+POST 重建后仍能续上旧快照
      const snapKey = `bots/${b.user_id}/${slug}/snapshot.tar.gz`;
      snapEnv.BOT_SNAPSHOT_PUT_URL = await this.signer.signPut(snapKey, 7 * 86_400);
      snapEnv.BOT_SNAPSHOT_GET_URL = await this.signer.signGet(snapKey);
    }
    const logPut = await this.logPutUrlFor(deployName);
    if (logPut) snapEnv.RUNNER_LOG_PUT_URL = logPut;
    // bot 用 Deployment（非 raw Pod）：ACS 驱逐后自动重建；Aone 后端返回 sandboxId
    const actualDeploy = await this.orchestrator.createDeployment({
      podName: deployName,
      mode: 'bot',
      env: { RUNNER_TOKEN: runnerToken, QWEN_SERVER_TOKEN: serveToken, BOT_NAME: b.name, ...snapEnv },
      secretRefs: [...modelRefs, `bot-${botId}`],
      labels: { 'agenthub/kind': 'bot', 'agenthub/owner': String(b.user_id), 'agenthub/bot': String(botId) },
    });
    this.db.prepare("UPDATE bots SET pod_name=?, runner_token=?, serve_token=?, status='running' WHERE id=?").run(actualDeploy, runnerToken, serveToken, botId);
    recordSandboxReady(this.db, actualDeploy);
    return actualDeploy;
  }

  // queued → provisioning：web 建新 Pod；bot 复用常驻 Pod（死了自动唤醒）
  private async handleQueued(): Promise<void> {
    for (const h of listByStatus(this.db, 'queued')) {
      if (h.kind === 'bot') {
        const bot = h.bot_id ? getBot(this.db, h.bot_id) : undefined;
        if (!bot) {
          setStatus(this.db, h, 'failed', 'bot not found');
          continue;
        }
        const actual = await this.orchestrator.findPodNameByLabel({ 'agenthub/bot': String(bot.id) }).catch(() => undefined);
        const phase: PodPhase = actual ? await this.orchestrator.getPodPhase(actual).catch(() => 'failed') : 'gone';
        if (phase !== 'ready') {
          // push --bot 自动唤醒：沙箱死/过期直接拉新的，用户无需先发消息唤醒
          const n = this.provisionRetries.get(h.id) ?? 0;
          try {
            await this.wakeBot(bot.id);
            this.provisionRetries.delete(h.id);
          } catch (e) {
            if (n + 1 > 3) {
              this.provisionRetries.delete(h.id);
              setStatus(this.db, h, 'failed', `bot wake failed: ${e instanceof Error ? e.message : String(e)}`);
            } else {
              this.provisionRetries.set(h.id, n + 1);
            }
          }
          continue; // 留在 queued，唤醒成功后下轮发 /load
        }
        patchHandoff(this.db, h.id, { pod_name: actual, runner_token: bot.runner_token, serve_token: bot.serve_token });
        setStatus(this.db, h, 'provisioning');
        continue;
      }
      const podName = `ah-web-${h.id.slice(3)}`;
      const serveToken = token();
      const runnerToken = token();
      // 先落历史行再建 Pod：建不出来的实例也要在面板上看得见（S6）
      recordSandboxCreate(this.db, {
        podName,
        userId: h.user_id,
        kind: 'web',
        image: this.image,
        namespace: this.cfg.namespace,
        handoffId: h.id,
      });
      try {
        const modelRefs = await this.ensureModelSecret(h.user_id);
        const logPut = await this.logPutUrlFor(podName);
        const actualPod = await this.orchestrator.createPod({
          podName,
          mode: 'web',
          env: {
            RUNNER_TOKEN: runnerToken,
            QWEN_SERVER_TOKEN: serveToken,
            HANDOFF_ID: h.id,
            ...(logPut ? { RUNNER_LOG_PUT_URL: logPut } : {}),
            // 不注入 AGENTHUB_WEB_ORIGIN：iframe 文档源随后端变化（Aone 每沙箱子域 / port-forward），
            // 无法枚举；runner 侧 serve --allow-origin 默认 '*'（配 QWEN_SERVER_TOKEN，qwen serve 强制要求）
          },
          secretRefs: modelRefs,
          labels: { 'agenthub/kind': 'web', 'agenthub/owner': String(h.user_id), 'agenthub/handoff': h.id },
        });
        patchHandoff(this.db, h.id, { pod_name: actualPod, serve_token: serveToken, runner_token: runnerToken });
        this.provisionRetries.delete(h.id);
        setStatus(this.db, h, 'provisioning');
      } catch (e) {
        // 间歇网络错误（本机 node 对 API server 偶发 EBADF）：保留 queued 下轮重试，上限 5 次
        const m = msg(e);
        const transient = /EBADF|ECONN|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EAI_AGAIN|socket hang up/i.test(m);
        const n = (this.provisionRetries.get(h.id) ?? 0) + 1;
        if (transient && n <= 5) {
          this.provisionRetries.set(h.id, n);
          recordEvent(this.db, h.id, 'log', JSON.stringify({ t: nowIso(), tag: 'sys', c: `provision transient error (${n}/5), retrying: ${m.slice(0, 120)}` }));
          continue;
        }
        this.provisionRetries.delete(h.id);
        recordSandboxReclaim(this.db, podName, 'failed', 'pod-failed', `provision failed: ${m}`);
        setStatus(this.db, h, 'failed', `provision failed: ${m}`);
      }
    }
  }

  // provisioning → running：Pod 就绪后下发 /load
  private async handleProvisioning(): Promise<void> {
    for (const h of listByStatus(this.db, 'provisioning')) {
      try {
        const phase = await this.resolvePodPhase(h).catch(() => 'pending' as const);
        if (phase === 'pending') continue;
        if (phase === 'failed' || phase === 'gone') {
          // bot 的 Pod 是共享常驻沙箱：瞬态 gone 重试，且任何失败都不随 handoff 删 Pod（否则级联打死其他 handoff）
          if (h.kind === 'bot') {
            const n = this.provisionRetries.get(h.id) ?? 0;
            if (n + 1 <= 3) {
              this.provisionRetries.set(h.id, n + 1);
              recordEvent(this.db, h.id, 'log', JSON.stringify({ t: nowIso(), tag: 'sys', c: `bot pod ${phase} (${n + 1}/3), retrying` }));
              continue;
            }
            this.provisionRetries.delete(h.id);
          }
          setStatus(this.db, h, 'failed', `pod ${phase}`);
          if (h.kind !== 'bot') await this.safeDeletePod(h, 'pod-failed');
          void this.mergeArchivedLogs(h);
          continue;
        }
        const runner = await this.runnerOf(h);
        const inputUrl = await this.signer.signGet(h.input_oss_key ?? ossKeyOf(h.user_id, h.id, 'input.tar.gz'));
        // S19 依赖缓存：sidecar lockHash 与本次 push 匹配才下发缓存 GET URL，否则照旧重装
        let depsCacheUrl: string | undefined;
        const ossForDeps = asOssClient(this.signer);
        if (ossForDeps?.configured && h.deps_lock_hash) {
          const meta = await ossForDeps
            .get(depsSidecarKeyOf(h.user_id, h.ws_hash))
            .then((b) => (b ? (JSON.parse(b.toString('utf8')) as { lockHash?: string }) : null))
            .catch(() => null);
          if (meta?.lockHash === h.deps_lock_hash) {
            depsCacheUrl = await this.signer.signGet(depsCacheKeyOf(h.user_id, h.ws_hash));
          }
        }
        await runner.load({
          inputUrl,
          ...(depsCacheUrl ? { depsCacheUrl } : {}),
          // S20：delta 模式下发 warm 全量 bundle URL（集群内下载）
          ...(h.bundle_mode === 'delta' && ossForDeps?.configured
            ? { warmBundleUrl: await this.signer.signGet(warmBundleKeyOf(h.user_id, h.ws_hash)) }
            : {}),
          ...(h.task ? { task: h.task } : {}),
          ...(h.bind_chat_id ? { bindChatId: h.bind_chat_id } : {}),
          ...(h.serve_token ? { serveToken: h.serve_token } : {}),
        });
        if (h.kind === 'bot' && h.bot_id) {
          this.db.prepare('UPDATE bots SET current_handoff_id=? WHERE id=?').run(h.id, h.bot_id);
        }
        patchHandoff(this.db, h.id, { last_active_at: nowIso() });
        setStatus(this.db, h, 'running');
        recordSandboxReady(this.db, h.pod_name!);
        recordEvent(this.db, h.id, 'log', JSON.stringify({ t: nowIso(), tag: 'sys', c: 'sandbox loaded, agent running' }));
      } catch (e) {
        setStatus(this.db, h, 'failed', `load failed: ${msg(e)}`);
        // bot 共享沙箱不随 handoff 回收
        if (h.kind !== 'bot') await this.safeDeletePod(h, 'load-failed');
        void this.mergeArchivedLogs(h);
      }
    }
  }

  /** runner 日志归档 URL（7d PUT，key 跟 Pod 名）；OSS 未配置返回 undefined */
  private async logPutUrlFor(podName: string): Promise<string | undefined> {
    if (!asOssClient(this.signer)?.configured) return undefined;
    return this.signer.signPut(`logs/${podName}.jsonl`, 7 * 86_400).catch(() => undefined);
  }

  /** 沙箱死后从 OSS 归档补取 runner 日志进事件流（每 handoff 仅一次） */
  private readonly archivedMerged = new Set<string>();
  private async mergeArchivedLogs(h: HandoffRow): Promise<void> {
    if (!h.pod_name || this.archivedMerged.has(h.id)) return;
    this.archivedMerged.add(h.id);
    try {
      const url = await this.signer.signGet(`logs/${h.pod_name}.jsonl`);
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const items = (await r.text())
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { i?: number });
      const after = this.logCursors.get(h.id) ?? 0;
      for (const e of items) {
        if ((e.i ?? 0) >= after) recordEvent(this.db, h.id, 'log', JSON.stringify(e));
      }
      if (items.length > 0) this.logCursors.set(h.id, Math.max(after, (items[items.length - 1]?.i ?? 0) + 1));
    } catch {
      // 无归档（旧镜像/未配置）放弃
    }
  }

  /** 搬运 runner 结构化日志到 handoff_events（spec §4.3 GET /logs） */
  private async relayLogs(h: HandoffRow, runner: RunnerClient): Promise<void> {
    try {
      const after = this.logCursors.get(h.id) ?? 0;
      const { items, nextAfter } = await runner.logs(after);
      for (const e of items) {
        recordEvent(this.db, h.id, 'log', JSON.stringify(e));
      }
      this.logCursors.set(h.id, nextAfter);
    } catch {
      // 日志搬运失败不影响主流程，下轮重试
    }
  }

  // running：搬运日志、检测 task 完成 / 硬超时 / 空闲 TTL
  private async handleRunning(): Promise<void> {
    const idleTtlMs = (this.cfg.idleTtlMinutes ?? 30) * 60_000;
    for (const h of listByStatus(this.db, 'running')) {
      let runner: RunnerClient | undefined;
      try {
        runner = await this.runnerOf(h);
        const health = await runner.healthz();
        await this.relayLogs(h, runner);
        if (health.lastError) {
          this.enterPackaging(h, 'failed', health.lastError);
          continue;
        }
        // task 完成 → 正常打包（仅 web；bot 常驻等 pull）
        if (h.kind === 'web' && h.task && health.taskDone) {
          this.enterPackaging(h, 'done');
          continue;
        }
        // 硬超时只约束任务执行期：taskDone 后时钟停摆（bot 转驻留交互）。
        // 旧逻辑以进 running 起算一刀切，任务完成后的群聊追问在 deadline 被连坐砍断（hf-0dc37c 事故）
        const runningSince = statusEnteredAt(this.db, h.id, 'running');
        const runningSinceMs = runningSince ? Date.parse(runningSince) : undefined;
        // timeoutMinutes 语义＝最长静默容忍，不是任务寿命上限：以「进 running 与最近活动的较晚者」起算，
        // 活跃任务（含 24h+ 夜间长任务）持续续命永不撞墙钟；阈值只在无产出静默时充当卡死检测。
        // 容忍度设得宽是因为长静默操作（大型构建/依赖安装）合法；老 runner 不上报活跃度时退化为纯墙钟
        const actMs = health.lastActivityAt ? Date.parse(health.lastActivityAt) : NaN;
        const actSafe = Number.isFinite(actMs) ? Math.min(actMs, Date.now()) : 0;
        if (h.task && !health.taskDone && runningSinceMs) {
          const basis = Math.max(runningSinceMs, actSafe);
          if (Date.now() - basis > h.timeout_minutes * 60_000) {
            this.enterPackaging(h, 'expired', 'hard timeout');
            continue;
          }
        }
        // 空闲 TTL（web 交互，无 task）
        if (h.kind === 'web' && !h.task && h.last_active_at && Date.now() - Date.parse(h.last_active_at) > idleTtlMs) {
          this.enterPackaging(h, 'expired', 'idle ttl');
          continue;
        }
        // bot 驻留期（含 task 完成后）：钉钉消息直达 daemon，hub 看不见，活跃度由 runner healthz 上报
        // （控制面打点 ∨ session jsonl mtime）；活跃即续命，进行中的轮次不会被误杀
        if (h.kind === 'bot') {
          const basis = actSafe > 0 ? Math.max(actSafe, runningSinceMs ?? 0) : runningSinceMs;
          if (basis && Date.now() - basis > idleTtlMs) {
            this.enterPackaging(h, 'expired', 'idle ttl');
            continue;
          }
        }
      } catch {
        // runner 不可达：先区分「瞬断」与「确失」——
        // phase 查询报错（网络抖动/API 故障）时保留状态下轮重试，绝不兜底成 gone，
        // 避免把成功任务误判 failed（hf-f4da72 事故）；判死前先尽力补 relay 日志。
        const phase = await this.resolvePodPhase(h).catch(() => undefined);
        if (phase === undefined) continue;
        if (phase === 'gone' || phase === 'failed') {
          if (runner) await this.relayLogs(h, runner).catch(() => undefined);
          setStatus(this.db, h, 'failed', 'sandbox pod lost');
          await this.safeDeletePod(h, 'pod-lost');
          void this.mergeArchivedLogs(h);
        }
      }
    }
  }

  private enterPackaging(h: HandoffRow, target: HandoffStatus, error?: string): void {
    patchHandoff(this.db, h.id, { terminal_target: target });
    setStatus(this.db, h, 'packaging', error);
  }

  // packaging → snapshot 上传 → 终态 →（web）回收 Pod
  private async handlePackaging(): Promise<void> {
    for (const h of listByStatus(this.db, 'packaging')) {
      const target = (h.terminal_target ?? 'done') as HandoffStatus;
      try {
        const runner = await this.runnerOf(h);
        await this.relayLogs(h, runner);
        const outputKey = ossKeyOf(h.user_id, h.id, 'output.tar.gz');
        const outputUrl = await this.signer.signPut(outputKey);
        // S19 依赖缓存：签发快照/sidecar PUT URL，runner 侧决定是否真传
        const oss = asOssClient(this.signer);
        const depsPut = oss?.configured ? await this.signer.signPut(depsCacheKeyOf(h.user_id, h.ws_hash)) : undefined;
        const sidecarPut = oss?.configured ? await this.signer.signPut(depsSidecarKeyOf(h.user_id, h.ws_hash)) : undefined;
        const warmPut = oss?.configured ? await this.signer.signPut(warmBundleKeyOf(h.user_id, h.ws_hash)) : undefined;
        const warmSidecarPut = oss?.configured ? await this.signer.signPut(warmSidecarKeyOf(h.user_id, h.ws_hash)) : undefined;
        const { manifest } = await runner.snapshot({
          outputUrl,
          ...(depsPut && sidecarPut ? { depsCachePutUrl: depsPut, depsSidecarPutUrl: sidecarPut } : {}),
          ...(warmPut && warmSidecarPut ? { warmBundlePutUrl: warmPut, warmSidecarPutUrl: warmSidecarPut } : {}),
        });
        patchHandoff(this.db, h.id, { output_oss_key: outputKey, result_manifest: JSON.stringify(manifest) });
        // snapshot 阶段的 runner 日志（deps/warm 上传成败）补搬运，否则 Pod 回收后永远看不到
        await this.relayLogs(h, runner).catch(() => undefined);
        // S12：真相时刻 head 一次落 output size；失败不致命
        if (oss?.configured) {
          await oss
            .head(outputKey)
            .then((o) => {
              if (o) patchHandoff(this.db, h.id, { output_size: o.size, output_uploaded_at: o.lastModified });
            })
            .catch(() => undefined);
        }
        setStatus(this.db, h, target === 'failed' ? 'failed' : target);
      } catch (e) {
        setStatus(this.db, h, 'failed', `snapshot failed: ${msg(e)}`);
      } finally {
        this.logCursors.delete(h.id);
        if (h.kind === 'web') await this.safeDeletePod(h, reasonOfTarget(target));
        else if (h.bot_id) this.db.prepare('UPDATE bots SET current_handoff_id=NULL WHERE id=? AND current_handoff_id=?').run(h.bot_id, h.id);
      }
    }
  }

  /** 触发交互式 handoff 的收尾打包（pull-intent 调用），返回是否已发起 */
  requestPackaging(id: string): boolean {
    const h = getHandoff(this.db, id);
    if (!h || h.status !== 'running') return false;
    this.enterPackaging(h, 'done');
    return true;
  }

  /** 崩溃恢复：启动时先对账 sandbox 历史（S8），再扫描执行态任务，不可达则 failed 并回收 */
  async recover(): Promise<void> {
    await this.reconcileSandboxes();
    for (const status of ['provisioning', 'running', 'packaging'] as const) {
      for (const h of listByStatus(this.db, status)) {
        if (!h.pod_name) {
          setStatus(this.db, h, 'failed', 'recovered: no pod ref');
          continue;
        }
        // 集群瞬断时 resolvePodPhase 抛错：保留状态，交给后续 tick/重启再判定
        const phase = await this.resolvePodPhase(h).catch(() => undefined);
        if (phase === undefined) continue;
        if (phase === 'gone' || phase === 'failed') {
          setStatus(this.db, h, 'failed', 'recovered: pod lost');
          await this.safeDeletePod(h, 'crash-recover');
        }
        // ready/pending 的留给正常 tick 继续推进
      }
    }
  }

  /** 重启对账（S8）：开着的行但 Pod 没了 → lost；Pod 活着但没有开着的行 → 按标签收养。集群不可达静默返回 */
  async reconcileSandboxes(): Promise<void> {
    let pods: SandboxPodInfo[];
    try {
      pods = await this.orchestrator.listSandboxPods();
    } catch {
      return;
    }
    const alive = new Map(pods.map((p) => [p.name, p]));
    for (const row of this.db.prepare("SELECT * FROM sandboxes WHERE status IN ('provisioning','running')").all() as SandboxRow[]) {
      if (!alive.has(row.pod_name)) recordSandboxReclaim(this.db, row.pod_name, 'lost', 'crash-recover');
    }
    for (const p of pods) {
      const owner = Number(p.labels['agenthub/owner']);
      // 不凭空编造归属：owner 标签缺失或非正整数跳过，交给孤儿清理
      if (!Number.isInteger(owner) || owner <= 0) continue;
      const open = this.db
        .prepare("SELECT 1 FROM sandboxes WHERE pod_name=? AND status IN ('provisioning','running')")
        .get(p.name);
      if (open) continue;
      const botRaw = p.labels['agenthub/bot'];
      adoptSandbox(this.db, {
        podName: p.name,
        userId: owner,
        kind: p.labels['agenthub/kind'] === 'bot' ? 'bot' : 'web',
        image: this.image,
        namespace: this.cfg.namespace,
        handoffId: p.labels['agenthub/handoff'] ?? null,
        botId: botRaw !== undefined && Number.isInteger(Number(botRaw)) ? Number(botRaw) : null,
        startedAt: p.startedAt,
        running: p.phase === 'ready',
      });
    }
  }

  /** 孤儿 Pod 清理：带 sandbox 标签但无活跃 handoff/bot 引用的一律删除 */
  async cleanupOrphans(): Promise<void> {
    const pods = (await this.orchestrator.listSandboxPods()).map((p) => p.name);
    const active = new Set<string>();
    for (const row of this.db
      .prepare("SELECT pod_name FROM handoffs WHERE pod_name IS NOT NULL AND status IN ('provisioning','running','packaging')")
      .all() as Array<{ pod_name: string }>) {
      active.add(row.pod_name);
    }
    for (const row of this.db.prepare("SELECT pod_name FROM bots WHERE pod_name IS NOT NULL AND status != 'deleted'").all() as Array<{
      pod_name: string;
    }>) {
      active.add(row.pod_name);
    }
    for (const pod of pods) {
      if (!active.has(pod)) {
        await this.orchestrator.deletePod(pod).catch(() => undefined);
      }
    }
  }

  /** web pod 回收的唯一咽喉点（S6）：reason 必传，在这里写 ended_at + duration_seconds */
  private async safeDeletePod(h: HandoffRow, reason: ReclaimReason): Promise<void> {
    if (h.kind !== 'web' || !h.pod_name) return;
    await this.connector.dispose(this.podRef(h.pod_name)).catch(() => undefined);
    await this.orchestrator.deletePod(h.pod_name).catch(() => undefined);
    recordSandboxReclaim(this.db, h.pod_name, reclaimStatus(reason), reason, h.error ?? undefined);
  }
}

/** 终态 target → 回收原因（S6） */
const reasonOfTarget = (target: HandoffStatus): ReclaimReason =>
  target === 'failed' ? 'task-failed' : target === 'expired' ? 'expired' : target === 'cancelled' ? 'cancelled' : 'task-done';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
