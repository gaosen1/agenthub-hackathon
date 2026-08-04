# 长任务：补齐 Sandbox / OSS 存储 / 设置 三个面板及其真实后端

> 本文件是这条长任务的**唯一持久台账**。会话中断后由巡检拉起，你要做的第一件事就是重读本文件，
> 跳过已勾选项，从第一个未勾选的切片继续。**每完成一片就立刻把方框勾上并 commit。**
>
> 完整设计文档：`/Users/gaosen/.qoder/plans/bold-wilderness-bream.md`（若不可读，本文件信息已足够自持）
> 工作目录：`/Users/gaosen/.qoder/worktree/team-055/ESFm4T`（**git worktree，不要 cd 回主仓**）

---

## 目标

`docs/prototype.html` 是 UI 契约，定义 4 个顶级 tab：**Handoff 任务 · Sandbox · OSS 存储 · 设置**。
真实的 `packages/hub-web` 目前**只有第一个 tab，且完全没有导航外壳**（`src/App.tsx` 是写死的三栏 grid）。
后三个面板的界面和它们背后的 API 都不存在（`docs/spec.md` 里也没规定，属于全新 API 面）。

把这三个面板连同真实后端逐步补齐，共 23 个纵向切片。

---

## 铁律（每次续跑都要重读）

1. **`pnpm build` 必须先于 `pnpm test`。** 全新 worktree 里 `packages/shared/dist` 不存在，
   会导致 `sandbox`/`cli` 两个包报 `Cannot find module '@agenthub/shared'` 而**假性失败**。
   看到这个报错先 `pnpm build`，不要去"修"它。
2. **绿了才 commit。** 每片验证基线 `pnpm typecheck && pnpm test`；改了 UI 的切片追加
   `pnpm -C packages/hub-web build`。基线是 **4 包 typecheck 干净 + 109 个测试通过**
   （shared 77 / hub-server 21 / cli 4 / sandbox 7），只允许增加不允许减少。
3. **一片一 commit**，message 用 `feat(panels): S<n> …` / `fix(panels): …`。
   **每个 Phase 结束才 `git push`**，不要每片都推。
4. **绝不造假数据。** 原型里大量值是编的。凡是要在界面上显示一个数，
   必须能指出它来自哪张表哪个字段或哪个环境变量。做不到就渲染「未配置」/「计划中」，
   **不要写死一个好看的假值**。逐条对照下面「原型虚构项 → 真实来源」表。
5. **卡住就跳过，不要自己拍板。** 缺凭证、要动共享资源、设计有歧义 →
   写进 `ops/state/panels-buildout.blocked.md`（追加，带时间戳和切片号），
   然后跳到下一个不依赖它的切片继续。
6. **全部完成后**执行 `touch ops/state/panels-buildout.done`，否则巡检会把正常退出
   当成中断反复重启你。
7. 不要新造 lint/格式化工具，本仓库有意只用 typecheck + vitest 两道闸门。
8. `store.ts` 的 `patchHandoff` 把 key 直接拼进 SQL——**永远不要把用户输入当 key 传进去**。

---

## Phase 0 — 先建闸门

- [x] **S1 ⚠️必须最先做：hub-web 测试闸门** — 已完成（vitest 3.2.7 + jsdom + testing-library，6 个测试；基线 109 → 115）
  - 文件：`packages/hub-web/package.json`（`test` 脚本目前是 `echo 'no tests yet'`）、
    新建 `packages/hub-web/vitest.config.ts`（jsdom 环境）、2 个 smoke 测试
  - 依赖：`vitest` 对齐 hub-server 的 **3.x**（`shared`/`cli` 用的是 4.x，别引入第三个版本）、
    `jsdom`、`@testing-library/react`、`@testing-library/jest-dom`
  - 验收：根 `pnpm test` 跑到 >0 个 web 测试；能渲染 `<App/>`（mock 回退态）和 Topbar（未登录态）
  - **坑**：`src/api/client.ts` 里的 `dataSource` 是 module 级可变量，
    每个测试要 `vi.resetModules()` 否则相互污染
  - 为什么最先做：hub-web 现在**零测试覆盖**，是这条 24h 任务最大的风险敞口
  - 验证：`pnpm build && pnpm typecheck && pnpm test`

