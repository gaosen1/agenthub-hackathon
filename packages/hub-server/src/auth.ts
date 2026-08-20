/**
 * 认证：argon2id 口令哈希 + HS256 JWT（spec §3.8 / §4.2）
 * JWT 手写 HS256（零依赖），payload: {uid, sub, iat, exp}
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64url');

export interface JwtPayload {
  uid: number;
  sub: string;
  /** token 版本（S17）：轮换后旧 token 立刻失效；verifyJwt 保持无状态，比对在 requireAuth */
  tv?: number;
  iat: number;
  exp: number;
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password); // 默认 argon2id
}

export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hashStr, password);
  } catch {
    return false;
  }
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, ttlSeconds = 7 * 86400): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(full));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expect = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
