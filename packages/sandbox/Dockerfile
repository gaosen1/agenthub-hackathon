# Sandbox 镜像（spec §5.1 / §7.1）
# node:22-slim + Qwen Code（固定版本）+ runner + git/ripgrep
# 单镜像双模式：RUNNER_MODE=web|bot；镜像不含任何 secret
ARG BASE_IMAGE=docker.m.daocloud.io/library/node:22-slim
FROM ${BASE_IMAGE}

# 国内构建环境：apt/npm 走阿里与 npmmirror 源
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates procps tar zstd curl \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name agenthub \
    && git config --system user.email agenthub@sandbox.local

ARG QWEN_VERSION=0.21.14
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @qwen-code/qwen-code@${QWEN_VERSION}

# Web IDE：code-server 独立预编译包（npm 路线需原生编译工具链且镜像源 tarball 不全，弃用）；
# GitHub release 直连，解开即用，软链到 /usr/local/bin 与 ide.ts bakedBin 对齐
ARG CODE_SERVER_VERSION=4.106.3
RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" -o /tmp/cs.tgz \
    && tar -xzf /tmp/cs.tgz -C /opt \
    && ln -s "/opt/code-server-${CODE_SERVER_VERSION}-linux-amd64/bin/code-server" /usr/local/bin/code-server \
    && rm /tmp/cs.tgz

WORKDIR /app
# 由 deploy/build-sandbox.sh 先执行 pnpm 构建与 deploy 打包，再 docker build
COPY sandbox-dist/ ./

ENV RUNNER_MODE=web
EXPOSE 8080 8081 8083
CMD ["node", "dist/runner.js"]
