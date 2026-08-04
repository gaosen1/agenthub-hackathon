/**
 * hub-server 入口：生产装配（spec §4.2 / §5）
 * K8s 可用时启用 Worker 编排与 sandbox 相关路由；否则仅控制面 API（M1 数据链路）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PortForward } from '@kubernetes/client-node';
import { buildApp, type SandboxDeps } from './app.js';
import { openDb } from './db.js';
import { createOssSigner } from './oss.js';
import { DirectConnector, PortForwardConnector, type SandboxConnector } from './connector.js';
import { K8sOrchestrator, loadKube } from './k8s.js';
import { Worker } from './worker.js';

const PORT = Number(process.env.HUB_PORT ?? 4180);
const DB_PATH = process.env.HUB_DB_PATH ?? './data/hub.sqlite';
const SECRET = process.env.HUB_SECRET_KEY;
const NAMESPACE = process.env.SANDBOX_NAMESPACE ?? 'agenthub';

if (!SECRET) {
  console.error('HUB_SECRET_KEY is required');
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const signer = createOssSigner();

// K8s 编排装配：kubeconfig 不可用时降级为纯控制面（HUB_NO_K8S=1 显式关闭）
let sandbox: SandboxDeps | undefined;
let worker: Worker | undefined;
if (process.env.HUB_NO_K8S !== '1') {
  try {
    const kc = loadKube();
    const orchestrator = new K8sOrchestrator(kc, {
      namespace: NAMESPACE,
      image: process.env.SANDBOX_IMAGE ?? 'agenthub/sandbox:dev',
      acs: process.env.SANDBOX_ACS !== '0',
      ...(process.env.SANDBOX_PULL_SECRET ? { imagePullSecret: process.env.SANDBOX_PULL_SECRET } : {}),
    });
    const connector: SandboxConnector =
      process.env.HUB_IN_CLUSTER === '1' ? new DirectConnector(orchestrator.coreApi()) : new PortForwardConnector(new PortForward(kc));
    worker = new Worker(db, orchestrator, connector, signer, {
      namespace: NAMESPACE,
      idleTtlMinutes: Number(process.env.SANDBOX_IDLE_TTL_MINUTES ?? 120),
    });
    sandbox = { connector, orchestrator, namespace: NAMESPACE, worker };
  } catch (e) {
    console.warn(`k8s unavailable, orchestration disabled: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const app = buildApp({
  db,
  signer,
  secret: SECRET,
  webBaseUrl: process.env.HUB_WEB_URL,
  sandbox,
  webDistDir: process.env.HUB_WEB_DIST ?? new URL('../../hub-web/dist', import.meta.url).pathname,
});

app
  .listen({ port: PORT, host: process.env.HUB_HOST ?? '127.0.0.1' })
  .then(async () => {
    console.log(`hub-server listening on :${PORT}${sandbox ? ' (k8s orchestration on)' : ' (no k8s)'}`);
    if (worker) {
      await worker.recover().catch((e) => console.warn(`recover failed: ${e}`));
      await worker.cleanupOrphans().catch(() => undefined);
      worker.start(Number(process.env.WORKER_INTERVAL_MS ?? 5000));
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
