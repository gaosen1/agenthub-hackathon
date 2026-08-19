/**
 * OSS 对象存储视图（原型 docs/prototype.html §view-oss）
 * 真实数据接入见 S13/S15（GET /api/oss）。
 */
export function OssView() {
  return (
    <section className="view">
      <div className="view-inner">
        <div className="view-h">
          <div className="v-icon">
            <i className="fa-solid fa-database" />
          </div>
          <div>
            <h1>OSS 对象存储</h1>
            <div className="sub">输入包 / 返回包的唯一数据通道 · 代码不经过第三方托管平台</div>
          </div>
        </div>
        <div className="card">
          <div className="card-b">
            <div className="empty-hint">包对象与 Bucket 信息待接入 GET /api/oss。</div>
          </div>
        </div>
      </div>
    </section>
  );
}
