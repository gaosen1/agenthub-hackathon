#!/usr/bin/env bash
# 构建并推送 sandbox 镜像（spec §7.1）
# 用法: ./build-sandbox.sh <acr-registry> [tag]
# 可选环境变量: ACR_NAMESPACE（默认 qwen-code-demo）、QWEN_VERSION
set -euo pipefail
REGISTRY="${1:?用法: $0 <acr-registry> [tag]}"
TAG="${2:-latest}"
IMAGE="$REGISTRY/${ACR_NAMESPACE:-qwen-code-demo}/sandbox:$TAG"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @agenthub/shared --filter @agenthub/sandbox build

# pnpm deploy 产出独立可运行目录（含 dist + 生产依赖）
STAGE="$ROOT/packages/sandbox/sandbox-dist"
rm -rf "$STAGE"
pnpm --filter @agenthub/sandbox deploy --legacy --prod "$STAGE"

# ACS 节点为 amd64，本地 arm64 需 buildx 交叉构建并直推
docker buildx build \
  --platform linux/amd64 \
  ${QWEN_VERSION:+--build-arg QWEN_VERSION=$QWEN_VERSION} \
  -t "$IMAGE" \
  -f "$ROOT/packages/sandbox/Dockerfile" \
  --push \
  "$ROOT/packages/sandbox"

echo "pushed $IMAGE"
