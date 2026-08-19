/**
 * OSS 客户端装配与归属校验（S11）。
 *
 * 最重要的一条：缺凭证时必须降级为 NullOssClient 而不是在构造时抛异常。
 * 改造前 createOssSigner() 会在 new OSS(...) 处抛
 * "require accessKeyId, accessKeySecret"，导致 hub-server 在没有 OSS 凭证的机器上
 * 根本起不来——本地开发和降级部署都被卡死。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiFail } from './state.js';
import { SIGNED_URL_TTL_SECONDS, assertOwnedKey, createOssClient, ossKeyOf, userPrefix } from './oss.js';

const OSS_ENV = ['OSS_BUCKET', 'OSS_AK', 'OSS_SK', 'OSS_REGION', 'OSS_STS_TOKEN', 'HUB_NO_OSS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(OSS_ENV.map((k) => [k, process.env[k]]));
  for (const k of OSS_ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of OSS_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('createOssClient 降级', () => {
  it('缺凭证时不抛异常，返回未配置的替身', () => {
    // 关键回归：这里一旦抛异常，hub-server 在无凭证机器上就起不来
    const oss = createOssClient();
    expect(oss.configured).toBe(false);
  });

  it('HUB_NO_OSS=1 强制降级，即使凭证齐全', () => {
    process.env.OSS_BUCKET = 'agenthub-handoff-test';
    process.env.OSS_AK = 'ak';
    process.env.OSS_SK = 'sk';
    process.env.HUB_NO_OSS = '1';

    expect(createOssClient().configured).toBe(false);
  });

  it('凭证齐全时启用真实客户端', () => {
    process.env.OSS_BUCKET = 'agenthub-handoff-test';
    process.env.OSS_AK = 'ak';
    process.env.OSS_SK = 'sk';

    expect(createOssClient().configured).toBe(true);
  });

  it('未配置时签名报 ERR_OSS，而不是返回一个无效 URL', async () => {
    const oss = createOssClient();

    await expect(oss.signGet('handoffs/1/hf-a/input.tar.gz')).rejects.toBeInstanceOf(ApiFail);
    await expect(oss.signPut('handoffs/1/hf-a/input.tar.gz')).rejects.toMatchObject({ code: 'ERR_OSS' });
  });

  it('未配置时列举返回空、head 返回 null、bucket 信息为 null——面板渲染未配置态', async () => {
    const oss = createOssClient();

    expect(await oss.list(userPrefix(1))).toEqual({ objects: [], truncated: false });
    expect(await oss.head('handoffs/1/hf-a/input.tar.gz')).toBeNull();
    expect(await oss.bucketInfo()).toBeNull();
  });
});

describe('key 归属校验', () => {
  it('key 用数字 user_id，不是用户名', () => {
    expect(ossKeyOf(1, 'hf-9f3a2c', 'input.tar.gz')).toBe('handoffs/1/hf-9f3a2c/input.tar.gz');
    expect(userPrefix(42)).toBe('handoffs/42/');
  });

  it('本人前缀下的 key 通过', () => {
    expect(() => assertOwnedKey(1, 'handoffs/1/hf-a/input.tar.gz')).not.toThrow();
  });

  it('他人 key 一律 403', () => {
    expect(() => assertOwnedKey(1, 'handoffs/2/hf-a/input.tar.gz')).toThrow(ApiFail);
    expect(() => assertOwnedKey(1, 'handoffs/2/hf-a/input.tar.gz')).toThrow(/not owned/);
  });

  it('前缀相似但不同的用户不能混过（handoffs/1 vs handoffs/11）', () => {
    expect(() => assertOwnedKey(1, 'handoffs/11/hf-a/input.tar.gz')).toThrow(ApiFail);
  });

  it('路径穿越一律 403', () => {
    expect(() => assertOwnedKey(1, 'handoffs/1/../2/hf-a/input.tar.gz')).toThrow(ApiFail);
    expect(() => assertOwnedKey(1, '../../etc/passwd')).toThrow(ApiFail);
  });

  it('签名有效期是可读常量，面板据此显示', () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(1800);
  });
});
