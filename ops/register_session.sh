#!/bin/bash
# 将已有的 qodercli 会话（如交互式长任务）登记到巡检注册表 agents.json。
# 识别方式：会话活跃期间 qodercli 进程始终打开 segments 日志文件，
# 巡检通过 lsof 匹配该文件判断存活；恢复时用 -r <session-id> 续接。
#
# 用法: ./register_session.sh <session-id> <agent名称> <工作目录> [任务文件]
# session-id 可通过 qodercli --list-sessions 查询。
set -eu
SID="${1:?用法: $0 <session-id> <agent名称> <工作目录> [任务文件]}"
NAME="${2:?缺少 agent 名称}"
WORKDIR="${3:?缺少工作目录}"
TASK_FILE="${4:-}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
QODERCLI="${QODERCLI_BIN:-$HOME/.local/bin/qodercli}"
LOG_FILE="$ROOT/logs/$NAME.log"
STATE_DIR="$ROOT/state"
mkdir -p "$ROOT/logs" "$STATE_DIR"

# 定位该会话当前打开的 segments 日志文件，用于 lsof 识别
SESSION_LOG=$(lsof 2>/dev/null | grep "/$SID/segments/.*\.jsonl" | awk '{print $NF}' | head -1 || true)
if [ -z "$SESSION_LOG" ]; then
  echo "[ERROR] 未找到 session $SID 的活跃进程（lsof 未匹配到 segments 文件），请确认会话正在运行"
  exit 1
fi

# 恢复指令：续接原会话；若任务文件存在则按其进度继续，全部完成后写 .done 标记
if [ -n "$TASK_FILE" ]; then
  CONT="请读取任务列表 $TASK_FILE，跳过已完成项继续执行剩余任务；若所有任务均已完成，请执行 touch $STATE_DIR/$NAME.done 后结束。"
else
  CONT="请回顾会话上下文，继续执行之前未完成的工作。"
fi
RESTART_CMD="$QODERCLI -r $SID -p '上次会话意外中断。$CONT' --dangerously-skip-permissions"

# 登记（同名覆盖）
python3 - "$ROOT/agents.json" "$NAME" "$SESSION_LOG" "$WORKDIR" "$RESTART_CMD" "$LOG_FILE" "$TASK_FILE" <<'PYEOF'
import json, sys
registry_path, name, session_log, workdir, restart_cmd, log, task_list = sys.argv[1:8]
with open(registry_path) as f:
    data = json.load(f)
agents = data.setdefault("agents", [])
agents = [a for a in agents if a.get("name") != name]
agents.append({
    "name": name,
    "enabled": True,
    "session_log": session_log,   # lsof 识别用：会话活跃进程始终打开该文件
    "match": "",                  # 交互式会话命令行无 session-id，不用 pgrep
    "workdir": workdir,
    "restart_cmd": restart_cmd,
    "log": log,
    "task_list": task_list,
})
data["agents"] = agents
with open(registry_path, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PYEOF

echo "[REGISTERED] $NAME"
echo "  session-id:  $SID"
echo "  识别文件:    $SESSION_LOG"
echo "  恢复命令:    qodercli -r $SID ..."
echo "  已加入巡检注册表。"
