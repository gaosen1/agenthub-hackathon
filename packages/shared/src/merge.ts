import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { HandoffMarkerSchema, MergedMarkerSchema } from './manifest.js';
import type { HandoffMarker, MergedMarker } from './manifest.js';

/** §3.4 合并器错误：共同前缀校验失败（不动本地文件） */
export class MergePrefixMismatchError extends Error {
  readonly code = 'ERR_MERGE_PREFIX_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'MergePrefixMismatchError';
  }
}

interface ParsedLine {
  raw: string;
  json: Record<string, unknown> | null;
}

function parseLines(content: string): ParsedLine[] {
  return content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((raw) => {
      try {
        return { raw, json: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        return { raw, json: null };
      }
    });
}

/** 提取行时间戳（§3.4 最小字段集：timestamp 或等价时间字段） */
function lineTimestamp(line: ParsedLine): number {
  const j = line.json;
  if (!j) return 0;
  const v = j['timestamp'] ?? j['ts'] ?? j['time'] ?? j['createdAt'];
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof v === 'number') return v;
  return 0;
}

function findMarker(lines: ParsedLine[], handoffId: string): { index: number; marker: HandoffMarker } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i].json;
    if (j && j['type'] === 'agenthub_handoff_marker' && j['handoffId'] === handoffId) {
      const parsed = HandoffMarkerSchema.safeParse(j);
      if (parsed.success) return { index: i, marker: parsed.data };
    }
  }
  return null;
}

function hasMergedMarker(lines: ParsedLine[], handoffId: string): boolean {
  return lines.some((l) => {
    const j = l.json;
    return j != null && j['type'] === 'agenthub_merged_marker' && j['handoffId'] === handoffId;
  });
}

export interface MergeResult {
  /** 合并后的完整 jsonl 文本 */
  content: string;
  /** 云端新增条数 */
  mergedCount: number;
  /** 是否发生分叉交错合并 */
  forked: boolean;
  /** 因幂等（已合并过）而跳过 */
  skipped: boolean;
}

/**
 * §3.4 session jsonl 合并（纯函数，文件 IO 由 mergeSessionJsonlFile 封装）
 * 1. 按 marker.messageCount 切共同前缀并校验两侧一致
 * 2. 本地无增量 → 云端增量直接 append
 * 3. 分叉 → 按 timestamp 交错合并，云端记录注入 "agenthub_source":"cloud"，合并点插系统消息
 * 4. 幂等：已存在同 handoffId 的合并标记行则跳过
 */
export function mergeSessionJsonl(localContent: string, cloudContent: string, handoffId: string): MergeResult {
  const local = parseLines(localContent);
  const cloud = parseLines(cloudContent);

  // 规则 4（幂等）：同一 handoffId 重复合并直接跳过
  if (hasMergedMarker(local, handoffId)) {
    return { content: localContent, mergedCount: 0, forked: false, skipped: true };
  }

  const localMark = findMarker(local, handoffId);
  const cloudMark = findMarker(cloud, handoffId);
  if (!localMark) throw new MergePrefixMismatchError(`本地 jsonl 未找到 handoff_marker（${handoffId}）`);
  if (!cloudMark) throw new MergePrefixMismatchError(`云端 jsonl 未找到 handoff_marker（${handoffId}）`);

  // 规则 1：校验共同前缀条数（marker 之前的记录条数须与 messageCount 一致）
  const expected = localMark.marker.messageCount;
  if (localMark.index !== expected) {
    throw new MergePrefixMismatchError(`本地前缀条数 ${localMark.index} ≠ marker.messageCount ${expected}`);
  }
  if (cloudMark.index !== expected) {
    throw new MergePrefixMismatchError(`云端前缀条数 ${cloudMark.index} ≠ marker.messageCount ${expected}`);
  }

  // 共同前缀 = 前缀记录 + marker 行本身
  const prefix = local.slice(0, localMark.index + 1).map((l) => l.raw);
  const localDelta = local.slice(localMark.index + 1);
  const cloudDelta = cloud.slice(cloudMark.index + 1);

  const tagCloud = (l: ParsedLine): string =>
    l.json ? JSON.stringify({ ...l.json, agenthub_source: 'cloud' }) : l.raw;

  const now = new Date().toISOString();
  const mergedMarker: MergedMarker = MergedMarkerSchema.parse({
    type: 'agenthub_merged_marker',
    handoffId,
    mergedCount: cloudDelta.length,
    timestamp: now,
  });

  let body: string[];
  let forked = false;

  if (localDelta.length === 0) {
    // 规则 2：本地无增量 → 直接 append
    body = cloudDelta.map(tagCloud);
  } else {
    // 规则 3：分叉 → 按 timestamp 交错合并（稳定：同刻本地在前），合并点插系统消息
    forked = true;
    const notice = JSON.stringify({
      type: 'system',
      subtype: 'agenthub_merge_notice',
      timestamp: now,
      content: `AgentHub：本地与云端在 handoff ${handoffId} 后各有 ${localDelta.length}/${cloudDelta.length} 条新记录，已按时间戳交错合并；云端记录带 agenthub_source=cloud 标记。`,
    });
    const interleaved: string[] = [];
    let i = 0;
    let j = 0;
    while (i < localDelta.length || j < cloudDelta.length) {
      if (j >= cloudDelta.length) interleaved.push(localDelta[i++].raw);
      else if (i >= localDelta.length) interleaved.push(tagCloud(cloudDelta[j++]));
      else if (lineTimestamp(localDelta[i]) <= lineTimestamp(cloudDelta[j])) interleaved.push(localDelta[i++].raw);
      else interleaved.push(tagCloud(cloudDelta[j++]));
    }
    body = [notice, ...interleaved];
  }

  const content = [...prefix, ...body, JSON.stringify(mergedMarker)].join('\n') + '\n';
  return { content, mergedCount: cloudDelta.length, forked, skipped: false };
}

export interface MergeFileResult extends MergeResult {
  backupPath?: string;
}

/** 文件级合并：备份 <file>.bak.<epoch> 后原子写回（§3.4 规则 4 前半） */
export function mergeSessionJsonlFile(localPath: string, cloudPath: string, handoffId: string): MergeFileResult {
  const localContent = readFileSync(localPath, 'utf8');
  const cloudContent = readFileSync(cloudPath, 'utf8');
  const result = mergeSessionJsonl(localContent, cloudContent, handoffId);
  if (result.skipped) return result;

  const backupPath = `${localPath}.bak.${Date.now()}`;
  copyFileSync(localPath, backupPath);
  writeFileSync(localPath, result.content);
  return { ...result, backupPath };
}

/** push 时向 session jsonl 追加 handoff_marker（§3.3） */
export function appendHandoffMarker(sessionPath: string, handoffId: string, baseCommit: string): HandoffMarker {
  if (!existsSync(sessionPath)) throw new Error(`session 文件不存在: ${sessionPath}`);
  const content = readFileSync(sessionPath, 'utf8');
  const messageCount = parseLines(content).length;
  const marker: HandoffMarker = {
    type: 'agenthub_handoff_marker',
    handoffId,
    baseCommit,
    messageCount,
    timestamp: new Date().toISOString(),
  };
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  writeFileSync(sessionPath, content + sep + JSON.stringify(marker) + '\n');
  return marker;
}
