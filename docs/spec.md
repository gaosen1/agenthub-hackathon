# AgentHub 完整设计规格（Spec）

> 本文档是开发的**唯一契约**：所有数据格式、接口定义、分工以此为准。产品背景与竞品分析见 [design.md](./design.md)，UI 原型见 [prototype.html](./prototype.html)。
>
> 契约变更规则：`§3 数据格式` 与 `§4 接口定义` 的任何改动必须 PR + 知会对方，其余章节可自行更新。

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0（实现基线） |
| 团队 | Team 055：俊良、松间客 |
| 最后更新 | 2026-08 |

---

## 1. 系统概览

```
本地: qwen + agenthub CLI
        │ REST /api/*（JWT）           ┌── OSS（签名 URL 直传直取）
        ▼                              │
hub-server (Fastify + SQLite)  ────────┤
  ├─ REST API / 状态机 / 签名 URL       │
  ├─ Worker：K8s 编排（@kubernetes/client-node）
  └─ Chat 代理：反代 sandbox 的 /acp    │
        │ SandboxConnector（port-forward → Pod IP）
        ▼                              │
ACK 集群（ACS 算力，ns=agenthub）        │
  Pod = runner(:8080, 1号进程) ─────────┘
         └─ spawn qwen serve(:8081)
              ├─ task/web 模式: ACP over HTTP
              └─ bot 模式: --channel 钉钉 Stream 出站长连接 ←→ 钉钉群
```

**两个正交维度**：
- **载体 `kind`**：`web`（临时 sandbox，Web 聊天入口，pull 后销毁）| `bot`（常驻钉钉机器人 sandbox，群内 @ 对话）
- **初始指令 `task`（可选，与载体无关）**：带 task → 恢复 session 后自动注入该指令 headless 续跑（期间仍可 Web/钉钉插话）；不带 → 恢复后挂起等待对话。产品叙事中的"任务接力/交互接力"即指此维度，不是 API 枚举

**monorepo 结构**（pnpm workspaces，全 TypeScript，Node 22）：

```
packages/
  shared/       # 本规格 §3/§4 的全部类型 + 打包/解包/合并库（zod schema 即契约）
  cli/          # agenthub CLI
  hub-server/   # REST + Worker + Chat 代理
  hub-web/      # Web 面板（按 prototype.html）
  sandbox/      # Dockerfile + runner
deploy/         # K8s manifests + 构建脚本
```

---

## 2. 通用约定

- 所有 HTTP body 为 `application/json`（SSE、tar.gz 上传下载除外）；时间一律 ISO8601 UTC 字符串
- ID 规则：handoff id = `hf-` + 6 位 hex；snapshot id = `snap-` + 6 位 hex；session id 沿用 qwen 的 uuid
- 所有接口的请求/响应类型在 `packages/shared/src/dto.ts` 用 zod 定义并导出，服务端入参必须过 zod 校验
- 错误响应统一格式：`{ "error": { "code": "<ERR_CODE>", "message": "<人类可读>" } }`，HTTP 状态码见 §4.6

---

## 3. 数据格式

### 3.1 输入包 / 返回包（tar.gz 布局）

**输入包** `handoffs/<userId>/<handoffId>/input.tar.gz`：

```
manifest.json
repo.bundle                    # git bundle：首次全量（git bundle create repo.bundle --all）
worktree/                      # 未提交变更 + 白名单未跟踪文件（遵循 .gitignore；不含 .git/）
qwen-home/
  projects/<wsHash>/chats/<sessionId>.jsonl    # 移交的 session（末尾已追加 handoff_marker）
  settings.json                # 剔除密钥后的 qwen 配置（可缺省）
```

**返回包** `handoffs/<userId>/<handoffId>/output.tar.gz`：

```
manifest.json                  # direction=pull，含执行结果字段
result.bundle                  # 云端 commit 增量：git bundle create result.bundle <baseCommit>..HEAD（无新 commit 则缺省）
qwen-home/projects/<wsHash>/chats/*.jsonl      # 全部会话文件（含移交 session 的完整版 + bot 各群新 session）
logs/events.jsonl              # 结构化执行日志（§3.6）
```

### 3.2 manifest.json（shared: `HandoffManifest`）

