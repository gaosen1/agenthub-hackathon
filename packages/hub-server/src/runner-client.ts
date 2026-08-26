/**
 * runner 控制面客户端（spec §4.3），Worker/API 经 SandboxConnector 调用
 */
import type { ChatListItem, HandoffManifest, RunnerHealthzResp, RunnerIdeStatusResp, RunnerLoadReq, RunnerSnapshotReq, RunnerBindReq, SandboxEvent } from '@agenthub/shared';

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

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-runner-token': this.token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
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
    // 打包+上传返回包、依赖缓存（node_modules 最高 1.5GB）与 warm bundle 串行执行，
    // 大仓库分钟级：30s 通用超时会 abort 掉正在上传的成功任务（hf-dbe36d 事故），env 可调
    return this.call('POST', '/snapshot', req, Number(process.env.RUNNER_SNAPSHOT_TIMEOUT_MS ?? 600_000));
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

  ensureIde(): Promise<RunnerIdeStatusResp> {
    // 空 {} 而非无 body：call 固定带 application/json 头，fastify 拒绝空 JSON body
    return this.call('POST', '/ide/ensure', {});
  }

  ideStatus(): Promise<RunnerIdeStatusResp> {
    return this.call('GET', '/ide/status');
  }
}
