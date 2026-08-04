/**
 * 上下文还原与打包（spec §3.1 / §4.3）+ bot 路由绑定（spec §8 语义）
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { HandoffManifestSchema, getWorkspaceScopeDirName, type HandoffManifest, type ChatListItem, type HandoffResult, type SandboxEvent } from '@agenthub/shared';

const exec = promisify(execFile);

export const qwenHome = (): string => process.env.QWEN_HOME_DIR ?? join(homedir(), '.qwen');

// ── 输入包还原 ───────────────────────────────────────────
export interface RestoredContext {
  manifest: HandoffManifest;
}

export async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  await fs.mkdir(dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

export async function unpackInput(tarball: string, staging: string): Promise<HandoffManifest> {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await tar.x({ file: tarball, cwd: staging });
  const manifest = HandoffManifestSchema.parse(JSON.parse(await fs.readFile(join(staging, 'manifest.json'), 'utf8')));
  // 路径一致性自校验（spec §6.1）
  const expect = getWorkspaceScopeDirName(manifest.workspacePath);
  if (expect !== manifest.wsHash) {
    throw new Error(`wsHash mismatch: manifest=${manifest.wsHash} computed=${expect}`);
  }
  return manifest;
}

/** 还原 workspace（重建与本地一致的绝对路径）与 ~/.qwen 会话目录 */
export async function restoreContext(staging: string, manifest: HandoffManifest): Promise<void> {
  const ws = manifest.workspacePath;
  await fs.rm(ws, { recursive: true, force: true });
  await fs.mkdir(ws, { recursive: true });

  const bundle = join(staging, 'repo.bundle');
  if (await exists(bundle)) {
    await exec('git', ['clone', bundle, ws], { cwd: staging });
    await exec('git', ['checkout', manifest.repo.branch], { cwd: ws }).catch(() => undefined);
  } else {
    await exec('git', ['init', '-b', manifest.repo.branch, ws]);
  }
  const worktree = join(staging, 'worktree');
  if (await exists(worktree)) {
    await fs.cp(worktree, ws, { recursive: true, force: true });
  }

  const home = qwenHome();
  const pkgHome = join(staging, 'qwen-home');
  if (await exists(pkgHome)) {
    await fs.mkdir(home, { recursive: true });
    await fs.cp(pkgHome, home, { recursive: true, force: true });
  }
}

// ── bot channel 配置注入（spec §8.1 语义）────────────────
export async function writeChannelsConfig(home: string, botName: string, workspacePath: string): Promise<void> {
  const settingsPath = join(home, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // 无现成配置：从空对象开始
  }
  const channels = (settings['channels'] as Record<string, unknown> | undefined) ?? {};
  channels[botName] = {
    type: 'dingtalk',
    clientId: '$DINGTALK_CLIENT_ID',
    clientSecret: '$DINGTALK_CLIENT_SECRET',
    cwd: workspacePath,
    sessionScope: 'chat_thread',
    groupPolicy: 'open',
  };
  settings['channels'] = channels;
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

// ── 路由绑定（spec §8.2：改写 routes.json，daemon 懒恢复接续）──
export const routesPath = (home: string, wsHash: string): string => join(home, 'channels', 'daemon', wsHash, 'routes.json');

export async function rewriteRoute(
  home: string,
  wsHash: string,
  botName: string,
  chatId: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const path = routesPath(home, wsHash);
  let routes: Record<string, unknown> = {};
  try {
    routes = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // 首次绑定：新建路由表
  }
  const key = `${botName}:${chatId}`;
  const prev = routes[key] as { target?: unknown } | undefined;
  routes[key] = {
    sessionId,
    target: prev?.target ?? { channelName: botName, senderId: '-', chatId, isGroup: true },
    cwd,
  };
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(routes, null, 2));
}

