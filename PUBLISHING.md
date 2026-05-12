# Publishing DEV Anywhere

## Release artifacts

A single `vX.Y.Z` git tag produces four public artifacts:

| Kind   | Name                                                                                                         | What it's for                                         |
| ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| npm    | `@dev-anywhere/proxy`                                                                                        | Local proxy CLI end-users install on their laptop     |
| npm    | `@dev-anywhere/relay`                                                                                        | Standalone relay binary for local/dev use             |
| Docker | `crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip/dev-anywhere-relay:<tag>` | Production relay container                            |
| Docker | `crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip/dev-anywhere-web:<tag>`   | Nginx + web SPA container, reverse-proxying the relay |

`@dev-anywhere/shared` stays `private: true` and is bundled into the published npm packages via tsup `noExternal`.

## Release pipeline

`.github/workflows/release.yml` triggers on `v*.*.*` tag pushes and runs two jobs:

1. `publish-images`: builds `dev-anywhere-relay` and `dev-anywhere-web`, then pushes `latest`, `vX.Y.Z`, `X.Y.Z`, `X.Y`, and `X` tags to GHCR and, when Aliyun ACR secrets are configured, Aliyun ACR. The VPS installer defaults to the Aliyun ACR path.
2. `publish-npm`: builds the workspace and publishes `@dev-anywhere/proxy` and `@dev-anywhere/relay`. This requires the `NPM_TOKEN` repo secret.

GHCR auth uses the workflow `GITHUB_TOKEN`; the workflow requests `packages: write`. Aliyun ACR publishing uses `ACR_REGISTRY`, `ACR_NAMESPACE`, `ACR_USERNAME`, and `ACR_PASSWORD`.

## Cutting a release

Keep proxy, relay, and web versions in lockstep:

```bash
# 1. Bump versions together
$EDITOR apps/proxy/package.json apps/relay/package.json apps/web/package.json

# 2. Run local verification
pnpm format:check
pnpm typecheck
pnpm test
pnpm release:check
pnpm test:layout
pnpm test:pc
pnpm test:mobile

# 3. Commit, tag, and push
git add -A
git commit -m "release: prepare vX.Y.Z"
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

When the release touches mobile-specific behavior (chat / PTY / history / session create / provider routing), run `pnpm test:mobile` against an Android emulator before tagging.

After pushing the tag, wait for the release workflow:

```bash
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

If a release workflow fails before publishing completes, fix the failure, commit again, and create a new unused tag. Do not retag a version that may already have published npm packages or images.

## First-time repo setup

1. In GitHub repo Settings -> Secrets and variables -> Actions, add `NPM_TOKEN` with publish permission on both npm packages.
2. Settings -> Actions -> General -> Workflow permissions must allow write permissions, or the workflow `packages: write` permission must be respected.
3. Aliyun ACR publishing needs `ACR_REGISTRY`, `ACR_NAMESPACE`, `ACR_USERNAME`, and `ACR_PASSWORD`.
4. Keep the Aliyun ACR repositories public so unauthenticated VPS `docker pull` works.
5. First image publish creates the GHCR package pages. Set them to public if GHCR will be used explicitly via `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip`.

## Version policy

- Bump both npm packages and both Docker images together. The shared protocol lives in `@dev-anywhere/shared`; version skew can otherwise create silent envelope drift between proxy, relay, and web.
- Pre-`1.0.0`: minor bumps may include breaking changes. Document user-facing breakage in release notes or the changelog.

## VPS deploy

Production deploys must use published images. Do not deploy from local-only images or installer bypasses.

The installer defaults to Aliyun ACR:

```bash
IMAGE_TAG=X.Y.Z ./scripts/install-relay.sh --ssh ubuntu@dev-anywhere.example.com dev-anywhere.example.com
```

To deploy from GHCR explicitly, pass `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip`.

The installer reuses `/opt/dev-anywhere/.env` when relay tokens already exist, pulls the requested image tag, restarts Docker Compose, and verifies:

```bash
curl -fsS https://dev-anywhere.example.com/health
```

Direct VPS mode is also supported:

```bash
sudo ./scripts/install-relay.sh dev-anywhere.example.com
```

The installer prints two credentials:

- `RELAY_PROXY_TOKEN`: put this in each developer machine's `~/.dev-anywhere/config.json` as `relays.cloud.proxyToken`.
- `RELAY_CLIENT_TOKEN`: open the web client once with `https://dev-anywhere.example.com/?relayToken=<RELAY_CLIENT_TOKEN>`.

## Local proxy update

After npm publish succeeds, update the local CLI and reconnect the local runtime to cloud:

```bash
npm install -g @dev-anywhere/proxy@X.Y.Z
dev-anywhere serve restart --relay cloud
dev-anywhere serve status
```

For first-time local setup:

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
# edit ~/.dev-anywhere/config.json: set relays.cloud.url and relays.cloud.proxyToken
dev-anywhere serve start --relay cloud
```

## Standalone relay without TLS

For local development only:

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN=$(openssl rand -hex 24) \
RELAY_CLIENT_TOKEN=$(openssl rand -hex 24) \
PORT=3100 dev-anywhere-relay
```
