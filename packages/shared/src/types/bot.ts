/**
 * Bot DTO（spec §4.2 Bot 段）
 * 契约文件：改动需 PR + 知会对方
 */
import { z } from 'zod';

export const CreateBotReqSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'letters/digits/_/- only'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
export type CreateBotReq = z.infer<typeof CreateBotReqSchema>;

export interface BotSummary {
  id: number;
  name: string;
  status: 'creating' | 'running' | 'error' | 'deleted';
  podName?: string;
  currentHandoffId?: string;
  createdAt: string;
}

export const BindChatReqSchema = z.object({
  chatId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type BindChatReq = z.infer<typeof BindChatReqSchema>;