/** 已知群列表：合并 routes.json 与 observed-contacts.json（spec §4.3 GET /chats） */
export async function listChats(home: string, wsHash: string): Promise<ChatListItem[]> {
  const seen = new Map<string, ChatListItem>();
  try {
    const routes = JSON.parse(await fs.readFile(routesPath(home, wsHash), 'utf8')) as Record<string, { target?: { chatId?: string } }>;
    for (const entry of Object.values(routes)) {
      const chatId = entry?.target?.chatId;
      if (chatId) seen.set(chatId, { chatId });
    }
  } catch {
    // 路由表尚不存在
  }
  try {
    const contactsPath = join(home, 'channels', 'daemon', wsHash, 'observed-contacts.json');
    const contacts = JSON.parse(await fs.readFile(contactsPath, 'utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(contacts)) {
      const v = value as { chatId?: string; title?: string; name?: string; lastSeenAt?: string };
      const chatId = v.chatId ?? key;
      if (!chatId) continue;
      const prev = seen.get(chatId) ?? { chatId };
      seen.set(chatId, {
        ...prev,
        ...(v.title ?? v.name ? { title: v.title ?? v.name } : {}),
        ...(v.lastSeenAt ? { lastSeenAt: v.lastSeenAt } : {}),
      });
    }
  } catch {
    // observed-contacts 尚不存在
  }
  return [...seen.values()];
}

// ── 返回包打包（spec §3.1 output）────────────────────────
export async function buildOutput(
  manifest: HandoffManifest,
  opts: { workDir: string; logs: SandboxEvent[]; status: HandoffResult['status']; startedAt: number; error?: string },
): Promise<{ tarball: string; manifest: HandoffManifest }> {
  const { workDir } = opts;
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const ws = manifest.workspacePath;

  // 云端 commit 增量
  let commitCount = 0;
  let cloudHead: string | undefined;
  try {
    cloudHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: ws })).stdout.trim();
    commitCount = Number(
      (await exec('git', ['rev-list', `${manifest.repo.baseCommit}..HEAD`, '--count'], { cwd: ws })).stdout.trim(),
    );
    if (commitCount > 0) {
      await exec('git', ['bundle', 'create', join(workDir, 'result.bundle'), `${manifest.repo.baseCommit}..HEAD`], { cwd: ws });
    }
  } catch {
    // 非 git 环境 / 无变更：返回包不含 bundle
  }

  // 会话目录（含 bot 各群的多个 session）
  const home = qwenHome();
  const chatsSrc = join(home, 'projects', manifest.wsHash);
  const newSessionIds: string[] = [];
  if (await exists(chatsSrc)) {
    const dest = join(workDir, 'qwen-home', 'projects', manifest.wsHash);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.cp(chatsSrc, dest, { recursive: true });
    try {
      for (const f of await fs.readdir(join(dest, 'chats'))) {
        const id = f.replace(/\.jsonl?$/, '').replace(/\.json$/, '');
        if (id && id !== manifest.sessionId) newSessionIds.push(id);
      }
    } catch {
      // chats 目录结构不同则跳过枚举
    }
  }

  // 日志
  await fs.mkdir(join(workDir, 'logs'), { recursive: true });
  await fs.writeFile(join(workDir, 'logs', 'events.jsonl'), opts.logs.map((e) => JSON.stringify(e)).join('\n'));

  // manifest（direction=pull + result）
  const outManifest: HandoffManifest = {
    ...manifest,
    direction: 'pull',
    createdAt: new Date().toISOString(),
    result: {
      status: opts.status,
      ...(cloudHead ? { cloudHead } : {}),
      commitCount,
      newSessionIds,
      elapsedSeconds: Math.round((Date.now() - opts.startedAt) / 1000),
      ...(opts.error ? { error: opts.error } : {}),
    },
  };
  await fs.writeFile(join(workDir, 'manifest.json'), JSON.stringify(outManifest, null, 2));

  const tarball = join(dirname(workDir), `output-${manifest.handoffId}.tar.gz`);
  await tar.c({ file: tarball, cwd: workDir, gzip: true }, await fs.readdir(workDir));
  return { tarball, manifest: outManifest };
}

export async function uploadTo(url: string, file: string): Promise<void> {
  const data = await fs.readFile(file);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body: data,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
}

export const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
