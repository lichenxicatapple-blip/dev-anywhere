# Publishing cc-anywhere

## Release artifacts

A single `vX.Y.Z` git tag produces four artifacts:

| Kind   | Name                                           | What it's for                                         |
|--------|------------------------------------------------|-------------------------------------------------------|
| npm    | `cc-anywhere`                                  | Local proxy CLI end-users install on their laptop     |
| npm    | `cc-anywhere-relay`                            | Standalone relay binary for local/dev use             |
| Docker | `ghcr.io/<owner>/cc-anywhere-relay:<tag>`      | Production relay container                            |
| Docker | `ghcr.io/<owner>/cc-anywhere-web:<tag>`        | Nginx + web SPA container (reverse-proxies the relay) |

`@cc-anywhere/shared` stays `private: true` and is bundled into both npm packages via tsup `noExternal`.

## Release pipeline

`.github/workflows/release.yml` triggers on any `v*.*.*` tag push (or manual `workflow_dispatch`) and runs two jobs in parallel:

1. **publish-images** — matrix over `cc-anywhere-relay` and `cc-anywhere-web`. Each job uses `docker/build-push-action` with buildx + GHA cache and pushes image tags `latest`, `X.Y.Z`, `X.Y`, `X` to GHCR.
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
pnpm -r build

# Validate npm packages
(cd apps/proxy && pnpm pack --pack-destination /tmp)
(cd apps/relay && pnpm pack --pack-destination /tmp)

rm -rf /tmp/cc-test
npm install --prefix /tmp/cc-test --global \
  /tmp/cc-anywhere-*.tgz /tmp/cc-anywhere-relay-*.tgz

/tmp/cc-test/bin/cc-anywhere --version
PORT=3199 /tmp/cc-test/bin/cc-anywhere-relay &   # ^C to stop

rm -rf /tmp/cc-test /tmp/cc-anywhere-*.tgz

# Validate Docker images build (optional)
docker buildx build -f apps/relay/Dockerfile -t cc-anywhere-relay:dry .
docker buildx build -f apps/web/Dockerfile   -t cc-anywhere-web:dry   .
```

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
npm install -g cc-anywhere
cc-anywhere init
# edit ~/.cc-anywhere/config.json: { "relayUrl": "wss://...", "relayToken": "..." }
cc-anywhere serve start
```

### Self-hosted relay + web (VPS, turnkey)

`scripts/install-relay.sh` uses pre-built GHCR images — no source clone, no build on the VPS, ~30s cold start.

```bash
# A) From your laptop, auto-ssh:
./scripts/install-relay.sh --ssh user@vps-host cc-anywhere.example.com

# B) On the VPS directly:
curl -fsSL https://raw.githubusercontent.com/<owner>/cc-anywhere/main/scripts/install-relay.sh \
  | sudo bash -s -- cc-anywhere.example.com
```

Upgrade later:

```bash
cd /opt/cc-anywhere && docker compose pull && docker compose up -d
```

### Standalone relay without TLS (dev)

```bash
npm install -g cc-anywhere-relay
RELAY_PROXY_TOKEN=$(openssl rand -hex 24) PORT=3100 cc-anywhere-relay
```
