/**
 * 状态展示映射（对齐 prototype.html STATUS_META/STEPS 与 spec §4.1 状态机）
 */
import type { HandoffStatus } from '@agenthub/shared/contracts';

export const STATUS_META: Record<string, { label: string; cls: string; icon: string }> = {
  created: { label: '已创建', cls: 'b-queued', icon: 'fa-solid fa-plus' },
  uploaded: { label: '已上传', cls: 'b-queued', icon: 'fa-solid fa-cloud-arrow-up' },
  queued: { label: '排队中', cls: 'b-queued', icon: 'fa-solid fa-hourglass-half' },
  provisioning: { label: '创建中', cls: 'b-packaging', icon: 'fa-solid fa-cube' },
  running: { label: '执行中', cls: 'b-running', icon: 'fa-solid fa-circle-notch' },
  packaging: { label: '打包中', cls: 'b-packaging', icon: 'fa-solid fa-box' },
  done: { label: '已完成', cls: 'b-done', icon: 'fa-solid fa-check' },
  failed: { label: '失败', cls: 'b-failed', icon: 'fa-solid fa-xmark' },
  cancelled: { label: '已取消', cls: 'b-failed', icon: 'fa-solid fa-ban' },
  expired: { label: '已超时', cls: 'b-failed', icon: 'fa-solid fa-hourglass-end' },
};

/** stepper 主链路（终态 failed/cancelled/expired 显示在中断位置） */
export const STEPS = [
  { key: 'created', label: 'created', icon: 'fa-solid fa-plus' },
  { key: 'uploaded', label: 'uploaded', icon: 'fa-solid fa-cloud-arrow-up' },
  { key: 'queued', label: 'queued', icon: 'fa-solid fa-hourglass-half' },
  { key: 'provisioning', label: 'provisioning', icon: 'fa-solid fa-cube' },
  { key: 'running', label: 'running', icon: 'fa-solid fa-play' },
  { key: 'packaging', label: 'packaging', icon: 'fa-solid fa-box' },
  { key: 'done', label: 'done', icon: 'fa-solid fa-flag-checkered' },
] as const;

export const TERMINAL_BAD: readonly HandoffStatus[] = ['failed', 'cancelled', 'expired'];

/** 主链路 step 索引；终态异常按 timeline 最后一个主链路状态推 */
export function stepIndexOf(status: HandoffStatus, timeline: { status: string }[]): number {
  const idx = STEPS.findIndex((s) => s.key === status);
  if (idx >= 0) return idx;
  // failed/cancelled/expired：取 timeline 中最后一个主链路状态的下一步
  for (let i = timeline.length - 1; i >= 0; i--) {
    const j = STEPS.findIndex((s) => s.key === timeline[i].status);
    if (j >= 0) return j;
  }
  return 0;
}

/** ISO 时间 → HH:mm:ss（本地展示） */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtHm(iso: string): string {
  return fmtTime(iso).slice(0, 5);
}
