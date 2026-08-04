# Sandbox 镜像（design.md §5.5 F-14）
# node:22-slim + Qwen Code（固定版本）+ runner + git/ripgrep
# 单镜像双模式：RUNNER_MODE=task|bot；镜像不含任何 secret
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# TODO(M2): 固定 Qwen Code 版本
# RUN npm install -g @qwen-code/qwen-code@<pinned-version>

WORKDIR /app
# TODO(M2): COPY 构建产物（runner dist + node_modules）
# COPY dist/ ./dist/

ENV RUNNER_MODE=task
EXPOSE 8080
CMD ["node", "dist/runner.js"]
