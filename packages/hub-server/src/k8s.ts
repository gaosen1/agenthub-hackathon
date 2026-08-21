/**
 * Pod/Secret 编排（spec §5.1）：Worker 经此操作 ACK 集群（ACS 算力）
 * 接口抽象便于测试注入 Fake。
 */
import * as k8s from '@kubernetes/client-node';
import type { RunnerMode } from '@agenthub/shared';

export type PodPhase = 'pending' | 'ready' | 'failed' | 'gone';

/** 存活 Pod 的摘要信息（S7）；startedAt 可选：ACS virtual-kubelet 可能不给 startTime */
export interface SandboxPodInfo {
  name: string;
  phase: PodPhase;
  startedAt?: string;
  labels: Record<string, string>;
}

/** Pod 相位判定纯函数（S7）：getPodPhase 与 listSandboxPods 共用一个真相 */
export function phaseOf(pod: k8s.V1Pod): PodPhase {
  const phase = pod.status?.phase;
  if (phase === 'Failed' || phase === 'Succeeded') return 'failed';
  const ready = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
  return ready ? 'ready' : 'pending';
}

export interface SandboxPodSpec {
  podName: string;
  mode: RunnerMode;
  env: Record<string, string>;
  /** 以 envFrom secretRef 注入的 Secret 名（模型凭证 / bot 钉钉凭证） */
  secretRefs: string[];
  labels: Record<string, string>;
}

export interface PodOrchestrator {
  createPod(spec: SandboxPodSpec): Promise<void>;
  deletePod(podName: string): Promise<void>;
  getPodPhase(podName: string): Promise<PodPhase>;
  listSandboxPods(): Promise<SandboxPodInfo[]>;
  createSecret(name: string, data: Record<string, string>): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** bot 模式：创建 Deployment（自动重建 Pod），存储 deployment 名为 pod_name */
  createDeployment(spec: SandboxPodSpec): Promise<void>;
  /** bot 模式：删除 Deployment */
  deleteDeployment(name: string): Promise<void>;
  /** 按 label 查找实际运行中的 Pod 名（Deployment 重建后 Pod 名变化，用 label 定位） */
  findPodNameByLabel(labels: Record<string, string>): Promise<string | undefined>;
}

export interface K8sConfig {
  namespace: string;
  image: string;
  /** ACS 调度所需 nodeSelector/tolerations 开关 */
  acs: boolean;
  /** 私有 ACR 拉取凭证 Secret 名（可选） */
  imagePullSecret?: string;
  /** ConfigMap 名（可选）：挂载最新编译的 runner.js/context.js，免重建镜像 */
  configMapName?: string;
  /** NAS 共享只读层（可选）：预置 code-server 等工具，挂载到 /mnt/shared */
  nas?: { server: string; path: string };
}

export const SANDBOX_LABEL = 'app=agenthub-sandbox';

/** 默认沙箱镜像（SANDBOX_IMAGE 环境变量可覆盖） */
export const DEFAULT_SANDBOX_IMAGE = '<YOUR_ACR_REGISTRY>/agenthub-demo/sandbox:dev';
export const sandboxImage = () => process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

/** Pod 资源规格：createPod/createDeployment 与面板模板（S9）共用，不漂移 */
export const SANDBOX_RESOURCES = { cpu: '2', memory: '4Gi' };
export const SANDBOX_PORTS = { runner: 8080, serve: 8081, ide: 8082 };

/** NAS 在沙箱内的挂载点（runner 由此找 tools/code-server） */
export const NAS_MOUNT_PATH = '/mnt/shared';

/** 镜像元数据登记：事实源头是 packages/sandbox/Dockerfile，改 Dockerfile 要同步改 */
export const SANDBOX_TEMPLATE = {
  baseImage: 'node:22-slim',
  qwenVersion: '0.20.1',
  toolchain: ['git', 'ripgrep', 'tar', 'procps'],
};

export function loadKube(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.HUB_IN_CLUSTER === '1') kc.loadFromCluster();
  else kc.loadFromDefault();
  return kc;
}

/**
 * Pod volumes/volumeMounts 构造（纯函数，单测直接断言）：
 * NAS 共享只读层 + 可选 ConfigMap 叠加层，两者合并而非互斥。
 * 都未配置时返回 undefined（spec 不出现空 volumes 数组）。
 */
