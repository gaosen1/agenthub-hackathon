import { z } from 'zod';
import { HandoffManifestSchema, SandboxEventSchema } from './manifest.js';

/** §4.3 runner 控制面协议（Pod :8080，认证头 X-Runner-Token） */

export const RunnerModeSchema = z.enum(['web', 'bot']);
export type RunnerMode = z.infer<typeof RunnerModeSchema>;

export const RunnerHealthzRespSchema = z.object({
  ok: z.boolean(),
  mode: RunnerModeSchema,
  serveReady: z.boolean(),
  loadedHandoffId: z.string().optional(),
  lastError: z.string().optional(),
});
export type RunnerHealthzResp = z.infer<typeof RunnerHealthzRespSchema>;

export const RunnerLoadReqSchema = z.object({
  inputUrl: z.string(),
  task: z.string().optional(),
  bindChatId: z.string().optional(),
  serveToken: z.string().optional(),
});
export type RunnerLoadReq = z.infer<typeof RunnerLoadReqSchema>;

export const RunnerSnapshotReqSchema = z.object({
  outputUrl: z.string(),
});
export type RunnerSnapshotReq = z.infer<typeof RunnerSnapshotReqSchema>;

export const RunnerSnapshotRespSchema = z.object({
  manifest: HandoffManifestSchema,
});
export type RunnerSnapshotResp = z.infer<typeof RunnerSnapshotRespSchema>;

export const RunnerChatsRespSchema = z.object({
  items: z.array(z.object({ chatId: z.string(), title: z.string().optional(), lastSeenAt: z.string().optional() })),
});
export type RunnerChatsResp = z.infer<typeof RunnerChatsRespSchema>;

export const RunnerBindReqSchema = z.object({
  chatId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type RunnerBindReq = z.infer<typeof RunnerBindReqSchema>;

export const RunnerLogsRespSchema = z.object({
  items: z.array(SandboxEventSchema),
  nextAfter: z.number(),
});
export type RunnerLogsResp = z.infer<typeof RunnerLogsRespSchema>;
