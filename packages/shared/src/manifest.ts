import { z } from 'zod';

/** §4.1 handoff 状态机 */
export const HandoffStatusSchema = z.enum([
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
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

/** 终态集合（可 pull） */
export const TERMINAL_STATUSES: readonly HandoffStatus[] = ['done', 'failed', 'cancelled', 'expired'];

/** 载体维度：web（临时 sandbox）| bot（常驻钉钉机器人）；task 指令与之正交（§1） */
export const HandoffKindSchema = z.enum(['web', 'bot']);
export type HandoffKind = z.infer<typeof HandoffKindSchema>;

/** §3.2 返回包执行结果 */
export const HandoffResultSchema = z.object({
  status: z.enum(['done', 'failed', 'cancelled', 'expired']),
  cloudHead: z.string().optional(),
  commitCount: z.number().int().nonnegative(),
  newSessionIds: z.array(z.string()),
  elapsedSeconds: z.number().nonnegative(),
  tokensUsed: z.number().optional(),
  error: z.string().optional(),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

/** §3.2 manifest.json */
export const HandoffManifestSchema = z.object({
  version: z.literal(1),
  handoffId: z.string().regex(/^hf-[0-9a-f]{6}$/),
  direction: z.enum(['push', 'pull']),
  agentName: z.string().min(1),
  /** 本地绝对路径，容器内必须原样重建（design.md §6.1） */
  workspacePath: z.string().min(1),
  /** getWorkspaceScopeDirName(workspacePath)，还原后自校验 */
  wsHash: z.string().min(1),
  repo: z.object({
    baseCommit: z.string().min(1),
    branch: z.string().min(1),
    dirty: z.boolean(),
    /** S20 增量 bundle：delta 的基 commit（warm 全量 bundle 必含该 commit）；缺省=全量包 */
    deltaBase: z.string().optional(),
  }),
  sessionId: z.string().min(1),
  /** 接力指令；缺省 = 交互接力 */
  task: z.string().optional(),
  timeoutMinutes: z.number().int().positive().default(30),
  qwenVersion: z.string(),
  createdAt: z.string(),
  /** 仅 direction=pull（返回包）时存在 */
  result: HandoffResultSchema.optional(),
});
export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;

/** §3.3 handoff_marker：push 时追加到移交 session jsonl 的最后一行 */
export const HandoffMarkerSchema = z.object({
  type: z.literal('agenthub_handoff_marker'),
  handoffId: z.string(),
  baseCommit: z.string(),
  /** marker 之前的记录条数，合并时校验共同前缀 */
  messageCount: z.number().int().nonnegative(),
  timestamp: z.string(),
});
export type HandoffMarker = z.infer<typeof HandoffMarkerSchema>;

/** 合并完成后插入 jsonl 的标记行（§3.4 规则 4 幂等判断依据） */
export const MergedMarkerSchema = z.object({
  type: z.literal('agenthub_merged_marker'),
  handoffId: z.string(),
  mergedCount: z.number().int().nonnegative(),
  timestamp: z.string(),
});
export type MergedMarker = z.infer<typeof MergedMarkerSchema>;

/** §3.6 结构化执行日志行 */
export const SandboxEventSchema = z.object({
  t: z.string(),
  tag: z.enum(['sys', 'info', 'tool', 'git', 'chat', 'ok', 'err']),
  c: z.string(),
});
export type SandboxEvent = z.infer<typeof SandboxEventSchema>;
