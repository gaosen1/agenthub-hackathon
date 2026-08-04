#!/bin/bash
# 启动一个 qodercli Agent 进程，并自动登记到巡检注册表 agents.json。
# 用法: ./launch_agent.sh <agent名称> <任务文件>
# 示例: ./launch_agent.sh dev-agent ops/tasks/agent1.md
set -eu
NAME="${1:?用法: $0 <agent名称> <任务文件>}"
TASK_FILE="${2:?缺少任务文件}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$ROOT")"
QODERCLI="${QODERCLI_BIN:-$HOME/.local/bin/qodercli}"

if [ ! -f "$TASK_FILE" ]; then
  echo "[ERROR] 任务文件不存在: $TASK_FILE"
  exit 1
fi

LOG_DIR="$ROOT/logs"
STATE_DIR="$ROOT/state"
mkdir -p "$LOG_DIR" "$STATE_DIR"

# 为每个 Agent 生成固定 session-id，巡检恢复时用 qodercli -r 续接同一会话
SID=$(uuidgen | tr 'A-Z' 'a-z')
# 用正则兼容两种命令行：首启为 --session-id <sid>，巡检恢复为 -r <sid>
MATCH="qodercli .*${SID}"
LOG_FILE="${LOG_DIR}/${NAME}.log"
# 恢复指令：续接原会话上下文，并以任务文件中的进度为准继续。
# 注意：重启方（巡检定时会话）若运行在沙箱中，需先提权（required_permissions=all）再执行本命令，
# 否则 qodercli 无法写入 ~/.qoder 会话目录会立即退出。
RESTART_CMD="${QODERCLI} -r ${SID} -p '上次会话意外中断。请读取任务列表 ${TASK_FILE}，跳过已完成项，继续执行剩余任务。' --dangerously-skip-permissions"

echo "$SID" > "$STATE_DIR/$NAME.session-id"

# 拉起 Agent（headless 模式，日志落盘）
cd "$REPO"
nohup "$QODERCLI" --session-id "$SID" -n "$NAME" \
  -p "$(cat "$TASK_FILE")" \
  --dangerously-skip-permissions \
  >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$STATE_DIR/$NAME.pid"

# 自动登记到巡检注册表
python3 - "$ROOT/agents.json" "$NAME" "$MATCH" "$REPO" "$RESTART_CMD" "$LOG_FILE" "$TASK_FILE" <<'PYEOF'
import json, sys
registry_path, name, match, workdir, restart_cmd, log, task_list = sys.argv[1:8]
with open(registry_path) as f:
    data = json.load(f)
agents = data.setdefault("agents", [])
agents = [a for a in agents if a.get("name") != name]  # 同名覆盖
agents.append({
    "name": name,
    "enabled": True,
    "match": match,
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

echo "[LAUNCHED] $NAME"
echo "  session-id: $SID"
echo "  pid:        $PID"
echo "  日志:       $LOG_FILE"
echo "  已登记到巡检注册表，每 10 分钟自动巡检。"