- [x] **S2 ⚠️阻塞项：SQLite 迁移机制** — 已完成（`PRAGMA user_version` 门控 + 事务化推进 + 拒绝降级；新增迁移**追加**到 `MIGRATIONS` 数组末尾，不改已发布项。基线 115 → 120）
  - 文件：`packages/hub-server/src/db.ts`
  - 现状：`db.exec(DDL)` 全是 `CREATE TABLE IF NOT EXISTS`，**没有 `PRAGMA user_version`、没有任何迁移**
  - 后果：新**表**会在已有 `data/hub.sqlite` 上自动出现，新**列不会**——
    `IF NOT EXISTS` 跳过整条语句，于是 `SELECT token_version` 在生产上每个请求 500。
    而所有测试都用 `:memory:`、`data/` 又不入库，**这个 bug 在 `pnpm test` 里永远看不见，只在部署时炸**
  - 做法：`PRAGMA user_version` + 有序 `MIGRATIONS[]` 数组 + 事务包裹
  - 验收：一个「用旧 DDL 建库 → 塞数据 → 跑迁移 → 数据仍在且新列存在」的测试
  - **后续所有加列的切片（S12/S17）都依赖本片，必须先落地**

- [ ] **S3 路由外壳**
  - 文件：新建 `src/routes.tsx`、`src/AppShell.tsx`、`src/views/{TasksView,SandboxView,OssView,SettingsView}.tsx`（后三个先占位）；
    改 `src/App.tsx`、`src/components/Topbar.tsx`、`src/styles.css`
  - 依赖：`react-router-dom`
  - 布局：`AppShell` 持有 `.app` grid = `<Topbar/>` + `<Outlet/>`；`.main` 只在 `/tasks*` 下渲染
  - `/` → `Navigate to="/tasks"`；`/tasks` 与 `/tasks/:id` 同一组件，
    `useParams().id` 取代 `App.tsx` 里的 `currentId` state，自动选中第一项的 effect 变成 `<Navigate replace>`
  - **顺带修死链**：`app.ts` 返回的 `webUrl = ${webBaseUrl}/tasks/:id` 今天没有任何代码消费，
    SPA fallback 已能返回 index.html，所以该 URL 现在能打开但**渲染的是错误的任务**
  - CSS：补 `.view` `.view-inner` `.view-h` `.v-icon` `.tbl*` `.form-row/.fl/.fc` `.switch(.on)`
    `.tag-chip` `.topbar .nav`（已有 `.card* .grid4 .stat .btn .badge .fi .mono .link-btn .modal* .cmd`）
    - **不要移植** `.view{display:none}` / `.view.active`——那对规则只是静态 HTML 模拟路由用的，有了 router 就是死代码
    - **一个真实冲突**：`.src`/`.local`/`.cloud`/`.marker` 现在嵌在 `.tl-row` 下面，
      要提到顶层，否则 `.tbl .src` 不生效
  - 验收：4 个 tab 可切换；`/tasks/hf-xxx` 深链选中**正确**任务；浏览器前进后退可用
  - 验证：+ `pnpm -C packages/hub-web build`

- [ ] **S4 共享 UI 原子组件**
  - 文件：`src/components/ui/{Card,ViewHeader,StatGrid,DataTable,FormRow,Switch,TagChip}.tsx` + 测试
  - `Switch` 必须是**受控**的 `role="switch" aria-checked` 组件，不是原型的 `classList.toggle`——
    这也是它可测试的前提
  - 验收：Switch/DataTable/FormRow 各有单测

---

## Phase 1 — Sandbox 面板

