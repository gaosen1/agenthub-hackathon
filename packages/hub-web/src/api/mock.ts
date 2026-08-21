/**
 * Mock 数据源（spec §7 CP-3：hub-web 先对 mock 数据渲染验收各视图）
 * 数据形状严格对齐 shared DTO（HandoffSummary/HandoffDetail/HandoffEventsResp）
 */
import type { HandoffDetail, HandoffSummary, SandboxEvent } from '@agenthub/shared/contracts';

/** Chat 消息（本地 UI 模型；真 Hub 联调时由 ACP 流驱动） */
export interface ChatMsg {
  role: 'user' | 'agent';
  via?: string;
  text: string;
  tool?: string;
  time: string;
}

/** 详情页扩展信息（mock 专用；真 Hub 后由 events/manifest 推导） */
export interface TaskExtra {
  summary: string;
  rounds: number;
  sandbox: string;
  tokens: string;
  inputPkg: string;
  outputPkg: string;
  elapsed: string;
  pushedAt: string;
  commits: { hash: string; msg: string; files: string; add: string; del: string; time: string }[];
  logs: (SandboxEvent & { id: number })[];
  chat: ChatMsg[];
  failReason?: string;
}

const T = (h: string, m: string, s = '00'): string => `2026-08-04T${h}:${m}:${s}Z`;

export const mockSummaries: HandoffSummary[] = [
  {
    id: 'hf-9f3a2c', agentName: 'payment-gateway', status: 'running', kind: 'web',
    branch: 'refactor/order-service', baseCommit: 'a41c9e0', sessionId: 'sess-c81e3f', archived: false,
    task: '重构 OrderService，拆分状态机逻辑并补齐单元测试',
    createdAt: T('14', '02', '11'), updatedAt: T('14', '15', '00'),
  },
  {
    id: 'hf-7b1e88', agentName: 'data-sync-cli', status: 'done', kind: 'web',
    branch: 'main', baseCommit: 'f02b117', sessionId: 'sess-a2f9d0', archived: false,
    task: '批量迁移 200+ 处 legacy API 调用到 v2 SDK',
    createdAt: T('10', '35', '02'), updatedAt: T('11', '02', '38'),
  },
  {
    id: 'hf-c204d1', agentName: 'ml-feature-store', status: 'queued', kind: 'web',
    branch: 'feat/ttl-cache', baseCommit: '0c8d5aa', sessionId: 'sess-77b2ce', archived: false,
    task: '为特征查询层增加 TTL 缓存与失效策略',
    createdAt: T('14', '18', '44'), updatedAt: T('14', '19', '02'),
  },
  {
    id: 'hf-33e0af', agentName: 'gateway-config', status: 'failed', kind: 'web',
    branch: 'hotfix/rate-limit', baseCommit: '77aa03e', sessionId: 'sess-de10b7', archived: false,
    task: '修复限流配置热更新不生效问题并补充回归用例',
    createdAt: T('03', '20', '05'), updatedAt: T('03', '29', '34'),
  },
];

export const mockDetails: Record<string, HandoffDetail> = {
  'hf-9f3a2c': {
    ...mockSummaries[0],
    timeline: [
      { status: 'created', at: T('14', '02', '11') },
      { status: 'uploaded', at: T('14', '02', '39') },
      { status: 'queued', at: T('14', '02', '40') },
      { status: 'provisioning', at: T('14', '03', '05') },
      { status: 'running', at: T('14', '03', '52') },
    ],
  },
  'hf-7b1e88': {
    ...mockSummaries[1],
    timeline: [
      { status: 'created', at: T('10', '35', '02') },
      { status: 'uploaded', at: T('10', '35', '20') },
      { status: 'queued', at: T('10', '35', '21') },
      { status: 'provisioning', at: T('10', '35', '49') },
      { status: 'running', at: T('10', '36', '30') },
      { status: 'packaging', at: T('11', '01', '44') },
      { status: 'done', at: T('11', '02', '38') },
    ],
    downloadUrl: 'https://oss.example/output.tar.gz?signature=mock',
    result: { status: 'done', cloudHead: 'f4a7d93', commitCount: 3, newSessionIds: [], elapsedSeconds: 1568, tokensUsed: 204700 },
  },
  'hf-c204d1': {
    ...mockSummaries[2],
    timeline: [
      { status: 'created', at: T('14', '18', '44') },
      { status: 'uploaded', at: T('14', '19', '01') },
      { status: 'queued', at: T('14', '19', '02') },
    ],
  },
  'hf-33e0af': {
    ...mockSummaries[3],
    timeline: [
      { status: 'created', at: T('03', '20', '05') },
      { status: 'uploaded', at: T('03', '20', '15') },
      { status: 'queued', at: T('03', '20', '16') },
      { status: 'provisioning', at: T('03', '20', '40') },
      { status: 'running', at: T('03', '21', '22') },
      { status: 'failed', at: T('03', '29', '34') },
    ],
    downloadUrl: 'https://oss.example/output-partial.tar.gz?signature=mock',
    result: {
      status: 'failed', cloudHead: '9d3e5b7', commitCount: 1, newSessionIds: [], elapsedSeconds: 492, tokensUsed: 31200,
      error: 'integration-test 依赖内网 etcd 集群，Sandbox 网络不可达 (connection timeout)',
    },
  },
};

