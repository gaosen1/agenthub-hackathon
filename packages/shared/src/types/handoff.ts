/**
 * Handoff 状态机、REST DTO（spec §4.1 / §4.2）
 * 契约文件：改动需 PR + 知会对方（spec §0）
 */
import { z } from 'zod';

// ── 状态机 ──────────────────────────────────────────────
export const HANDOFF_STATES = [
  'created',
  'uploaded',
  'queued',
  'provisioning',
  'running',
  'packaging',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export type HandoffStatus = (typeof HANDOFF_STATES)[number];

export const TERMINAL_STATES: readonly HandoffStatus[] = [
  'done',
  'failed',
  'cancelled',
  'expired',
];

/** 载体（spec §1）：web=临时 sandbox+Web 聊天；bot=常驻钉钉机器人。task 为正交可选字段 */
export const HandoffKindSchema = z.enum(['web', 'bot']);
export type HandoffKind = z.infer<typeof HandoffKindSchema>;

// ── REST DTO（spec §4.2）────────────────────────────────
export const CreateHandoffReqSchema = z.object({
  agentName: z.string().min(1).max(128),
  workspacePath: z.string().min(1),
  wsHash: z.string().min(1),
  sessionId: z.string().min(1),
  baseCommit: z.string().min(1),
  branch: z.string().min(1),
  task: z.string().min(1).optional(),
  kind: HandoffKindSchema,
  botId: z.number().int().positive().optional(),
  bindChatId: z.string().optional(),
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
});
export type CreateHandoffReq = z.infer<typeof CreateHandoffReqSchema>;

export interface CreateHandoffResp {
  handoffId: string;
  uploadUrl: string;
  webUrl: string;
}

export interface HandoffTimelineEntry {
  status: HandoffStatus;
  at: string;
}

export interface HandoffSummary {
  id: string;
  agentName: string;
  status: HandoffStatus;
  kind: HandoffKind;
  branch: string;
  baseCommit: string;
  sessionId: string;
  task?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffDetail extends HandoffSummary {
  timeline: HandoffTimelineEntry[];
  downloadUrl?: string;
  result?: unknown; // manifest.result（终态时）
  error?: string;
}

export const AuthReqSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
});
export type AuthReq = z.infer<typeof AuthReqSchema>;

export interface AuthResp {
  token: string;
  user: { id: number; username: string };
}

// ── 统一错误（spec §2 / §4.6）───────────────────────────
export const ERROR_CODES = [
  'ERR_AUTH',
  'ERR_FORBIDDEN',
  'ERR_NOT_FOUND',
  'ERR_NOT_READY',
  'ERR_STATE',
  'ERR_VALIDATION',
  'ERR_OSS',
  'ERR_K8S',
  'ERR_RUNNER',
  'ERR_MERGE_PREFIX_MISMATCH',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string };
}