> 设计要点：**`sandboxes` 历史表不能从 `handoffs` 推导**。两个硬理由：
> (1) bot pod 由 `app.ts` 的 `POST /api/bots` 创建（不是 worker），一个 pod 顺序服务 N 个 handoff，没有 1:1 关系；
> (2) 执行时长必须是 `ended_at - ready_at`，不是 handoff 的墙上时间。这个不对称就是建表的全部理由。

- [ ] **S5 `sandboxes` 表 + store 存取**
  - 文件：`packages/hub-server/src/db.ts`、`src/store.ts`
  ```sql
  CREATE TABLE IF NOT EXISTS sandboxes (
    id INTEGER PRIMARY KEY,
    pod_name TEXT NOT NULL, user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                 -- web | bot
    handoff_id TEXT, bot_id INTEGER,    -- 故意不加 FK
    image TEXT NOT NULL, namespace TEXT NOT NULL,
    status TEXT NOT NULL,               -- provisioning|running|reclaimed|failed|lost
    created_at TEXT NOT NULL, ready_at TEXT, ended_at TEXT,
    duration_seconds INTEGER, reclaim_reason TEXT, last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sandboxes_user ON sandboxes(user_id, created_at DESC);
  ```
  - **不加 FK 是有意的**：`db.ts` 开了 `foreign_keys = ON`，而历史行要能比 handoff 行活得更久
    （孤儿 pod 收养时引用的 handoff 可能已被清理）
  - 新增 `recordSandboxCreate/Ready/Reclaim`（纯 SQL、可单测）
  - 验收：DDL + 三个 helper 各有单测

- [ ] **S6 生命周期写入点**
  - 文件：`src/worker.ts`、`src/app.ts`（bots 段落）
  - `worker.ts` `handleQueued`：`createPod` 成功后、`patchHandoff` 之前 → 插入 `provisioning`；catch → `failed`
  - `worker.ts` `handleProvisioning`：`setStatus(running)` 之后 → 写 `ready_at`；
    phase `failed`/`gone` → `failed`，reason `pod-failed`
  - `worker.ts` `safeDeletePod`：**web pod 回收的唯一咽喉点**。加第二个参数 `reason: ReclaimReason`；
    4 个调用点语义各不相同，`handlePackaging` 的 `finally` 里从 `h.terminal_target` 推导 reason。
    在这里写 `ended_at` + `duration_seconds`
  - `worker.ts` `cleanupOrphans` → `reclaimed`，reason `orphan`
  - `app.ts`：`POST /api/bots` createPod → 插入；就绪 → `ready_at`；catch → `failed`；
    `DELETE /api/bots/:id` → `reclaimed`，reason `bot-deleted`。
    **bot pod 永远不走 `safeDeletePod`**（函数开头 `if (h.kind !== 'web') return` 直接挡掉）
  - `WorkerConfig` 要新增 `image` 字段——今天只有 `K8sConfig` 持有它，把 `index.ts` 里那个默认镜像串提成共享常量
  - 验收：`worker.test.ts` 断言一行走完 provisioning→running→reclaimed 且 `duration_seconds` 正确；
    bot pod 路径同样落行

- [ ] **S7 `listSandboxPods()` 取代 `listSandboxPodNames()`**
  - 文件：`src/k8s.ts` + 3 个测试 Fake（`worker.test.ts`、`bots.test.ts`、`stack.e2e.test.ts`，各约 3 行）
  - 返回 `SandboxPodInfo[]` = `{name, phase, startedAt?, labels}`
  - **是替换不是并存**——两条 list 路径会在 `cleanupOrphans` 里漂移
  - 把 phase 判断抽成 `phaseOf(pod: V1Pod)`，让 `getPodPhase` 和 `listSandboxPods` 共用一个真相
  - `startedAt` 必须可选：ACS virtual-kubelet pod 可能不给，回退到 DB `created_at`

