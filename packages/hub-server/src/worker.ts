/**
 * Worker（spec §5.2 F-10 语义，实现于 hub-server 内）：
 * queued → 建 Pod → provisioning → runner /load → running → 完成/超时 → packaging → snapshot → 终态 → 回收
 * 另含：崩溃恢复扫描、孤儿 Pod 清理、空闲 TTL 与硬超时。
 */
import { randomBytes } from 'node:crypto';
import type { HandoffStatus } from '@agenthub/shared';
import type { DB } from './db.js';
import type { OssSigner } from './oss.js';
import { ossKeyOf } from './oss.js';
import type { PodOrchestrator } from './k8s.js';
import type { PodRef, SandboxConnector } from './connector.js';
import { RunnerClient } from './runner-client.js';
import {
  adoptSandbox,
  getBot,
  getHandoff,
  listByStatus,
  listOpenSandboxes,
  nowIso,
  patchHandoff,
  recordEvent,
  recordSandboxCreate,
  recordSandboxReady,
  recordSandboxReclaim,
  setStatus,
  statusEnteredAt,
  type HandoffRow,
  type ReclaimReason,
} from './store.js';

export interface WorkerConfig {
  namespace: string;
  /** sandbox 镜像，写入 sandbox 历史行的 image 列 */
  image: string;
  /** 交互 sandbox 空闲 TTL（分钟），默认 120 */
  idleTtlMinutes?: number;
  /** task 完成后长驻分钟数（spec §4.1：task 已完成的会话可长驻继续对话）；
   *  0/缺省 = 完成即打包（任务接力模式）；>0 = 留驻供 Web/钉钉继续聊，
   *  空闲超时或 pull-intent 收尾 */
  taskLingerMinutes?: number;
  webBaseUrl?: string;
}

const token = () => randomBytes(24).toString('base64url');

