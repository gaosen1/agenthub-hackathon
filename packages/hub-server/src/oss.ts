/**
 * OSS 访问（spec §3.9 / §4.2）
 *
 * `OssSigner` 有意保持窄接口——worker 与 handoff 路由只需要签名，
 * 且有 4 个测试 Fake 实现它。OSS 面板需要的列举/统计能力放在 `OssClient` 里。
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import OSS from 'ali-oss';
import { fail } from './state.js';

const exec = promisify(execCb);

export interface OssSigner {
  /** PUT 上传签名 URL；ttl 默认 30min，bot 快照等长寿命场景可传 7d */
  signPut(key: string, ttlSeconds?: number): Promise<string>;
  /** GET 下载签名 URL */
  signGet(key: string): Promise<string>;
}

export interface OssObject {
  key: string;
  size: number;
  lastModified: string;
  storageClass?: string;
}

export interface BucketInfo {
  bucket: string;
  region: string;
  storageClass?: string;
  /** 服务端加密算法（未开启则为 undefined） */
  sse?: string;
  /** handoffs/ 前缀的生命周期天数；面板据此算过期时间，不写死 7 */
  lifecycleDays?: number;
}

/** 签名 URL 有效期。面板要显示这个值，所以必须是可读的常量而不是散落的字面量。 */
export const SIGNED_URL_TTL_SECONDS = 1800;

export interface OssClient extends OssSigner {
  /** 未配置凭证时为 false，路由据此返回 configured:false 让面板渲染未配置态 */
  readonly configured: boolean;
  list(prefix: string, max?: number): Promise<{ objects: OssObject[]; truncated: boolean }>;
  head(key: string): Promise<OssObject | null>;
  /** 读取小对象内容（sidecar 等）；404 返回 null */
  get(key: string): Promise<Buffer | null>;
  /** 删除对象（handoff 删除时 best-effort 清理）；404 视为成功 */
  deleteObject(key: string): Promise<void>;
  bucketInfo(): Promise<BucketInfo | null>;
}

export const ossKeyOf = (userId: number, handoffId: string, file: 'input.tar.gz' | 'output.tar.gz') =>
  `handoffs/${userId}/${handoffId}/${file}`;

/** S19 依赖缓存对象 key（落用户前缀下，受归属校验与生命周期约束） */
export const depsCacheKeyOf = (userId: number, wsHash: string) => `handoffs/${userId}/deps/${wsHash}.tar.gz`;
export const depsSidecarKeyOf = (userId: number, wsHash: string) => `handoffs/${userId}/deps/${wsHash}.json`;

/** S20 warm 全量 bundle key：下次 push 只传 delta，Pod 集群内下载全量合成 */
export const warmBundleKeyOf = (userId: number, wsHash: string) => `handoffs/${userId}/deps/${wsHash}.bundle`;
export const warmSidecarKeyOf = (userId: number, wsHash: string) => `handoffs/${userId}/deps/${wsHash}.bundle.json`;

/** 需要 list/head/get 等宽接口时鸭子判断；测试 Fake 只实现窄 OssSigner 则返回 undefined */
export const asOssClient = (s: OssSigner): OssClient | undefined =>
  typeof (s as Partial<OssClient>).head === 'function' ? (s as OssClient) : undefined;

/** 某用户名下所有对象的 key 前缀 */
export const userPrefix = (userId: number) => `handoffs/${userId}/`;

/**
 * 归属校验。**永不接受客户端传来的原始 key 去签名**——必须先确认它落在调用者
 * 自己的前缀下，否则任何登录用户都能签出别人的输入包。
 */
export function assertOwnedKey(userId: number, key: string): void {
  if (key.includes('..') || !key.startsWith(userPrefix(userId))) {
    throw fail(403, 'ERR_FORBIDDEN', 'object not owned by caller');
  }
}

/** 未配置 OSS 时的替身：签名直接报错，列举返回空，而不是伪造数据或在启动时崩掉 */
class NullOssClient implements OssClient {
  readonly configured = false;
  async signPut(): Promise<string> {
    throw fail(503, 'ERR_OSS', 'oss not configured');
  }
  async signGet(): Promise<string> {
    throw fail(503, 'ERR_OSS', 'oss not configured');
  }
  async deleteObject(): Promise<void> {
    // 未配置即无对象可删：best-effort 语义下静默成功
  }
  async list() {
    return { objects: [], truncated: false };
  }
  async head() {
    return null;
  }
  async get() {
    return null;
  }
  async bucketInfo() {
    return null;
  }
}

/** STS 续期命令输出解析（aliyun CLI AssumeRole 的 JSON 结构） */
interface StsRefreshOutput {
  Credentials?: { AccessKeyId?: string; AccessKeySecret?: string; SecurityToken?: string };
}

class AliOssClient implements OssClient {
  readonly configured = true;
  private client: OSS;

