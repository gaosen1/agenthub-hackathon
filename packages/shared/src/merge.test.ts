import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MergePrefixMismatchError,
  appendHandoffMarker,
  mergeSessionJsonl,
  mergeSessionJsonlFile,
} from './merge.js';

const HF = 'hf-9f3a2c';

function line(role: string, text: string, ts: string): string {
  return JSON.stringify({ type: role, content: text, timestamp: ts });
}

/** 构造共同前缀（2 条消息 + marker） */
const prefix = [
  line('user', '帮我重构 order-service', '2026-08-04T01:00:00Z'),
  line('assistant', '好的，先看下现有结构', '2026-08-04T01:00:05Z'),
  JSON.stringify({
    type: 'agenthub_handoff_marker',
    handoffId: HF,
    baseCommit: 'a41c9e0',
    messageCount: 2,
    timestamp: '2026-08-04T02:00:00Z',
  }),
];

const cloudDelta = [
  line('assistant', '云端：已拆分模块', '2026-08-04T03:00:00Z'),
  line('assistant', '云端：单测补齐', '2026-08-04T03:10:00Z'),
];

describe('mergeSessionJsonl（§3.4 四条规则）', () => {
  it('规则 2：本地无增量 → 云端增量直接 append，且云端记录带 source 标记', () => {
    const local = prefix.join('\n') + '\n';
    const cloud = [...prefix, ...cloudDelta].join('\n') + '\n';
    const r = mergeSessionJsonl(local, cloud, HF);

    assert.equal(r.skipped, false);
    assert.equal(r.forked, false);
    assert.equal(r.mergedCount, 2);
    const lines = r.content.trim().split('\n');
    // 前缀 3 + 云端 2 + merged_marker 1
    assert.equal(lines.length, 6);
    assert.match(lines[3], /"agenthub_source":"cloud"/);
    assert.match(lines[5], /agenthub_merged_marker/);
  });

  it('规则 3：分叉 → 按时间戳交错合并 + 合并点系统消息', () => {
    const localDelta = [
      line('user', '本地：顺便调下命名', '2026-08-04T03:05:00Z'),
    ];
    const local = [...prefix, ...localDelta].join('\n') + '\n';
    const cloud = [...prefix, ...cloudDelta].join('\n') + '\n';
    const r = mergeSessionJsonl(local, cloud, HF);

    assert.equal(r.forked, true);
    const lines = r.content.trim().split('\n');
    // 前缀 3 + 系统消息 1 + 交错 3 + marker 1
    assert.equal(lines.length, 8);
    assert.match(lines[3], /agenthub_merge_notice/);
    // 时间序：cloud 03:00 → local 03:05 → cloud 03:10
    assert.match(lines[4], /已拆分模块/);
    assert.match(lines[5], /本地：顺便调下命名/);
    assert.match(lines[6], /单测补齐/);
    // 本地行不带 cloud 标记
    assert.doesNotMatch(lines[5], /agenthub_source/);
  });

  it('规则 1：前缀条数不一致 → ERR_MERGE_PREFIX_MISMATCH 且异常类型正确', () => {
    // 本地在 marker 之前被人为删了一条 → marker.messageCount=2 但实际前缀只有 1
    const broken = [prefix[1], prefix[2]].join('\n') + '\n';
    const cloud = [...prefix, ...cloudDelta].join('\n') + '\n';
    assert.throws(() => mergeSessionJsonl(broken, cloud, HF), MergePrefixMismatchError);
  });

  it('规则 4：重复合并（已有 merged_marker）→ 幂等跳过', () => {
    const local = prefix.join('\n') + '\n';
    const cloud = [...prefix, ...cloudDelta].join('\n') + '\n';
    const first = mergeSessionJsonl(local, cloud, HF);
    const second = mergeSessionJsonl(first.content, cloud, HF);
    assert.equal(second.skipped, true);
    assert.equal(second.content, first.content);
  });

  it('marker 缺失 → 报错且不动内容', () => {
    const noMarker = [prefix[0], prefix[1]].join('\n') + '\n';
    const cloud = [...prefix, ...cloudDelta].join('\n') + '\n';
    assert.throws(() => mergeSessionJsonl(noMarker, cloud, HF), MergePrefixMismatchError);
  });
});

