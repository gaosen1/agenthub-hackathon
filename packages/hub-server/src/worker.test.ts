/**
 * Worker 调度测试（spec §7 D2–D3）：全链路推进 / 硬超时 / 孤儿回收 / 崩溃恢复
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from './db.js';
import type { OssSigner } from './oss.js';
import type { PodOrchestrator, PodPhase, SandboxPodSpec } from './k8s.js';
import type { PodRef, SandboxConnector } from './connector.js';
import { Worker } from './worker.js';
import { getHandoff, nowIso, recordEvent } from './store.js';

// ── fakes ────────────────────────────────────────────────
class FakeOrchestrator implements PodOrchestrator {
  pods = new Map<string, PodPhase>();
  secrets = new Map<string, Record<string, string>>();
  created: SandboxPodSpec[] = [];
  /** 模拟集群 API 故障：getPodPhase 抛错（hf-f4da72 事故的回归开关） */
  phaseError = false;
  async createPod(spec: SandboxPodSpec) {
    this.created.push(spec);
    this.pods.set(spec.podName, 'ready');
    return spec.podName;
  }
  async deletePod(name: string) {
    this.pods.delete(name);
  }
  async getPodPhase(name: string): Promise<PodPhase> {
    if (this.phaseError) throw new Error('api server unreachable');
    return this.pods.get(name) ?? 'gone';
  }
  async listSandboxPods() {
    return [...this.pods.entries()].map(([name, phase]) => ({ name, phase, labels: {} }));
  }
  async createSecret(name: string, data: Record<string, string>) {
    this.secrets.set(name, data);
  }
  async deleteSecret(name: string) {
    this.secrets.delete(name);
  }
  async createDeployment(spec: SandboxPodSpec) {
    this.created.push(spec);
    this.pods.set(spec.podName, 'ready');
    return spec.podName;
  }
  async deleteDeployment(name: string) {
    this.pods.delete(name);
  }
  async findPodNameByLabel(_labels: Record<string, string>): Promise<string | undefined> {
    return undefined;
  }
}

interface FakeRunnerState {
  loads: unknown[];
  snapshots: unknown[];
  taskDone: boolean;
  lastError?: string;
  /** 沙箱上报的最近活动时间（bot 驻留期空闲 TTL 判据） */
  lastActivityAt?: string;
  logs: Array<{ t: string; tag: string; c: string }>;
}

function startFakeRunner(): Promise<{ url: string; state: FakeRunnerState; server: Server }> {
  const state: FakeRunnerState = { loads: [], snapshots: [], taskDone: false, logs: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/healthz')
        return send(200, { ok: true, mode: 'web', serveReady: true, taskDone: state.taskDone, ...(state.lastError ? { lastError: state.lastError } : {}), ...(state.lastActivityAt ? { lastActivityAt: state.lastActivityAt } : {}) });
      if (req.url === '/load') {
        state.loads.push(JSON.parse(body || '{}'));
        return send(200, { accepted: true });
      }
      if (req.url === '/snapshot') {
        state.snapshots.push(JSON.parse(body || '{}'));
        return send(200, { manifest: { version: 1, handoffId: 'hf-x', result: { status: 'done', commitCount: 2, newSessionIds: [], elapsedSeconds: 5 } } });
      }
      if (req.url?.startsWith('/logs')) {
        const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
        const items = state.logs.slice(after);
        return send(200, { items, nextAfter: after + items.length });
      }
      return send(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, state, server });
    });
  });
}

const fakeSigner: OssSigner = {
  signPut: async (key) => `https://oss.fake/put/${key}`,
  signGet: async (key) => `https://oss.fake/get/${key}`,
};

function insertHandoff(
  db: DB,
  fields: { id: string; kind?: 'web' | 'bot'; task?: string; timeout?: number; status?: string; botId?: number },
): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO handoffs (id, user_id, agent_name, workspace_path, ws_hash, session_id, task, timeout_minutes,
      status, kind, bot_id, base_commit, branch, input_oss_key, created_at, updated_at, last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    fields.id, 1, 'demo', '/w', 'w-hash', 'sess', fields.task ?? null, fields.timeout ?? 30,
    fields.status ?? 'queued', fields.kind ?? 'web', fields.botId ?? null, 'base', 'main',
    `handoffs/1/${fields.id}/input.tar.gz`, at, at, at,
  );
  recordEvent(db, fields.id, 'status', fields.status ?? 'queued');
}