  constructor(
    private readonly bucket: string,
    private readonly region: string,
    ak: string,
    sk: string,
    stsToken?: string,
    stsRefreshCmd?: string,
  ) {
    this.client = this.buildClient(ak, sk, stsToken);
    // STS 凭证最长 1 小时；配置了续期命令时定时重建客户端。
    // 不用 ali-oss 自带的 refreshSTSToken：它只在异步请求时触发，
    // 而我们主要用同步的 signatureUrl，不会触发刷新。
    if (stsRefreshCmd) {
      const timer = setInterval(() => {
        void (async () => {
          try {
            const { stdout } = await exec(stsRefreshCmd, { timeout: 30_000 });
            const c = (JSON.parse(stdout) as StsRefreshOutput).Credentials;
            if (!c?.AccessKeyId || !c.AccessKeySecret || !c.SecurityToken) return;
            this.client = this.buildClient(c.AccessKeyId, c.AccessKeySecret, c.SecurityToken);
            console.log('[oss] sts credentials refreshed');
          } catch (e) {
            console.error(`[oss] sts refresh failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
      }, 50 * 60_000); // 提前于 1 小时过期刷新
      timer.unref();
    }
  }

  private buildClient(ak: string, sk: string, stsToken?: string): OSS {
    return new OSS({
      region: this.region,
      bucket: this.bucket,
      accessKeyId: ak,
      accessKeySecret: sk,
      ...(stsToken ? { stsToken } : {}),
    });
  }

  async signPut(key: string, ttlSeconds?: number): Promise<string> {
    return this.client.signatureUrl(key, {
      method: 'PUT',
      expires: ttlSeconds ?? SIGNED_URL_TTL_SECONDS,
      'Content-Type': 'application/gzip',
    });
  }

  async signGet(key: string): Promise<string> {
    return this.client.signatureUrl(key, { method: 'GET', expires: SIGNED_URL_TTL_SECONDS });
  }

  async list(prefix: string, max = 1000): Promise<{ objects: OssObject[]; truncated: boolean }> {
    try {
      const res = await this.client.listV2({ prefix, 'max-keys': max }, {});
      const objects = (res.objects ?? []).map((o) => ({
        key: o.name,
        size: Number(o.size ?? 0),
        lastModified: new Date(o.lastModified).toISOString(),
        ...(o.storageClass ? { storageClass: o.storageClass } : {}),
      }));
      return { objects, truncated: res.isTruncated === true };
    } catch (e) {
      throw fail(502, 'ERR_OSS', `oss list failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async head(key: string): Promise<OssObject | null> {
    try {
      const res = await this.client.head(key);
      const headers = res.res.headers as Record<string, string | undefined>;
      return {
        key,
        size: Number(headers['content-length'] ?? 0),
        lastModified: new Date(headers['last-modified'] ?? Date.now()).toISOString(),
        ...(headers['x-oss-storage-class'] ? { storageClass: headers['x-oss-storage-class'] } : {}),
      };
    } catch (e) {
      // 对象不存在（已过期被生命周期清理）是正常情况，不是错误
      if ((e as { status?: number }).status === 404) return null;
      throw fail(502, 'ERR_OSS', `oss head failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.get(key);
      return res.content as Buffer;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw fail(502, 'ERR_OSS', `oss get failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return;
      throw fail(502, 'ERR_OSS', `oss delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async bucketInfo(): Promise<BucketInfo | null> {
    const info: BucketInfo = { bucket: this.bucket, region: this.region };
    try {
      const res = (await this.client.getBucketInfo(this.bucket)) as {
        bucket?: { StorageClass?: string; ServerSideEncryptionRule?: { SSEAlgorithm?: string } };
      };
      if (res.bucket?.StorageClass) info.storageClass = res.bucket.StorageClass;
      const sse = res.bucket?.ServerSideEncryptionRule?.SSEAlgorithm;
      if (sse && sse !== 'None') info.sse = sse;
    } catch {
      // 没有 GetBucketInfo 权限时降级：仍返回名字与区域，不要整卡失败
    }
    try {
      const rules = (await this.client.getBucketLifecycle(this.bucket)) as {
        rules?: Array<{ prefix?: string; expiration?: { days?: string | number } }>;
      };
      const rule = (rules.rules ?? []).find((r) => (r.prefix ?? '').startsWith('handoffs'));
      const days = Number(rule?.expiration?.days);
      if (Number.isFinite(days) && days > 0) info.lifecycleDays = days;
    } catch {
      // 同上：生命周期规则读不到就不显示过期时间，不编一个 7
    }
    return info;
  }
}

/**
 * 装配 OSS 客户端。
 *
 * 缺凭证时返回 NullOssClient——此前的 `createOssSigner()` 会在 `new OSS(...)` 处
 * 直接抛 `require accessKeyId, accessKeySecret`，导致 hub-server 在没有 OSS 凭证的
 * 机器上**根本起不来**（本地开发与降级部署都被卡死）。对齐 HUB_NO_K8S 的先例。
 */
export function createOssClient(): OssClient {
  const bucket = process.env.OSS_BUCKET;
  const ak = process.env.OSS_AK;
  const sk = process.env.OSS_SK;
  if (process.env.HUB_NO_OSS === '1' || !bucket || !ak || !sk) return new NullOssClient();
  return new AliOssClient(
    bucket,
    process.env.OSS_REGION ?? 'oss-cn-hangzhou',
    ak,
    sk,
    process.env.OSS_STS_TOKEN,
    process.env.OSS_STS_REFRESH_CMD,
  );
}