- [ ] **S8 重启对账 `reconcileSandboxes()`**
  - 文件：`src/worker.ts`（在 `recover()` 开头调用）
  - 存活 pod 列表 vs DB：`status IN ('provisioning','running')` 而 pod 已不存在
    → `lost` + `ended_at`，reason `crash-recover`
  - 反向：存活的带标签 pod 没有对应开放行 → 用标签 `agenthub/owner|handoff|kind` 和 pod `startTime` 收养
  - **没有这一步，行会永久卡在 running**
  - 验收：孤儿行 → `lost`；存活 pod → 被收养

- [ ] **S9 `GET /api/sandboxes`**
  - 文件：`packages/shared/src/dto.ts`、`packages/hub-server/src/app.ts`
  - `GET /api/sandboxes?window=24h` → `{items, stats, template, policy}`，**恒带 `WHERE user_id=uid`**
  - `stats`：运行中 = `COUNT WHERE status IN ('provisioning','running')`；
    24h 已回收 = `COUNT WHERE ended_at > now-24h`；
    累计执行 = `SUM(duration_seconds)` + 活跃行的 `now-ready_at`；
    可用模板 = 1（单一 `SANDBOX_IMAGE`）
  - `template`：`SANDBOX_IMAGE` + `namespace` + `acs` + 真实 `resources`/`ports`（从 `k8s.ts` 的 pod spec 读）
    + 一份 hub-server 内由 `packages/sandbox/Dockerfile` 派生的 `SANDBOX_TEMPLATE` 描述常量。
    **工具链版本/构建时间/「已发布」没有运行时来源——放这个常量里，不要写死在 JSX**
  - `policy`：`{idleTtlMinutes, taskLingerMinutes, defaultTimeoutMinutes, orphanIntervalMs, workerIntervalMs}` 真配置
  - 验收：跨用户隔离测试（A 用户看不到 B 用户的 sandbox）

- [ ] **S10 SandboxView 界面**
  - 文件：`src/views/SandboxView.tsx`、新 `src/api/sandbox.ts`（沿用 `client.ts` 的 `hubFetch`/`AuthRequiredError` 模式）
  - 真实行 + `gotoTask(id)` 深链（= `navigate('/tasks/' + id)`）+ 未配置空态
  - 日志按钮复用现有 `GET /api/handoffs/:id/events` 过滤 `kind='log'`；**bot 行无 handoff 时禁用**
  - 副标题改掉「E2B 临时执行环境」——**本项目用的是 ACK/ACS**
  - 验证：+ `pnpm -C packages/hub-web build`

---

## Phase 2 — OSS 存储面板

> 设计要点：**镜像到 SQLite，不是每次轮询都 list**。面板会轮询（现有 hooks 是 5s/3s/2s），
> 每轮一次 ListObjectsV2 = 按用户 ~12rpm 的付费调用 + 每次渲染多 100–300ms，
> 而且 OSS 最终一致，刚 PUT 完的输入包可能根本列不出来。
> 我们本来已掌握 90% 真相：`handoffs.input_oss_key`/`output_oss_key` 说明对象存在，
> `created_at`/`updated_at` 给上传时间，过期时间 = 上传 + 生命周期天数。**只缺 size。**

