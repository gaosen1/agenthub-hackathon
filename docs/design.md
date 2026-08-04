# Agent Hub 详细设计文档

## 1. 背景与目标

### 1.1 产品定位
Agent Hub 是"agent 界的 GitHub"：把本地运行的 Qwen Code agent（工作区 + 会话上下文）一键托管到云端 sandbox 继续运行，用户可通过 Web 聊天或钉钉群随时随地操控云端 agent，完工后再拉回本地。

### 1.2 核心用户旅程
1. 开发者本地用 Qwen Code 干活，中途需要离开 → `agenthub push` 把 agent 连同上下文托管上云
2. 在 Hub Web 界面聊天，或在钉钉群 @ 机器人，继续指挥云端 agent 干活（手机可操作）
3. 回到电脑 → `agenthub pull` 把云端更新的工作区与会话拉回本地，无缝接续

### 1.3 设计原则
- **不改 Qwen Code 源码**：sandbox 只做配置注入与进程编排，复用 `qwen serve` / channel / SessionRouter 全部现成机制
- **OSS 为唯一数据中转**：本地 ↔ 云端不直连，所有上下文迁移走 AgentPack 快照
- **轻量多用户**：hackathon 规模，SQLite + 单副本 Hub，但账户体系完整

## 2. 总体架构

```
┌──────────────┐  push/pull(AgentPack)   ┌─────────────────┐
│  本地开发机   │ ──────────────────────→ │   OSS bucket    │
│ qwen + CLI   │ ←────────────────────── │ (handoffs 中转)  │
└──────┬───────┘                         └────────┬────────┘
       │ REST(login/push/pull/bots)               │ load/snapshot
       ▼                                          ▼
┌──────────────┐   K8s API 编排    ┌──────────────────────────────┐
│  hub-server  │ ────────────────→ │  ACK 集群 (ACS Serverless)    │
│ Fastify+SQLite│  port-forward /  │  ns: agenthub                │
│ + hub-web 静态│   Pod IP 代理     │  ┌─────────┐  ┌────────────┐ │
└──────┬───────┘ ←──────────────── │  │web sandbox│ │bot sandbox │ │
       │ REST+SSE 聊天代理          │  │(临时)     │  │(常驻)      │ │
       ▼                           │  │runner+serve│ │runner+serve │ │
┌──────────────┐                   │  └─────────┘  │+channel ────┼─┼──→ 钉钉 Stream
│ 浏览器/手机   │                   │               └────────────┘ │    (出站 WebSocket)
└──────────────┘                   └──────────────────────────────┘
```

### 2.1 两种 sandbox 形态
| | web sandbox（临时） | bot sandbox（常驻） |
|---|---|---|
| 生命周期 | push 创建，pull 后销毁 | 录入机器人时创建，长驻 |
| 对话入口 | Hub Web 聊天（代理 serve 的 ACP HTTP） | 钉钉群/私聊（channel Stream 长连接） |
| qwen 启动方式 | `qwen serve --hostname 0.0.0.0 --port 8081` | `qwen serve --workspace <ws> --channel <botName>` |
| session 模型 | 单 session（pushed session） | 多 session，按钉钉群隔离（chat_thread scope） |

### 2.2 复用的现有云资源
- ACK 托管集群 `qwen-code-demo`（杭州，k8s 1.36.1，0 节点，Pod 调度到 ACS Serverless 算力），新建 namespace `agenthub`
- OSS bucket `qwen-agent-hub-handoffs-1676569025647691`（杭州）
- RAM 角色 `agenthubosshandoffrole`（CLI profile `agent-hub-dev`）：hub-server 用它给 CLI 签发 STS 临时凭证，实现 OSS 直传不过 Hub
- 需新建：ACR 个人版镜像仓库（存 sandbox 镜像）
- 成本约束：账户余额有限，ACS 按量 Pod 用完即删；`release` 命令与 pull 闭环自动销毁保证不留常驻资源（bot sandbox 除外，演示后手动清理）

## 3. 仓库结构（pnpm workspaces monorepo，全 TypeScript）

