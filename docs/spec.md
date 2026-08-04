# AgentHub 完整设计规格（Spec）

> 本文档是开发的**唯一契约**：所有数据格式、接口定义、分工以此为准。产品背景与竞品分析见 [design.md](./design.md)，UI 原型见 [prototype.html](./prototype.html)。
>
> 契约变更规则：`§3 数据格式` 与 `§4 接口定义` 的任何改动必须 PR + 知会对方，其余章节可自行更新。

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0（实现基线） |
| 团队 | Team 055：张子剑（俊良）、高森（松间客） |
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

**两种接力形态**：
- **任务接力**（`push --task`）：临时 Pod，headless 自动续跑，完成即 packaging + 回收
- **交互接力**（`push` 不带 task / `push --bot`）：Web 聊天（临时 Pod）或钉钉群对话（常驻 bot Pod）

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
  kind TEXT NOT NULL,                       -- task | web | bot
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

- bucket：`qwen-agent-hub-handoffs-1676569025647691`（杭州）；Pod/CLI 走签名 URL，无长期凭证
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

- `running` 中交互接力可长驻；空闲 TTL（默认 2h，按 last_active_at）到期 → packaging → expired
- 任务接力 timeoutMinutes 硬超时到期 → packaging → expired（已产出成果仍打返回包）

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
  "task": "继续完成重构并补齐单测",          // 可省 → 交互接力
  "kind": "task",                            // task | web | bot
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

#### Chat 代理（Web 聊天，kind=web/task 且 running）

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
| `GET /healthz` | — | `200 {ok:true, mode:"task"\|"bot", serveReady:boolean, loadedHandoffId?:string}` |
| `POST /load` | `{inputUrl, task?, bindChatId?, serveToken?}` | `202 {accepted:true}`；异步执行：下载解包 → 校验 wsHash → 重建 workspacePath → 铺 qwen-home → （bot）写 channels 配置/（可选）改路由 → spawn serve → 就绪后 serveReady=true。失败记录到 /healthz 的 `lastError` |
| `POST /snapshot` | `{outputUrl}` | `200 {manifest: HandoffManifest}`；现场打包（result.bundle + 全部 chats + logs）PUT 到签名 URL |
| `GET /chats` | — | `200 {items:[{chatId,title?,lastSeenAt?}]}`（bot 模式；合并 routes.json + observed-contacts.json） |
| `POST /bind` | `{chatId, sessionId}` | `200 {ok:true}`：停 serve → 改写/新增 `<botName>:<chatId>` 路由指向 sessionId → 重启 serve |
| `GET /logs?after=<n>` | — | `200 {items: SandboxEvent[], nextAfter}`（Worker 轮询搬运到 handoff_events） |

runner 进程模型：容器 1 号进程；`qwen serve` 为其子进程（stop/start 实现绑定重启，Pod 不重建）；spawn 参数：
- task/web：`qwen serve --hostname 0.0.0.0 --port 8081 --workspace <ws>`，env `QWEN_SERVER_TOKEN=<serveToken>`
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
  labels: { app: agenthub-sandbox, agenthub/kind: "<task|web|bot>", agenthub/owner: "<userId>" }
spec:
  nodeSelector: { type: virtual-kubelet }        # 以集群 ack-virtual-node 实际要求为准
  tolerations: [{ key: virtual-kubelet.io/provider, operator: Exists }]
  containers:
  - name: sandbox
    image: <ACR>/agenthub/sandbox:<tag>          # node22 + qwen(固定版) + runner + git/rg
    ports: [{ containerPort: 8080 }, { containerPort: 8081 }]
    resources: { requests: { cpu: "2", memory: 4Gi }, limits: { cpu: "2", memory: 4Gi } }
    env:
    - RUNNER_MODE=<task|web|bot>
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

| | 高森（A 线：数据面 / 本地侧 / 前端） | 张子剑（B 线：控制面 / 云端侧 / 钉钉） |
| --- | --- | --- |
| **负责包** | `shared`、`cli`、`hub-web` | `hub-server`、`sandbox`、`deploy/` |
| **§3 数据格式主笔** | 3.1–3.4（包/manifest/marker/合并） | 3.5–3.9（路由/日志/settings/DDL/OSS） |
| **§4 接口主笔** | 4.4 ACP 客户端、4.7 CLI | 4.1–4.3、4.5–4.6（REST/runner/Connector） |
| **越界规则** | `shared` 是唯一共享包；对方负责的 DTO 改动必须 PR + 知会 | 同左 |

### 6.2 阶段与联调检查点

**D1 上午（一起，≤1h）**：过一遍本文档 §3/§4 并冻结；`shared` 里把全部 zod schema 落成代码（高森主键盘，张子剑 review）。

| 阶段 | 高森 | 张子剑 | 汇合点 |
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

## 7. 验收清单（对齐里程碑）

- **M1**：`packHandoff→unpackHandoff` 往返一致（单测）；手工构造返回包后 `agenthub pull` 三场景正确（无分叉/分叉/重复 pull 幂等）
- **M2**：真实 push → Pod 内 `session/load` 恢复 20+ 轮上下文 → task 自动续跑产生 commit → pull 后本地 `qwen` 续聊、`git log` 可见云端 commit
- **M3**：Web 聊天流式输出；钉钉群 A 两人 @ 共享 session、同一人群 B @ 隔离、`push --bot --chat` 后该群接续 pushed session 且群 B 不受影响
- **M4**：3 分钟演示剧本连续 3 次成功；性能：push≤30s（500MB 内）、冷启动≤60s、pull≤10s
