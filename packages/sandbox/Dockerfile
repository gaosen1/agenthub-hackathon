# Sandbox 镜像（spec §5.1 / §7.1）
# node:22-slim + Qwen Code（固定版本）+ runner + git/ripgrep
# 单镜像双模式：RUNNER_MODE=web|bot；镜像不含任何 secret
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name agenthub \
    && git config --system user.email agenthub@sandbox.local

ARG QWEN_VERSION=0.20.1
RUN npm install -g @qwen-code/qwen-code@${QWEN_VERSION}

WORKDIR /app
# 由 deploy/build-sandbox.sh 先执行 pnpm 构建与 deploy 打包，再 docker build
COPY sandbox-dist/ ./

ENV RUNNER_MODE=web
EXPOSE 8080 8081
CMD ["node", "node_modules/@agenthub/sandbox/dist/runner.js"]