```
packages/
  shared/       # 类型与协议：AgentPack manifest、REST DTO、runner 协议、错误码
  cli/          # agenthub CLI（commander + ali-oss + tar + zod 校验）
  hub-server/   # Fastify + better-sqlite3 + @kubernetes/client-node + undici(代理)
  hub-web/      # Vite + React + TanStack Query（列表/详情/聊天/机器人管理）
  sandbox/      # Dockerfile + runner（Fastify 控制面小服务，端口 8080）
deploy/         # K8s manifests（hub 上云）+ 镜像构建推送脚本
```

## 4. AgentPack 快照格式（v1）

tar.gz 包，push 与 pull 双向使用同一格式。OSS key：`packs/{userId}/{agentId}/{snapshotId}.tar.gz`。

```
manifest.json          # 见下
workspace/             # 工作区文件全量（遵循 .gitignore，排除 node_modules 等）
qwen-home/
  projects/<ws-hash>/  # 该项目的会话历史（chats/*.json 等）
  channels/            # sessions.json 路由表（若存在）
  settings.json        # 剔除 apiKey 等密钥字段后的配置
```

manifest.json 字段：
```jsonc
{
  "version": 1,
  "agentName": "my-project",          // agent 标识（默认取 workspace basename）
  "workspacePath": "/Users/x/proj",   // 本地绝对路径 —— 云端必须原样重建（见 §8.3）
  "wsHash": "proj-ab12cd34ef56",      // getWorkspaceScopeDirName 结果，校验用
  "sessionId": "uuid",                // push 时的活跃 session，绑定/恢复的目标
  "qwenVersion": "x.y.z",
  "createdAt": "ISO8601",
  "direction": "push" | "pull"
}
```

打包/解包实现放 `shared/`（`packAgent()` / `unpackAgent()`），CLI 与 runner 共用。密钥剔除：settings.json 中的 `apiKey`、`clientSecret` 等敏感字段在打包时置空，云端凭证一律走环境变量注入。

## 5. 数据模型（hub-server，better-sqlite3）

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- argon2id
  created_at TEXT NOT NULL
);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,                  -- pushed | deploying | running | pulling | pulled | released | error
  workspace_path TEXT NOT NULL,          -- 本地绝对路径，sandbox 重建用
  session_id TEXT,                       -- 最近 push 的 session
  sandbox_kind TEXT,                     -- web | bot | NULL
  pod_name TEXT, serve_token TEXT,       -- 运行期信息
  bot_id INTEGER REFERENCES bots(id),    -- bot 模式关联
  latest_snapshot_id INTEGER,
  UNIQUE(user_id, name)
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id),
  direction TEXT NOT NULL,               -- push | pull
  oss_key TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE bots (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                    -- channel 实例名，即 settings.json channels.<name>
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,       -- AES-256-GCM，密钥来自 HUB_SECRET_KEY 环境变量
  pod_name TEXT, status TEXT NOT NULL,   -- creating | running | error | deleted
  current_agent_id INTEGER REFERENCES agents(id),
  UNIQUE(user_id, name)
);
```

agent 状态机：`pushed → deploying → running →（pulling → pulled）| released | error`；`pulled/released` 后可再次 push 回到 `pushed`。

## 6. API 规格

### 6.1 hub-server REST（前缀 /api，JWT bearer 认证，除 auth 外全部需登录）
```
POST /api/auth/register {username,password} → {token}
POST /api/auth/login    {username,password} → {token}

GET  /api/agents                        → Agent[]（含状态、快照数、sandbox 信息）
GET  /api/agents/:id                    → Agent + snapshots[]
POST /api/agents/push-intent {name,workspacePath,sessionId}
     → {agentId, snapshotId, ossKey, sts:{accessKeyId,secret,token,expiration}}   # 签发限定前缀的 STS
POST /api/agents/:id/deploy {snapshotId, target:{kind:"web"}|{kind:"bot",botId,chatId?}}
     → {podName}                        # web: 建 Pod；bot: 热加载到既有 bot Pod
