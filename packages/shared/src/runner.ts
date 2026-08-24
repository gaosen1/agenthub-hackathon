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
  /** S19 依赖缓存 tar.gz 的签名 GET URL（sidecar 校验通过才下发） */
  depsCacheUrl: z.string().optional(),
  /** S20 warm 全量 bundle 的签名 GET URL（delta 模式才下发） */
  warmBundleUrl: z.string().optional(),
});
export type RunnerLoadReq = z.infer<typeof RunnerLoadReqSchema>;

export const RunnerSnapshotReqSchema = z.object({
  outputUrl: z.string(),
  /** S19 依赖缓存：node_modules 快照与 sidecar 的签名 PUT URL；缺省不缓存 */
  depsCachePutUrl: z.string().optional(),
  depsSidecarPutUrl: z.string().optional(),
  /** S20 warm 全量 bundle 与 sidecar 的签名 PUT URL；缺省不上传 */
  warmBundlePutUrl: z.string().optional(),
  warmSidecarPutUrl: z.string().optional(),
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
  /** 三段式路由 key 需要 senderId（observed 不记 group，operator 后门） */
  senderId: z.string().min(1).optional(),
  isGroup: z.boolean().optional(),
});
export type RunnerBindReq = z.infer<typeof RunnerBindReqSchema>;

export const RunnerLogsRespSchema = z.object({
  items: z.array(SandboxEventSchema),
  nextAfter: z.number(),
});
export type RunnerLogsResp = z.infer<typeof RunnerLogsRespSchema>;

/** Web IDE（code-server）状态：POST /ide/ensure 与 GET /ide/status 共用 */
export const RunnerIdeStatusRespSchema = z.object({
  ready: z.boolean(),
  pid: z.number().optional(),
  error: z.string().optional(),
});
export type RunnerIdeStatusResp = z.infer<typeof RunnerIdeStatusRespSchema>;
