#!/usr/bin/env bash
# 构建并推送 hub 镜像
# 用法: ./build-hub.sh <acr-registry> [tag]
set -euo pipefail
REGISTRY="${1:?用法: $0 <acr-registry> [tag]}"
TAG="${2:-latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm --filter @agenthub/shared --filter @agenthub/hub-server build

STAGE="$ROOT/deploy/hub-dist"
rm -rf "$STAGE"
pnpm --filter @agenthub/hub-server deploy --prod "$STAGE"

docker build -t "$REGISTRY/agenthub/hub:$TAG" -f "$ROOT/deploy/Dockerfile.hub" "$ROOT/deploy"
docker push "$REGISTRY/agenthub/hub:$TAG"
echo "pushed $REGISTRY/agenthub/hub:$TAG"
