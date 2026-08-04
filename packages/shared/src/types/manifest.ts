/**
 * HandoffManifest — 输入包/返回包元数据（spec §3.2）
 * 契约文件：改动需 PR + 知会对方
 */
import { z } from 'zod';

export const ManifestResultSchema = z.object({
  status: z.enum(['done', 'failed', 'cancelled', 'expired']),
  cloudHead: z.string().optional(),
  commitCount: z.number().int().min(0),
  newSessionIds: z.array(z.string()),
  elapsedSeconds: z.number().min(0),
  tokensUsed: z.number().optional(),
  error: z.string().optional(),
});
export type ManifestResult = z.infer<typeof ManifestResultSchema>;

export const HandoffManifestSchema = z.object({
  version: z.literal(1),
  handoffId: z.string().regex(/^hf-[0-9a-f]{6}$/),
  direction: z.enum(['push', 'pull']),
  agentName: z.string().min(1),
  workspacePath: z.string().min(1),
  wsHash: z.string().min(1),
  repo: z.object({
    baseCommit: z.string().min(1),
    branch: z.string().min(1),
    dirty: z.boolean(),
  }),
  sessionId: z.string().min(1),
  task: z.string().optional(),
  timeoutMinutes: z.number().int().min(1).max(240),
  qwenVersion: z.string(),
  createdAt: z.string(),
  result: ManifestResultSchema.optional(),
});
export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;
