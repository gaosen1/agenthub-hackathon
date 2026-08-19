#!/usr/bin/env bash
# 构建并推送 hub 镜像
# 用法: ./build-hub.sh <acr-registry> [tag]
# 可选环境变量: ACR_NAMESPACE（默认 agenthub）
set -euo pipefail
REGISTRY="${1:?用法: $0 <acr-registry> [tag]}"
TAG="${2:-latest}"
IMAGE="$REGISTRY/${ACR_NAMESPACE:-agenthub}/hub:$TAG"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @agenthub/shared --filter @agenthub/hub-server build

STAGE="$ROOT/deploy/hub-dist"
rm -rf "$STAGE"
pnpm --filter @agenthub/hub-server deploy --legacy --prod "$STAGE"

# ACS 节点为 amd64，本地 arm64 需 buildx 交叉构建并直推
docker buildx build \
  --platform linux/amd64 \
  -t "$IMAGE" \
  -f "$ROOT/deploy/Dockerfile.hub" \
  --push \
  "$ROOT/deploy"

echo "pushed $IMAGE"
