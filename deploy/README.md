# deploy

K8s manifests 与镜像构建推送脚本（design.md §7）。

- 集群：ACK `agenthub-demo`（杭州，ACS 算力），namespace `agenthub`
- OSS bucket：`your-agenthub-bucket`（生命周期 7 天过期）
- RAM 角色：`<YOUR_RAM_ROLE>`
- 镜像仓库：ACR 个人版（待新建）

```
deploy/
  k8s/          # namespace、secret（模型凭证/serve token）、sandbox pod 模板
  scripts/      # 镜像构建与推送
```

## Web IDE（code-server）NAS 共享层

沙箱镜像不内置 code-server；它预置在 NAS 上，沙箱 Pod 只读挂载 `/mnt/shared`，
用户在任务页点「打开 IDE」时由 runner 按需拉起（秒级）。启用步骤：

1. NAS：本环境已有现成文件系统 `011ycys4ld1m2mdhupu`（与 ACK/ACS 同 VPC，挂载点 `-ken57`），直接复用即可；
   若是全新环境才需要先在 NAS 控制台创建文件系统与挂载点（同 VPC，通用型按量）；
2. 播种：替换 `k8s/30-nas-seed-job.yaml` 里的 `REPLACE_NAS_SERVER` / `REPLACE_NAS_PATH`
   后 `kubectl apply -f k8s/30-nas-seed-job.yaml`，等 Job 完成（`kubectl -n agenthub logs job/agenthub-nas-seed`）；
3. 配置 hub：`k8s/20-hub.yaml` 打开 `SANDBOX_NAS_SERVER` / `SANDBOX_NAS_PATH` 两项 env
   （与 Job 里的 server/path 一致），重新部署 hub；
4. 验证：running 的 web handoff 详情页点「打开 IDE」，应秒级进入 code-server，
   目录为云端工作区，内置终端可用。

升级 code-server：改 Job 里 `CODE_SERVER_VERSION` 重跑，`current` 软链原子切换；
旧版本目录可事后手动清理。未配置 NAS 的集群点「打开 IDE」会得到明确提示，不影响其他功能。

真云踩坑（已固化进 Job 清单，此处留索引）：
- ECI/ACS 挂 NFS 子路径不会自动建目录 → 挂根目录 + 脚本内 mkdir；
- 集群拉不到 docker.io，镜像用 ACR 已有的（沙箱镜像内 wget 缺失时下载行换 node fetch）；
- 集群出网到不了 GitHub → 本地下载 tar.gz 传 OSS，用内网签名 URL；
- `current` 用相对软链，绝对路径在消费方挂载点（/mnt/shared）必断。