export function buildSandboxVolumes(
  cfg: Pick<K8sConfig, 'nas'>,
  overlay?: { volumes: k8s.V1Volume[]; volumeMounts: k8s.V1VolumeMount[] },
): { volumes: k8s.V1Volume[]; volumeMounts: k8s.V1VolumeMount[] } | undefined {
  const volumes: k8s.V1Volume[] = [];
  const volumeMounts: k8s.V1VolumeMount[] = [];
  if (cfg.nas) {
    volumes.push({ name: 'nas-shared', nfs: { server: cfg.nas.server, path: cfg.nas.path } });
    volumeMounts.push({ name: 'nas-shared', mountPath: NAS_MOUNT_PATH, readOnly: true });
  }
  if (overlay) {
    volumes.push(...overlay.volumes);
    volumeMounts.push(...overlay.volumeMounts);
  }
  if (volumes.length === 0) return undefined;
  return { volumes, volumeMounts };
}

export class K8sOrchestrator implements PodOrchestrator {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;

  constructor(kc: k8s.KubeConfig, private readonly cfg: K8sConfig) {
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
  }

  coreApi(): k8s.CoreV1Api {
    return this.core;
  }

  async createPod(spec: SandboxPodSpec): Promise<void> {
    const vols = buildSandboxVolumes(this.cfg);
    const pod: k8s.V1Pod = {
      metadata: {
        name: spec.podName,
        labels: { app: 'agenthub-sandbox', ...spec.labels },
      },
      spec: {
        restartPolicy: 'Never',
        ...(this.cfg.imagePullSecret ? { imagePullSecrets: [{ name: this.cfg.imagePullSecret }] } : {}),
        ...(this.cfg.acs
          ? {
              nodeSelector: { type: 'virtual-kubelet' },
              tolerations: [{ key: 'virtual-kubelet.io/provider', operator: 'Exists' }],
            }
          : {}),
        ...(vols ? { volumes: vols.volumes } : {}),
        containers: [
          {
            name: 'sandbox',
            image: this.cfg.image,
            imagePullPolicy: 'IfNotPresent',
            ports: [{ containerPort: SANDBOX_PORTS.runner }, { containerPort: SANDBOX_PORTS.serve }, { containerPort: SANDBOX_PORTS.ide }],
            ...(vols ? { volumeMounts: vols.volumeMounts } : {}),
            env: Object.entries({
              RUNNER_MODE: spec.mode,
              // 云端无人值守必用 yolo；静音 qwen 启动警告，避免它混入会话首条输出
              QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
              ...spec.env,
            }).map(([name, value]) => ({ name, value })),
            envFrom: spec.secretRefs.map((name) => ({ secretRef: { name, optional: true } })),
            resources: {
              requests: { ...SANDBOX_RESOURCES },
              limits: { ...SANDBOX_RESOURCES },
            },
            readinessProbe: {
              httpGet: { path: '/healthz', port: SANDBOX_PORTS.runner },
              initialDelaySeconds: 2,
              periodSeconds: 3,
            },
          },
        ],
      },
    };
    await withRetry(() => this.core.createNamespacedPod({ namespace: this.cfg.namespace, body: pod }));
  }

