# Stage 1: build + prune
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Dep manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/relay/package.json apps/relay/

RUN pnpm install --frozen-lockfile \
  --filter @dev-anywhere/shared \
  --filter @dev-anywhere/relay

# Sources
COPY packages/shared/ packages/shared/
COPY apps/relay/ apps/relay/

RUN pnpm --filter @dev-anywhere/shared build
RUN pnpm --filter @dev-anywhere/relay build

# Produce a self-contained prod-only deployment directory.
# `pnpm deploy --prod` copies the package files (as declared in "files")
# and installs only runtime dependencies — no devDeps, no workspace graph.
RUN pnpm --filter @dev-anywhere/relay deploy --prod /app/deploy

# Stage 2: minimal runtime
FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/deploy ./

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
