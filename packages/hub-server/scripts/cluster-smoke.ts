/**
 * 真实集群冒烟脚本（一次性，spec §7 D2 验收辅助）：
 * 用生产代码路径 K8sOrchestrator + PortForwardConnector 对真实 ACK/ACS 建 Pod、
 * 等就绪、port-forward 打通 HTTP、删 Pod。用法：
 *   pnpm --filter @agenthub/hub-server exec tsx scripts/cluster-smoke.ts
 */
import { PortForward } from '@kubernetes/client-node';
import { K8sOrchestrator, loadKube } from '../src/k8s.js';
import { PortForwardConnector } from '../src/connector.js';

const NS = 'agenthub';
const POD = 'smoke-orchestrator';
const IMAGE = process.env.SMOKE_IMAGE ?? 'registry.cn-hangzhou.aliyuncs.com/acs-sample/nginx:latest';
const PORT = Number(process.env.SMOKE_PORT ?? 80);

async function main(): Promise<void> {
  const kc = loadKube();
  const orch = new K8sOrchestrator(kc, {
    namespace: NS,
    image: IMAGE,
    acs: true,
    ...(process.env.SMOKE_PULL_SECRET ? { imagePullSecret: process.env.SMOKE_PULL_SECRET } : {}),
  });

  console.log('creating pod via K8sOrchestrator...');
  await orch.createPod({
    podName: POD,
    mode: 'web',
    env: {},
    secretRefs: [],
    labels: { 'agenthub/kind': 'smoke' },
  });

  const deadline = Date.now() + 180_000;
  for (;;) {
    const phase = await orch.getPodPhase(POD);
    console.log('phase:', phase);
    // nginx 镜像没有 /healthz，readiness 探针不会过 → pending 即算调度成功，转而等容器起来
    if (phase === 'failed' || phase === 'gone') throw new Error(`pod ${phase}`);
    if (Date.now() > deadline) break;
    if (phase === 'ready') break;
    await new Promise((r) => setTimeout(r, 3000));
    // pending 超过 60s 且容器已 Running 也继续（探针不匹配 nginx 是预期内）
    const raw = await orch.coreApi().readNamespacedPod({ name: POD, namespace: NS });
    if (raw.status?.containerStatuses?.[0]?.state?.running) {
      console.log('container running (readiness probe not applicable to nginx) — proceeding');
      break;
    }
  }

  console.log('port-forwarding via PortForwardConnector...');
  const connector = new PortForwardConnector(new PortForward(kc));
  const base = await connector.getBaseUrl({ namespace: NS, podName: POD }, PORT);
  const path = PORT === 8080 ? '/healthz' : '/';
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
  console.log('HTTP', res.status, await res.text().then((t) => t.slice(0, 120)).catch(() => ''), 'via', base);
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);

  await connector.dispose({ namespace: NS, podName: POD });
  const pods = await orch.listSandboxPodNames();
  console.log('sandbox pods:', pods);
  await orch.deletePod(POD);
  console.log('deleted. smoke OK ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
