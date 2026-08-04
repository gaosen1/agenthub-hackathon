/**
 * Sandbox runner 控制面（design.md §5.5 F-15，端口 8080）
 * 下载还原 / 打包上传 / 拉起 qwen serve / 路由绑定
 */
import Fastify from 'fastify';
import type { HealthzResponse, RunnerMode } from '@agenthub/shared';

const PORT = Number(process.env.RUNNER_PORT ?? 8080);
const MODE = (process.env.RUNNER_MODE ?? 'task') as RunnerMode;

const app = Fastify({ logger: true });

app.get('/healthz', async (): Promise<HealthzResponse> => ({
  ok: true,
  mode: MODE,
  serveReady: false,
}));

// TODO(M2): POST /load {inputUrl, task?, bindChatId?} —— 下载还原 → 拉起 serve → 注入接力指令
// TODO(M2): POST /snapshot {outputUrl} —— 现场打包上传返回包
// TODO(M3): GET /chats · POST /bind —— bot 模式钉钉群路由

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
