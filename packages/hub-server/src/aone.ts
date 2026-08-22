/**
 * Aone Sandbox 后端（弹内免费算力）：实现与 K8s 相同的 PodOrchestrator/SandboxConnector 两接口，
 * worker/app 上层零改动。pod_name == Aone sandboxId（create 返回真实 id，调用方落库）。
 *
 * SDK @ali/aone-sandbox 走内网 registry，不进 package.json：运行时动态加载，
 * 公有云构建不受影响；SANDBOX_BACKEND=aone 但 SDK 缺失时给出明确错误。
 */
import type { PodOrchestrator, PodPhase, SandboxPodInfo, SandboxPodSpec } from './k8s.js';
import type { PodRef, SandboxConnector } from './connector.js';

/** SDK 结构子集（仅依赖面），测试以替身注入 */
export interface AoneSandboxLike {
  id: string;
  getEndpointUrl(port: number): Promise<string>;
  getInfo(): Promise<{ status?: { state?: string } }>;
  kill(): Promise<void>;
  close(): Promise<void>;
}
export interface AoneSdkLike {
  create(opts: Record<string, unknown>): Promise<AoneSandboxLike>;
  connect(opts: Record<string, unknown>): Promise<AoneSandboxLike>;
}

export const aoneDeps = {
  loadSdk: async (): Promise<AoneSdkLike> => {
    const spec = '@ali/aone-sandbox';
    try {
      const m = (await import(/* @vite-ignore */ spec)) as unknown as { Sandbox: AoneSdkLike };
      return m.Sandbox;
    } catch (e) {
      throw new Error(
        `SANDBOX_BACKEND=aone 需要内网 SDK @ali/aone-sandbox（内网 registry 安装；公有云请用 SANDBOX_BACKEND=k8s）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export interface AoneConfig {
  apiKey: string;
  /** 内网 registry 镜像（runner 烤入） */
  image: string;
  /** 容器启动命令（镜像 CMD 不会被 Aone 沿用，需显式给） */
  entrypoint: string;
  timeoutSeconds: number;
  resource?: { cpu: string; memory: string };
}

const STATE_TO_PHASE: Record<string, PodPhase> = {
  Running: 'ready',
  Pending: 'pending',
  Pausing: 'pending',
  Paused: 'pending',
  Failed: 'failed',
  Terminated: 'failed',
  Stopped: 'failed',
};

export class AoneOrchestrator implements PodOrchestrator {
  private handles = new Map<string, AoneSandboxLike>();
  private labels = new Map<string, Record<string, string>>();
  private secrets = new Map<string, Record<string, string>>();

  constructor(private cfg: AoneConfig, private sdk: AoneSdkLike) {}

  private conn(): Record<string, unknown> {
    return { connectionConfig: { apiKey: this.cfg.apiKey } };
  }

  /** 按 id 取句柄；hub 重启后 map 丢失时经 connect 重连（readiness 失败不杀远端实例） */
  async handle(name: string): Promise<AoneSandboxLike> {
    const hit = this.handles.get(name);
    if (hit) return hit;
    const sb = await this.sdk.connect({ ...this.conn(), sandboxId: name });
    this.handles.set(name, sb);
    return sb;
  }

  private async provision(spec: SandboxPodSpec): Promise<string> {
    const env: Record<string, string> = { ...spec.env };
    for (const ref of spec.secretRefs) Object.assign(env, this.secrets.get(ref) ?? {});
    const sb = await this.sdk.create({
      ...this.conn(),
      dynamicTemplate: { image: this.cfg.image, entrypoint: this.cfg.entrypoint },
      timeoutSeconds: this.cfg.timeoutSeconds,
      env,
      ...(this.cfg.resource ? { resource: this.cfg.resource } : {}),
      metadata: { ...spec.labels },
    });
    this.handles.set(sb.id, sb);
    this.labels.set(sb.id, spec.labels);
    return sb.id;
  }

  createPod(spec: SandboxPodSpec): Promise<string> {
    return this.provision(spec);
  }

  /** bot 常驻 = 长 TTL sandbox；v1 不做自动重建（pause/resume 后续迭代） */
  createDeployment(spec: SandboxPodSpec): Promise<string> {
    return this.provision(spec);
  }

  async deletePod(name: string): Promise<void> {
    const sb = await this.handle(name).catch(() => undefined);
    if (sb) {
      await sb.kill().catch(() => undefined);
      await sb.close().catch(() => undefined);
    }
    this.handles.delete(name);
    this.labels.delete(name);
  }

  deleteDeployment(name: string): Promise<void> {
    return this.deletePod(name);
  }

  async getPodPhase(name: string): Promise<PodPhase> {
    const sb = await this.handle(name).catch(() => undefined);
    if (!sb) return 'gone';
    const info = await sb.getInfo().catch(() => undefined);
    const st = info?.status?.state;
    return (st && STATE_TO_PHASE[st]) || 'pending';
  }

  /** v1：返回本 hub 知晓的实例；全量查询走 SandboxManager.listSandboxInfos（后续迭代） */
  async listSandboxPods(): Promise<SandboxPodInfo[]> {
    return [...this.labels.entries()].map(([name, labels]) => ({ name, phase: 'ready' as PodPhase, labels }));
  }

  /** Aone 无 Secret 对象：内存暂存，create 时并入 env（敏感值不进镜像层） */
  async createSecret(name: string, data: Record<string, string>): Promise<void> {
    this.secrets.set(name, data);
  }

  async deleteSecret(name: string): Promise<void> {
    this.secrets.delete(name);
  }

  async findPodNameByLabel(want: Record<string, string>): Promise<string | undefined> {
    for (const [name, labels] of this.labels) {
      if (Object.entries(want).every(([k, v]) => labels[k] === v)) return name;
    }
    return undefined;
  }
}

/** 网关直连：每端口 https/wss 入口 URL，无隧道无缓存，invalidate/dispose 皆 no-op */
export class AoneConnector implements SandboxConnector {
  constructor(private orch: AoneOrchestrator) {}

  async getBaseUrl(pod: PodRef, port: number): Promise<string> {
    const sb = await this.orch.handle(pod.podName);
    return await sb.getEndpointUrl(port);
  }

  invalidate(): void {
    // 网关无状态，无通道缓存
  }

  async dispose(): Promise<void> {
    // kill 由 deletePod 负责
  }
}