// ── tests ────────────────────────────────────────────────
let db: DB;
let orch: FakeOrchestrator;
let runner: Awaited<ReturnType<typeof startFakeRunner>>;
let worker: Worker;

beforeEach(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('u','x','t')").run();
  orch = new FakeOrchestrator();
  runner = await startFakeRunner();
  const connector: SandboxConnector = {
    getBaseUrl: async (_pod: PodRef, _port: number) => runner.url,
    dispose: async () => undefined,
  };
  worker = new Worker(db, orch, connector, fakeSigner, { namespace: 'agenthub', idleTtlMinutes: 120 }, 'test-secret');
});

afterEach(() => {
  runner.server.close();
  db.close();
});

describe('worker 全链路', () => {
  it('queued → running（同 tick 连续推进）→ taskDone → done，Pod 回收', async () => {
    insertHandoff(db, { id: 'hf-000001', task: 'do it' });
    await worker.tick(); // queued → provisioning → running（fake Pod 立即 ready）
    const running = getHandoff(db, 'hf-000001')!;
    expect(running.status).toBe('running');
    expect(orch.created).toHaveLength(1);
    expect(orch.created[0]!.env['QWEN_SERVER_TOKEN']).toBeTruthy();
    expect(runner.state.loads).toHaveLength(1);
    expect((runner.state.loads[0] as { task: string }).task).toBe('do it');

    await worker.tick(); // taskDone=false，保持 running
    expect(getHandoff(db, 'hf-000001')!.status).toBe('running');

    runner.state.taskDone = true;
    runner.state.logs.push({ t: 't1', tag: 'tool', c: 'edit_file x.ts' });
    await worker.tick(); // → packaging → snapshot → done + Pod 删除（同 tick）
    const done = getHandoff(db, 'hf-000001')!;
    expect(done.status).toBe('done');
    expect(done.output_oss_key).toBe('handoffs/1/hf-000001/output.tar.gz');
    expect(done.result_manifest).toContain('commitCount');
    expect(runner.state.snapshots).toHaveLength(1);
    expect(orch.pods.size).toBe(0);
    // 日志已搬运到 handoff_events（spec §4.3）
    const logs = db
      .prepare("SELECT payload FROM handoff_events WHERE handoff_id=? AND kind='log'")
      .all('hf-000001') as Array<{ payload: string }>;
    expect(logs.some((l) => l.payload.includes('edit_file x.ts'))).toBe(true);
  });

  it('带 task 的任务硬超时 → expired（部分成果仍打包）', async () => {
    insertHandoff(db, { id: 'hf-000002', task: 'long', timeout: 1 });
    await worker.tick();
    expect(getHandoff(db, 'hf-000002')!.status).toBe('running');
    // 把 running 事件时间改到 2 分钟前，触发 1 分钟硬超时
    db.prepare("UPDATE handoff_events SET at=? WHERE handoff_id=? AND payload='running'").run(
      new Date(Date.now() - 120_000).toISOString(), 'hf-000002',
    );
    await worker.tick(); // → packaging(target=expired) → expired（同 tick）
    const h = getHandoff(db, 'hf-000002')!;
    expect(h.status).toBe('expired');
    expect(runner.state.snapshots.length).toBeGreaterThan(0);
  });

  it('runner 报 lastError → packaging(target=failed) → failed', async () => {
    insertHandoff(db, { id: 'hf-000003' });
    await worker.tick();
    expect(getHandoff(db, 'hf-000003')!.status).toBe('running');
    runner.state.lastError = 'load exploded';
    await worker.tick(); // → packaging → failed（同 tick）
    expect(getHandoff(db, 'hf-000003')!.status).toBe('failed');
  });

  // ── bot 生命周期两段式：任务执行期硬超时，taskDone 后转活跃度驱动的空闲 TTL（hf-0dc37c）──
  const insertRunningBot = (id: string): void => {
    insertHandoff(db, { id, task: 't', kind: 'bot', timeout: 1, status: 'running' });
    db.prepare('UPDATE handoffs SET pod_name=? WHERE id=?').run('ah-bot-x', id);
    orch.pods.set('ah-bot-x', 'ready');
  };
  const backdateRunning = (id: string, msAgo: number): void => {
    db.prepare("UPDATE handoff_events SET at=? WHERE handoff_id=? AND payload='running'").run(
      new Date(Date.now() - msAgo).toISOString(), id,
    );
  };

  it('bot task 完成后不再受硬超时（驻留等 pull，hf-0dc37c 回归）', async () => {
    insertRunningBot('hf-000010');
    backdateRunning('hf-000010', 120_000); // 已过 1 分钟硬超时 deadline
    runner.state.taskDone = true;
    runner.state.lastActivityAt = new Date().toISOString();
    await worker.tick();
    expect(getHandoff(db, 'hf-000010')!.status).toBe('running');
  });

  it('bot task 未完成时硬超时照旧生效', async () => {
    insertRunningBot('hf-000011');
    backdateRunning('hf-000011', 120_000);
    runner.state.taskDone = false;
    await worker.tick();
    expect(getHandoff(db, 'hf-000011')!.status).toBe('expired');
    expect(getHandoff(db, 'hf-000011')!.error).toBe('hard timeout');
  });

  it('bot 驻留期空闲 TTL：无活动超 idleTtl → expired', async () => {
    insertRunningBot('hf-000012');
    backdateRunning('hf-000012', 130 * 60_000);
    runner.state.taskDone = true;
    runner.state.lastActivityAt = new Date(Date.now() - 121 * 60_000).toISOString(); // > 120min idleTtl
    await worker.tick();
    expect(getHandoff(db, 'hf-000012')!.status).toBe('expired');
    expect(getHandoff(db, 'hf-000012')!.error).toBe('idle ttl');
  });

  it('bot 驻留期活跃续命：新活动 → 保持 running（进行中的轮次不被误杀）', async () => {
    insertRunningBot('hf-000013');
    backdateRunning('hf-000013', 3 * 3600_000); // 进 running 已 3 小时
    runner.state.taskDone = true;
    runner.state.lastActivityAt = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 分钟前还在聊
    await worker.tick();
    expect(getHandoff(db, 'hf-000013')!.status).toBe('running');
  });

  it('瞬断不误判：runner 不可达 + phase 查询抛错 → 保持 running（hf-f4da72 回归）', async () => {
    insertHandoff(db, { id: 'hf-000004', task: 'x' });
    await worker.tick();
    expect(getHandoff(db, 'hf-000004')!.status).toBe('running');
    orch.phaseError = true;
    runner.server.close(); // healthz 连接拒绝
    await worker.tick();
    expect(getHandoff(db, 'hf-000004')!.status).toBe('running');
  });

  it('确失仍判死：runner 不可达 + phase=gone → failed', async () => {
    insertHandoff(db, { id: 'hf-000005', task: 'x' });
    await worker.tick();
    expect(getHandoff(db, 'hf-000005')!.status).toBe('running');
    runner.server.close();
    orch.pods.clear(); // Pod 真的没了
    await worker.tick();
    expect(getHandoff(db, 'hf-000005')!.status).toBe('failed');
  });

  it('requestPackaging：running 的交互任务被 pull 触发收尾', async () => {
    insertHandoff(db, { id: 'hf-000004' });
    await worker.tick();
    expect(worker.requestPackaging('hf-000004')).toBe(true);
    await worker.tick();
    expect(getHandoff(db, 'hf-000004')!.status).toBe('done');
  });
});

