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
  /** 本地绝对路径；Web 端 ACP session/load 的 cwd 参数需要（spec §4.4） */
  workspacePath: z.string().optional(),
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

// ---------- 模型凭证（per-user 隔离）----------

export const ModelConfigReqSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
});
export type ModelConfigReq = z.infer<typeof ModelConfigReqSchema>;

export const ModelConfigRespSchema = z.object({
  hasKey: z.boolean(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
});
export type ModelConfigResp = z.infer<typeof ModelConfigRespSchema>;

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

// ---------- Sandbox 面板（原型 §view-sandbox） ----------

export const SandboxStatusSchema = z.enum(['provisioning', 'running', 'reclaimed', 'failed', 'lost']);
export type SandboxStatusDto = z.infer<typeof SandboxStatusSchema>;

export const ReclaimReasonSchema = z.enum([
  'task-done',
  'task-failed',
  'expired',
  'cancelled',
  'pod-failed',
  'load-failed',
  'pod-lost',
  'bot-deleted',
  'orphan',
  'crash-recover',
]);
export type ReclaimReasonDto = z.infer<typeof ReclaimReasonSchema>;

export const SandboxInstanceSchema = z.object({
  podName: z.string(),
  kind: z.enum(['web', 'bot']),
  handoffId: z.string().nullable(),
  botId: z.number().nullable(),
  image: z.string(),
  status: SandboxStatusSchema,
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** 执行时长（秒），按 readyAt → endedAt 计；从未就绪的实例为 null */
  durationSeconds: z.number().nullable(),
  reclaimReason: ReclaimReasonSchema.nullable(),
  lastError: z.string().nullable(),
});
export type SandboxInstance = z.infer<typeof SandboxInstanceSchema>;

export const SandboxStatsSchema = z.object({
  running: z.number(),
  reclaimedInWindow: z.number(),
  /** 可用模板数；当前单一 SANDBOX_IMAGE，故为 1（未配置编排时 0） */
  templates: z.number(),
  /** 窗口内累计执行秒数，含仍在运行实例的当前时长 */
  execSecondsInWindow: z.number(),
});
export type SandboxStats = z.infer<typeof SandboxStatsSchema>;

/** 模板信息。事实源头是 packages/sandbox/Dockerfile 与建 Pod 时的资源规格。 */
export const SandboxTemplateSchema = z.object({
  image: z.string(),
  namespace: z.string(),
  baseImage: z.string(),
  qwenVersion: z.string(),
  toolchain: z.array(z.string()),
  resources: z.object({ cpu: z.string(), memory: z.string() }),
  ports: z.object({ runner: z.number(), serve: z.number() }),
  /** ACS 弹性算力调度（virtual-kubelet） */
  acs: z.boolean(),
});
export type SandboxTemplate = z.infer<typeof SandboxTemplateSchema>;

/** 回收与超时策略——取自 Worker 的实际配置，不是前端写死的文案 */
export const SandboxPolicySchema = z.object({
  defaultTimeoutMinutes: z.number(),
  idleTtlMinutes: z.number(),
  taskLingerMinutes: z.number(),
  orphanIntervalMs: z.number(),
  workerIntervalMs: z.number(),
});
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export const SandboxListRespSchema = z.object({
  /** 编排是否可用（HUB_NO_K8S=1 或 kubeconfig 不可用时为 false，面板渲染未配置态） */
  configured: z.boolean(),
  windowHours: z.number(),
  items: z.array(SandboxInstanceSchema),
  stats: SandboxStatsSchema,
  template: SandboxTemplateSchema.nullable(),
  policy: SandboxPolicySchema,
});
export type SandboxListResp = z.infer<typeof SandboxListRespSchema>;

// ---------- OSS 存储面板（S13） ----------

export const OssObjectDtoSchema = z.object({
  key: z.string(),
  size: z.number().nullable(),
  uploadedAt: z.string().nullable(),
  handoffId: z.string(),
  direction: z.enum(['input', 'output']),
  /** 部分成果：handoff 以 expired/cancelled 终态结束 */
  partial: z.boolean(),
  /** 对象已被生命周期清理（refresh 对账或时间推导） */
  expired: z.boolean(),
});
export type OssObjectDto = z.infer<typeof OssObjectDtoSchema>;

export const OssListRespSchema = z.object({
  configured: z.boolean(),
  /** bucket 生命周期天数；读不到为 null，面板不显示过期时间（不编一个 7） */
  lifecycleDays: z.number().nullable(),
  signedUrlTtlSeconds: z.number(),
  stats: z.object({
    totalBytes: z.number(),
    objectCount: z.number(),
    uploadedToday: z.number(),
  }),
  items: z.array(OssObjectDtoSchema),
});
export type OssListResp = z.infer<typeof OssListRespSchema>;

export const OssSignReqSchema = z.object({ key: z.string().min(1) });
export type OssSignReq = z.infer<typeof OssSignReqSchema>;
