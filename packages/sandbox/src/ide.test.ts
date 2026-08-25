/**
 * Web IDE 拉起测试：shared 层未安装 / 无工作区 / 幂等复用 / 进程早退
 * spawn 与就绪探测经 ideDeps 替身，不真起 code-server。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { buildRunner } from './runner.js';
import { ensureIde, ideDeps, ideStatus, resetIdeForTest } from './ide.js';

/** 最小 ChildProcess 替身：只实现 ensureIde 用到的面 */
function fakeChild(opts: { exitCode?: number | null; pid?: number } = {}): ChildProcess & { emitExit: (code: number) => void; killed: boolean } {
  const handlers: Record<string, Array<(code: number) => void>> = {};
  const child = {
    pid: opts.pid ?? 4242,
    exitCode: opts.exitCode ?? null,
    killed: false,
    unref: () => undefined,
    kill: () => {
      child.killed = true;
    },
    on: (ev: string, fn: (code: number) => void) => {
      (handlers[ev] ??= []).push(fn);
    },
    emitExit(code: number) {
      this.exitCode = code;
      for (const fn of handlers['exit'] ?? []) fn(code);
    },
  };
  return child as unknown as ChildProcess & { emitExit: (code: number) => void; killed: boolean };
}

beforeEach(() => {
  resetIdeForTest();
  ideDeps.exists = () => true;
  ideDeps.probeReady = async () => true;
});

describe('runner IDE 路由', () => {
  it('未加载工作区时 /ide/ensure 返回 409 ERR_STATE', async () => {
    const app = buildRunner();
    const res = await app.inject({ method: 'POST', url: '/ide/ensure' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ERR_STATE');
  });

  it('/ide/status 返回未就绪状态', async () => {
    const app = buildRunner();
    const res = await app.inject({ method: 'GET', url: '/ide/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(false);
  });
});

describe('ensureIde', () => {
  it('shared 层未安装 code-server 时不 spawn 直接报错', async () => {
    ideDeps.exists = () => false;
    let spawned = 0;
    ideDeps.spawn = (() => {
      spawned++;
      return fakeChild();
    }) as unknown as typeof ideDeps.spawn;
    const st = await ensureIde('/tmp/ws');
    expect(st.ready).toBe(false);
    expect(st.error).toMatch(/not installed/);
    expect(spawned).toBe(0);
  });

  it('首次 spawn 并探测就绪；二次调用幂等复用不再 spawn', async () => {
    let spawned = 0;
    ideDeps.spawn = ((bin: string, args: string[]) => {
      spawned++;
      expect(bin).toMatch(/code-server/);
      expect(args).toContain('--auth');
      expect(args[args.length - 1]).toBe('/tmp/ws');
      return fakeChild({ pid: 4321 });
    }) as unknown as typeof ideDeps.spawn;

    const first = await ensureIde('/tmp/ws');
    expect(first).toEqual({ ready: true, pid: 4321 });
    const second = await ensureIde('/tmp/ws');
    expect(second.ready).toBe(true);
    expect(spawned).toBe(1);
  });

  it('进程早退时返回失败并复位，允许下次重新拉起', async () => {
    const child = fakeChild();
    ideDeps.spawn = (() => child) as unknown as typeof ideDeps.spawn;
    ideDeps.probeReady = async () => {
      child.emitExit(1);
      return false;
    };
    const st = await ensureIde('/tmp/ws');
    expect(st.ready).toBe(false);
    expect(st.error).toMatch(/exited early/);
    expect(ideStatus().ready).toBe(false);
  });

  it('workspace 变更时重启 code-server 指向新目录（bot 常驻 Pod 切 handoff）', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    ideDeps.spawn = ((_bin: string, args: string[]) => {
      const c = fakeChild({ pid: 5000 + children.length });
      children.push(c);
      expect(args[args.length - 1]).toBe(children.length === 1 ? '/tmp/ws-a' : '/tmp/ws-b');
      return c;
    }) as unknown as typeof ideDeps.spawn;

    const first = await ensureIde('/tmp/ws-a');
    expect(first).toEqual({ ready: true, pid: 5000 });

    const second = await ensureIde('/tmp/ws-b');
    expect(second).toEqual({ ready: true, pid: 5001 });
    expect(children).toHaveLength(2);
    expect(children[0]!.killed).toBe(true);

    // 新目录上再次调用仍幂等，不再 spawn
    const third = await ensureIde('/tmp/ws-b');
    expect(third.ready).toBe(true);
    expect(children).toHaveLength(2);
  });
});