```ts
interface HandoffManifest {
  version: 1;
  handoffId: string;               // hf-xxxxxx
  direction: 'push' | 'pull';
  agentName: string;               // 默认 basename(workspacePath)
  workspacePath: string;           // 本地绝对路径，容器内必须原样重建
  wsHash: string;                  // getWorkspaceScopeDirName(workspacePath)，还原后自校验
  repo: {
    baseCommit: string;            // push 时 HEAD（云端增量 bundle 的基准）
    branch: string;
    dirty: boolean;                // push 时是否有未提交变更
  };
  sessionId: string;               // 移交的 session
  task?: string;                   // 接力指令；缺省 = 交互接力
  timeoutMinutes: number;          // 默认 30（任务接力硬超时）
  qwenVersion: string;
  createdAt: string;
  // —— 以下仅 direction=pull（返回包）时存在 ——
  result?: {
    status: 'done' | 'failed' | 'cancelled' | 'expired';
    cloudHead?: string;            // 云端 HEAD commit
    commitCount: number;
    newSessionIds: string[];       // 云端新产生的 session（bot 各群）
    elapsedSeconds: number;
    tokensUsed?: number;
    error?: string;
  };
}
```

### 3.3 handoff_marker（jsonl 锚点记录）

push 时由 CLI 追加到移交 session jsonl 的最后一行；pull 合并时以它定位共同前缀：

```json
{ "type": "agenthub_handoff_marker", "handoffId": "hf-9f3a2c",
  "baseCommit": "a41c9e0", "messageCount": 46, "timestamp": "2026-08-04T06:02:39Z" }
```

- `messageCount`：marker 之前的记录条数，合并时校验共同前缀（P1 升级为 hash 链）
- qwen 加载 jsonl 时忽略未知 type 的行（已验证），marker 不影响 resume

### 3.4 session jsonl 合并器依赖的最小字段集

合并器（shared: `mergeSessionJsonl`）只读取每行的：`timestamp`（或等价时间字段）、`role`/`type`、原始行文本。规则：

1. 按 marker 的 `messageCount` 切出共同前缀，校验两侧前缀条数一致，不一致 → `ERR_MERGE_PREFIX_MISMATCH`（不动本地文件）
2. 本地无增量 → 云端增量直接 append
3. 本地有增量（分叉）→ 按 timestamp 交错合并；每条云端记录注入 `"agenthub_source":"cloud"` 字段；合并点插入一条系统消息行说明来源
4. 合并前备份 `<file>.bak.<epoch>`；同一 handoffId 重复合并直接跳过（幂等，靠已存在的合并标记行判断）

### 3.5 bot 路由表 routes.json（qwen 既有格式，runner 只读写不定义）

路径：`~/.qwen/channels/daemon/<wsHash>/routes.json`

```json
{
  "<botName>:<chatId>": {
    "sessionId": "<uuid>",
    "target": { "channelName": "<botName>", "senderId": "-", "chatId": "<chatId>", "isGroup": true },
    "cwd": "<workspacePath>"
  }
}
```

- `sessionScope=chat_thread` → key 为 `<botName>:<chatId>`：同群共享 session、跨群隔离
- 绑定 = 改写目标 key 的 `sessionId` 后重启 serve（daemon 启动时 `restoreRoutes()` 懒恢复，下条消息 `loadSession` 接续历史，失败自动降级新建）
- 同目录 `observed-contacts.json` 提供机器人见过的群/联系人，`GET /chats` 合并两者

### 3.6 执行日志 logs/events.jsonl（shared: `SandboxEvent`）

```ts
interface SandboxEvent {
  t: string;                       // ISO8601
  tag: 'sys' | 'info' | 'tool' | 'git' | 'chat' | 'ok' | 'err';
  c: string;                       // 内容（单行）
}
```
runner 产出，Web 日志流与钉钉摘要都消费此格式。

### 3.7 settings.json 注入（bot 模式，runner 生成/合并）

```jsonc
{
  "channels": {
    "<botName>": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",       // $ENV 引用，由 qwen 启动时解析
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "cwd": "<workspacePath>",                 // 必须 = serve --workspace（daemon 校验）
      "sessionScope": "chat_thread",
      "groupPolicy": "open"
    }
  }
}
```

