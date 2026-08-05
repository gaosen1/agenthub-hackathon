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
  /** 每个 Pod 的标签与起始时间；对账测试可直接塞进来模拟集群里已存在的 Pod */
  podMeta = new Map<string, { labels: Record<string, string>; startedAt?: string }>();
  async createPod(spec: SandboxPodSpec) {
    this.created.push(spec);
    this.pods.set(spec.podName, 'ready');
    this.podMeta.set(spec.podName, { labels: { app: 'agenthub-sandbox', ...spec.labels } });
  }
  async deletePod(name: string) {
    this.pods.delete(name);
    this.podMeta.delete(name);
  }
  async getPodPhase(name: string): Promise<PodPhase> {
    return this.pods.get(name) ?? 'gone';
  }
  async listSandboxPods() {
    return [...this.pods.entries()].map(([name, phase]) => {
      const meta = this.podMeta.get(name);
      return {
        name,
        phase,
        labels: meta?.labels ?? {},
        ...(meta?.startedAt ? { startedAt: meta.startedAt } : {}),
      };
    });
  }
  async createSecret(name: string, data: Record<string, string>) {
    this.secrets.set(name, data);
  }
  async deleteSecret(name: string) {
    this.secrets.delete(name);
  }
}

interface FakeRunnerState {
  loads: unknown[];
  snapshots: unknown[];
  taskDone: boolean;
  lastError?: string;
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
        return send(200, { ok: true, mode: 'web', serveReady: true, taskDone: state.taskDone, ...(state.lastError ? { lastError: state.lastError } : {}) });
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
  worker = new Worker(db, orch, connector, fakeSigner, { namespace: 'agenthub', image: 'test/sandbox:itest', idleTtlMinutes: 120 });
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

describe('sandbox 实例历史（S6 写入点）', () => {
  const sandboxRows = () =>
    db.prepare('SELECT * FROM sandboxes ORDER BY id').all() as Array<{
      pod_name: string;
      kind: string;
      handoff_id: string | null;
      image: string;
      namespace: string;
      status: string;
      ready_at: string | null;
      ended_at: string | null;
      duration_seconds: number | null;
      reclaim_reason: string | null;
      last_error: string | null;
    }>;

  it('web pod 走完 provisioning → running → reclaimed，并算出执行时长', async () => {
    insertHandoff(db, { id: 'hf-000101', task: 'do it' });

    await worker.tick(); // queued → provisioning → running（fake Pod 立即 ready）
    let [s] = sandboxRows();
    expect(s!.status).toBe('running');
    expect(s!.pod_name).toBe('ah-web-000101');
    expect(s!.kind).toBe('web');
    expect(s!.handoff_id).toBe('hf-000101');
    expect(s!.image).toBe('test/sandbox:itest');
    expect(s!.namespace).toBe('agenthub');
    expect(s!.ready_at).not.toBeNull();
    expect(s!.ended_at).toBeNull();

    // 把 ready_at 挪早，验证时长按 ready_at → ended_at 计
    db.prepare("UPDATE sandboxes SET ready_at = datetime('now','-90 seconds')").run();
    runner.state.taskDone = true;
    await worker.tick(); // → packaging → done → 回收

    [s] = sandboxRows();
    expect(s!.status).toBe('reclaimed');
    expect(s!.reclaim_reason).toBe('task-done');
    expect(s!.ended_at).not.toBeNull();
    expect(s!.duration_seconds).toBeGreaterThanOrEqual(89);
    expect(s!.duration_seconds).toBeLessThanOrEqual(91);
  });

  it('硬超时收尾记为 expired，与正常完成区分开', async () => {
    insertHandoff(db, { id: 'hf-000102', task: 'long', timeout: 1 });
    await worker.tick();
    db.prepare("UPDATE handoff_events SET at=? WHERE handoff_id=? AND payload='running'").run(
      new Date(Date.now() - 120_000).toISOString(),
      'hf-000102',
    );

    await worker.tick();

    const [s] = sandboxRows();
    expect(s!.status).toBe('reclaimed');
    expect(s!.reclaim_reason).toBe('expired');
  });

  it('Pod 起不来记为 failed/pod-failed，且从未 ready 故无执行时长', async () => {
    insertHandoff(db, { id: 'hf-000103' });
    // 让 Pod 建出来就是 failed 相位
    const origCreate = orch.createPod.bind(orch);
    orch.createPod = async (spec) => {
      await origCreate(spec);
      orch.pods.set(spec.podName, 'failed');
    };

    await worker.tick(); // queued → provisioning
    await worker.tick(); // provisioning 看到 failed 相位 → 回收

    const [s] = sandboxRows();
    expect(s!.status).toBe('failed');
    expect(s!.reclaim_reason).toBe('pod-failed');
    expect(s!.ready_at).toBeNull();
    expect(s!.duration_seconds).toBeNull();
  });

  it('孤儿清理会关掉行，不留永久 running', async () => {
    insertHandoff(db, { id: 'hf-000104' });
    await worker.tick();
    expect(sandboxRows()[0]!.status).toBe('running');

    // 抹掉 handoff 的活跃引用，让 pod 变成孤儿
    db.prepare("UPDATE handoffs SET status='done' WHERE id=?").run('hf-000104');
    await worker.cleanupOrphans();

    const [s] = sandboxRows();
    expect(s!.status).toBe('reclaimed');
    expect(s!.reclaim_reason).toBe('orphan');
  });

  it('崩溃恢复把丢失的实例记为 lost，而不是留在 running', async () => {
    insertHandoff(db, { id: 'hf-000105' });
    await worker.tick();
    expect(sandboxRows()[0]!.status).toBe('running');

    // 模拟 hub 重启期间 Pod 消失
    orch.pods.clear();
    db.prepare("UPDATE handoffs SET status='running' WHERE id=?").run('hf-000105');
    await worker.recover();

    const [s] = sandboxRows();
    expect(s!.status).toBe('lost');
    expect(s!.reclaim_reason).toBe('crash-recover');
  });

  it('bot handoff 复用常驻 pod，不新开历史行', async () => {
    db.prepare(
      "INSERT INTO bots (user_id, name, client_id, client_secret_enc, pod_name, runner_token, status, created_at) VALUES (1,'ops','c','e','ah-bot-1-ops','rt','running','t')",
    ).run();
    insertHandoff(db, { id: 'hf-000106' });
    db.prepare("UPDATE handoffs SET kind='bot', bot_id=1 WHERE id=?").run('hf-000106');
    orch.pods.set('ah-bot-1-ops', 'ready');

    await worker.tick();

    // bot pod 的行由 POST /api/bots 负责，worker 这条路径不该凭空造行
    expect(sandboxRows()).toHaveLength(0);
  });
});

describe('重启对账 reconcileSandboxes（S8）', () => {
  const sandboxRows = () =>
    db.prepare('SELECT * FROM sandboxes ORDER BY id').all() as Array<{
      pod_name: string;
      user_id: number;
      kind: string;
      handoff_id: string | null;
      bot_id: number | null;
      status: string;
      created_at: string;
      ready_at: string | null;
      reclaim_reason: string | null;
    }>;

  it('行开着但 Pod 已消失 → lost/crash-recover，不留永久 running', async () => {
    insertHandoff(db, { id: 'hf-000201' });
    await worker.tick();
    expect(sandboxRows()[0]!.status).toBe('running');

    orch.pods.clear(); // 模拟 hub 崩溃期间 Pod 被回收
    await worker.reconcileSandboxes();

    const [s] = sandboxRows();
    expect(s!.status).toBe('lost');
    expect(s!.reclaim_reason).toBe('crash-recover');
  });

  it('Pod 活着但库里没有开着的行 → 按标签收养，并回填 Pod 起始时间', async () => {
    const startedAt = new Date(Date.now() - 300_000).toISOString();
    orch.pods.set('ah-web-adopted', 'ready');
    orch.podMeta.set('ah-web-adopted', {
      startedAt,
      labels: { 'agenthub/kind': 'web', 'agenthub/owner': '7', 'agenthub/handoff': 'hf-adopted' },
    });

    await worker.reconcileSandboxes();

    const [s] = sandboxRows();
    expect(s!.pod_name).toBe('ah-web-adopted');
    expect(s!.user_id).toBe(7);
    expect(s!.kind).toBe('web');
    expect(s!.handoff_id).toBe('hf-adopted');
    // ready 的 Pod 直接当 running，且不把它报成「刚创建」
    expect(s!.status).toBe('running');
    expect(s!.created_at).toBe(startedAt);
    expect(s!.ready_at).toBe(startedAt);
  });

  it('收养 bot pod 时带上 bot_id', async () => {
    orch.pods.set('ah-bot-3-ops', 'ready');
    orch.podMeta.set('ah-bot-3-ops', {
      labels: { 'agenthub/kind': 'bot', 'agenthub/owner': '7', 'agenthub/bot': '3' },
    });

    await worker.reconcileSandboxes();

    const [s] = sandboxRows();
    expect(s!.kind).toBe('bot');
    expect(s!.bot_id).toBe(3);
    expect(s!.handoff_id).toBeNull();
  });

  it('未就绪的 Pod 收养为 provisioning，不假装已 ready', async () => {
    orch.pods.set('ah-web-pending', 'pending');
    orch.podMeta.set('ah-web-pending', { labels: { 'agenthub/kind': 'web', 'agenthub/owner': '7' } });

    await worker.reconcileSandboxes();

    const [s] = sandboxRows();
    expect(s!.status).toBe('provisioning');
    expect(s!.ready_at).toBeNull();
  });

  it('缺 owner 标签的 Pod 不收养——不凭空编造归属', async () => {
    orch.pods.set('ah-web-nolabel', 'ready');
    orch.podMeta.set('ah-web-nolabel', { labels: { 'agenthub/kind': 'web' } });

    await worker.reconcileSandboxes();

    expect(sandboxRows()).toHaveLength(0);
  });

  it('已有开着的行时不重复收养', async () => {
    insertHandoff(db, { id: 'hf-000202' });
    await worker.tick();
    expect(sandboxRows()).toHaveLength(1);

    await worker.reconcileSandboxes();

    expect(sandboxRows()).toHaveLength(1);
  });

  it('集群不可达时静默返回，不拖垮恢复流程', async () => {
    insertHandoff(db, { id: 'hf-000203' });
    await worker.tick();
    orch.listSandboxPods = async () => {
      throw new Error('cluster unreachable');
    };

    await expect(worker.reconcileSandboxes()).resolves.toBeUndefined();
    expect(sandboxRows()[0]!.status).toBe('running');
  });
});
