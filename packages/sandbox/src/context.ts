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
    sessionScope: 'perChat',
    senderPolicy: 'open',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': { requireMention: true } },
    useConnectionManager: true,
  };
  settings['channels'] = channels;
  // qwen serve 需要完整的模型 provider 配置才能用正确的端点和 key
  if (!settings['model']) {
    settings['model'] = {
      name: '$OPENAI_MODEL',
      baseUrl: '$OPENAI_BASE_URL',
    };
  }
  if (!settings['modelProviders']) {
    settings['modelProviders'] = {
      openai: [
        {
          id: '$OPENAI_MODEL',
          name: '[DashScope] model',
          envKey: 'DASHSCOPE_API_KEY',
          baseUrl: '$OPENAI_BASE_URL',
        },
      ],
    };
  }
  if (!settings['security']) {
    settings['security'] = { auth: { selectedType: 'openai' } };
  }
  const env = (settings['env'] as Record<string, unknown> | undefined) ?? {};
  if (!env['DASHSCOPE_API_KEY']) {
    env['DASHSCOPE_API_KEY'] = '$DASHSCOPE_API_KEY';
  }
  settings['env'] = env;
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

// ── 路由绑定（spec §8.2：改写 routes.json，daemon 懒恢复接续）──
export const routesPath = (home: string, wsHash: string): string => join(home, 'channels', 'daemon', wsHash, 'routes.json');

/** 从 observed-contacts.json 查找群内所有已知用户 ID（daemon 用 channelName:senderId:chatId 三段式 key） */
async function resolveSenderIds(home: string, botName: string, chatId: string): Promise<string[]> {
  const ids: string[] = [];
  const daemonDir = join(home, 'channels', 'daemon');
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(daemonDir, { withFileTypes: true }); } catch { return ids; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(await fs.readFile(join(daemonDir, entry.name, 'observed-contacts.json'), 'utf8')) as { observations?: Array<{ channelName?: string; user?: { id?: string }; group?: { id?: string } }> };
      for (const obs of raw.observations ?? []) {
        if (obs.channelName === botName && obs.group?.id === chatId && obs.user?.id) ids.push(obs.user.id);
      }
    } catch { /* skip */ }
  }
  return [...new Set(ids)];
}

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
  // 删除旧的两段式路由（channelName:chatId）
  const oldKey = `${botName}:${chatId}`;
  delete routes[oldKey];

  // 从 observed-contacts.json 获取群内已知用户，写三段式路由（channelName:senderId:chatId）
  const senderIds = await resolveSenderIds(home, botName, chatId);
  if (senderIds.length > 0) {
    for (const senderId of senderIds) {
      const key = `${botName}:${senderId}:${chatId}`;
      const prev = routes[key] as { target?: unknown } | undefined;
      routes[key] = {
        sessionId,
        target: prev?.target ?? { channelName: botName, senderId, chatId, isGroup: true },
        cwd,
      };
    }
  } else {
    // 无用户记录时用两段式兼容
    routes[oldKey] = {
      sessionId,
      target: { channelName: botName, senderId: '-', chatId, isGroup: true },
      cwd,
    };
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(routes, null, 2));
}

/** 已知群列表：合并 routes.json 与 observed-contacts.json（spec §4.3 GET /chats）
 *  routes.json 和 observed-contacts.json 可能在不同的 daemon workspace 目录下，
 *  扫描所有子目录以兼容 qwen serve daemon 的实际 hash。 */
export async function listChats(home: string, wsHash: string): Promise<ChatListItem[]> {
  const seen = new Map<string, ChatListItem>();
  const daemonDir = join(home, 'channels', 'daemon');

  // 先读指定 wsHash 的 routes.json
  try {
    const routes = JSON.parse(await fs.readFile(routesPath(home, wsHash), 'utf8')) as Record<string, { target?: { chatId?: string } }>;
    for (const entry of Object.values(routes)) {
      const chatId = entry?.target?.chatId;
      if (chatId) seen.set(chatId, { chatId });
    }
  } catch {
    // 路由表尚不存在
  }

  // 扫描所有 daemon 子目录，合并 routes.json 和 observed-contacts.json
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(daemonDir, { withFileTypes: true });
  } catch {
    return [...seen.values()];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(daemonDir, entry.name);

    // 读 routes.json
    try {
      const routes = JSON.parse(await fs.readFile(join(dir, 'routes.json'), 'utf8')) as Record<string, { target?: { chatId?: string } }>;
      for (const e of Object.values(routes)) {
        const chatId = e?.target?.chatId;
        if (chatId) seen.set(chatId, { chatId });
      }
    } catch {
      // 跳过
    }

    // 读 observed-contacts.json（qwen serve 格式：{version, observations: [...]}）
    try {
      const raw = JSON.parse(await fs.readFile(join(dir, 'observed-contacts.json'), 'utf8')) as Record<string, unknown>;
      // 新格式：{ version, observations: [{ channelName, user: {id,label}, group: {id,label}, lastObservedAt }] }
      if (Array.isArray((raw as { observations?: unknown[] }).observations)) {
        for (const obs of (raw as { observations: Array<{ group?: { id?: string; label?: string }; user?: { id?: string; label?: string }; lastObservedAt?: string }> }).observations) {
          const chatId = obs.group?.id;
          if (!chatId) continue;
          const prev = seen.get(chatId) ?? { chatId };
          seen.set(chatId, {
            ...prev,
            ...(obs.group?.label ? { title: obs.group.label } : {}),
            ...(obs.lastObservedAt ? { lastSeenAt: obs.lastObservedAt } : {}),
          });
        }
      } else {
        // 旧格式兼容：Record<string, {chatId, title, ...}>
        for (const [key, value] of Object.entries(raw)) {
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
      }
    } catch {
      // observed-contacts 尚不存在
    }
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

  // 云端 commit 增量；打包前先把 Agent 未提交的变更兜底 commit（design.md §6：云端所有变更以 commit 落盘）
  let commitCount = 0;
  let cloudHead: string | undefined;
  try {
    const dirty = (await exec('git', ['status', '--porcelain'], { cwd: ws })).stdout.trim();
    if (dirty) {
      await exec('git', ['config', 'user.email', 'cloud-agent@agenthub'], { cwd: ws });
      await exec('git', ['config', 'user.name', 'cloud-agent'], { cwd: ws });
      await exec('git', ['add', '-A'], { cwd: ws });
      await exec('git', ['commit', '-m', 'chore(agenthub): auto-commit cloud changes before snapshot', '--no-verify'], { cwd: ws });
    }
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
