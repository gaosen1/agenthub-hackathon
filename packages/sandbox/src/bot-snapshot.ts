/**
 * bot 外置存储（删除式沙箱）：沙箱无状态可丢弃，workspace + qwen 会话 chats 打快照存 OSS；
 * 新实例启动时还原（跨沙箱续记忆），运行中周期回写。
 * 快照布局：manifest.json{workspacePath} + workspace/ + chats/。
 */
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as tar from 'tar';
import { qwenHome, uploadTo } from './context.js';
import { appendLog } from './state.js';

/** 与 hub replay / 真 qwen 一致：projects 分片 = 绝对路径 dash-slug */
export const wsSlug = (p: string): string => resolve(p).replace(/\//g, '-');

const STAGE = join(tmpdir(), 'agenthub-bot-snapshot');
const PKG = join(tmpdir(), 'agenthub-bot-snapshot.tar.gz');
/** 单快照上限：超限跳过回写（防把沙箱打爆），日志告警 */
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;

/** 启动时还原；无快照（首启）/下载失败 → 默认 workspace，不致命 */
export async function restoreBotSnapshot(getUrl: string | undefined, defaultWorkspace: string): Promise<string> {
  if (!getUrl) return defaultWorkspace;
  const res = await fetch(getUrl, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  if (!res || res.status === 404) return defaultWorkspace;
  if (!res.ok) {
    appendLog('sys', `bot snapshot download failed: ${res.status}; start fresh`);
    return defaultWorkspace;
  }
  await fs.writeFile(PKG, Buffer.from(await res.arrayBuffer()));
  await fs.rm(STAGE, { recursive: true, force: true });
  await fs.mkdir(STAGE, { recursive: true });
  try {
    await tar.x({ file: PKG, cwd: STAGE });
    let workspacePath = defaultWorkspace;
    try {
      const meta = JSON.parse(await fs.readFile(join(STAGE, 'manifest.json'), 'utf8')) as { workspacePath?: string };
      if (meta.workspacePath) workspacePath = meta.workspacePath;
    } catch {
      // 无 manifest 用默认
    }
    const wsSrc = join(STAGE, 'workspace');
    if (existsSync(wsSrc)) {
      await fs.rm(workspacePath, { recursive: true, force: true });
      await fs.mkdir(dirname(workspacePath), { recursive: true });
      await fs.cp(wsSrc, workspacePath, { recursive: true });
    }
    const chatsSrc = join(STAGE, 'chats');
    if (existsSync(chatsSrc)) {
      const dest = join(qwenHome(), 'projects', wsSlug(workspacePath), 'chats');
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.cp(chatsSrc, dest, { recursive: true });
    }
    // channels 目录（CHANNEL.json 等 channel memory）一并还原，暗号跨沙箱
    const chanSrc = join(STAGE, 'channels');
    if (existsSync(chanSrc)) {
      const dest = join(qwenHome(), 'channels');
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.cp(chanSrc, dest, { recursive: true });
      // service.pid 是旧沙箱的运行时预留（exclusive-create），还原后新 serve 会报
      // channel_service_conflict 拒启动；内存文件（CHANNEL.json）不受影响
      await fs.rm(join(dest, 'service.pid'), { force: true });
    }
    appendLog('ok', `bot snapshot restored → ${workspacePath}`);
    return workspacePath;
  } catch (e) {
    appendLog('sys', `bot snapshot restore failed (${e instanceof Error ? e.message : String(e)}); start fresh`);
    return defaultWorkspace;
  } finally {
    await fs.rm(STAGE, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(PKG, { force: true }).catch(() => undefined);
  }
}

/** 周期回写；PUT URL 缺失/过期/超限 → 静默跳过（best-effort，不打断 bot） */
export async function uploadBotSnapshot(putUrl: string | undefined, workspacePath: string): Promise<void> {
  if (!putUrl || !existsSync(workspacePath)) return;
  await fs.rm(STAGE, { recursive: true, force: true });
  await fs.mkdir(join(STAGE, 'workspace'), { recursive: true });
  try {
    await fs.cp(workspacePath, join(STAGE, 'workspace'), {
      recursive: true,
      filter: (src) => !src.split(sep).includes('node_modules'),
    });
    const chatsSrc = join(qwenHome(), 'projects', wsSlug(workspacePath), 'chats');
    const entries = ['workspace', 'manifest.json'];
    if (existsSync(chatsSrc)) {
      await fs.cp(chatsSrc, join(STAGE, 'chats'), { recursive: true });
      entries.push('chats');
    }
    // channel memory（CHANNEL.json）随快照走，跨沙箱续记忆；service.pid 是运行时预留，不入快照
    const chanSrc = join(qwenHome(), 'channels');
    if (existsSync(chanSrc)) {
      await fs.cp(chanSrc, join(STAGE, 'channels'), { recursive: true });
      await fs.rm(join(STAGE, 'channels', 'service.pid'), { force: true });
      entries.push('channels');
    }
    await fs.writeFile(join(STAGE, 'manifest.json'), JSON.stringify({ workspacePath }));
    await tar.c({ cwd: STAGE, file: PKG, gzip: true }, entries);
    const st = await fs.stat(PKG);
    if (st.size > MAX_SNAPSHOT_BYTES) {
      appendLog('sys', `bot snapshot too large (${st.size}B), skip upload`);
      return;
    }
    await uploadTo(putUrl, PKG);
    appendLog('ok', `bot snapshot uploaded (${(st.size / 1024).toFixed(0)}KB)`);
  } catch (e) {
    appendLog('sys', `bot snapshot upload failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await fs.rm(STAGE, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(PKG, { force: true }).catch(() => undefined);
  }
}