POST /api/agents/:id/pull-intent        → {snapshotId, ossKey, sts}   # 命令 runner snapshot 后返回下载凭证
POST /api/agents/:id/release            → 204   # 销毁 sandbox

GET  /api/bots                          → Bot[]（含常驻 Pod 状态、当前加载的 agent）
POST /api/bots {name, clientId, clientSecret} → Bot   # 创建即拉起常驻 bot sandbox
DELETE /api/bots/:id                    → 204
GET  /api/bots/:id/chats                → 透传 runner GET /chats（可绑定的钉钉群列表）
POST /api/bots/:id/bind {chatId, sessionId} → 透传 runner POST /bind

ANY  /api/agents/:id/chat/*             → 聊天代理（见 6.3）
```

### 6.2 runner 控制面（sandbox 内端口 8080，Hub 经 SandboxConnector 访问，共享密钥头 X-Runner-Token）
```
GET  /healthz                → {ok, mode, serveReady}
POST /load {ossKey, sts}     → 下载 AgentPack → 恢复 workspace + qwen-home → (重)启 serve；bot 模式带 {bindChatId?}
POST /snapshot {sts}         → 现场打包上传 OSS → {ossKey, manifest}
GET  /chats                  → [{chatId, title?, lastSeenAt}]   # bot 模式：合并 routes.json 与 observed-contacts.json
POST /bind {chatId, sessionId} → 改写 routes.json 后重启 serve（见 §8.2），bot 模式专用
```

### 6.3 聊天代理协议（web 模式）
`qwen serve` 的对话接口是 **ACP over HTTP**（不自造协议，hub-server 纯反向代理并注入 sandbox 各自的 `Authorization: Bearer <serveToken>`）：
- `POST /acp`：提交 ACP JSON-RPC 消息（initialize / session/new / session/load / session/prompt），响应 202，结果走 SSE
- `GET /acp`（Accept: text/event-stream）：SSE 事件流；`Acp-Connection-Id` 头标识连接，`Acp-Session-Id` 头可选（区分连接级/会话级流）；支持 `Last-Event-ID` 断线续传
- `DELETE /acp`：关闭连接

hub-web 聊天窗口实现一个薄 ACP 客户端（shared/ 里定义消息类型）：initialize → session/load(manifest.sessionId) → session/prompt，事件流渲染 agent 输出、工具调用与权限请求。

### 6.4 SandboxConnector 抽象（网络环境切换零改动）
```ts
interface SandboxConnector {
  request(pod: PodRef, port: number, req: HttpRequest): Promise<HttpResponse>; // 含 SSE 流式
}
```
- `PortForwardConnector`（开发期）：@kubernetes/client-node 的 portForward，Hub 本地跑也能通 Pod
- `DirectConnector`（上云后）：Hub 部署进集群，直连 Pod IP

启动时按 `HUB_IN_CLUSTER` 环境变量选择实现。

## 7. Sandbox 镜像与生命周期

### 7.1 镜像内容
`node:22-slim` + Qwen Code（npm 全局装指定版本）+ runner + git/ripgrep 等常用工具。单镜像双模式，`RUNNER_MODE=web|bot` 环境变量区分。

### 7.2 Pod 规格（ACS 算力）
- labels: `app=agenthub-sandbox, agenthub/kind=web|bot, agenthub/agent-id=<id>`
- 调度到 ACS：按集群虚拟节点要求打 `alibabacloud.com/compute-class: general-purpose` 等标签/容忍
- resources: 2C4G（ACS 按量）
- env：`RUNNER_MODE`、`RUNNER_TOKEN`、`QWEN_SERVER_TOKEN`（web 模式）、`OPENAI_API_KEY` 等模型凭证（K8s Secret）、bot 模式追加 `DINGTALK_CLIENT_ID/SECRET`（每 bot 一个 Secret）
- 无 Service/Ingress：web 聊天走 port-forward/Pod IP；钉钉是出站连接

### 7.3 runner 启动流程
```
读 RUNNER_MODE → 起 8080 控制面 → 等待 POST /load
/load: 下载解包 → mkdir -p <manifest.workspacePath> 恢复 workspace
      → 恢复 ~/.qwen（projects/<ws-hash>、channels、脱敏 settings.json）
      → web:  spawn `qwen serve --hostname 0.0.0.0 --port 8081 --workspace <ws>`
      → bot:  写 settings.json channels 配置（§8.1）→ 若带 bindChatId 先改路由（§8.2）
              → spawn `qwen serve --workspace <ws> --channel <botName>`
      → 轮询 serve 健康后置 serveReady=true
```

## 8. 钉钉 bot：多 session 路由与绑定机制（核心设计）

### 8.1 channel 配置（runner 生成 settings.json）
```jsonc
{
  "channels": {
    "<botName>": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",      // $ENV 引用，凭证不落盘
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "cwd": "<manifest.workspacePath>",       // 必须等于 serve 的 --workspace（daemon 校验）
      "sessionScope": "chat_thread",           // 关键：按群隔离
      "groupPolicy": "open"
    }
  }
}
```
钉钉走 Stream 模式（DWClient 出站 WebSocket），sandbox 无需公网入口。

### 8.2 路由语义与绑定
`sessionScope=chat_thread` 时 SessionRouter 的 routingKey = `<botName>:<chatId>`，天然满足需求：
- **同一群内多人 @ → 共享一个 session**（key 只含 chatId 不含 senderId）
- **同一个人在不同群 @ → 不同 session**（chatId 不同）
- 新群首次 @ 自动新建 session，多 session 零配置

绑定（把 pushed session 接续到指定群）利用 **daemon 懒恢复**机制：
1. bot sandbox 必须用 `qwen serve --channel` 启动（daemon worker 以 `recoveryMode:'lazy'` 创建 SessionRouter 并在启动时调 `restoreRoutes()` 加载休眠路由；`qwen channel start` 是 eager 模式启动时不读路由表，不可用）
2. 路由表位置：`~/.qwen/channels/daemon/<ws-hash>/routes.json`，条目格式
   `{"<botName>:<chatId>": {"sessionId","target":{channelName,senderId,chatId,isGroup},"cwd"}}`
3. `POST /bind {chatId, sessionId}`：runner 停 serve → 改写/新增该 key 的 sessionId 为 pushed id（新条目 target 用占位 senderId + isGroup:true）→ 重启 serve（秒级）→ restoreRoutes() 装载 → 该群下一条消息命中路由 → `loadOrReplaceSession()` → `bridge.loadSession(pushed id)` 恢复完整历史；load 失败自动降级新建 session（SessionRouter 内置容错，不会卡死）
4. **chatId 来源**：runner `GET /chats` 合并 routes.json 与 observed-contacts.json（同目录，daemon 运行中自动积累）返回已知群；Hub 机器人管理页选群绑定；CLI 可 `push --bot <name> --chat <chatId>` 显式指定。目标群从未出现过时，先在群里 @ 一下机器人即可被学到

### 8.3 路径一致性约束（易错点）
qwen 的会话存储按 cwd 路径 hash 分片（`getWorkspaceScopeDirName` = 净化 basename(≤32) + '-' + sha256(canonical path) 前 12 位）。**runner 必须在容器内重建与本地完全相同的绝对路径**（如 `/Users/x/proj`），否则 loadSession 找不到历史。manifest 的 `wsHash` 字段用于恢复后自校验。

### 8.4 push --bot 热替换流程
runner 收到 `/load`（带新 ossKey）：停 serve → 备份后覆盖 workspace 与 qwen-home → 若带 bindChatId 执行 §8.2 改写 → 重启 serve。其他群的既有路由保留在 routes.json 中，重启后懒恢复，各群会话不受影响。

## 9. 核心流程时序

### 9.1 push → web 聊天
```
CLI: packAgent() → POST /push-intent（拿 STS + ossKey）→ ali-oss 直传
   → POST /deploy {kind:web} → hub-server 创建 Pod → runner POST /load
   → 用户打开 hub-web 聊天页 → hub-server 代理 /acp → session/load(pushed id) → 对话
```
### 9.2 pull 闭环
```
CLI: POST /pull-intent → hub-server 命令 runner POST /snapshot（打包上传 OSS）
   → CLI 拿 STS 下载解包 → 覆盖本地 workspace 与 ~/.qwen（先备份到 ~/.agenthub/backup/<ts>）
   → hub-server 删 Pod（web 模式）→ agent 状态 pulled
   → 本地 `qwen --resume <sessionId>` 接续
```
### 9.3 创建机器人 → 钉钉对话
```
Web: POST /api/bots（凭证加密入库）→ 建 Secret + 常驻 Pod（RUNNER_MODE=bot）
   → 首次无 agent 时 runner 用空 workspace 起 serve --channel（可闲聊）
   → 用户把机器人拉进钉钉群 → @ 即对话（各群自动独立 session）
```
### 9.4 push --bot --chat（绑定指定群）
```
CLI: push 上传 → POST /deploy {kind:bot, botId, chatId}
   → hub-server 调 runner POST /load {ossKey, bindChatId}
   → runner 热替换 + 改路由 + 重启 → 该群下条消息接续 pushed session
```
多 session 的 pull 无需特殊处理：所有群的 session 都在 qwen-home 项目目录内整包回传，本地可 resume 任意一个。

## 10. 安全设计
- Hub API：JWT（HS256，HUB_SECRET_KEY 派生）；密码 argon2id
- OSS：STS 凭证限定 `packs/{userId}/` 前缀、15 分钟有效，CLI 直传不经 Hub 中转数据
- serve token：每 sandbox 随机生成，只存 hub-server DB，经 env 注入；serve 非 loopback 绑定强制 token（qwen 内置）
- runner token：每 Pod 随机，Hub↔runner 所有调用带 X-Runner-Token
- 钉钉凭证：DB 内 AES-256-GCM 加密，运行时只进 K8s Secret；AgentPack 打包时剔除一切密钥
- 访问控制可选强化：channel 配置 `allowedUsers` 限定可 @ 的钉钉用户（演示期用 groupPolicy=open）

## 11. 实施顺序
1. monorepo 脚手架 + shared 类型 + AgentPack 打包/解包库（含单测）
2. hub-server：auth、agents、snapshots、STS 签发（先不含 K8s）
3. CLI：login/push/pull 与 OSS 直传打通（pull 先直接回放最近 push 的包，闭环数据链路）
4. sandbox 镜像 + runner（web 模式）+ K8s 编排 + PortForwardConnector 聊天代理，打通 push→web 聊天→pull 全链路
5. hub-web 前端（登录/列表/详情/聊天）
6. bot 模式：bots API、常驻 sandbox、channel 配置注入、/chats、/bind、push --bot --chat
7. deploy 清单 + 镜像推 ACR，演示前 Hub 部署进集群（切 DirectConnector）

## 12. 测试计划
- 单元测试（vitest）：AgentPack 打包/解包往返一致性、manifest 校验、agent 状态机、routes.json 改写逻辑
- 集成：本地起 hub-server + 假 runner，跑 push→deploy→pull 状态流转
- 端到端手动脚本：真实 push → web 聊天改文件 → pull 回本地校验文件与会话更新 → Pod 销毁确认
- 钉钉链路：注册机器人 → 群 A 两人 @ 对话（验证同群共享 session）→ 同一人在群 B @（验证跨群隔离）→ push --bot --chat 群A 后再对话（验证接续 pushed session 上下文、群 B 不受影响）

## 13. 假设与风险
- Qwen Code 已具备钉钉 channel（Stream 模式）与 serve 能力，sandbox 不改其源码
- ACK 集群 ACS 虚拟节点可调度 Pod（若未就绪需先在控制台开启）
- 容器内重建本地绝对路径（如 /Users/...）在 Linux 容器可行（mkdir -p 任意路径，无权限障碍）
- 成本约束：严格控制 Pod 存活时长，演示彩排前不留常驻资源
- 风险：serve 重启窗口内到达的钉钉消息会丢（Stream 断连期间不投递）——绑定操作秒级完成，可接受；如需强化可让 runner 延迟到空闲时重启
