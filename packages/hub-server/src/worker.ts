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
  getBot,
  getHandoff,
  listByStatus,
  nowIso,
  patchHandoff,
  recordEvent,
  setStatus,
  statusEnteredAt,
  type HandoffRow,
} from './store.js';

export interface WorkerConfig {
  namespace: string;
  /** 交互 sandbox 空闲 TTL（分钟），默认 120 */
  idleTtlMinutes?: number;
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
      try {
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
          await this.safeDeletePod(h);
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
        recordEvent(this.db, h.id, 'log', JSON.stringify({ t: nowIso(), tag: 'sys', c: 'sandbox loaded, agent running' }));
      } catch (e) {
        setStatus(this.db, h, 'failed', `load failed: ${msg(e)}`);
        await this.safeDeletePod(h);
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
        const phase = await this.orchestrator.getPodPhase(h.pod_name!).catch(() => 'gone' as const);
        if (phase === 'gone' || phase === 'failed') {
          setStatus(this.db, h, 'failed', 'sandbox pod lost');
          await this.safeDeletePod(h);
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
        if (h.kind === 'web') await this.safeDeletePod(h);
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

  /** 崩溃恢复：启动时扫描执行态任务，不可达则 failed 并回收 */
  async recover(): Promise<void> {
    for (const status of ['provisioning', 'running', 'packaging'] as const) {
      for (const h of listByStatus(this.db, status)) {
        if (!h.pod_name) {
          setStatus(this.db, h, 'failed', 'recovered: no pod ref');
          continue;
        }
        const phase = await this.orchestrator.getPodPhase(h.pod_name).catch(() => 'gone' as const);
        if (phase === 'gone' || phase === 'failed') {
          setStatus(this.db, h, 'failed', 'recovered: pod lost');
          await this.safeDeletePod(h);
        }
        // ready/pending 的留给正常 tick 继续推进
      }
    }
  }

  /** 孤儿 Pod 清理：带 sandbox 标签但无活跃 handoff/bot 引用的一律删除 */
  async cleanupOrphans(): Promise<void> {
    const pods = await this.orchestrator.listSandboxPodNames();
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

  private async safeDeletePod(h: HandoffRow): Promise<void> {
    if (h.kind !== 'web' || !h.pod_name) return;
    await this.connector.dispose(this.podRef(h.pod_name)).catch(() => undefined);
    await this.orchestrator.deletePod(h.pod_name).catch(() => undefined);
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
