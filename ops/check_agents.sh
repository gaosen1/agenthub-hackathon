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
state_dir = os.path.join(os.path.dirname(registry_path), "state")
with open(registry_path) as f:
    data = json.load(f)

agents = [a for a in data.get("agents", []) if a.get("enabled")]
now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
print(f"=== Agent 巡检报告 {now} ===")

# 收集自身及直接父进程 PID，防止 pgrep 误匹配巡检自身
self_pids = {os.getpid()}
r = subprocess.run(["ps", "-o", "ppid=", "-p", str(os.getpid())], capture_output=True, text=True)
if r.stdout.strip().isdigit():
    self_pids.add(int(r.stdout.strip()))


def find_pids(agent):
    """优先用 state/<name>.pid 精确判断，其次回退 pgrep -f match"""
    pid_file = os.path.join(state_dir, f"{agent.get('name', '')}.pid")
    if os.path.isfile(pid_file):
        try:
            pid = int(open(pid_file).read().strip())
            os.kill(pid, 0)  # 存在性检查
            return [str(pid)]
        except (ValueError, ProcessLookupError, PermissionError):
            pass
        except OSError:
            return []
    match = agent.get("match", "")
    if not match:
        return []
    r = subprocess.run(["pgrep", "-f", match], capture_output=True, text=True)
    return [p for p in r.stdout.split() if p and int(p) not in self_pids]


if not agents:
    print("[EMPTY] 注册表中没有 enabled=true 的 Agent，无需巡检。")
    sys.exit(0)

dead = 0
for a in agents:
    name = a.get("name", "unnamed")
    pids = find_pids(a)
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
        proc = subprocess.Popen(
            restart_cmd, shell=True, cwd=workdir,
            stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        # 尽力回写 pid 文件（sh 对单命令会直接 exec，pid 通常即为新进程）
        try:
            with open(os.path.join(state_dir, f"{name}.pid"), "w") as pf:
                pf.write(str(proc.pid))
        except OSError:
            pass
        hint = f"，任务列表: {task_list}" if task_list else ""
        print(f"[RESTARTED] {name}: 进程中断，已重新拉起（日志: {log_path}{hint}）")
        print(f"    提示: 若复查发现进程未存活，多为沙箱限制（qodercli 需写 ~/.qoder），")
        print(f"    请以提权方式（required_permissions=all）重新执行 agents.json 中的 restart_cmd。")
    except Exception as e:
        print(f"[FAILED] {name}: 重启失败 - {e}")

print(f"=== 巡检结束：共 {len(agents)} 个，异常 {dead} 个 ===")
PYEOF
