/**
 * OSS 存储面板数据（S15）。沿用 hubFetch 语义：401 抛 AuthRequiredError。
 * 不做 mock 回退——宁可显示未配置/加载失败，不拿假数据冒充真实对象。
 */
import { OssListRespSchema, type OssListResp } from '@agenthub/shared/contracts';
import { AuthRequiredError, hubFetch, setDataSource } from './client.js';

export async function fetchOss(refresh = false): Promise<OssListResp> {
  try {
    const data = await hubFetch(`/api/oss${refresh ? '?refresh=1' : ''}`, (d) => OssListRespSchema.parse(d));
    setDataSource('hub');
    return data;
  } catch (e) {
    if (e instanceof AuthRequiredError) setDataSource('unauth');
    throw e;
  }
}

/** 签名下载链接（服务端先做归属校验） */
export async function signOss(key: string): Promise<string> {
  const { url } = await hubFetch(
    '/api/oss/sign',
    (d) => d as { url: string },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) },
  );
  return url;
}
