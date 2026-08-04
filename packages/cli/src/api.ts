import { createWriteStream, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ApiErrorSchema,
  AuthRespSchema,
  CreateHandoffRespSchema,
  HandoffDetailSchema,
  ListHandoffsRespSchema,
  PullIntentRespSchema,
} from '@agenthub/shared';
import type {
  AuthResp,
  CreateHandoffReq,
  CreateHandoffResp,
  HandoffDetail,
  ListHandoffsResp,
  PullIntentResp,
} from '@agenthub/shared';
import type { CliConfig } from './config.js';

export class HubApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

/** hub-server REST 客户端（§4.2） */
export class HubClient {
  constructor(private readonly cfg: CliConfig) {}

  private async request<T>(method: string, path: string, body?: unknown, parse?: (d: unknown) => T): Promise<T> {
    // 无 body 时不能带 json content-type（Fastify 会拒绝空 JSON body）
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    if (this.cfg.token) headers['authorization'] = `Bearer ${this.cfg.token}`;
    const resp = await fetch(`${this.cfg.hubUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = resp.status === 204 ? undefined : await resp.json().catch(() => undefined);
    if (!resp.ok) {
      const err = ApiErrorSchema.safeParse(data);
      if (err.success) throw new HubApiError(err.data.error.code, err.data.error.message, resp.status);
      throw new HubApiError('ERR_UNKNOWN', `HTTP ${resp.status} ${path}`, resp.status);
    }
    return parse ? parse(data) : (data as T);
  }

  login(username: string, password: string): Promise<AuthResp> {
    return this.request('POST', '/api/auth/login', { username, password }, (d) => AuthRespSchema.parse(d));
  }

  register(username: string, password: string): Promise<AuthResp> {
    return this.request('POST', '/api/auth/register', { username, password }, (d) => AuthRespSchema.parse(d));
  }

  createHandoff(req: CreateHandoffReq): Promise<CreateHandoffResp> {
    return this.request('POST', '/api/handoffs', req, (d) => CreateHandoffRespSchema.parse(d));
  }

  markUploaded(id: string): Promise<{ status: string }> {
    return this.request('POST', `/api/handoffs/${id}/uploaded`);
  }

  getHandoff(id: string): Promise<HandoffDetail> {
    return this.request('GET', `/api/handoffs/${id}`, undefined, (d) => HandoffDetailSchema.parse(d));
  }

  listHandoffs(query: { agentName?: string; status?: string; limit?: number } = {}): Promise<ListHandoffsResp> {
    const qs = new URLSearchParams();
    if (query.agentName) qs.set('agentName', query.agentName);
    if (query.status) qs.set('status', query.status);
    if (query.limit) qs.set('limit', String(query.limit));
    const suffix = qs.size > 0 ? `?${qs}` : '';
    return this.request('GET', `/api/handoffs${suffix}`, undefined, (d) => ListHandoffsRespSchema.parse(d));
  }

  cancel(id: string): Promise<{ status: string }> {
    return this.request('POST', `/api/handoffs/${id}/cancel`);
  }

  pullIntent(id: string): Promise<PullIntentResp> {
    return this.request('POST', `/api/handoffs/${id}/pull-intent`, undefined, (d) => PullIntentRespSchema.parse(d));
  }
}

/** OSS 签名 URL 直传（PUT tar.gz） */
export async function uploadToSignedUrl(url: string, filePath: string): Promise<void> {
  const body = readFileSync(filePath);
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body,
  });
  if (!resp.ok) throw new HubApiError('ERR_OSS', `上传失败 HTTP ${resp.status}`, resp.status);
}

/** OSS 签名 URL 直取（GET tar.gz） */
export async function downloadFromSignedUrl(url: string, filePath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new HubApiError('ERR_OSS', `下载失败 HTTP ${resp.status}`, resp.status);
  await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(filePath));
}
