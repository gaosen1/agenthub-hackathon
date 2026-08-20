# AgentHub CLI（`ah` / `agenthub`）使用手册

> `ah` 与 `agenthub` 为同一命令的长短别名。
> 安装：仓库内 `pnpm --filter @agenthub/cli build`，并将 `packages/cli/dist/index.js` 软链到 PATH（本机已链至 `~/.local/bin/ah` 与 `~/.local/bin/agenthub`）。
> 改 CLI 源码后需重新 build 才会生效。
> `push` / `pull` 依赖 repo 信息，须在 **git 仓库内**执行。

## 命令总览

| 命令 | 语法 | 说明 |
|---|---|---|
| login | `ah login [--hub <url>] [--register]` | 登录 Hub；`--register` 首次注册。token 存 `~/.agenthub/config.json`，**有效期 7 天**，过期重跑 login |
| push | `ah push [选项]` | 打包当前 repo + 最近活跃 session 移交云端 |
| pull | `ah pull [handoff-id] [--branch]` | 拉回返回包：git 增量合并 + 会话时间线合并（**幂等**，可重复执行） |
| list | `ah list [--all]` | 列 handoff 任务；缺省仅当前仓库，`--all` 全部 |
| status | `ah status <handoff-id>` | 查看任务状态、时间线、结果与是否可 pull |
| cancel | `ah cancel <handoff-id>` | 取消任务；执行中会先打包部分成果再终止 |
| help | `ah help [command]` / `ah -h` | 查看帮助；`ah -V` 看版本 |

## push 选项

| 选项 | 缺省 | 说明 |
|---|---|---|
| `--session <id>` | 当前 workspace 最近修改的 session jsonl | 显式指定移交的 session |
| `--task <指令>` | 无（交互接力） | 带 task = **任务接力**：云端 headless 续跑，跑完自动 packaging→done；不带 = **交互接力**：云端 serve 挂起，Web/钉钉随时插话 |
| `--include-untracked` | 关 | 快照包含未跟踪文件 |
| `--bot <name>` | 无（web 载体） | 推到常驻钉钉机器人 sandbox |
| `--chat <chatId>` | 无 | 配合 `--bot`，绑定到指定钉钉群 |
| `--timeout <min>` | 30 | 任务接力硬超时分钟数 |

## pull 选项与参数

| 项 | 说明 |
|---|---|
| `[handoff-id]` | 缺省拉当前仓库最近一次已完成任务 |
| `--branch` | 云端 commit 落到独立分支 `agenthub/<handoff-id>`，不直接合入当前分支 |

## 任务状态机

| 状态 | 含义 | 可对话 | 可 pull |
|---|---|---|---|
| created / uploaded / queued | 本地打包上传、排队中 | ✗ | ✗ |
| provisioning | 沙箱 Pod 创建中 | ✗ | ✗ |
| running | Pod 存活、qwen serve 就绪 | ✓（Web/钉钉插话） | ✗（可 cancel） |
| packaging | 现场打包返回包中 | ✗ | ✗ |
| done | 完成，返回包已落 OSS | ✗ | ✓ |
| failed / cancelled / expired | 失败 / 已取消 / 超时 | ✗ | ✓（含部分成果） |

## 环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `QWEN_HOME` | `~/.qwen` | qwen 本地存储目录（session jsonl 来源；本地 CLI 若用其他目录需 export） |
| `AGENTHUB_CONFIG_DIR` | `~/.agenthub` | 覆盖 config.json 目录 |
| `AGENTHUB_HUB_URL` | config 内 hubUrl | 覆盖 Hub 地址 |

## 典型流程

```bash
ah login --register --hub http://127.0.0.1:4180   # 首次注册并登录
ah push --task '继续重构并补单测'                   # 任务接力（自动取最近 session）
ah list && ah status <handoff-id>                  # 跟踪状态与时间线
ah pull                                            # done 后拉回：git 合并 + 时间线合并
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `✗ [ERR_AUTH] missing or invalid token` | token 缺失或过期（7 天）。重跑 `ah login`（首次用 `--register`） |
| `ah push` 报找不到 session | 当前目录不是 git 仓库，或 `QWEN_HOME` 未指向真实 qwen 会话目录 |
| Web 聊天停在"正在连接云端会话" | 任务需处于 running；若持续卡住，刷新页面或检查 hub-server 版本（详情接口需返回 workspacePath） |
| pull 后重复执行无变化 | 幂等设计，git 与 jsonl 均不会重复合并 |
