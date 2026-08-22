/**
 * Pod 编排测试：NAS 共享只读层挂载与 IDE 端口（buildSandboxVolumes 纯函数 + K8sOrchestrator 组装）
 */
import * as k8s from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import {
  K8sOrchestrator,
  buildSandboxVolumes,
  NAS_MOUNT_PATH,
  SANDBOX_PORTS,
  type K8sConfig,
  type SandboxPodSpec,
} from './k8s.js';

const baseCfg: K8sConfig = { namespace: 'agenthub', image: 'img:test', acs: true };
const nasCfg: K8sConfig = { ...baseCfg, nas: { server: 'nas.fake.aliyuncs.com', path: '/agenthub' } };

const spec: SandboxPodSpec = { podName: 'ah-web-abc123', mode: 'web', env: {}, secretRefs: [], labels: {} };

/** 构造 orchestrator 并替身掉 K8s API 客户端，捕获提交体 */
function makeFake(cfg: K8sConfig) {
  const kc = new k8s.KubeConfig();
  kc.loadFromClusterAndUser({ name: 'c', server: 'http://127.0.0.1:1' }, { name: 'u' });
  const orch = new K8sOrchestrator(kc, cfg);
  const captured: { pods: k8s.V1Pod[]; deployments: k8s.V1Deployment[] } = { pods: [], deployments: [] };
  (orch as unknown as { core: unknown }).core = {
    createNamespacedPod: async ({ body }: { body: k8s.V1Pod }) => {
      captured.pods.push(body);
      return body;
    },
  };
  (orch as unknown as { apps: unknown }).apps = {
    createNamespacedDeployment: async ({ body }: { body: k8s.V1Deployment }) => {
      captured.deployments.push(body);
      return body;
    },
  };
  return { orch, captured };
}

describe('buildSandboxVolumes', () => {
  it('NAS 与 ConfigMap 叠加层都未配置时返回 undefined（spec 不出现空 volumes）', () => {
    expect(buildSandboxVolumes(baseCfg)).toBeUndefined();
  });

  it('NAS 只读挂载与 ConfigMap 叠加层合并而非互斥', () => {
    const overlay = {
      volumes: [{ name: 'runner-cm', configMap: { name: 'cm' } }],
      volumeMounts: [{ name: 'runner-cm', mountPath: '/tmp/runner-cm' }],
    };
    const vols = buildSandboxVolumes(nasCfg, overlay);
    expect(vols?.volumes.map((v) => v.name)).toEqual(['nas-shared', 'runner-cm']);
    expect(vols?.volumeMounts.map((m) => m.mountPath)).toEqual([NAS_MOUNT_PATH, '/tmp/runner-cm']);
  });
});

describe('K8sOrchestrator Pod spec', () => {
  it('配置 NAS 时 createPod 带 nfs volume、只读挂载与 IDE 端口', async () => {
    const { orch, captured } = makeFake(nasCfg);
    await orch.createPod(spec);
    const pod = captured.pods[0]!;
    expect(pod.spec?.volumes).toEqual([{ name: 'nas-shared', nfs: { server: 'nas.fake.aliyuncs.com', path: '/agenthub' } }]);
    const container = pod.spec?.containers?.[0]!;
    expect(container.volumeMounts).toEqual([{ name: 'nas-shared', mountPath: NAS_MOUNT_PATH, readOnly: true }]);
    expect(container.ports?.map((p) => p.containerPort)).toContain(SANDBOX_PORTS.ide);
  });

  it('未配置 NAS 时 createPod 不出现 volumes', async () => {
    const { orch, captured } = makeFake(baseCfg);
    await orch.createPod(spec);
    expect(captured.pods[0]!.spec?.volumes).toBeUndefined();
  });

  it('配置 ConfigMap 时 createPod 也带叠加层（web Pod 免重建镜像更新 runner）', async () => {
    const cfg: K8sConfig = { ...nasCfg, configMapName: 'runner-cm-data' };
    const { orch, captured } = makeFake(cfg);
    await orch.createPod(spec);
    const pod = captured.pods[0]!;
    expect(pod.spec?.volumes?.map((v) => v.name)).toEqual(['nas-shared', 'runner-cm']);
    const container = pod.spec?.containers?.[0]!;
    expect(container.command).toEqual(['sh', '-c']);
    expect(container.args?.[0]).toContain('ide.js');
  });

  it('createDeployment 同时保留 ConfigMap 叠加层与 NAS 挂载', async () => {
    const cfg: K8sConfig = { ...nasCfg, configMapName: 'runner-cm' };
    const { orch, captured } = makeFake(cfg);
    await orch.createDeployment(spec);
    const tpl = captured.deployments[0]!.spec?.template?.spec;
    expect(tpl?.volumes?.map((v) => v.name)).toEqual(['nas-shared', 'runner-cm']);
    const container = tpl?.containers?.[0]!;
    expect(container.volumeMounts?.map((m) => m.name)).toEqual(['nas-shared', 'runner-cm']);
    // ConfigMap 叠加层的启动命令不被 NAS 挂载吃掉
    expect(container.command).toEqual(['sh', '-c']);
    expect(container.ports?.map((p) => p.containerPort)).toContain(SANDBOX_PORTS.ide);
  });
});