  async deletePod(podName: string): Promise<void> {
    try {
      await withRetry(() => this.core.deleteNamespacedPod({ name: podName, namespace: this.cfg.namespace, gracePeriodSeconds: 5 }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async getPodPhase(podName: string): Promise<PodPhase> {
    let pod: k8s.V1Pod;
    try {
      pod = await withRetry(() => this.core.readNamespacedPod({ name: podName, namespace: this.cfg.namespace }));
    } catch (e) {
      if (isNotFound(e)) return 'gone';
      throw e;
    }
    const phase = phaseOf(pod);
    return phase;
  }

  async listSandboxPods(): Promise<SandboxPodInfo[]> {
    const res = await withRetry(() => this.core.listNamespacedPod({ namespace: this.cfg.namespace, labelSelector: SANDBOX_LABEL }));
    return res.items
      .map((p) => ({
        name: p.metadata?.name ?? '',
        phase: phaseOf(p),
        ...(p.status?.startTime ? { startedAt: new Date(p.status.startTime).toISOString() } : {}),
        labels: p.metadata?.labels ?? {},
      }))
      .filter((i) => i.name);
  }

  /** bot 模式：创建 Deployment（ACS 驱逐后自动重建 Pod） */
  async createDeployment(spec: SandboxPodSpec): Promise<void> {
    const overlay = this.configMapOverlay();
    const vols = buildSandboxVolumes(this.cfg, overlay);
    const deploy: k8s.V1Deployment = {
      metadata: {
        name: spec.podName,
        labels: spec.labels,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: spec.labels },
        template: {
          metadata: { labels: spec.labels },
          spec: {
            restartPolicy: 'Always',
            ...(this.cfg.imagePullSecret ? { imagePullSecrets: [{ name: this.cfg.imagePullSecret }] } : {}),
            ...(this.cfg.acs
              ? {
                  nodeSelector: { type: 'virtual-kubelet' },
                  tolerations: [{ key: 'virtual-kubelet.io/provider', operator: 'Exists' }],
                }
              : {}),
            ...(vols ? { volumes: vols.volumes } : {}),
            containers: [
              {
                name: 'sandbox',
                image: this.cfg.image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: SANDBOX_PORTS.runner }, { containerPort: SANDBOX_PORTS.serve }, { containerPort: SANDBOX_PORTS.ide }],
                ...(overlay ? { command: overlay.command, args: overlay.args } : {}),
                ...(vols ? { volumeMounts: vols.volumeMounts } : {}),
                env: Object.entries({
                  RUNNER_MODE: spec.mode,
                  // 云端无人值守必用 yolo；静音 qwen 启动警告，避免它混入会话首条输出
                  QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
                  ...spec.env,
                }).map(([name, value]) => ({ name, value })),
                envFrom: spec.secretRefs.map((name) => ({ secretRef: { name, optional: true } })),
                resources: {
                  requests: { ...SANDBOX_RESOURCES },
                  limits: { ...SANDBOX_RESOURCES },
                },
                readinessProbe: {
                  httpGet: { path: '/healthz', port: SANDBOX_PORTS.runner },
                  initialDelaySeconds: 2,
                  periodSeconds: 3,
                },
              },
            ],
          },
        },
      },
    };
    await withRetry(() => this.apps.createNamespacedDeployment({ namespace: this.cfg.namespace, body: deploy }));
  }

  /** ConfigMap 叠加层：挂载最新 runner.js/context.js，免重建镜像 */
  private configMapOverlay(): { volumes: k8s.V1Volume[]; volumeMounts: k8s.V1VolumeMount[]; command: string[]; args: string[] } | undefined {
    if (!this.cfg.configMapName) return undefined;
    const volName = 'runner-cm';
    return {
      volumes: [{ name: volName, configMap: { name: this.cfg.configMapName } }],
      volumeMounts: [{ name: volName, mountPath: '/tmp/runner-cm' }],
      command: ['sh', '-c'],
      args: ['cp /tmp/runner-cm/runner.js /app/dist/runner.js && cp /tmp/runner-cm/context.js /app/dist/context.js && exec node /app/dist/runner.js'],
    };
  }

  async deleteDeployment(name: string): Promise<void> {
    try {
      await withRetry(() => this.apps.deleteNamespacedDeployment({ name, namespace: this.cfg.namespace }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async findPodNameByLabel(labels: Record<string, string>): Promise<string | undefined> {
    const selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
    const res = await withRetry(() => this.core.listNamespacedPod({ namespace: this.cfg.namespace, labelSelector: selector }));
    const pod = res.items.find((p) => p.status?.phase === 'Running' || p.status?.phase === 'Pending');
    return pod?.metadata?.name;
  }

  async createSecret(name: string, data: Record<string, string>): Promise<void> {
    const body: k8s.V1Secret = {
      metadata: { name },
      stringData: data,
    };
    try {
      await withRetry(() => this.core.createNamespacedSecret({ namespace: this.cfg.namespace, body }));
    } catch (e) {
      if (isConflict(e)) {
        await withRetry(() => this.core.replaceNamespacedSecret({ name, namespace: this.cfg.namespace, body }));
        return;
      }
      throw e;
    }
  }

  async deleteSecret(name: string): Promise<void> {
    try {
      await withRetry(() => this.core.deleteNamespacedSecret({ name, namespace: this.cfg.namespace }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

const statusOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? Number((e as { code: unknown }).code) : undefined;

const isNotFound = (e: unknown) => statusOf(e) === 404;
const isConflict = (e: unknown) => statusOf(e) === 409;

const isTransient = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /EBADF|ECONNRESET|EPIPE|ECONNREFUSED|socket hang up|ETIMEDOUT/.test(m);
};

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i < retries && isTransient(e)) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('unreachable');
}