- [ ] **S11 `oss.ts` → `OssClient` + `NullOssClient`**
  - 文件：`src/oss.ts`（目前仅 33 行，只有 `signPut`/`signGet`）、`src/index.ts`
  ```ts
  export interface OssObject { key: string; size: number; lastModified: string; storageClass?: string }
  export interface OssClient extends OssSigner {   // OssSigner 保持窄接口——4 个测试 Fake 依赖它
    list(prefix: string, max?: number): Promise<{ objects: OssObject[]; truncated: boolean }>;
    head(key: string): Promise<OssObject | null>;
    bucketInfo(): Promise<BucketInfo | null>;      // storageClass / sse / lifecycle rules
  }
  ```
  - `ali-oss` 对应：`listV2({prefix,'max-keys','continuation-token'})`、`head(key)`、
    `getBucketInfo()`、`getBucketLifecycle()`。全部包成 `ERR_OSS`
  - **授权：永不接受客户端传来的原始 key。** 加 `userPrefix(uid) = 'handoffs/${uid}/'` 和
    `assertOwnedKey(uid, key)`，不满足 `key.startsWith(userPrefix(uid))` 或含 `..` 就抛 `ERR_FORBIDDEN`
  - **降级模式**：今天 `createOssSigner()` 在没凭证时会拿 `accessKeyId: ''` 建出 client 并返回
    垃圾签名 URL——**静默错误，比报错更糟**。新增 `createOssClient()`，当
    `HUB_NO_OSS=1 || !OSS_BUCKET || !OSS_AK` 时返回 `NullOssClient`：
    签名抛 `ApiFail ERR_OSS`（`app.ts` 已有 catch），`list()` 返回空，`bucketInfo()` 返回 null。
    对齐现有 `HUB_NO_K8S` 先例
  - 验收：**无任何 OSS 环境变量时服务器能正常启动**

- [ ] **S12 对象元数据落库**（依赖 S2 迁移机制）
  - 文件：`src/db.ts`（加列 `input_size`/`output_size`/`input_uploaded_at`/`output_uploaded_at`）、
    `src/app.ts`（`POST /:id/uploaded`）、`src/worker.ts`（snapshot 之后）
  - 在真相时刻各做一次 `head()` 填 size——一个对象一生一次 head，而不是几千次 list
  - 验收：size/uploaded_at 落库；**head 失败不致命**（不能因为 OSS 抖动就让上传流程失败）

- [ ] **S13 `GET /api/oss` + `POST /api/oss/sign`**
  - 文件：`src/app.ts`、`packages/shared/src/dto.ts`
  - `GET /api/oss` 纯 SQL 出数据：总占用 = `SUM(sizes)`；对象数；今日上传 = 按 uploaded_at 计数；
    签名 URL 有效期 = `oss.ts` 里字面量 `1800` 作为 config 暴露；`configured: false` 时 UI 渲染未配置
  - 「部分成果」tag 可推导：`handoffs.terminal_target IN ('expired','cancelled')`
  - `POST /api/oss/sign` 走 `assertOwnedKey` 再 `signGet`
  - 验收：**他人 key → 403**、含 `..` 的 key → 403

- [ ] **S14 ⚠️需凭证：`?refresh=1` 对账**
  - 文件：`src/app.ts`
  - 只有显式 `?refresh=1` 才做真 `list()` 对账，顺便把已被 7 天生命周期删掉的对象标记 expired——
    这也是「过期」在 UI 上唯一能变真的途径
  - 验收：未配置 OSS 时该路径 no-op 且测试全绿（**不能因为没凭证就阻塞**）

- [ ] **S15 OssView 界面**
  - 文件：`src/views/OssView.tsx`、新 `src/api/oss.ts`
  - 真实对象表 + 复制签名链接 + 关联 handoff 深链
  - **BYO Bucket（「切换为自有 Bucket」）本次不做**：按钮 disabled + 「当前使用平台托管 Bucket」提示。
    理由：per-user AK/SK 托管是一整套新的密钥体系
  - 验证：+ `pnpm -C packages/hub-web build`

---

## Phase 3 — 设置面板

