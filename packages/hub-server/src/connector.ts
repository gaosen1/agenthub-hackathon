/**
 * SandboxConnector（spec §4.5）：Hub 访问 Pod 的网络抽象
 * - DirectConnector：集群内直连 Pod IP（HUB_IN_CLUSTER=1）
 * - PortForwardConnector：开发期经 K8s API port-forward
 */
import { createServer, type Server, type Socket } from 'node:net';
import type * as k8s from '@kubernetes/client-node';

export interface PodRef {
  namespace: string;
  podName: string;
}

export interface SandboxConnector {
  getBaseUrl(pod: PodRef, port: number): Promise<string>;
  dispose(pod: PodRef): Promise<void>;
}

export class DirectConnector implements SandboxConnector {
  constructor(private readonly core: k8s.CoreV1Api) {}

  async getBaseUrl(pod: PodRef, port: number): Promise<string> {
    const res = await this.core.readNamespacedPod({ name: pod.podName, namespace: pod.namespace });
    const ip = res.status?.podIP;
    if (!ip) throw new Error(`pod ${pod.podName} has no IP yet`);
    return `http://${ip}:${port}`;
  }

  async dispose(): Promise<void> {
    // 无状态，无需清理
  }
}

interface ForwardEntry {
  server: Server;
  localPort: number;
}

export class PortForwardConnector implements SandboxConnector {
  private readonly forwards = new Map<string, ForwardEntry>();

  constructor(private readonly pf: k8s.PortForward) {}

  private keyOf(pod: PodRef, port: number): string {
    return `${pod.namespace}/${pod.podName}:${port}`;
  }

  async getBaseUrl(pod: PodRef, port: number): Promise<string> {
    const key = this.keyOf(pod, port);
    const existing = this.forwards.get(key);
    if (existing) return `http://127.0.0.1:${existing.localPort}`;

    const server = createServer((socket: Socket) => {
      this.pf
        .portForward(pod.namespace, pod.podName, [port], socket, null, socket)
        .catch(() => socket.destroy());
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('failed to bind local port'));
      });
    });
    this.forwards.set(key, { server, localPort });
    return `http://127.0.0.1:${localPort}`;
  }

  async dispose(pod: PodRef): Promise<void> {
    for (const [key, entry] of this.forwards) {
      if (key.startsWith(`${pod.namespace}/${pod.podName}:`)) {
        entry.server.close();
        this.forwards.delete(key);
      }
    }
  }
}
