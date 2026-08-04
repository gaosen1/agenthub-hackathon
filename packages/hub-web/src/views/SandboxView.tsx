/**
 * Sandbox 调度层视图（原型 docs/prototype.html §view-sandbox）
 * 真实数据接入见 S9/S10（GET /api/sandboxes）。
 *
 * 注意：原型副标题写的是「E2B 临时执行环境」，本项目实际用的是 ACK 集群 + ACS 弹性算力。
 */
export function SandboxView() {
  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-h">
          <div className="v-icon">
            <i className="fa-solid fa-cube" />
          </div>
          <div>
            <h1>Sandbox 调度层</h1>
            <div className="sub">ACK 集群 · ACS 弹性算力 · 任务级生命周期 · 用完即毁</div>
          </div>
        </div>
        <div className="card">
          <div className="card-b">
            <div className="empty-hint">实例记录与回收策略待接入 GET /api/sandboxes。</div>
          </div>
        </div>
      </div>
    </section>
  );
}
