# 构建阶段: Vite 打包 web SPA
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# 依赖声明层, 利用 Docker 缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @dev-anywhere/shared --filter @dev-anywhere/web

COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN pnpm --filter @dev-anywhere/shared build
RUN pnpm --filter @dev-anywhere/web build

# 生产阶段: nginx 静态服务; 公网 TLS 和 relay 分流由宿主机 nginx 负责
FROM nginx:alpine AS runner

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
