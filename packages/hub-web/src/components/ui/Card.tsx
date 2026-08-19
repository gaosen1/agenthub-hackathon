import type { ReactNode } from 'react';

/** 二级视图页头（原型 .view-h） */
export function ViewHeader({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="view-h">
      <div className="v-icon">
        <i className={`fa-solid ${icon}`} />
      </div>
      <div>
        <h1>{title}</h1>
        <div className="sub">{sub}</div>
      </div>
    </div>
  );
}

/** 卡片（原型 .card）。hint 是标题右侧的浅色补充说明。 */
export function Card({
  icon,
  title,
  hint,
  children,
  padded = true,
}: {
  icon?: string;
  title?: string;
  hint?: ReactNode;
  children: ReactNode;
  /** 表格类内容需要贴边，传 false 去掉 .card-b 内边距 */
  padded?: boolean;
}) {
  return (
    <div className="card">
      {title && (
        <div className="card-h">
          {icon && <i className={`fa-solid ${icon}`} />}
          {title}
          {hint !== undefined && <span className="hint">{hint}</span>}
        </div>
      )}
      {padded ? <div className="card-b">{children}</div> : children}
    </div>
  );
}