- [ ] **S16 `user_settings` 表 + `GET/PATCH /api/settings`**
  - 文件：`src/db.ts`、`src/app.ts`、`packages/shared/src/dto.ts`
  ```sql
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (user_id, key));
  ```
  - 选 key/value 而不是单行 JSON blob：PATCH 变 per-key upsert，不会和通知器游标写入产生
    read-modify-write 竞争；密钥行可单独处理。blob 会强制每次 PATCH 都解密/重加密/整体重写
  - 默认值放 shared 里一个带类型的 `SETTINGS_DEFAULTS`，避免到处判 null
  - `GET /api/settings` → `{settings: {...}, server: {hubUrl, ossBucket, ossRegion, signedUrlTtlSeconds, sandboxImage, idleTtlMinutes}}`。
    `server` 段只读，**这才是原型里「Hub 地址」「OSS Bucket」的真实来源**（`HUB_WEB_URL`/`OSS_BUCKET`/`OSS_REGION`）
  - 钉钉 webhook 用现有 `src/crypto.ts` 的 `encryptSecret` 落库
  - 验收：**响应里永不回传 webhook 明文**，只回 `{configured: true, masked: '…access_token=••••'}`；
    测试里 grep 响应体确认无明文

- [ ] **S17 API Token 真失效**（依赖 S2）
  - 文件：`src/db.ts`（`users.token_version INTEGER NOT NULL DEFAULT 1`）、`src/auth.ts`、`src/app.ts`
  - `JwtPayload` 加 `tv`。`verifyJwt` 保持无状态（它拿不到 DB），检查放在 `app.ts` 的 `requireAuth`：
    verify 之后一次主键查询，`token_version !== payload.tv` → 401 `ERR_AUTH`
  - `POST /api/settings/token` 自增 version 并**返回新签发的 token**（发起轮换的浏览器不会把自己踢下线）
  - **不接受 `tv ?? 1` 兜底**——那是永久绕过，宁可强制重登一次
  - 验收：轮换后旧 token → 401，新 token → 200

- [ ] **S18 ⚠️涉网：状态变更通知器**
  - 文件：新 `src/notifier.ts`、`src/worker.ts`
  - **不要挂 `setStatus`**：`store.ts` 的 `setStatus` 是正确的语义点，但它是同步、纯 DB 的函数，
    被 14 处调用；把 notifier 穿进去会让一个纯写操作做网络 IO
  - 它已经通过 `recordEvent(db, h.id, 'status', to)` 落了行 → 在 `Worker.tick()` 加第 5 步 `notifyPending()`：
    扫 `handoff_events WHERE kind='status' AND id > cursor`，join handoffs 拿 user_id，
    过滤终态/running，按用户 `notifyStatusChange` 开关决定是否发，游标持久化在 `user_settings`
  - 单点、at-least-once、重启安全、失败下轮重试，而且能覆盖路由里发生的状态变更（如 cancel）
  - 「Chat 消息同步」开关**没有干净的挂点**——ACP 路由 `reply.hijack()` 了，任何全局 onSend 钩子都不触发。
    选择：从 `kind='log'` 且 `tag='chat'` 的事件驱动；**做不出来就把开关渲染成 disabled +「计划中」，不要撒谎**
  - 验收：fetch 可注入；测试打**本地 http server**（照抄 `worker.test.ts` 里已有的写法），
    **绝不真连 oapi.dingtalk.com**

- [ ] **S19 SettingsView 界面**
  - 文件：`src/views/SettingsView.tsx`、新 `src/api/settings.ts`
  - 真实值；「测试」按钮有真实成败反馈
  - 「API Token」不是原型里的 `ahk-9f2c81de…`——**不存在那种 token 类型，就是 JWT**
  - 「本地缓存清理」是 CLI 本机行为，服务端管不到 → 渲染成只读「CLI 本机配置」+ 可复制命令（用已有 `.cmd` 类）
  - 验证：+ `pnpm -C packages/hub-web build`

- [ ] **S20 CLI 配置扩展**
  - 文件：`packages/cli/src/config.ts`（`CliConfig` 目前只有 `{hubUrl, token?}`）、`src/api.ts`
  - 扩展 `includeUntracked` / `mergeMode` / `backupSessions`；新增 `agenthub config set`

