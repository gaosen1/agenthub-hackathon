# AgentHub 并行开发分工

> 配套文档：[docs/design.md](./design.md)（融合版设计）。两人四条线并行，**接口契约冻结后各自开发，按联调检查点汇合**。

## 1. 分工总览

| | 高森（A 线：数据面 / 本地侧 / 前端） | 张子剑（B 线：控制面 / 云端侧 / 钉钉） |
| --- | --- | --- |
| 负责包 | `packages/shared`、`packages/cli`、`packages/hub-web` | `packages/hub-server`、`packages/sandbox`、`deploy/` |
| 核心内容 | 打包/解包/git bundle/jsonl 合并库、CLI 全部命令、Web 面板 | REST API + SQLite + 状态机、Worker K8s 编排、聊天代理、sandbox 镜像与 runner、钉钉 channel 链路 |
| 依据 | PRD 与合并策略、prototype.html 原型作者 | qwen-code channel/serve 机制调研、云资源盘点 |

选边理由：合并逻辑（git bundle + jsonl 时间线）和 Web 原型在高森的 PRD/原型里最完整；云端运行时（qwen serve ACP、SessionRouter 懒恢复绑定、K8s/ACS 编排）在子剑的设计里最完整。各写各最熟的部分，文档已互相覆盖对方领域。

## 2. 阶段一：接口冻结 + 各自开工（第 1 天，并行）

**共同动作（约 1 小时，一起）**：在 `packages/shared` 中冻结以下接口契约，双方确认后不再私自改动（改动必须 PR 并知会对方）：

1. `manifest.json` schema（design.md §4.2 的字段集）
2. 输入包 / 返回包目录结构与打包解包函数签名 `packHandoff()` / `unpackHandoff()`
3. REST API 路径与 DTO（design.md §5.2 F-7，对齐到 TypeScript 类型）
4. runner 控制面协议（design.md §5.5 F-15）
5. ACP 客户端最小消息子集（initialize / session/load / session/prompt / 事件帧）

**随后并行**：

| 高森 | 张子剑 |
| --- | --- |
| monorepo 脚手架（pnpm workspaces、tsup/tsc、vitest、lint） | ACK 集群准备：ns `agenthub`、虚拟节点冒烟（nginx Pod 验证 ACS 调度）、ACR 建仓 |
| `shared` 实现：打包/解包、manifest 校验、jsonl 合并器、git bundle 合并器（**含单测**，这是 M1 验收核心） | `hub-server` 骨架：Fastify + better-sqlite3 + 建表（design.md 数据模型）+ auth + handoffs CRUD + 状态机 + 签名 URL 签发（RAM role 调 STS） |

## 3. 阶段二：M1/M2 各自闭环（第 2~3 天，并行）

| 高森（CLI 线） | 张子剑（云端线） |
| --- | --- |
| `agenthub login` / `push` / `pull` / `list` / `status` | Worker 模块：领任务 → K8s 建 Pod → `/load` → 监控 → `/snapshot` → 删 Pod |
| push：打包 → 拿签名 URL → OSS 直传 → uploaded 回执 | `packages/sandbox`：Dockerfile + runner（healthz/load/snapshot），web/task 模式拉起 `qwen serve` |
| pull：下载 → git 合并 → jsonl 合并 → 备份/幂等 | `SandboxConnector`：PortForwardConnector（开发期） |
| **自测方式**：对 mock Hub（json-server 或手写 stub）跑通；M1 验收"不经 Sandbox 手动构造返回包可合并" | **自测方式**：用 curl 手工构造 handoff + 本地已有 qwen 会话目录跑通"建 Pod → resume → 打包回传" |

**联调检查点 CP-1（M1 验收）**：CLI ↔ 真 Hub ↔ OSS 直传直取闭环。
**联调检查点 CP-2（M2 验收）**：真 push → 云端 resume 自动续跑 → 真 pull 合并，US-1 主链路端到端。两人一起联调，预计半天。

## 4. 阶段三：M3 交互面（第 4~5 天，并行）

| 高森（Web 线） | 张子剑（钉钉线） |
| --- | --- |
| `hub-web` 按 prototype.html 实现：任务列表/详情/时间线/日志/commit 列表 | runner bot 模式：settings.json 生成、`qwen serve --workspace <ws> --channel <bot>` 拉起 |
| 薄 ACP 客户端：initialize → session/load → prompt，SSE 渲染（消费 hub-server 的 `/chat/*` 代理） | `/chats`、`/bind` 实现（routes.json 改写 + 重启懒恢复） |
| Pull 指引 Modal、Sandbox/OSS/设置视图（接真实 API） | hub-server：bots CRUD（凭证 AES 加密）、bot 常驻 Pod 编排、ACP 聊天代理（`/api/handoffs/:id/chat/*` → serve `/acp`） |
| **自测方式**：对 mock 数据渲染 + 真 Hub 联调 | **自测方式**：本地 `qwen serve --channel` 起真钉钉机器人验证多群多 session 与绑定 |

**联调检查点 CP-3（M3 验收）**：Web 聊天 ↔ 云端活会话；钉钉群 A 双人共享 session、跨群 B 隔离、push --bot --chat 绑定接续。

## 5. 阶段四：M4 打磨（第 6 天，一起）

- 演示剧本串讲（US-1 全流程 + US-4 钉钉多群）、异常路径兜底（超时/取消/分叉合并）
- `deploy/`：hub 上云清单、镜像推 ACR、DirectConnector 切换（张子剑主笔，高森协助）
- 性能验收对齐 design.md §8（push ≤30s、冷启动 ≤60s、pull ≤10s）

## 6. 协作规则

- **分支**：各自 `feat/cli`、`feat/hub` 等特性分支，合入 `main` 走 Code Review（对方 review 自己负责包的接口部分即可，实现细节自审）
- **冲突规避**：以包为界互不越界；`shared` 是唯一共享包，改接口必须 PR + 群里知会
- **联调节奏**：每天收工前一次 15 分钟同步 + 各检查点集中联调
- **凭证**：OSS/模型/钉钉密钥一律不进仓库，本地 `.env` + K8s Secret；`.qoder/` 已忽略不入库
- **成本控制**：sandbox 用完即删，演示彩排前不留常驻 Pod（bot 常驻除外）
