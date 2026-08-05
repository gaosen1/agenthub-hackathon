/**
 * Pod/Secret 编排（spec §5.1）：Worker 经此操作 ACK 集群（ACS 算力）
 * 接口抽象便于测试注入 Fake。
 */
import * as k8s from '@kubernetes/client-node';
import type { RunnerMode } from '@agenthub/shared';

export type PodPhase = 'pending' | 'ready' | 'failed' | 'gone';

/** 集群里一个 sandbox Pod 的实况。startedAt 可选：ACS virtual-kubelet 可能不给 startTime。 */
export interface SandboxPodInfo {
  name: string;
  phase: PodPhase;
  startedAt?: string;
  labels: Record<string, string>;
}

/** Pod → 相位的唯一判定，getPodPhase 与 listSandboxPods 共用，避免两处口径漂移 */
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
  /** 取代原先只返回名字的 listSandboxPodNames——并存会让孤儿清理与面板对「存活 Pod」的口径漂移 */
  listSandboxPods(): Promise<SandboxPodInfo[]>;
  createSecret(name: string, data: Record<string, string>): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

export interface K8sConfig {
  namespace: string;
  image: string;
  /** ACS 调度所需 nodeSelector/tolerations 开关 */
  acs: boolean;
  /** 私有 ACR 拉取凭证 Secret 名（可选） */
  imagePullSecret?: string;
}

export const SANDBOX_LABEL = 'app=agenthub-sandbox';

/**
 * sandbox 镜像的唯一来源。镜像名现在有三个消费方——K8sConfig（建 Pod）、
 * WorkerConfig 与 bots 路由（写 sandbox 历史行的 image 列），所以不能再各处内联字面量。
 */
export const DEFAULT_SANDBOX_IMAGE =
  'crpi-0y776m3vqetn6kuh.cn-hangzhou.personal.cr.aliyuncs.com/qwen-code-demo/sandbox:dev';

export const sandboxImage = (): string => process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

export function loadKube(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.HUB_IN_CLUSTER === '1') kc.loadFromCluster();
  else kc.loadFromDefault();
  return kc;
}

export class K8sOrchestrator implements PodOrchestrator {
  private readonly core: k8s.CoreV1Api;

  constructor(kc: k8s.KubeConfig, private readonly cfg: K8sConfig) {
    this.core = kc.makeApiClient(k8s.CoreV1Api);
  }

  coreApi(): k8s.CoreV1Api {
    return this.core;
  }

  async createPod(spec: SandboxPodSpec): Promise<void> {
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
        containers: [
          {
            name: 'sandbox',
            image: this.cfg.image,
            imagePullPolicy: 'IfNotPresent',
            ports: [{ containerPort: 8080 }, { containerPort: 8081 }],
            env: Object.entries({ RUNNER_MODE: spec.mode, ...spec.env }).map(([name, value]) => ({ name, value })),
            envFrom: spec.secretRefs.map((name) => ({ secretRef: { name, optional: true } })),
            resources: {
              requests: { cpu: '2', memory: '4Gi' },
              limits: { cpu: '2', memory: '4Gi' },
            },
            readinessProbe: {
              httpGet: { path: '/healthz', port: 8080 },
              initialDelaySeconds: 2,
              periodSeconds: 3,
            },
          },
        ],
      },
    };
    await this.core.createNamespacedPod({ namespace: this.cfg.namespace, body: pod });
  }

  async deletePod(podName: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name: podName, namespace: this.cfg.namespace, gracePeriodSeconds: 5 });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async getPodPhase(podName: string): Promise<PodPhase> {
    let pod: k8s.V1Pod;
    try {
      pod = await this.core.readNamespacedPod({ name: podName, namespace: this.cfg.namespace });
    } catch (e) {
      if (isNotFound(e)) return 'gone';
      throw e;
    }
    return phaseOf(pod);
  }

  async listSandboxPods(): Promise<SandboxPodInfo[]> {
    const res = await this.core.listNamespacedPod({ namespace: this.cfg.namespace, labelSelector: SANDBOX_LABEL });
    return res.items
      .filter((p) => p.metadata?.name)
      .map((p) => {
        const startedAt = p.status?.startTime;
        return {
          name: p.metadata!.name!,
          phase: phaseOf(p),
          // ACS virtual-kubelet 的 Pod 可能不给 startTime，故为可选；调用方回退 DB created_at
          ...(startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}),
          labels: p.metadata?.labels ?? {},
        };
      });
  }

  async createSecret(name: string, data: Record<string, string>): Promise<void> {
    const body: k8s.V1Secret = {
      metadata: { name },
      stringData: data,
    };
    try {
      await this.core.createNamespacedSecret({ namespace: this.cfg.namespace, body });
    } catch (e) {
      if (isConflict(e)) {
        await this.core.replaceNamespacedSecret({ name, namespace: this.cfg.namespace, body });
        return;
      }
      throw e;
    }
  }

  async deleteSecret(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace: this.cfg.namespace });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

const statusOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? Number((e as { code: unknown }).code) : undefined;

const isNotFound = (e: unknown) => statusOf(e) === 404;
const isConflict = (e: unknown) => statusOf(e) === 409;
