/**
 * runner 控制面协议（spec §4.3）
 * 契约文件：改动需 PR + 知会对方
 */
import { z } from 'zod';

/** 载体模式（spec §1）：web | bot；task 不是模式而是可选初始指令 */
export const RunnerModeSchema = z.enum(['web', 'bot']);
export type RunnerMode = z.infer<typeof RunnerModeSchema>;

export interface HealthzResponse {
  ok: boolean;
  mode: RunnerMode;
  serveReady: boolean;
  loadedHandoffId?: string;
  lastError?: string;
}

export const LoadReqSchema = z.object({
  inputUrl: z.string().url(),
  task: z.string().optional(),
  bindChatId: z.string().optional(),
  serveToken: z.string().optional(),
});
export type LoadReq = z.infer<typeof LoadReqSchema>;

export const SnapshotReqSchema = z.object({
  outputUrl: z.string().url(),
});
export type SnapshotReq = z.infer<typeof SnapshotReqSchema>;

export const BindReqSchema = z.object({
  chatId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type BindReq = z.infer<typeof BindReqSchema>;

export interface ChatListItem {
  chatId: string;
  title?: string;
  lastSeenAt?: string;
}

/** 结构化执行日志（spec §3.6） */
export interface SandboxEvent {
  t: string;
  tag: 'sys' | 'info' | 'tool' | 'git' | 'chat' | 'ok' | 'err';
  c: string;
}
