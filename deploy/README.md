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