export class Worker {
  private timer?: NodeJS.Timeout;
  private orphanTimer?: NodeJS.Timeout;
  private ticking = false;
  /** runner 日志搬运游标（handoffId → nextAfter） */
  private readonly logCursors = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly orchestrator: PodOrchestrator,
    private readonly connector: SandboxConnector,
    private readonly signer: OssSigner,
    private readonly cfg: WorkerConfig,
  ) {}

  start(intervalMs = 5000, orphanIntervalMs = 600_000): void {
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

  private async runnerOf(h: Pick<HandoffRow, 'pod_name' | 'runner_token'>): Promise<RunnerClient> {
    const base = await this.connector.getBaseUrl(this.podRef(h.pod_name!), 8080);
    return new RunnerClient(base, h.runner_token);
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
      // 提到 try 外：catch 里要知道是哪个 pod，好把历史行关掉
      let attemptedPod: string | undefined;
      try {
        if (h.kind === 'bot') {
          const bot = h.bot_id ? getBot(this.db, h.bot_id) : undefined;
          if (!bot?.pod_name) {
            setStatus(this.db, h, 'failed', 'bot sandbox not available');
            continue;
          }
          // bot pod 的历史行在 POST /api/bots 建 Pod 时就已落库，这里只是复用，不新开一行
          patchHandoff(this.db, h.id, { pod_name: bot.pod_name, runner_token: bot.runner_token });
          setStatus(this.db, h, 'provisioning');
          continue;
        }
        const podName = `ah-web-${h.id.slice(3)}`;
        const serveToken = token();
        const runnerToken = token();
        // 先落行再建 Pod：建不出来的实例也要在面板上看得见，而不是凭空消失
        attemptedPod = podName;
        recordSandboxCreate(this.db, {
          podName,
          userId: h.user_id,
          kind: 'web',
          image: this.cfg.image,
          namespace: this.cfg.namespace,
          handoffId: h.id,
        });
        await this.orchestrator.createPod({
          podName,
          mode: 'web',
          env: {
            RUNNER_TOKEN: runnerToken,
            QWEN_SERVER_TOKEN: serveToken,
            HANDOFF_ID: h.id,
          },
          secretRefs: ['agenthub-model'],
          labels: { 'agenthub/kind': 'web', 'agenthub/owner': String(h.user_id), 'agenthub/handoff': h.id },
        });
        patchHandoff(this.db, h.id, { pod_name: podName, serve_token: serveToken, runner_token: runnerToken });
        setStatus(this.db, h, 'provisioning');
      } catch (e) {
        if (attemptedPod) recordSandboxReclaim(this.db, attemptedPod, 'failed', 'pod-failed', msg(e));
        setStatus(this.db, h, 'failed', `provision failed: ${msg(e)}`);
      }
    }
  }

  // provisioning → running：Pod 就绪后下发 /load
  private async handleProvisioning(): Promise<void> {
    for (const h of listByStatus(this.db, 'provisioning')) {
      try {
        const phase = await this.orchestrator.getPodPhase(h.pod_name!);
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
        // 执行时长从这里起算——agent 真正开始跑的时刻。
        // 只更新仍处于 provisioning 的行，所以复用的 bot pod（行已是 running）这里是 no-op。
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
        // task 完成（仅 web；bot 常驻等 pull）：缺省立即打包；配置 linger 则长驻继续对话
        if (h.kind === 'web' && h.task && health.taskDone) {
          const lingerMs = (this.cfg.taskLingerMinutes ?? 0) * 60_000;
          if (lingerMs <= 0) {
            this.enterPackaging(h, 'done');
            continue;
          }
          // 长驻窗口内按空闲计时（chat 代理每次请求刷新 last_active_at），超时正常收尾为 done
          const idleSince = h.last_active_at ?? statusEnteredAt(this.db, h.id, 'running');
          if (idleSince && Date.now() - Date.parse(idleSince) > lingerMs) {
            this.enterPackaging(h, 'done');
          }
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
        const phase = await this.orchestrator.getPodPhase(h.pod_name!).catch(() => 'gone' as const);
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
        // 回收原因由终态推导，面板要能区分正常收尾 / 失败 / 超时 / 取消
        const reason: ReclaimReason =
          target === 'failed' ? 'task-failed' : target === 'expired' ? 'expired' : target === 'cancelled' ? 'cancelled' : 'task-done';
        if (h.kind === 'web') await this.safeDeletePod(h, reason);
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

  /**
   * 重启对账：库里「开着的行」与集群实况互相校准。
   *
   * 没有这一步，hub 崩溃期间消失的 Pod 会让行永久停在 running，
   * 面板上的「运行中」与「累计执行时长」会一直虚高。
   */
  async reconcileSandboxes(): Promise<void> {
    let pods;
    try {
      pods = await this.orchestrator.listSandboxPods();
    } catch {
      // 集群暂时不可达不该拖垮恢复流程，下次重启或孤儿清理再对账
      return;
    }
    const live = new Map(pods.map((p) => [p.name, p]));
    const open = new Set<string>();
    for (const row of listOpenSandboxes(this.db)) {
      if (live.has(row.pod_name)) open.add(row.pod_name);
      else recordSandboxReclaim(this.db, row.pod_name, 'lost', 'crash-recover');
    }

    // 反向：Pod 活着但库里没有开着的行（建 Pod 后 hub 就崩了，或库被重建）
    for (const p of pods) {
      if (open.has(p.name)) continue;
      const owner = Number(p.labels['agenthub/owner']);
      // 没有可用 owner 标签的 Pod 不是我们能归属的，交给孤儿清理，别凭空编个用户
      if (!Number.isInteger(owner) || owner <= 0) continue;
      const kind = p.labels['agenthub/kind'] === 'bot' ? 'bot' : 'web';
      const botLabel = Number(p.labels['agenthub/bot']);
      const startedAt = p.startedAt ?? nowIso();
      adoptSandbox(this.db, {
        podName: p.name,
        userId: owner,
        kind,
        handoffId: p.labels['agenthub/handoff'] ?? null,
        botId: Number.isInteger(botLabel) && botLabel > 0 ? botLabel : null,
        image: this.cfg.image,
        namespace: this.cfg.namespace,
        status: p.phase === 'ready' ? 'running' : 'provisioning',
        createdAt: startedAt,
        readyAt: p.phase === 'ready' ? startedAt : null,
      });
    }
  }

  /** 崩溃恢复：启动时扫描执行态任务，不可达则 failed 并回收 */
  async recover(): Promise<void> {
    await this.reconcileSandboxes();
    for (const status of ['provisioning', 'running', 'packaging'] as const) {
      for (const h of listByStatus(this.db, status)) {
        if (!h.pod_name) {
          setStatus(this.db, h, 'failed', 'recovered: no pod ref');
          continue;
        }
        const phase = await this.orchestrator.getPodPhase(h.pod_name).catch(() => 'gone' as const);
        if (phase === 'gone' || phase === 'failed') {
          setStatus(this.db, h, 'failed', 'recovered: pod lost');
          await this.safeDeletePod(h, 'crash-recover');
        }
        // ready/pending 的留给正常 tick 继续推进
      }
    }
  }

  /** 孤儿 Pod 清理：带 sandbox 标签但无活跃 handoff/bot 引用的一律删除 */
  async cleanupOrphans(): Promise<void> {
    const pods = await this.orchestrator.listSandboxPods();
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
      if (!active.has(pod.name)) {
        recordSandboxReclaim(this.db, pod.name, 'reclaimed', 'orphan');
        await this.orchestrator.deletePod(pod.name).catch(() => undefined);
      }
    }
  }

  /** reason → 历史行终态。异常丢失与正常收尾在面板上要能区分开。 */
  private static reclaimStatus(reason: ReclaimReason): 'reclaimed' | 'failed' | 'lost' {
    if (reason === 'pod-failed' || reason === 'load-failed') return 'failed';
    if (reason === 'pod-lost' || reason === 'crash-recover') return 'lost';
    return 'reclaimed';
  }

  /**
   * web pod 回收的唯一咽喉点——顺带关掉 sandbox 历史行。
   * bot pod 常驻、不走这里，它的历史行由 DELETE /api/bots/:id 关闭。
   */
  private async safeDeletePod(h: HandoffRow, reason: ReclaimReason): Promise<void> {
    if (h.kind !== 'web' || !h.pod_name) return;
    recordSandboxReclaim(this.db, h.pod_name, Worker.reclaimStatus(reason), reason);
    await this.connector.dispose(this.podRef(h.pod_name)).catch(() => undefined);
    await this.orchestrator.deletePod(h.pod_name).catch(() => undefined);
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
