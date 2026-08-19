import type { ReactNode } from 'react';

/** 设置项一行（原型 .form-row）：左侧标签 + 副说明，右侧控件 */
export function FormRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="fl">
        {label}
        {hint && <small>{hint}</small>}
      </div>
      <div className="fc">{children}</div>
    </div>
  );
}

export function TagChip({ children }: { children: ReactNode }) {
  return <span className="tag-chip">{children}</span>;
}

/**
 * 受控开关。原型用 `onclick="this.classList.toggle('on')"` 直接改 DOM，
 * 那样既不受控也不可测；这里用 role=switch + aria-checked，状态由调用方持有。
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 无可见文字，必须给无障碍名 */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}