describe('mergeSessionJsonlFile（备份可回滚）', () => {
  it('合并前生成 .bak.<epoch> 备份，内容等于原文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-merge-'));
    const localPath = join(dir, 'session.jsonl');
    const cloudPath = join(dir, 'cloud.jsonl');
    const localContent = prefix.join('\n') + '\n';
    writeFileSync(localPath, localContent);
    writeFileSync(cloudPath, [...prefix, ...cloudDelta].join('\n') + '\n');

    const r = mergeSessionJsonlFile(localPath, cloudPath, HF);
    assert.ok(r.backupPath);
    assert.equal(readFileSync(r.backupPath!, 'utf8'), localContent);
    assert.match(readFileSync(localPath, 'utf8'), /agenthub_merged_marker/);

    // 幂等：再跑一次不再新增备份
    const before = readdirSync(dir).length;
    const r2 = mergeSessionJsonlFile(localPath, cloudPath, HF);
    assert.equal(r2.skipped, true);
    assert.equal(readdirSync(dir).length, before);
  });
});

describe('linearizeChain（hf-f4da72 回归）', () => {
  const uline = (role: string, text: string, ts: string, uuid: string, parent: string | null) =>
    JSON.stringify({ type: role, content: text, timestamp: ts, uuid, parentUuid: parent });
  const marker = JSON.stringify({
    type: 'agenthub_handoff_marker',
    handoffId: HF,
    baseCommit: 'b1',
    messageCount: 2,
    timestamp: '2026-08-04T02:00:00Z',
  });

  it('分叉合并后 parentUuid 单链：从尾遍历覆盖本地+云端全部分叉记录', () => {
    const pfx = [
      uline('user', '本地上下文', '2026-08-04T01:00:00Z', 'u1', null),
      uline('assistant', 'ok', '2026-08-04T01:00:05Z', 'u2', 'u1'),
      marker,
    ];
    const localDelta = [uline('user', '本地测试轮', '2026-08-04T05:00:00Z', 'u3', 'u2')];
    const cloudDelta = [uline('assistant', '云端：四则运算完成', '2026-08-04T03:00:00Z', 'u4', 'u2')];

    const r = mergeSessionJsonl([...pfx, ...localDelta].join('\n') + '\n', [...pfx, ...cloudDelta].join('\n') + '\n', HF);
    assert.equal(r.forked, true);

    const entries = r.content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((j) => typeof j['uuid'] === 'string');
    const byUuid = new Map(entries.map((j) => [j['uuid'] as string, j]));
    // 从叶子回走 parentUuid 链，应覆盖全部 4 条会话记录（无分叉遗漏）
    const visited: string[] = [];
    let cur: Record<string, unknown> | undefined = entries[entries.length - 1];
    while (cur) {
      visited.push(cur['uuid'] as string);
      cur = byUuid.get(cur['parentUuid'] as string);
    }
    assert.deepEqual(new Set(visited), new Set(['u1', 'u2', 'u3', 'u4']));
    // 时间序：云端(03:00) 在本地测试轮(05:00) 之前
    const order = entries.map((j) => j['uuid']);
    assert.ok(order.indexOf('u4') < order.indexOf('u3'));
  });
});

describe('appendHandoffMarker（§3.3）', () => {
  it('追加 marker 且 messageCount = 现有记录条数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-marker-'));
    const p = join(dir, 's.jsonl');
    writeFileSync(p, [prefix[0], prefix[1]].join('\n') + '\n');
    const marker = appendHandoffMarker(p, HF, 'a41c9e0');
    assert.equal(marker.messageCount, 2);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[2], /agenthub_handoff_marker/);
  });
});