- [ ] **S21 CLI 真正消费服务端设置**
  - 文件：`packages/cli/src/push.ts`、`src/pull.ts`
  - push/pull 拉 `GET /api/settings` 并**真正生效**（服务端值优先，本地可覆盖，离线回退本地）
  - **这一片是「设置项不是假开关」的唯一保证**——没有它，合并策略/未跟踪文件/自动备份
    就只是有数据库支撑的装饰品
  - 验收：`packages/cli/src/e2e.test.ts` 覆盖

---

## Phase 4 — 收口

- [ ] **S22 降级矩阵 + e2e**
  - `{无 OSS 凭证} × {HUB_NO_K8S=1} × {未登录}` 每种组合下，每个面板都要渲染合理空态：
    **不能白屏、不能显示假数字**
  - 扩 `packages/hub-server/src/stack.e2e.test.ts` 覆盖所有新端点

- [ ] **S23 部署与文档 + 真云验证**
  - 新环境变量（`HUB_NO_OSS` 等）进 `deploy/k8s/20-hub.yaml`
  - `docs/spec.md` / `docs/design.md` 补新路由、新表、新 DTO
  - 真云验证（**已获授权**）：真 ACK 建删一个 pod + 真 OSS 读写一轮，
    跑完 `kubectl get pod -n agenthub -l app=agenthub-sandbox` 确认**无残留资源**
  - 凭证缺失时降级跳过并记入 blocked 文件，不阻塞

---

## 原型虚构项 → 真实来源

照抄原型文案就是把假数据从 HTML 搬进 JSX。逐条替换：

| 原型里的值 | 真实来源 |
|---|---|
| 「E2B 临时执行环境」 | 本项目用 **ACK/ACS**，改副标题 |
| `sb-e2b-7d21` | `ah-web-<6hex>`（worker）/ `ah-bot-<id>-<name>`（app.ts） |
| `qwen-code:v1.4.2` | `SANDBOX_IMAGE` 环境变量 |
| 「已发布」badge / 「构建于 2026-07-28」/ 工具链 chips | 无运行时来源 → hub-server 内 `SANDBOX_TEMPLATE` 常量（由 Dockerfile 派生），**不写死在 JSX** |
| `agenthub-handoff-prod` | `OSS_BUCKET` 环境变量 |
| `handoffs/gaosen/…` | key 用的是**数字** user_id：`handoffs/1/…` |
| `ahk-9f2c81de77aa03e5` | 不存在这种 token 类型，就是 JWT |
| 「hz-prod」 | 删掉，或从 config 出 |
| 4 个 Sandbox 统计数 | 见 S9 的 SQL |
| 「回收与超时策略」4 条 | `{idleTtlMinutes, taskLingerMinutes, defaultTimeoutMinutes, orphanIntervalMs, workerIntervalMs}` |
| 签名 URL 有效期 30min | `oss.ts` 里字面量 `1800`，作为 config 暴露 |
| 「部分成果」tag | `handoffs.terminal_target IN ('expired','cancelled')` |
| 「切换为自有 Bucket」 | **本次不做**，按钮 disabled + 提示 |

---

## 可复用的现成东西（别重写）

- `hubFetch` / `AuthRequiredError` — `packages/hub-web/src/api/client.ts`
- `requireAuth` / `ownHandoff` / `ownBot` — `packages/hub-server/src/auth.ts`（是**普通函数**，在 handler 里调用，不是 Fastify hook）
- `encryptSecret` / `decryptSecret` — `packages/hub-server/src/crypto.ts`（bot 的 `client_secret_enc` 已在用）
- `ApiFail` / `fail` / `assertTransition` — `packages/hub-server/src/state.ts`
- `recordEvent` / `patchHandoff` / `setStatus` / `nowIso` / `statusEnteredAt` — `packages/hub-server/src/store.ts`
- `ossKeyOf` — `packages/hub-server/src/oss.ts`
- 错误码 `ERROR_CODES` / 各 zod schema — `packages/shared/src/dto.ts`，浏览器侧经 `@agenthub/shared/contracts` barrel
