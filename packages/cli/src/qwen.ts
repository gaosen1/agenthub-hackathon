import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceScopeDirName } from '@agenthub/shared';

/** qwen 本地存储定位；QWEN_HOME 可覆盖（测试/多环境） */

export function qwenHome(): string {
  return process.env.QWEN_HOME ?? join(homedir(), '.qwen');
}

export function chatsDir(workspacePath: string): string {
  return join(qwenHome(), 'projects', getWorkspaceScopeDirName(workspacePath), 'chats');
}

export function sessionPath(workspacePath: string, sessionId: string): string {
  return join(chatsDir(workspacePath), `${sessionId}.jsonl`);
}

/** 缺省 session：当前 workspace 下最近修改的 jsonl */
export function latestSessionId(workspacePath: string): string | undefined {
  const dir = chatsDir(workspacePath);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.f.replace(/\.jsonl$/, '');
}

/** 剔除密钥后的 settings.json 内容（§3.1）；不存在返回 undefined */
export function sanitizedSettings(): string | undefined {
  const p = join(qwenHome(), 'settings.json');
  if (!existsSync(p)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const SECRET_KEY_RE = /apikey|api_key|secret|token|password|credential/i;
    const strip = (obj: unknown): unknown => {
      if (Array.isArray(obj)) return obj.map(strip);
      if (obj !== null && typeof obj === 'object') {
        return Object.fromEntries(
          Object.entries(obj as Record<string, unknown>)
            .filter(([k]) => !SECRET_KEY_RE.test(k))
            .map(([k, v]) => [k, strip(v)]),
        );
      }
      return obj;
    };
    const cleaned = strip(settings) as Record<string, unknown>;
    // hooks 引用本地绝对路径脚本，云端还原后必然 Warn 并混入模型输出（hf-351dcf 实测），不随包携带
    delete cleaned['hooks'];
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return undefined;
  }
}

export function qwenVersion(): string {
  try {
    return execFileSync('qwen', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
