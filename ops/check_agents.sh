#!/bin/bash
# Agent 进程巡检脚本：读取同目录 agents.json，逐个检查进程是否存活，
# 挂掉且配置了 restart_cmd 的自动拉起，并输出巡检报告。
# 用法: ./check_agents.sh
set -u
REGISTRY="$(cd "$(dirname "$0")" && pwd)/agents.json"

if [ ! -f "$REGISTRY" ]; then
  echo "[ERROR] 注册表不存在: $REGISTRY"
  exit 2
fi

python3 - "$REGISTRY" <<'PYEOF'
import json, os, subprocess, sys, datetime

registry_path = sys.argv[1]
with open(registry_path) as f:
    data = json.load(f)

agents = [a for a in data.get("agents", []) if a.get("enabled")]
now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
print(f"=== Agent 巡检报告 {now} ===")

if not agents:
    print("[EMPTY] 注册表中没有 enabled=true 的 Agent，无需巡检。")
    sys.exit(0)

dead = 0
for a in agents:
    name = a.get("name", "unnamed")
    match = a.get("match", "")
    if not match:
        print(f"[SKIP] {name}: 未配置 match 模式")
        continue
    r = subprocess.run(["pgrep", "-f", match], capture_output=True, text=True)
    pids = [p for p in r.stdout.split() if p and int(p) != os.getpid()]
    if pids:
        print(f"[OK] {name}: 存活 (pid: {', '.join(pids)})")
        continue

    dead += 1
    restart_cmd = a.get("restart_cmd", "").strip()
    if not restart_cmd:
        print(f"[DEAD] {name}: 进程不存在，且未配置 restart_cmd，仅报告不重启")
        continue

    workdir = a.get("workdir") or os.getcwd()
    log_path = a.get("log") or "/tmp/agent-restart.log"
    task_list = a.get("task_list", "")
    try:
        logf = open(log_path, "a")
        logf.write(f"\n===== [{now}] 巡检发现进程中断，自动重启: {restart_cmd} =====\n")
        logf.flush()
        subprocess.Popen(
            restart_cmd, shell=True, cwd=workdir,
            stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        hint = f"，任务列表: {task_list}" if task_list else ""
        print(f"[RESTARTED] {name}: 进程中断，已重新拉起（日志: {log_path}{hint}）")
    except Exception as e:
        print(f"[FAILED] {name}: 重启失败 - {e}")

print(f"=== 巡检结束：共 {len(agents)} 个，异常 {dead} 个 ===")
PYEOF