### 3.8 SQLite DDL（hub-server 独占，其他包不直接碰库）

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- argon2id
  created_at TEXT NOT NULL
);
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,                      -- hf-xxxxxx
  user_id INTEGER NOT NULL REFERENCES users(id),
  agent_name TEXT NOT NULL, workspace_path TEXT NOT NULL, ws_hash TEXT NOT NULL,
  session_id TEXT NOT NULL, task TEXT, timeout_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL,                     -- §4.1 状态机
  kind TEXT NOT NULL,                       -- web | bot（载体；task 字段正交）
  bot_id INTEGER REFERENCES bots(id), bind_chat_id TEXT,
  pod_name TEXT, serve_token TEXT, runner_token TEXT,
  base_commit TEXT NOT NULL, branch TEXT NOT NULL,
  input_oss_key TEXT, output_oss_key TEXT,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_active_at TEXT                       -- 交互接力空闲 TTL 依据
);
CREATE TABLE handoff_events (               -- 状态时间线 + 关键事件（Web 展示）
  id INTEGER PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id),
  at TEXT NOT NULL, kind TEXT NOT NULL,     -- status | log
  payload TEXT NOT NULL                     -- status 名或 SandboxEvent JSON
);
CREATE TABLE bots (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                       -- channel 实例名
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,          -- AES-256-GCM(HUB_SECRET_KEY)
  pod_name TEXT, runner_token TEXT,
  status TEXT NOT NULL,                     -- creating | running | error | deleted
  current_handoff_id TEXT REFERENCES handoffs(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
```

### 3.9 OSS 规划

- bucket：`your-agenthub-bucket`（杭州）；Pod/CLI 走签名 URL，无长期凭证
- key：`handoffs/<userId>/<handoffId>/input.tar.gz | output.tar.gz`
- 生命周期规则：`handoffs/` 前缀 7 天自动删除；签名 URL 有效期 30 分钟

---

## 4. 接口定义

### 4.1 handoff 状态机

```
created → uploaded → queued → provisioning → running → packaging → done
                                   │            │
                                   └────────────┴──→ failed / cancelled / expired
```

- 生命周期全程活跃度驱动：有活动不回收；`running` 中无 task 或 task 已完成的会话空闲 TTL（默认 30min，env SANDBOX_IDLE_TTL_MINUTES 可调）到期 → packaging → expired
- 带 task 的 handoff 的 timeoutMinutes（缺省 1440 分钟）语义为最长静默容忍而非寿命上限：仅适用于任务执行期（task 未完成），以「进 running 与最近活动时间的较晚者」起算，活跃任务（含 24h+ 长任务）持续续命；taskDone 后时钟停摆
- bot 驻留期（含 task 完成后）改按 runner 上报的活跃度（控制面事件 ∨ session jsonl mtime）计空闲 TTL，活跃即续命（hf-0dc37c）

### 4.2 hub-server REST API（前缀 `/api`；除 auth 外均需 `Authorization: Bearer <jwt>`）

#### 认证

| Method Path | 请求 | 响应 |
| --- | --- | --- |
| `POST /api/auth/register` | `{username, password}` | `201 {token, user:{id,username}}` |
| `POST /api/auth/login` | `{username, password}` | `200 {token, user}`；失败 `401 ERR_AUTH` |

#### Handoff

**`POST /api/handoffs`** — 创建（CLI push 第一步）
```jsonc
// 请求（CreateHandoffReq）
{ "agentName": "payment-gateway", "workspacePath": "/Users/x/payment-gateway",
  "wsHash": "payment-gateway-ab12cd34ef56", "sessionId": "<uuid>",
  "baseCommit": "a41c9e0", "branch": "refactor/order-service",
  "task": "继续完成重构并补齐单测",          // 可选，与 kind 正交：带 → 落地后自动续跑；不带 → 挂起等对话
  "kind": "web",                             // web | bot（载体）
  "botId": 3, "bindChatId": "cid...",        // kind=bot 时
  "timeoutMinutes": 30 }
// 响应 201（CreateHandoffResp）
{ "handoffId": "hf-9f3a2c",
  "uploadUrl": "https://...oss...signature...",   // PUT input.tar.gz，30min 有效
  "webUrl": "https://hub.../tasks/hf-9f3a2c" }
```

**`POST /api/handoffs/:id/uploaded`** — 上传回执，状态 → uploaded → queued。响应 `200 {status:"queued"}`

**`GET /api/handoffs/:id`** — 详情
```jsonc
// 响应 200（HandoffDetail）
{ "id": "hf-9f3a2c", "agentName": "...", "status": "running", "kind": "task",
  "branch": "...", "baseCommit": "...", "sessionId": "...", "task": "...",
  "createdAt": "...", "updatedAt": "...",
  "timeline": [ {"status": "created", "at": "..."}, {"status": "uploaded", "at": "..."} ],
  "downloadUrl": "https://...",              // 仅 done/failed/expired/cancelled 且返回包存在
  "result": { /* manifest.result，终态时 */ } }
```

**`GET /api/handoffs?agentName=&status=&limit=`** — 列表，响应 `200 {items: HandoffSummary[]}`（Summary = Detail 去掉 timeline/result）

**`GET /api/handoffs/:id/events?after=<eventId>`** — 日志流（Web 轮询），响应 `200 {items: [{id, at, kind, payload}], nextAfter}`

**`POST /api/handoffs/:id/cancel`** — 取消。queued 直接终态；执行中触发 packaging，部分成果仍打包。响应 `200 {status}`

**`POST /api/handoffs/:id/pull-intent`** — CLI pull 入口：非终态 `409 ERR_NOT_READY {status}`；终态返回 `200 {downloadUrl, manifest}`

#### Chat 代理（Web 聊天，kind=web 且 running）

**`ANY /api/handoffs/:id/chat/acp`** — 透明反代 sandbox `qwen serve` 的 `/acp`（POST/GET-SSE/DELETE 原样转发，注入 `Authorization: Bearer <serve_token>`；转发 `Acp-Connection-Id` / `Acp-Session-Id` / `Last-Event-ID` 头）。每次代理更新 `last_active_at`。

#### Bot

| Method Path | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/bots` | — | `200 {items: Bot[]}`（Bot = {id,name,status,podName,currentHandoffId,createdAt}，不回传 secret） |
| `POST /api/bots` | `{name, clientId, clientSecret}` | `201 Bot`（加密入库 → 建 Secret + 常驻 Pod） |
| `DELETE /api/bots/:id` | — | `204`（删 Pod + Secret，软删记录） |
| `GET /api/bots/:id/chats` | — | `200 {items: [{chatId, title?, lastSeenAt?}]}`（透传 runner） |
| `POST /api/bots/:id/bind` | `{chatId, sessionId}` | `200 {ok:true}`（透传 runner /bind） |

### 4.3 runner 控制面协议（Pod :8080；认证头 `X-Runner-Token: <runner_token>`）

| 接口 | 请求 | 响应 / 行为 |
| --- | --- | --- |
| `GET /healthz` | — | `200 {ok:true, mode:"web"\|"bot", serveReady:boolean, loadedHandoffId?:string}` |
| `POST /load` | `{inputUrl, task?, bindChatId?, serveToken?}` | `202 {accepted:true}`；异步执行：下载解包 → 校验 wsHash → 重建 workspacePath → 铺 qwen-home → （bot）写 channels 配置/（可选）改路由 → spawn serve → 就绪后 serveReady=true。失败记录到 /healthz 的 `lastError` |
| `POST /snapshot` | `{outputUrl}` | `200 {manifest: HandoffManifest}`；现场打包（result.bundle + 全部 chats + logs）PUT 到签名 URL |
| `GET /chats` | — | `200 {items:[{chatId,title?,lastSeenAt?}]}`（bot 模式；合并 routes.json + observed-contacts.json） |
| `POST /bind` | `{chatId, sessionId}` | `200 {ok:true}`：停 serve → 改写/新增 `<botName>:<chatId>` 路由指向 sessionId → 重启 serve |
| `GET /logs?after=<n>` | — | `200 {items: SandboxEvent[], nextAfter}`（Worker 轮询搬运到 handoff_events） |

runner 进程模型：容器 1 号进程；`qwen serve` 为其子进程（stop/start 实现绑定重启，Pod 不重建）；spawn 参数：
- web：`qwen serve --hostname 0.0.0.0 --port 8081 --workspace <ws>`，env `QWEN_SERVER_TOKEN=<serveToken>`
- bot：`qwen serve --workspace <ws> --channel <botName>`（loopback 即可，无外部访问）

### 4.4 ACP over HTTP 消息子集（shared: `acp.ts`；hub-web 与 runner 共用）

传输：`POST /acp`（提交，202）+ `GET /acp`（SSE 收流）+ `DELETE /acp`（关连接）。
头：`Acp-Connection-Id`（客户端生成 uuid，全程携带）、`Acp-Session-Id`（会话级流）、`Accept: text/event-stream`（GET）、`Last-Event-ID`（断线续传）。

最小 JSON-RPC 方法集（客户端只需实现这些）：

```jsonc
// 1. 初始化
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }
// 2. 恢复移交的 session（首选）
{ "jsonrpc": "2.0", "id": 2, "method": "session/load",
  "params": { "sessionId": "<pushed>", "cwd": "<workspacePath>" } }
// 3.（备选）新会话
{ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": "<workspacePath>" } }
// 4. 发消息
{ "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
  "params": { "sessionId": "...", "prompt": [ { "type": "text", "text": "..." } ] } }
// 5. 权限请求应答（收到 session/request_permission 后）
{ "jsonrpc": "2.0", "id": 4, "method": "session/permission_response", "params": { ... } }
```

SSE 事件负载为 JSON-RPC 帧；hub-web 渲染这三类：`session/update`（增量输出/工具调用，按 `params.update.sessionUpdate` 分派）、`session/request_permission`、id 应答帧（方法返回值）。演示期权限策略：serve 端配 `approvalMode=yolo`（sandbox 隔离环境，自动放行），Web 端权限 UI 为 P1。

### 4.5 SandboxConnector（hub-server 内部抽象）

```ts
interface PodRef { namespace: string; podName: string; }
interface SandboxConnector {
  // 返回可直接发 HTTP 的 base URL（实现内部维护 port-forward 或直连）
  getBaseUrl(pod: PodRef, port: number): Promise<string>;
  dispose(pod: PodRef): Promise<void>;
}
// PortForwardConnector: kubectl port-forward 等价实现（开发期，HUB_IN_CLUSTER 未设）
// DirectConnector: http://<podIP>:<port>（上云后）
```

### 4.6 错误码

| code | HTTP | 场景 |
| --- | --- | --- |
| ERR_AUTH | 401 | token 无效/过期 |
| ERR_FORBIDDEN | 403 | 资源不属于当前用户 |
| ERR_NOT_FOUND | 404 | handoff/bot 不存在 |
| ERR_NOT_READY | 409 | pull 时任务未到终态；chat 时 sandbox 未 ready |
| ERR_STATE | 409 | 状态机非法流转（如对 done 任务 cancel） |
| ERR_VALIDATION | 400 | zod 校验失败 |
| ERR_OSS | 502 | 签名/上传/下载失败 |
| ERR_K8S | 502 | Pod 创建/删除失败 |
| ERR_RUNNER | 502 | runner 调用失败/超时 |
| ERR_MERGE_PREFIX_MISMATCH | —(CLI 本地) | jsonl 共同前缀校验失败 |

### 4.7 CLI 命令面（用户接口）

```
agenthub login [--hub <url>]                         # token 存 ~/.agenthub/config.json
agenthub push [--task "<指令>"] [--session <id>]
              [--bot <name> [--chat <chatId>]]
              [--include-untracked] [--timeout <min>]
agenthub pull [<handoff-id>] [--branch]              # --branch: 落 agenthub/<id> 分支
agenthub list [--all]
agenthub status <handoff-id>
agenthub cancel <handoff-id>
```

---

## 5. 运行时与环境

### 5.1 Pod spec 要点（Worker 生成）

```yaml
metadata:
  generateName: ah-<kind>-<handoffId|botName>-
  labels: { app: agenthub-sandbox, agenthub/kind: "<web|bot>", agenthub/owner: "<userId>" }
spec:
  nodeSelector: { type: virtual-kubelet }        # 以集群 ack-virtual-node 实际要求为准
  tolerations: [{ key: virtual-kubelet.io/provider, operator: Exists }]
  containers:
  - name: sandbox
    image: <ACR>/agenthub-demo/sandbox:<tag>          # node22 + qwen(固定版) + runner + git/rg
    ports: [{ containerPort: 8080 }, { containerPort: 8081 }]
    resources: { requests: { cpu: "2", memory: 4Gi }, limits: { cpu: "2", memory: 4Gi } }
    env:
    - RUNNER_MODE=<web|bot>
    - RUNNER_TOKEN=<random>                      # Hub↔runner 认证
    - QWEN_SERVER_TOKEN=<random>                 # task/web 模式 serve 认证
    - OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL  ← secretRef agenthub-model
    - DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET      ← secretRef bot-<botId>（bot 模式）
    readinessProbe: httpGet /healthz :8080
```

无 Service/Ingress：Hub 经 SandboxConnector 访问；钉钉为出站连接。

### 5.2 环境变量清单

| 进程 | 变量 | 说明 |
| --- | --- | --- |
| hub-server | `HUB_SECRET_KEY` | JWT 签名 + bot secret AES 密钥 |
| | `OSS_AK/OSS_SK/OSS_BUCKET/OSS_REGION`（或 RAM 角色） | 签名 URL 签发 |
| | `KUBECONFIG` / in-cluster SA | K8s 访问 |
| | `HUB_IN_CLUSTER` | 置 1 用 DirectConnector |
| CLI | `AGENTHUB_HUB_URL`（可选） | 覆盖配置文件 |
| runner/serve | 见 §5.1 Pod env | |

### 5.3 集群准备清单（一次性）

1. ACK 控制台开启 API Server 公网端点 + IP 白名单，下载 kubeconfig（上云后 Hub 改用 in-cluster SA）
2. 确认/安装 ack-virtual-node 组件，nginx Pod 冒烟验证 ACS 调度与计费
3. 建 ns `agenthub`、Secret `agenthub-model`、ACR 个人版仓库
4. OSS bucket 配置 `handoffs/` 生命周期 7 天过期规则

---

## 6. 分工（并行开发契约）

### 6.1 责任分界

| | 松间客（A 线：数据面 / 本地侧 / 前端） | 俊良（B 线：控制面 / 云端侧 / 钉钉） |
| --- | --- | --- |
| **负责包** | `shared`、`cli`、`hub-web` | `hub-server`、`sandbox`、`deploy/` |
| **§3 数据格式主笔** | 3.1–3.4（包/manifest/marker/合并） | 3.5–3.9（路由/日志/settings/DDL/OSS） |
| **§4 接口主笔** | 4.4 ACP 客户端、4.7 CLI | 4.1–4.3、4.5–4.6（REST/runner/Connector） |
| **越界规则** | `shared` 是唯一共享包；对方负责的 DTO 改动必须 PR + 知会 | 同左 |

### 6.2 阶段与联调检查点

**D1 上午（一起，≤1h）**：过一遍本文档 §3/§4 并冻结；`shared` 里把全部 zod schema 落成代码（松间客主键盘，俊良 review）。

| 阶段 | 松间客 | 俊良 | 汇合点 |
| --- | --- | --- | --- |
| **D1** | monorepo 脚手架；`shared`：schema + packHandoff/unpackHandoff | 集群准备清单 §5.3；hub-server 骨架（auth + handoffs CRUD + 状态机 + 签名 URL） | — |
| **D2–D3** | CLI 全命令；jsonl 合并器 + git bundle 合并（**单测覆盖 §3.4 四条规则**）；自测用 mock Hub | Worker K8s 编排 + PortForwardConnector；sandbox 镜像 + runner（/healthz /load /snapshot）；自测用 curl + 手工包 | **CP-1**：CLI↔Hub↔OSS 闭环（M1）；**CP-2**：push→云端 resume 续跑→pull 合并（M2） |
| **D4–D5** | hub-web：任务面板（列表/详情/时间线/日志）+ ACP 薄客户端聊天 | Chat 代理；bots API + 常驻 Pod；runner bot 模式（channels 注入 + /chats + /bind） | **CP-3**：Web 活会话；钉钉群 A 共享/群 B 隔离/绑定接续（M3） |
| **D6** | 异常路径与分叉合并打磨、演示数据 | deploy 清单 + 镜像推 ACR + Hub 上云（DirectConnector） | 演示彩排（M4） |

### 6.3 协作规则

- 分支：`feat/cli`、`feat/hub` 等，合 `main` 走 Code Review；对方只需 review 接口面
- 每日收工 15min 同步；CP-1/2/3 集中联调各留半天
- 密钥不进仓库（`.env` + K8s Secret）；`.qoder/` 已忽略
- 成本：sandbox 用完即删；彩排前除 bot 外不留常驻 Pod

---

## 7. 分阶段测试与验收标准

> 每个阶段的产出必须通过当阶段全部验收项才算完成；联调检查点（CP）的验收由双方一起执行并在群里贴结果。

### 阶段 D1：契约冻结 + 骨架

**测试方法**
- `shared`：vitest 单测——每个 zod schema 用合法/非法样本各至少 1 例；`packHandoff → unpackHandoff` 往返测试（含中文路径、空 worktree、大文件 >100MB 三个边界样本）
- `hub-server`：vitest + supertest 起内存 SQLite，覆盖 auth 注册/登录/错 token，handoffs 创建→uploaded→queued 状态流转，非法流转（对 done 任务 cancel）返回 ERR_STATE
- 集群准备：手工验证（不写代码）

**验收标准**
- [ ] `pnpm -r build && pnpm -r test` 全绿；shared 单测覆盖率 ≥ 80%（行）
- [ ] 往返一致：解包后逐字节比对 workspace 文件 + manifest 字段全等
- [ ] REST 骨架：上述 supertest 用例全过，错误响应格式符合 §2 统一格式
- [ ] 集群：本地 kubectl 能建 nginx Pod 到 ACS 并 Running，删除后计费停止；`agenthub` ns、model Secret、ACR 仓库就绪

### 阶段 D2–D3（上）：各自闭环

**测试方法**
- 合并器单测（松间客）：四类场景各成独立用例——无分叉 append / 分叉交错 / 重复 pull 幂等 / 前缀不一致拒绝；git 合并用临时仓库 fixture 覆盖 fast-forward、有冲突保留标记、--branch 落独立分支三条路径
- CLI 对 **mock Hub**（固定响应的 stub server）跑 push/pull 全流程，OSS 用真 bucket
- runner 单机测（子剑）：不经 K8s，本地 `RUNNER_MODE=web node runner` + curl 手工包验证 /load → serveReady → /snapshot
- Worker 对真集群测 Pod 创建/删除/超时回收（用 sleep 镜像代替 sandbox 镜像先验调度）

**验收标准**
- [ ] 合并器：四类场景单测全过；分叉合并后用真 qwen 加载合并后的 jsonl 能正常续聊（手工验证一次）
- [ ] CLI：mock Hub 下 push 产出的包经 unpack 验证结构完整；手工构造返回包后 pull 三场景（无分叉/分叉/重复）结果正确
- [ ] runner：本地 load 后 `curl :8081`（带 serve token）能 initialize + session/load 成功；snapshot 产出的包含 result.bundle 与全部 chats
- [ ] Worker：Pod 超时后 ≤ 1 分钟内被回收；杀掉 hub-server 重启后能重新接管 running 任务或标记 failed，无孤儿 Pod 残留

### CP-1（M1 验收，双方联调 ½ 天）

**测试方法**：真 CLI + 真 Hub + 真 OSS（不经 sandbox）：push 一个真实项目 → Hub 状态到 queued → 手工把输入包改造成返回包上传 → 手工置 done → pull

**验收标准**
- [ ] 全流程无手工修数据库（除置 done 外）；状态时间线完整落库
- [ ] pull 后代码与会话均正确合入；重复 pull 不重复合并
- [ ] 鉴权：用户 A 的 token 访问用户 B 的 handoff 返回 403

### 阶段 D2–D3（下）→ CP-2（M2 验收，双方联调 ½ 天）

**测试方法**：真实链路端到端——本地用 qwen 对一个测试仓库聊 20+ 轮并改代码，`agenthub push --task "继续完成并补单测"` → 观察 Pod 自动续跑 → done 后 pull

**验收标准**
- [ ] Pod 内 session/load 成功恢复全部历史（日志可见轮数），无"失忆"现象（agent 能引用 push 前的讨论结论）
- [ ] 云端自动产生 ≥ 1 个 commit；pull 后 `git log` 可见、本地 `qwen` 打开 session 可追问云端改动细节并得到基于上下文的回答
- [ ] 失败路径：故意给错 inputUrl，任务进 failed 且 error 信息可读；超时任务进 expired 且部分成果在返回包中
- [ ] 性能初测：冷启动（建 Pod 到 serveReady）≤ 60s，超标则记录瓶颈（镜像拉取/依赖安装）进 D6 优化项

### 阶段 D4–D5 → CP-3（M3 验收，双方联调 ½ 天）

**测试方法**
- Web 线（松间客）：hub-web 先对 mock 数据渲染验收各视图；再对真 Hub 联调 ACP 聊天
- 钉钉线（子剑）：先用本地 `qwen serve --channel` + 真钉钉机器人验证多群路由与 /bind（不经 K8s），再上云重验
- 联调脚本化：准备两个测试钉钉群（群 A 双人、群 B 单人）走完整剧本

**验收标准**
- [ ] Web：任务列表/详情/时间线/日志流与真实数据一致；聊天流式输出、断网 10s 重连后消息不丢不重（Last-Event-ID）
- [ ] 钉钉多 session：群 A 两人先后 @ 机器人，第二人能看到第一人的上下文（同 session）；同一人在群 B @，agent 无群 A 上下文（隔离）
- [ ] 绑定：`push --bot --chat 群A` 后群 A 下一条消息 agent 能引用 push 前本地讨论内容；群 B 会话不受影响；未知群绑定时 `GET /chats` 能在首次 @ 后学到该群
- [ ] bot pull：返回包含各群全部 session，本地 `qwen --resume` 可接续任意一个
- [ ] 安全：无 token 访问 chat 代理返回 401；bot secret 不出现在任何 API 响应与日志中

### 阶段 D6（M4 验收，一起）

**测试方法**：演示剧本（US-1 全流程 + US-4 多群）连续完整跑 3 次；性能用真实中型仓库（~100MB）计时 3 次取中位数；上云后用 DirectConnector 重跑 CP-2/CP-3 关键用例

**验收标准**
- [ ] 剧本 3 次全成，单次 ≤ 3 分钟口述节奏；任意一步失败有可当场执行的兼容预案（如预热备用 handoff）
- [ ] 性能中位数：push ≤ 30s、冷启动 ≤ 60s、pull ≤ 10s
- [ ] Hub 在集群内运行（DirectConnector）下 CP-2/CP-3 关键用例复验通过
- [ ] 成本：演示结束后 `kubectl get pods -n agenthub` 除保留 bot 外无残留；OSS 临时对象有过期规则

---

## 附录 A：管理面板（S2–S23，个人工具阶段补齐）

### A.1 新增路由

| 路由 | 说明 |
|---|---|
| `GET /api/sandboxes?windowHours=1..720` | Sandbox 历史行 + 模板 + 真实策略；恒带 `WHERE user_id` |
| `GET /api/oss[?refresh=1]` | OSS 镜像纯 SQL 出数据；`refresh=1` 才真 list 对账并标 expired |
| `POST /api/oss/sign` | 签名下载；`assertOwnedKey` 先校验归属（他人/穿越 → 403） |
| `GET/PATCH /api/settings` | per-user 设置；webhook 加密落库，响应仅回掩码 |
| `POST /api/settings/token` | token 轮换（token_version+1），旧 token 即刻 401 |
| `POST /api/settings/webhook/test` | webhook 连通性真实测试，成败直给 |

### A.2 新增表/列

- `sandboxes`：实例历史（provisioning/running/reclaimed/failed/lost；duration=ready→ended；无 FK）
- `user_settings(user_id,key,value,updated_at)`：PK(user_id,key)，per-key upsert
- `users.token_version`：S17 轮换真失效
- `handoffs.{input,output}_size / {input,output}_uploaded_at / {input,output}_expired`：OSS 元数据镜像

### A.3 迁移机制

`PRAGMA user_version` 门控 + `MIGRATIONS[]` 事务化推进 + 版本高于进程已知时拒绝运行（不静默降级）。

### A.4 通知器（S18）

`Notifier` 由 `Worker.tick()` 第 5 步单点驱动；扫 `handoff_events kind='status'` 游标推进，
at-least-once；游标存 `user_settings.notifyCursor`；仅当 webhook 已配且 `notifyStatusChange=1` 时发送。

### A.5 CLI 设置消费（S20/S21）

`agenthub config set/get/list`；push/pull 拉 `GET /api/settings`：
优先级 = 显式 flag > 本地 config > 服务端 > 缺省。离线回退本地。
