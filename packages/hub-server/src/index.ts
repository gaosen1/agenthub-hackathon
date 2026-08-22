/**
 * hub-server 入口：生产装配（spec §4.2 / §5）
 * K8s 可用时启用 Worker 编排与 sandbox 相关路由；否则仅控制面 API（M1 数据链路）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PortForward } from '@kubernetes/client-node';
import { buildApp, type SandboxDeps } from './app.js';
import { openDb } from './db.js';
import { createOssClient } from './oss.js';
import { DirectConnector, PortForwardConnector, type SandboxConnector } from './connector.js';
import { K8sOrchestrator, loadKube, sandboxImage } from './k8s.js';
import { AoneConnector, AoneOrchestrator, aoneDeps } from './aone.js';
import { Worker } from './worker.js';
import { Notifier } from './notifier.js';

// fetch（undici）默认不读代理 env：Aone 网关 *.agent.alibaba-inc.com 仅办公网代理可达，
// 装上 EnvHttpProxyAgent（尊重 no_proxy，aliyuncs.com 等直照直连）
if (process.env.https_proxy || process.env.HTTPS_PROXY) {
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (e) {
    console.warn(`proxy dispatcher unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
const signer = createOssClient();

// 沙箱后端装配：aone（弹内免费算力）| k8s（公有云默认）；不可用时降级为纯控制面
let sandbox: SandboxDeps | undefined;
let worker: Worker | undefined;
if (process.env.SANDBOX_BACKEND === 'aone') {
  try {
    const apiKey = process.env.AONE_API_KEY;
    if (!apiKey) throw new Error('AONE_API_KEY is required for SANDBOX_BACKEND=aone');
    const sdk = await aoneDeps.loadSdk();
    const orchestrator = new AoneOrchestrator(
      {
        apiKey,
        image: process.env.AONE_IMAGE ?? sandboxImage(),
        entrypoint: process.env.AONE_ENTRYPOINT ?? 'cd /app && exec node dist/runner.js',
        timeoutSeconds: Number(process.env.AONE_TTL_SECONDS ?? 86400),
        resource: { cpu: '2', memory: '4Gi' },
      },
      sdk,
    );
    const connector = new AoneConnector(orchestrator);
    worker = new Worker(
      db,
      orchestrator,
      connector,
      signer,
      { namespace: 'aone', idleTtlMinutes: Number(process.env.SANDBOX_IDLE_TTL_MINUTES ?? 120) },
      SECRET,
      new Notifier(db, SECRET),
    );
    sandbox = { connector, orchestrator, namespace: 'aone', worker, image: process.env.AONE_IMAGE ?? sandboxImage(), acs: false };
  } catch (e) {
    console.warn(`aone backend unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
} else if (process.env.HUB_NO_K8S !== '1') {
  try {
    const kc = loadKube();
    const orchestrator = new K8sOrchestrator(kc, {
      namespace: NAMESPACE,
      image: sandboxImage(),
      acs: process.env.SANDBOX_ACS !== '0',
      ...(process.env.SANDBOX_PULL_SECRET ? { imagePullSecret: process.env.SANDBOX_PULL_SECRET } : {}),
      ...(process.env.SANDBOX_CONFIGMAP ? { configMapName: process.env.SANDBOX_CONFIGMAP } : {}),
      // NAS 共享只读层：server 与 path 都配置才启用（Web IDE 等工具的预置层）
      ...(process.env.SANDBOX_NAS_SERVER && process.env.SANDBOX_NAS_PATH
        ? { nas: { server: process.env.SANDBOX_NAS_SERVER, path: process.env.SANDBOX_NAS_PATH } }
        : {}),
    });
    const connector: SandboxConnector =
      process.env.HUB_IN_CLUSTER === '1' ? new DirectConnector(orchestrator.coreApi()) : new PortForwardConnector(new PortForward(kc));
    worker = new Worker(db, orchestrator, connector, signer, {
      namespace: NAMESPACE,
      idleTtlMinutes: Number(process.env.SANDBOX_IDLE_TTL_MINUTES ?? 120),
    }, SECRET, new Notifier(db, SECRET));
    sandbox = { connector, orchestrator, namespace: NAMESPACE, worker, image: sandboxImage(), acs: process.env.SANDBOX_ACS !== '0' };
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
