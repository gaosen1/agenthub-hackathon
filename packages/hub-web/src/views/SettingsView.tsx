/**
 * 设置视图（原型 docs/prototype.html §view-settings）
 * 真实数据接入见 S16/S19（GET/PATCH /api/settings）。
 */
export function SettingsView() {
  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-h">
          <div className="v-icon">
            <i className="fa-solid fa-gear" />
          </div>
          <div>
            <h1>设置</h1>
            <div className="sub">Hub 连接 · 通知集成 · Handoff 默认策略 · 数据与隐私</div>
          </div>
        </div>
        <div className="card">
          <div className="card-b">
            <div className="empty-hint">设置项待接入 GET/PATCH /api/settings。</div>
          </div>
        </div>
      </div>
    </section>
  );
}