export const mockExtras: Record<string, TaskExtra> = {
  'hf-9f3a2c': {
    summary: '重构 OrderService，拆分状态机逻辑并补齐单元测试',
    rounds: 23, sandbox: 'ah-web-9f3a2c (qwen-code)', tokens: '86.4k',
    inputPkg: '214 MB', outputPkg: '—', elapsed: '12m 40s', pushedAt: '14:02',
    commits: [
      { hash: 'b7e21d4', msg: 'refactor: 抽取 OrderStateMachine，分离状态流转与副作用', files: '6 files', add: '+412', del: '-388', time: '14:09' },
      { hash: 'c93f08a', msg: 'test: OrderStateMachine 状态流转单测（12 cases）', files: '3 files', add: '+286', del: '-4', time: '14:13' },
    ],
    logs: [
      { id: 1, t: '14:03:52', tag: 'sys', c: 'Sandbox 就绪，下载输入包 input.tar.gz (214 MB)' },
      { id: 2, t: '14:03:58', tag: 'sys', c: 'git clone repo.bundle → workspace/payment-gateway @ a41c9e0' },
      { id: 3, t: '14:04:01', tag: 'sys', c: '还原 session sess-c81e3f.jsonl（23 轮对话）→ qwen --resume' },
      { id: 4, t: '14:04:05', tag: 'info', c: '[qwen] 已加载会话上下文，接力指令：继续完成 OrderService 重构并补齐单测' },
      { id: 5, t: '14:04:31', tag: 'tool', c: 'read_file src/order/OrderService.java (1,204 lines)' },
      { id: 6, t: '14:05:12', tag: 'tool', c: 'edit_file src/order/OrderStateMachine.java (+218)' },
      { id: 7, t: '14:06:47', tag: 'tool', c: 'edit_file src/order/OrderService.java (-388 +194)' },
      { id: 8, t: '14:08:20', tag: 'tool', c: 'run_command ./gradlew :order:compileJava — BUILD SUCCESSFUL' },
      { id: 9, t: '14:09:02', tag: 'git', c: 'commit b7e21d4 "refactor: 抽取 OrderStateMachine…"' },
      { id: 10, t: '14:10:15', tag: 'tool', c: 'write_file src/test/order/OrderStateMachineTest.java (+286)' },
      { id: 11, t: '14:12:38', tag: 'tool', c: 'run_command ./gradlew :order:test — 12 passed, 0 failed' },
      { id: 12, t: '14:13:04', tag: 'git', c: 'commit c93f08a "test: OrderStateMachine 状态流转单测"' },
      { id: 13, t: '14:14:21', tag: 'info', c: '[qwen] 收到远程 Chat 指令：顺便把 OrderController 里的废弃接口清掉' },
      { id: 14, t: '14:14:40', tag: 'tool', c: 'grep_search "@Deprecated" src/order/ — 3 matches' },
    ],
    chat: [
      { role: 'agent', text: '已从本地会话恢复上下文（23 轮）。按讨论结论继续：先抽取 OrderStateMachine，再迁移 OrderService 中的状态流转调用点。', time: '14:04' },
      { role: 'agent', text: '重构完成并通过编译，已提交 b7e21d4。开始补充状态机单元测试。', tool: 'run_command · ./gradlew :order:test', time: '14:12' },
      { role: 'user', via: '钉钉', text: '顺便把 OrderController 里的废弃接口清掉', time: '14:14' },
      { role: 'agent', text: '收到。扫描到 3 处 @Deprecated 接口，确认无内部调用后将一并移除，完成后单独提交一个 commit。', tool: 'grep_search · "@Deprecated" src/order/', time: '14:14' },
    ],
  },
  'hf-7b1e88': {
    summary: '批量迁移 200+ 处 legacy API 调用到 v2 SDK',
    rounds: 17, sandbox: 'ah-web-7b1e88 (已回收)', tokens: '204.7k',
    inputPkg: '96 MB', outputPkg: '12 MB', elapsed: '26m 08s', pushedAt: '10:35',
    commits: [
      { hash: 'd15ac02', msg: 'chore: 迁移 storage 模块 84 处调用至 v2 SDK', files: '21 files', add: '+503', del: '-467', time: '18:47' },
      { hash: 'e8830b1', msg: 'chore: 迁移 network / auth 模块 129 处调用', files: '34 files', add: '+861', del: '-802', time: '18:56' },
      { hash: 'f4a7d93', msg: 'test: 全量回归通过，移除 legacy shim', files: '8 files', add: '+37', del: '-215', time: '19:00' },
    ],
    logs: [
      { id: 1, t: '18:36:30', tag: 'sys', c: 'Sandbox 就绪，还原 workspace 与 session（17 轮）' },
      { id: 2, t: '18:37:02', tag: 'info', c: '[qwen] 按本地会话中确认的映射表执行批量迁移' },
      { id: 3, t: '18:45:11', tag: 'tool', c: 'apply_edits storage/*（84 处替换）' },
      { id: 4, t: '18:55:47', tag: 'tool', c: 'apply_edits network/* auth/*（129 处替换）' },
      { id: 5, t: '18:59:30', tag: 'tool', c: 'run_command pytest — 412 passed' },
      { id: 6, t: '19:01:44', tag: 'sys', c: '开始 packaging：result.bundle（3 commits）+ session 增量（14 轮）' },
      { id: 7, t: '19:02:38', tag: 'ok', c: '返回包已上传 OSS：output.tar.gz (12 MB)，Sandbox 已销毁' },
    ],
    chat: [
      { role: 'agent', text: '会话已恢复。按本地讨论确认的 API 映射表开始批量迁移，共扫描到 213 处 legacy 调用。', time: '18:37' },
      { role: 'user', via: 'Web', text: '迁移完跑一遍全量测试再收尾', time: '18:52' },
      { role: 'agent', text: '全量回归 412 个用例全部通过，已移除 legacy shim 并完成 3 个 commit。任务收尾，返回包已上传。', tool: 'run_command · pytest (412 passed)', time: '19:01' },
    ],
  },
  'hf-c204d1': {
    summary: '为特征查询层增加 TTL 缓存与失效策略',
    rounds: 9, sandbox: '待分配', tokens: '—',
    inputPkg: '58 MB', outputPkg: '—', elapsed: '—', pushedAt: '14:18',
    commits: [],
    logs: [{ id: 1, t: '14:19:02', tag: 'sys', c: '输入包已上传，等待 Worker 领取…' }],
    chat: [],
  },
  'hf-33e0af': {
    summary: '修复限流配置热更新不生效问题并补充回归用例',
    rounds: 12, sandbox: 'ah-web-33e0af (已回收)', tokens: '31.2k',
    inputPkg: '22 MB', outputPkg: '4 MB（部分成果）', elapsed: '8m 12s（超时前）', pushedAt: '03:20',
    commits: [
      { hash: '9d3e5b7', msg: 'wip: 定位到 ConfigWatcher 未注册 rate-limit 命名空间', files: '2 files', add: '+18', del: '-3', time: '11:26' },
    ],
    logs: [
      { id: 1, t: '11:21:22', tag: 'sys', c: 'Sandbox 就绪，恢复会话（12 轮）' },
      { id: 2, t: '11:24:50', tag: 'tool', c: 'run_command make integration-test' },
      { id: 3, t: '11:28:31', tag: 'err', c: 'integration-test 依赖内网 etcd 集群，Sandbox 网络不可达 (connection timeout)' },
      { id: 4, t: '11:29:34', tag: 'err', c: '连续 3 次重试失败，任务标记 failed；部分成果已打包回传' },
    ],
    chat: [
      { role: 'agent', text: '集成测试依赖内网 etcd（10.32.x.x:2379），Sandbox 网络不可达，无法继续验证。已将定位结论与 WIP commit 打入返回包，建议 pull 回本地在内网环境完成验证。', time: '11:29' },
    ],
    failReason: '集成测试依赖内网 etcd 集群，Sandbox 网络不可达。已保留 WIP commit 与云端会话记录。',
  },
};
