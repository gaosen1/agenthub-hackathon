/**
 * Worker（spec §5.2 F-10 语义，实现于 hub-server 内）：
 * queued → 建 Pod → provisioning → runner /load → running → 完成/超时 → packaging → snapshot → 终态 → 回收
 * 另含：崩溃恢复扫描、孤儿 Pod 清理、空闲 TTL 与硬超时。
 */
import { randomBytes } from 'node:crypto';
import type { HandoffStatus, SandboxPolicy } from '@agenthub/shared';
import type { DB } from './db.js';
import type { OssSigner } from './oss.js';
import { ossKeyOf } from './oss.js';
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

  constructor(
    private readonly db: DB,
    private readonly orchestrator: PodOrchestrator,
    private readonly connector: SandboxConnector,
    private readonly signer: OssSigner,
    private readonly cfg: WorkerConfig,
    private readonly secret: string,
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
      defaultTimeoutMinutes: 30,
      idleTtlMinutes: this.cfg.idleTtlMinutes ?? 120,
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
    } finally {
      this.ticking = false;
    }
  }

  // queued → provisioning：web 建新 Pod；bot 复用常驻 Pod
  private async handleQueued(): Promise<void> {
    for (const h of listByStatus(this.db, 'queued')) {
      if (h.kind === 'bot') {
        const bot = h.bot_id ? getBot(this.db, h.bot_id) : undefined;
        if (!bot?.pod_name) {
          setStatus(this.db, h, 'failed', 'bot sandbox not available');
          continue;
        }
        patchHandoff(this.db, h.id, { pod_name: bot.pod_name, runner_token: bot.runner_token });
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
        await this.orchestrator.createPod({
          podName,
          mode: 'web',
          env: {
            RUNNER_TOKEN: runnerToken,
            QWEN_SERVER_TOKEN: serveToken,
            HANDOFF_ID: h.id,
          },
          secretRefs: modelRefs,
          labels: { 'agenthub/kind': 'web', 'agenthub/owner': String(h.user_id), 'agenthub/handoff': h.id },
        });
        patchHandoff(this.db, h.id, { pod_name: podName, serve_token: serveToken, runner_token: runnerToken });
        setStatus(this.db, h, 'provisioning');
      } catch (e) {
        recordSandboxReclaim(this.db, podName, 'failed', 'pod-failed', `provision failed: ${msg(e)}`);
        setStatus(this.db, h, 'failed', `provision failed: ${msg(e)}`);
      }
    }
  }

  // provisioning → running：Pod 就绪后下发 /load
  private async handleProvisioning(): Promise<void> {
    for (const h of listByStatus(this.db, 'provisioning')) {
      try {
        const phase = await this.resolvePodPhase(h);
        if (phase === 'pending') continue;
        if (phase === 'failed' || phase === 'gone') {
          setStatus(this.db, h, 'failed', `pod ${phase}`);
          await this.safeDeletePod(h, 'pod-failed');
          continue;
        }
        const runner = await this.runnerOf(h);
        const inputUrl = await this.signer.signGet(h.input_oss_key ?? ossKeyOf(h.user_id, h.id, 'input.tar.gz'));
        await runner.load({
          inputUrl,
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
        await this.safeDeletePod(h, 'load-failed');
      }
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
    const idleTtlMs = (this.cfg.idleTtlMinutes ?? 120) * 60_000;
    for (const h of listByStatus(this.db, 'running')) {
      try {
        const runner = await this.runnerOf(h);
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
        // 硬超时（带 task 的 handoff）
        const runningSince = statusEnteredAt(this.db, h.id, 'running');
        if (h.task && runningSince && Date.now() - Date.parse(runningSince) > h.timeout_minutes * 60_000) {
          this.enterPackaging(h, 'expired', 'hard timeout');
          continue;
        }
        // 空闲 TTL（web 交互，无 task）
        if (h.kind === 'web' && !h.task && h.last_active_at && Date.now() - Date.parse(h.last_active_at) > idleTtlMs) {
          this.enterPackaging(h, 'expired', 'idle ttl');
          continue;
        }
      } catch {
        // runner 暂时不可达：保留状态下轮重试；Pod 消失由 recover/孤儿清理兜底
        const phase = await this.resolvePodPhase(h).catch(() => 'gone' as const);
        if (phase === 'gone' || phase === 'failed') {
          setStatus(this.db, h, 'failed', 'sandbox pod lost');
          await this.safeDeletePod(h, 'pod-lost');
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
        const { manifest } = await runner.snapshot({ outputUrl });
        patchHandoff(this.db, h.id, { output_oss_key: outputKey, result_manifest: JSON.stringify(manifest) });
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
        const phase = await this.resolvePodPhase(h).catch(() => 'gone' as const);
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
