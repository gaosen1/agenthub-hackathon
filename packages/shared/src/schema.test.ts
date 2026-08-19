/**
 * D1 验收：每个 zod schema 用合法/非法样本各至少 1 例（spec §7 阶段 D1）
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { z } from 'zod';
import {
  ApiErrorSchema,
  AuthReqSchema,
  AuthRespSchema,
  BindChatReqSchema,
  BotChatsRespSchema,
  BotSchema,
  CreateBotReqSchema,
  CreateHandoffReqSchema,
  CreateHandoffRespSchema,
  HandoffDetailSchema,
  HandoffEventsRespSchema,
  HandoffKindSchema,
  HandoffManifestSchema,
  HandoffMarkerSchema,
  HandoffResultSchema,
  HandoffStatusSchema,
  HandoffSummarySchema,
  ListHandoffsRespSchema,
  MergedMarkerSchema,
  PullIntentRespSchema,
  RunnerBindReqSchema,
  RunnerChatsRespSchema,
  RunnerHealthzRespSchema,
  RunnerLoadReqSchema,
  RunnerLogsRespSchema,
  RunnerModeSchema,
  RunnerSnapshotReqSchema,
  RunnerSnapshotRespSchema,
  SandboxEventSchema,
} from './index.js';

const validManifest = {
  version: 1,
  handoffId: 'hf-9f3a2c',
  direction: 'push',
  agentName: 'demo',
  workspacePath: '/Users/x/demo',
  wsHash: 'demo-ab12cd34ef56',
  repo: { baseCommit: 'a41c9e0', branch: 'main', dirty: false },
  sessionId: 'sess-1',
  timeoutMinutes: 30,
  qwenVersion: '0.9.0',
  createdAt: '2026-08-04T06:00:00Z',
};

const validSummary = {
  id: 'hf-9f3a2c',
  agentName: 'demo',
  status: 'running',
  kind: 'web',
  branch: 'main',
  baseCommit: 'a41c9e0',
  sessionId: 'sess-1',
  createdAt: '2026-08-04T06:00:00Z',
  updatedAt: '2026-08-04T06:01:00Z',
};

interface Case {
  name: string;
  schema: z.ZodTypeAny;
  valid: unknown;
  invalid: unknown;
}

const cases: Case[] = [
  { name: 'HandoffStatus', schema: HandoffStatusSchema, valid: 'running', invalid: 'sleeping' },
  { name: 'HandoffKind', schema: HandoffKindSchema, valid: 'bot', invalid: 'task' },
  {
    name: 'HandoffResult',
    schema: HandoffResultSchema,
    valid: { status: 'done', commitCount: 1, newSessionIds: [], elapsedSeconds: 5 },
    invalid: { status: 'done', commitCount: -1, newSessionIds: [], elapsedSeconds: 5 },
  },
  { name: 'HandoffManifest', schema: HandoffManifestSchema, valid: validManifest, invalid: { ...validManifest, handoffId: 'xx-123' } },
  {
    name: 'HandoffMarker',
    schema: HandoffMarkerSchema,
    valid: { type: 'agenthub_handoff_marker', handoffId: 'hf-9f3a2c', baseCommit: 'a41c9e0', messageCount: 46, timestamp: '2026-08-04T06:02:39Z' },
    invalid: { type: 'wrong_type', handoffId: 'hf-9f3a2c', baseCommit: 'a41c9e0', messageCount: 46, timestamp: 't' },
  },
  {
    name: 'MergedMarker',
    schema: MergedMarkerSchema,
    valid: { type: 'agenthub_merged_marker', handoffId: 'hf-9f3a2c', mergedCount: 2, timestamp: 't' },
    invalid: { type: 'agenthub_merged_marker', handoffId: 'hf-9f3a2c', mergedCount: 1.5, timestamp: 't' },
  },
  { name: 'SandboxEvent', schema: SandboxEventSchema, valid: { t: '2026-08-04T06:00:00Z', tag: 'git', c: 'commit ok' }, invalid: { t: 't', tag: 'debug', c: 'x' } },
  { name: 'ApiError', schema: ApiErrorSchema, valid: { error: { code: 'ERR_AUTH', message: 'bad token' } }, invalid: { error: { code: 'ERR_NOPE', message: 'x' } } },
  { name: 'AuthReq', schema: AuthReqSchema, valid: { username: 'a', password: 'b' }, invalid: { username: '', password: 'b' } },
  { name: 'AuthResp', schema: AuthRespSchema, valid: { token: 't', user: { id: 1, username: 'a' } }, invalid: { token: 't', user: { id: 'x', username: 'a' } } },
  {
    name: 'CreateHandoffReq',
    schema: CreateHandoffReqSchema,
    valid: { agentName: 'demo', workspacePath: '/x', wsHash: 'h', sessionId: 's', baseCommit: 'c', branch: 'main', kind: 'web' },
    invalid: { agentName: 'demo', workspacePath: '/x', wsHash: 'h', sessionId: 's', baseCommit: 'c', branch: 'main', kind: 'cloud' },
  },
  { name: 'CreateHandoffResp', schema: CreateHandoffRespSchema, valid: { handoffId: 'hf-1', uploadUrl: 'u', webUrl: 'w' }, invalid: { handoffId: 'hf-1' } },
  { name: 'HandoffSummary', schema: HandoffSummarySchema, valid: validSummary, invalid: { ...validSummary, status: 'paused' } },
  {
    name: 'HandoffDetail',
    schema: HandoffDetailSchema,
    valid: { ...validSummary, timeline: [{ status: 'created', at: 't' }] },
    invalid: { ...validSummary, timeline: [{ status: 'birthed', at: 't' }] },
  },
  { name: 'ListHandoffsResp', schema: ListHandoffsRespSchema, valid: { items: [validSummary] }, invalid: { items: [{ id: 1 }] } },
  {
    name: 'HandoffEventsResp',
    schema: HandoffEventsRespSchema,
    valid: { items: [{ id: 1, at: 't', kind: 'status', payload: 'queued' }], nextAfter: 1 },
    invalid: { items: [{ id: 1, at: 't', kind: 'trace', payload: 'x' }], nextAfter: 1 },
  },
  { name: 'PullIntentResp', schema: PullIntentRespSchema, valid: { downloadUrl: 'u', manifest: validManifest }, invalid: { downloadUrl: 'u', manifest: { version: 2 } } },
  {
    name: 'Bot',
    schema: BotSchema,
    valid: { id: 1, name: 'b', status: 'running', createdAt: 't' },
    invalid: { id: 1, name: 'b', status: 'zombie', createdAt: 't' },
  },
  { name: 'CreateBotReq', schema: CreateBotReqSchema, valid: { name: 'b', clientId: 'i', clientSecret: 's' }, invalid: { name: 'b', clientId: 'i', clientSecret: '' } },
  { name: 'BotChatsResp', schema: BotChatsRespSchema, valid: { items: [{ chatId: 'c1' }] }, invalid: { items: [{}] } },
  { name: 'BindChatReq', schema: BindChatReqSchema, valid: { chatId: 'c', sessionId: 's' }, invalid: { chatId: 'c' } },
  { name: 'RunnerMode', schema: RunnerModeSchema, valid: 'web', invalid: 'task' },
  {
    name: 'RunnerHealthzResp',
    schema: RunnerHealthzRespSchema,
    valid: { ok: true, mode: 'bot', serveReady: false },
    invalid: { ok: 'yes', mode: 'bot', serveReady: false },
  },
  { name: 'RunnerLoadReq', schema: RunnerLoadReqSchema, valid: { inputUrl: 'u', task: 't' }, invalid: {} },
  { name: 'RunnerSnapshotReq', schema: RunnerSnapshotReqSchema, valid: { outputUrl: 'u' }, invalid: { outputUrl: 42 } },
  { name: 'RunnerSnapshotResp', schema: RunnerSnapshotRespSchema, valid: { manifest: validManifest }, invalid: { manifest: null } },
  { name: 'RunnerChatsResp', schema: RunnerChatsRespSchema, valid: { items: [] }, invalid: { items: [{ title: 'no chatId' }] } },
  { name: 'RunnerBindReq', schema: RunnerBindReqSchema, valid: { chatId: 'c', sessionId: 's' }, invalid: { chatId: '', sessionId: 's' } },
  { name: 'RunnerLogsResp', schema: RunnerLogsRespSchema, valid: { items: [{ t: 't', tag: 'ok', c: 'done' }], nextAfter: 3 }, invalid: { items: [], nextAfter: 'x' } },
];

describe('zod schema 合法/非法样本（D1 验收）', () => {
  for (const c of cases) {
    it(`${c.name}: 合法样本通过`, () => {
      assert.equal(c.schema.safeParse(c.valid).success, true);
    });
    it(`${c.name}: 非法样本拒绝`, () => {
      assert.equal(c.schema.safeParse(c.invalid).success, false);
    });
  }

  it('HandoffManifest: timeoutMinutes 缺省填充 30', () => {
    const { timeoutMinutes: _omit, ...rest } = validManifest;
    const parsed = HandoffManifestSchema.parse(rest);
    assert.equal(parsed.timeoutMinutes, 30);
  });
});
