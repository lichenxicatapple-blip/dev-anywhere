# 构建阶段：安装依赖并编译
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# 先拷贝依赖声明文件，利用 Docker 缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/relay/package.json apps/relay/

RUN pnpm install --frozen-lockfile --filter @cc-anywhere/shared --filter @lichenxi.cat/cc-anywhere-relay

# 拷贝源码并构建
COPY packages/shared/ packages/shared/
COPY apps/relay/ apps/relay/

RUN pnpm --filter @cc-anywhere/shared build
RUN pnpm --filter @lichenxi.cat/cc-anywhere-relay build

# 生产阶段：只拷贝运行时需要的文件
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/relay/package.json apps/relay/

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/relay/dist apps/relay/dist
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=builder /app/apps/relay/node_modules apps/relay/node_modules

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "apps/relay/dist/index.js"]
