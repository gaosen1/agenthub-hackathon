import { z } from 'zod';
import {
  HandoffKindSchema,
  HandoffManifestSchema,
  HandoffResultSchema,
  HandoffStatusSchema,
} from './manifest.js';

/** §4.6 错误码 */
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

/** §2 统一错误响应 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------- 认证 ----------

export const AuthReqSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type AuthReq = z.infer<typeof AuthReqSchema>;

export const AuthRespSchema = z.object({
  token: z.string(),
  user: z.object({ id: z.number(), username: z.string() }),
});
export type AuthResp = z.infer<typeof AuthRespSchema>;

// ---------- Handoff ----------

/** POST /api/handoffs 请求 */
export const CreateHandoffReqSchema = z.object({
  agentName: z.string().min(1),
  workspacePath: z.string().min(1),
  wsHash: z.string().min(1),
  sessionId: z.string().min(1),
  baseCommit: z.string().min(1),
  branch: z.string().min(1),
  task: z.string().optional(),
  kind: HandoffKindSchema,
  botId: z.number().optional(),
  bindChatId: z.string().optional(),
  timeoutMinutes: z.number().int().positive().default(30),
});
export type CreateHandoffReq = z.infer<typeof CreateHandoffReqSchema>;

/** POST /api/handoffs 响应 201 */
export const CreateHandoffRespSchema = z.object({
  handoffId: z.string(),
  uploadUrl: z.string(),
  webUrl: z.string(),
});
export type CreateHandoffResp = z.infer<typeof CreateHandoffRespSchema>;

/** GET /api/handoffs/:id 响应（Summary = Detail 去 timeline/result） */
export const HandoffSummarySchema = z.object({
  id: z.string(),
  agentName: z.string(),
  status: HandoffStatusSchema,
  kind: HandoffKindSchema,
  branch: z.string(),
  baseCommit: z.string(),
  sessionId: z.string(),
  task: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const HandoffDetailSchema = HandoffSummarySchema.extend({
  timeline: z.array(z.object({ status: HandoffStatusSchema, at: z.string() })),
  downloadUrl: z.string().optional(),
  result: HandoffResultSchema.optional(),
});
export type HandoffDetail = z.infer<typeof HandoffDetailSchema>;

export const ListHandoffsRespSchema = z.object({
  items: z.array(HandoffSummarySchema),
});
export type ListHandoffsResp = z.infer<typeof ListHandoffsRespSchema>;

/** GET /api/handoffs/:id/events 响应 */
export const HandoffEventsRespSchema = z.object({
  items: z.array(
    z.object({ id: z.number(), at: z.string(), kind: z.enum(['status', 'log']), payload: z.string() }),
  ),
  nextAfter: z.number(),
});
export type HandoffEventsResp = z.infer<typeof HandoffEventsRespSchema>;

/** POST /api/handoffs/:id/pull-intent 响应 200（非终态 409 ERR_NOT_READY） */
export const PullIntentRespSchema = z.object({
  downloadUrl: z.string(),
  manifest: HandoffManifestSchema,
});
export type PullIntentResp = z.infer<typeof PullIntentRespSchema>;

// ---------- Bot ----------

export const BotSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.enum(['creating', 'running', 'error', 'deleted']),
  podName: z.string().nullable().optional(),
  currentHandoffId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Bot = z.infer<typeof BotSchema>;

export const CreateBotReqSchema = z.object({
  name: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
export type CreateBotReq = z.infer<typeof CreateBotReqSchema>;

export const BotChatsRespSchema = z.object({
  items: z.array(z.object({ chatId: z.string(), title: z.string().optional(), lastSeenAt: z.string().optional() })),
});
export type BotChatsResp = z.infer<typeof BotChatsRespSchema>;

export const BindChatReqSchema = z.object({
  chatId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type BindChatReq = z.infer<typeof BindChatReqSchema>;
