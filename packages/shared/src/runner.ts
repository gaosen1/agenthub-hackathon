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
  /** task relay 是否已完成（B 线 Worker 判断 task 续跑结束的依据） */
  taskDone: z.boolean().optional(),
});
export type RunnerHealthzResp = z.infer<typeof RunnerHealthzRespSchema>;

/** 聊天列表项（runner /chats 与 bot /api/bots/:id/chats 共用） */
export interface ChatListItem {
  chatId: string;
  title?: string;
  lastSeenAt?: string;
}

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