describe('回收与恢复', () => {
  it('孤儿 Pod（无活跃引用）被清理，活跃/bot Pod 保留', async () => {
    orch.pods.set('ah-web-orphan', 'ready');
    orch.pods.set('ah-bot-1-mybot', 'ready');
    db.prepare(
      "INSERT INTO bots (user_id, name, client_id, client_secret_enc, pod_name, status, created_at) VALUES (1,'mybot','c','e','ah-bot-1-mybot','running','t')",
    ).run();
    insertHandoff(db, { id: 'hf-000005' });
    await worker.tick(); // 建出活跃 Pod
    await worker.cleanupOrphans();
    expect(orch.pods.has('ah-web-orphan')).toBe(false);
    expect(orch.pods.has('ah-bot-1-mybot')).toBe(true);
    expect(orch.pods.has('ah-web-000005')).toBe(true);
  });

  it('崩溃恢复：pod 丢失的 running 任务标记 failed', async () => {
    insertHandoff(db, { id: 'hf-000006', status: 'running' });
    db.prepare('UPDATE handoffs SET pod_name=? WHERE id=?').run('ah-web-000006', 'hf-000006');
    // orch 中没有这个 pod → gone
    await worker.recover();
    expect(getHandoff(db, 'hf-000006')!.status).toBe('failed');
  });
});
