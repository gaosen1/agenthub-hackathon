/**
 * 统一错误（spec §2 / §4.6）与状态机守卫（spec §4.1）
 */
import type { ErrorCode, HandoffStatus } from '@agenthub/shared';
import { TERMINAL_STATES } from '@agenthub/shared';

export class ApiFail extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (httpStatus: number, code: ErrorCode, message: string) =>
  new ApiFail(httpStatus, code, message);

/** 正向链路；到 failed/cancelled/expired 允许从任意非终态进入 */
const CHAIN: Partial<Record<HandoffStatus, HandoffStatus[]>> = {
  created: ['uploaded'],
  uploaded: ['queued'],
  queued: ['provisioning', 'cancelled'],
  provisioning: ['running'],
  running: ['packaging'],
  packaging: ['done'],
};

export function assertTransition(from: HandoffStatus, to: HandoffStatus): void {
  if (TERMINAL_STATES.includes(from)) {
    throw fail(409, 'ERR_STATE', `handoff is terminal (${from}), cannot move to ${to}`);
  }
  if (to === 'failed' || to === 'cancelled' || to === 'expired') return;
  if (!CHAIN[from]?.includes(to)) {
    throw fail(409, 'ERR_STATE', `illegal transition ${from} -> ${to}`);
  }
}
