/**
 * Aone 后端：create 合并 secret 进 env / pod_name=sandboxId / 网关 URL 透传 / phase 映射 / label 查找 / kill。
 * SDK 以结构替身注入，不打内网。
 */
import { describe, expect, it } from 'vitest';
import { AoneConnector, AoneOrchestrator, type AoneSandboxLike, type AoneSdkLike } from './aone.js';
import type { SandboxPodSpec } from './k8s.js';

function fakeSdk() {
  const created: Array<Record<string, unknown>> = [];
  const killed: string[] = [];
  const states = new Map<string, string>();
  const make = (id: string): AoneSandboxLike => ({
    id,
    getEndpointUrl: async (port: number) => `https://${id}-p${port}.sandbox.aone.alibaba-inc.com`,
    getInfo: async () => ({ status: { state: states.get(id) ?? 'Running' } }),
    kill: async () => {
      killed.push(id);
      states.set(id, 'Terminated');
    },
    close: async () => undefined,
  });
  const sdk: AoneSdkLike = {
    Sandbox: {
      create: async (opts) => {
        created.push(opts);
        return make(`sb-${created.length}`);
      },
      connect: async (opts) => {
        const id = String((opts as { sandboxId?: string }).sandboxId ?? '');
        if (!created.some((_, i) => `sb-${i + 1}` === id)) throw new Error(`sandbox ${id} not found`);
        return make(id);
      },
    },
    SandboxManager: {
      create: async () => ({
        getSandboxInfo: async (id: string) => {
          if (ctl.managerError) throw ctl.managerError;
          if (!created.some((_, i) => `sb-${i + 1}` === id)) throw new Error('not found');
          return { status: { state: states.get(id) ?? 'Running' } };
        },
        close: async () => undefined,
      }),
    },
  };
  const ctl: { managerError?: Error } = {};
  return { sdk, created, killed, states, ctl };
}

const cfg = { apiKey: 'k', image: 'reg/img:1', entrypoint: 'cd /app && exec node dist/runner.js', timeoutSeconds: 3600 };
const spec: SandboxPodSpec = {
  podName: 'ah-web-x',
  mode: 'web',
  env: { RUNNER_TOKEN: 'rt' },
  secretRefs: ['model-1'],
  labels: { 'agenthub/kind': 'web' },
};

describe('AoneOrchestrator', () => {
  it('createPod 返回 sandboxId 并把 secret 并入 env', async () => {
    const { sdk, created } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    await orch.createSecret('model-1', { OPENAI_API_KEY: 'mk' });
    const id = await orch.createPod(spec);
    expect(id).toBe('sb-1');
    const opts = created[0] as { env: Record<string, string>; dynamicTemplate: { image: string; entrypoint: string } };
    expect(opts.env).toMatchObject({ RUNNER_TOKEN: 'rt', OPENAI_API_KEY: 'mk' });
    expect(opts.dynamicTemplate.image).toBe('reg/img:1');
  });

  it('getPodPhase 映射 Running/Failed/未知→gone', async () => {
    const { sdk, states } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    const id = await orch.createPod(spec);
    expect(await orch.getPodPhase(id)).toBe('ready');
    states.set(id, 'Failed');
    expect(await orch.getPodPhase(id)).toBe('failed');
    expect(await orch.getPodPhase('nope')).toBe('gone');
  });

  it('getPodPhase 查询瞬断（非 not found）抛错不判 gone（hf-306082 误判回归）', async () => {
    const { sdk, ctl } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    ctl.managerError = new Error('api server timeout');
    await expect(orch.getPodPhase('sb-x')).rejects.toThrow('timeout');
  });

  it('findPodNameByLabel 按 label 命中', async () => {
    const { sdk } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    const id = await orch.createPod(spec);
    expect(await orch.findPodNameByLabel({ 'agenthub/kind': 'web' })).toBe(id);
    expect(await orch.findPodNameByLabel({ 'agenthub/kind': 'bot' })).toBeUndefined();
  });

  it('deletePod 触发 kill', async () => {
    const { sdk, killed } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    const id = await orch.createPod(spec);
    await orch.deletePod(id);
    expect(killed).toEqual([id]);
  });
});

describe('AoneConnector', () => {
  it('getBaseUrl 返回端口网关 URL', async () => {
    const { sdk } = fakeSdk();
    const orch = new AoneOrchestrator(cfg, sdk);
    const id = await orch.createPod(spec);
    const conn = new AoneConnector(orch);
    expect(await conn.getBaseUrl({ namespace: 'aone', podName: id }, 8080)).toBe(
      `https://${id}-p8082.sandbox.aone.alibaba-inc.com/__runner`,
    );
  });
});
