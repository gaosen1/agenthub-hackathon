/**
 * sandbox 实例历史（S5）。
 *
 * 核心不变量：
 * - 执行时长按 ready_at → ended_at 计，从未 ready 的实例 duration 为 NULL；
 * - pod 名会被 bot 重建复用，所有更新只作用于「当前开着的那一行」，不能污染历史行。
 */
import { describe, expect, it } from 'vitest';
import { openDb, type DB } from './db.js';
import { phaseOf } from './k8s.js';
import {
  recordSandboxCreate,
  recordSandboxReady,
  recordSandboxReclaim,
  type SandboxRow,
} from './store.js';

const rows = (db: DB): SandboxRow[] =>
  db.prepare('SELECT * FROM sandboxes ORDER BY id').all() as SandboxRow[];
const only = (db: DB): SandboxRow => {
  const all = rows(db);
  expect(all).toHaveLength(1);
  return all[0]!;
};

function webPod(db: DB, podName = 'ah-web-9f3a2c', handoffId = 'hf-9f3a2c') {
  recordSandboxCreate(db, {
    podName,
    userId: 1,
    kind: 'web',
    image: 'registry/agenthub-demo/sandbox:v1',
    namespace: 'agenthub',
    handoffId,
  });
}

describe('sandbox 历史记录', () => {
  it('创建后落 provisioning 行，尚无 ready_at / 时长', () => {
    const db = openDb(':memory:');
    webPod(db);

    const s = only(db);
    expect(s.status).toBe('provisioning');
    expect(s.kind).toBe('web');
    expect(s.handoff_id).toBe('hf-9f3a2c');
    expect(s.ready_at).toBeNull();
    expect(s.duration_seconds).toBeNull();
  });

  it('就绪后置 running 并记 ready_at', () => {
    const db = openDb(':memory:');
    webPod(db);

    recordSandboxReady(db, 'ah-web-9f3a2c');

    const s = only(db);
    expect(s.status).toBe('running');
    expect(s.ready_at).not.toBeNull();
  });

  it('回收后置终态、记原因并算出执行时长', () => {
    const db = openDb(':memory:');
    webPod(db);
    recordSandboxReady(db, 'ah-web-9f3a2c');
    // 把 ready_at 往前挪 12m40s，验证时长确实按 ready_at 算
    db.prepare("UPDATE sandboxes SET ready_at = datetime('now','-760 seconds')").run();

    recordSandboxReclaim(db, 'ah-web-9f3a2c', 'reclaimed', 'task-done');

    const s = only(db);
    expect(s.status).toBe('reclaimed');
    expect(s.reclaim_reason).toBe('task-done');
    expect(s.ended_at).not.toBeNull();
    expect(s.duration_seconds).toBeGreaterThanOrEqual(759);
    expect(s.duration_seconds).toBeLessThanOrEqual(761);
  });

  it('从未 ready 就失败的实例，执行时长保持 NULL 而不是退化成 created_at 计时', () => {
    const db = openDb(':memory:');
    webPod(db);
    db.prepare("UPDATE sandboxes SET created_at = datetime('now','-600 seconds')").run();

    recordSandboxReclaim(db, 'ah-web-9f3a2c', 'failed', 'pod-failed', 'pod failed');

    const s = only(db);
    expect(s.status).toBe('failed');
    expect(s.duration_seconds).toBeNull();
    expect(s.last_error).toBe('pod failed');
  });

  it('bot pod 同名重建：新行独立，已回收的历史行不被改写', () => {
    const db = openDb(':memory:');
    const bot = { podName: 'ah-bot-1-ops', userId: 1, kind: 'bot' as const, image: 'img', namespace: 'agenthub', botId: 1 };

    recordSandboxCreate(db, bot);
    recordSandboxReady(db, bot.podName);
    recordSandboxReclaim(db, bot.podName, 'reclaimed', 'bot-deleted');
    // 同名重建
    recordSandboxCreate(db, bot);
    recordSandboxReady(db, bot.podName);

    const all = rows(db);
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe('reclaimed');
    expect(all[0]!.reclaim_reason).toBe('bot-deleted');
    expect(all[1]!.status).toBe('running');
    expect(all[1]!.reclaim_reason).toBeNull();
  });

  it('重复回收不覆盖已有终态', () => {
    const db = openDb(':memory:');
    webPod(db);
    recordSandboxReady(db, 'ah-web-9f3a2c');
    recordSandboxReclaim(db, 'ah-web-9f3a2c', 'reclaimed', 'task-done');

    recordSandboxReclaim(db, 'ah-web-9f3a2c', 'lost', 'crash-recover');

    expect(only(db).reclaim_reason).toBe('task-done');
  });

  it('历史行不带外键，handoff 被清理后仍可查', () => {
    const db = openDb(':memory:');
    webPod(db, 'ah-web-deadbe', 'hf-deadbe');

    // handoffs 表里从来没有 hf-deadbe，插入也不该被 foreign_keys=ON 拦下
    expect(only(db).handoff_id).toBe('hf-deadbe');
  });
});

describe('phaseOf（getPodPhase 与 listSandboxPods 共用的相位判定）', () => {
  it('Failed / Succeeded 都算 failed——Never 重启策略下跑完即终态', () => {
    expect(phaseOf({ status: { phase: 'Failed' } })).toBe('failed');
    expect(phaseOf({ status: { phase: 'Succeeded' } })).toBe('failed');
  });

  it('Ready 条件为 True 才算 ready', () => {
    expect(phaseOf({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } })).toBe('ready');
    expect(phaseOf({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } })).toBe('pending');
  });

  it('缺 status / 缺 conditions 时保守判为 pending', () => {
    expect(phaseOf({})).toBe('pending');
    expect(phaseOf({ status: { phase: 'Pending' } })).toBe('pending');
  });
});
