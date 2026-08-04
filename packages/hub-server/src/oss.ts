/**
 * OSS 签名 URL（spec §3.9 / §4.2）
 * 生产实现用 ali-oss signatureUrl；测试注入 FakeSigner。
 */
import OSS from 'ali-oss';

export interface OssSigner {
  /** PUT 上传签名 URL（30min） */
  signPut(key: string): Promise<string>;
  /** GET 下载签名 URL（30min） */
  signGet(key: string): Promise<string>;
}

export const ossKeyOf = (userId: number, handoffId: string, file: 'input.tar.gz' | 'output.tar.gz') =>
  `handoffs/${userId}/${handoffId}/${file}`;

export function createOssSigner(): OssSigner {
  const client = new OSS({
    region: process.env.OSS_REGION ?? 'oss-cn-hangzhou',
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_AK ?? '',
    accessKeySecret: process.env.OSS_SK ?? '',
    ...(process.env.OSS_STS_TOKEN ? { stsToken: process.env.OSS_STS_TOKEN } : {}),
  });
  return {
    async signPut(key) {
      return client.signatureUrl(key, { method: 'PUT', expires: 1800, 'Content-Type': 'application/gzip' });
    },
    async signGet(key) {
      return client.signatureUrl(key, { method: 'GET', expires: 1800 });
    },
  };
}
