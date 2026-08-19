import type { ReactNode } from 'react';

export interface Stat {
  icon: string;
  label: string;
  value: ReactNode;
  /** 数值后的小字单位，如 MB / min */
  unit?: string;
}

/** 四格统计卡（原型 .grid4 + .stat） */
export function StatGrid({ items }: { items: Stat[] }) {
  return (
    <div className="grid4">
      {items.map((s) => (
        <div className="stat" key={s.label}>
          <div className="k">
            <i className={`fa-solid ${s.icon}`} /> {s.label}
          </div>
          <div className="v">
            {s.value}
            {s.unit && <small> {s.unit}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 单位换算只在展示层做，后端一律返回字节 */
export function formatBytes(bytes: number): { value: string; unit: string } {
  if (bytes <= 0) return { value: '0', unit: 'B' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / 1024 ** i;
  return { value: scaled >= 100 || i === 0 ? String(Math.round(scaled)) : scaled.toFixed(1), unit: units[i]! };
}

/** 秒 → 「12m 40s」/「1h 06m」，用于 sandbox 执行时长 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
