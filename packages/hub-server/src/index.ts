/**
 * hub-server 入口（design.md §5.2）
 * 控制面：认证 / handoff 状态机 / 签名 URL / Worker 编排 / 聊天代理 / 静态托管 hub-web
 */
import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, service: 'hub-server' }));

// TODO(M1): POST /api/auth/login|register（F-9）
// TODO(M1): POST /api/handoffs · /:id/uploaded · GET /:id · GET ?repo=（F-7/F-8）
// TODO(M2): Worker 模块——K8s Pod 编排（F-10）
// TODO(M3): ANY /api/handoffs/:id/chat/* 聊天代理（F-11）· /api/bots（F-13）

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
