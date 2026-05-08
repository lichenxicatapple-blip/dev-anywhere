# Publishing DEV Anywhere

## Release artifacts

A single `vX.Y.Z` git tag produces four artifacts:

| Kind   | Name                                       | What it's for                                         |
| ------ | ------------------------------------------ | ----------------------------------------------------- |
| npm    | `@dev-anywhere/proxy`                      | Local proxy CLI end-users install on their laptop     |
| npm    | `@dev-anywhere/relay`                      | Standalone relay binary for local/dev use             |
| Docker | `ghcr.io/<owner>/dev-anywhere-relay:<tag>` | Production relay container                            |
| Docker | `ghcr.io/<owner>/dev-anywhere-web:<tag>`   | Nginx + web SPA container (reverse-proxies the relay) |

`@dev-anywhere/shared` stays `private: true` and is bundled into both npm packages via tsup `noExternal`.

## Release pipeline

`.github/workflows/release.yml` triggers on any `v*.*.*` tag push and runs two jobs in parallel:

1. **publish-images** — matrix over `dev-anywhere-relay` and `dev-anywhere-web`. Each job uses `docker/build-push-action` with buildx + GHA cache and pushes image tags `latest`, `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X` to GHCR.
2. **publish-npm** — `pnpm -r build` then `pnpm publish` for each npm package. Requires `NPM_TOKEN` repo secret.

GHCR auth uses the workflow's `GITHUB_TOKEN` (no extra secret needed). `packages: write` permission is set on the workflow.

## Cutting a release

```bash
# 1. Bump versions in lockstep
pnpm -r exec npm version <patch|minor|major>

# 2. Commit and tag
git add apps/proxy/package.json apps/relay/package.json
git commit -m "chore: bump to vX.Y.Z"
git tag vX.Y.Z

# 3. Push — tag push triggers the workflow
git push && git push --tags
```

The workflow publishes npm packages and GHCR images; no manual publish step.

## Local dry-run (before pushing a tag)

```bash
pnpm typecheck
pnpm test
pnpm format:check
pnpm knip
pnpm release:check

# Validate Docker images build (optional)
docker buildx build -f apps/relay/Dockerfile -t dev-anywhere-relay:dry .
docker buildx build -f apps/web/Dockerfile   -t dev-anywhere-web:dry   .
```

`pnpm release:check` builds the workspace, validates npm pack contents for proxy and relay, verifies the bundled terminal font shards, and runs `dev-anywhere init` in an isolated `HOME`.

## First-time repo setup

1. In the GitHub repo Settings → Secrets and variables → Actions, add:
   - `NPM_TOKEN` with publish permission on both packages (`npm token create` on npmjs.com).
2. Settings → Actions → General → Workflow permissions: ensure "Read and write permissions" is enabled (or the workflow's `packages: write` is respected).
3. First push to main creates the GHCR packages on-demand. After the first publish, go to the GHCR package pages and set them to **public** so unauthenticated `docker pull` works.

## Version policy

- Both npm packages and both Docker images bumped together, even if only one changed. Rationale: protocol lives in `shared`; version skew risks silent envelope shape drift between relay and proxy.
- Pre-`1.0.0`: minor bumps may include breaking changes (document in CHANGELOG). Once stable, move to strict semver.

## User-facing install flows

### Local proxy CLI (end-user laptop)

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
# edit ~/.dev-anywhere/config.json: set envs.cloud.relayToken from RELAY_PROXY_TOKEN
dev-anywhere serve start --env cloud
```

### Self-hosted relay + web (VPS, turnkey)

`scripts/install-relay.sh` uses pre-built GHCR images — no source clone, no build on the VPS, ~30s cold start. Our own cloud deployment must use this same path; do not deploy from local-only images or installer bypasses.

```bash
# A) From your laptop, auto-ssh:
./scripts/install-relay.sh --ssh user@vps-host dev-anywhere.vita-tools.top

# B) On the VPS directly:
curl -fsSL https://raw.githubusercontent.com/<owner>/dev-anywhere/main/scripts/install-relay.sh \
  | sudo bash -s -- dev-anywhere.vita-tools.top
```

Upgrade later:

```bash
cd /opt/dev-anywhere && docker compose pull && docker compose up -d
```

### Standalone relay without TLS (dev)

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN=$(openssl rand -hex 24) \
RELAY_CLIENT_TOKEN=$(openssl rand -hex 24) \
PORT=3100 dev-anywhere-relay
```
