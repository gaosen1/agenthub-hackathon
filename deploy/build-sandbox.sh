#!/usr/bin/env bash
# 构建并推送 sandbox 镜像（spec §7.1）
# 用法: ./build-sandbox.sh <acr-registry> [tag]
set -euo pipefail
REGISTRY="${1:?用法: $0 <acr-registry> [tag]}"
TAG="${2:-latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @agenthub/shared --filter @agenthub/sandbox build

# pnpm deploy 产出独立可运行目录（含 dist + 生产依赖）
STAGE="$ROOT/packages/sandbox/sandbox-dist"
rm -rf "$STAGE"
pnpm --filter @agenthub/sandbox deploy --prod "$STAGE"

docker build \
  -t "$REGISTRY/agenthub/sandbox:$TAG" \
  -f "$ROOT/packages/sandbox/Dockerfile" \
  "$ROOT/packages/sandbox"

docker push "$REGISTRY/agenthub/sandbox:$TAG"
echo "pushed $REGISTRY/agenthub/sandbox:$TAG"
