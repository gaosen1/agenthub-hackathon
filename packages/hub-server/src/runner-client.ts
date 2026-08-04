/**
 * runner 控制面客户端（spec §4.3），Worker/API 经 SandboxConnector 调用
 */
import type { ChatListItem, HandoffManifest, RunnerHealthzResp, RunnerLoadReq, RunnerSnapshotReq, RunnerBindReq, SandboxEvent } from '@agenthub/shared';

export class RunnerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-runner-token': this.token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new RunnerError(res.status, `runner ${method} ${path} -> ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as T;
  }

  healthz(): Promise<RunnerHealthzResp> {
    return this.call('GET', '/healthz');
  }

  load(req: RunnerLoadReq): Promise<{ accepted: boolean }> {
    return this.call('POST', '/load', req);
  }

  snapshot(req: RunnerSnapshotReq): Promise<{ manifest: HandoffManifest }> {
    return this.call('POST', '/snapshot', req);
  }

  chats(): Promise<{ items: ChatListItem[] }> {
    return this.call('GET', '/chats');
  }

  bind(req: RunnerBindReq): Promise<{ ok: boolean }> {
    return this.call('POST', '/bind', req);
  }

  logs(after: number): Promise<{ items: SandboxEvent[]; nextAfter: number }> {
    return this.call('GET', `/logs?after=${after}`);
  }
}
