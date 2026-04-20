# Publishing cc-anywhere

Two public npm packages are produced from this monorepo:

| Package              | Source dir           | Bin                     | Scope   |
|----------------------|----------------------|-------------------------|---------|
| `cc-anywhere`        | `apps/proxy/`        | `cc-anywhere`           | public  |
| `cc-anywhere-relay`  | `apps/relay/`        | `cc-anywhere-relay`     | public  |

Both are **non-scoped** and published under the same MIT license. `@cc-anywhere/shared` is a workspace-internal helper, `private: true`, and is **not** published — both public packages bundle it via tsup `noExternal`.

## Local dry-run (do this before every publish)

```bash
pnpm -r build

# Pack tarballs
(cd apps/proxy && pnpm pack --pack-destination /tmp)
(cd apps/relay && pnpm pack --pack-destination /tmp)

# Install into an isolated prefix (does not pollute system PATH)
rm -rf /tmp/cc-test
npm install --prefix /tmp/cc-test --global \
  /tmp/cc-anywhere-*.tgz /tmp/cc-anywhere-relay-*.tgz

# Smoke test
/tmp/cc-test/bin/cc-anywhere --version
PORT=3199 /tmp/cc-test/bin/cc-anywhere-relay &   # ^C to stop

# Cleanup
rm -rf /tmp/cc-test /tmp/cc-anywhere-*.tgz
```

## Publish

### First-time setup

```bash
npm login     # https://www.npmjs.com account
```

### Cut a release

```bash
# 1. Update both versions (keep them in lockstep for cross-package guarantees)
pnpm -r exec npm version <patch|minor|major>

# 2. Commit
git add apps/proxy/package.json apps/relay/package.json
git commit -m "chore: bump to vX.Y.Z"
git tag vX.Y.Z

# 3. Build + publish (prepublishOnly re-runs pnpm build, safety net)
pnpm --filter cc-anywhere publish --no-git-checks --access public
pnpm --filter cc-anywhere-relay publish --no-git-checks --access public

# 4. Push
git push && git push --tags
```

## Release automation (future)

Add `.github/workflows/release.yml` triggered on `v*` tags:
- `pnpm install --frozen-lockfile`
- `pnpm -r build`
- `pnpm --filter cc-anywhere publish --no-git-checks`
- `pnpm --filter cc-anywhere-relay publish --no-git-checks`

Use `NPM_TOKEN` secret with publish scope.

## Version policy

- Both packages bumped together, even if only one changed. Rationale: protocol lives in `shared`, both bundles carry it; version skew between proxy and relay risks silent envelope shape drift.
- Pre-`1.0.0`: minor bumps may include breaking changes (document in CHANGELOG). Once stable, move to strict semver.

## What users see

### End-user install (proxy)

```bash
npm install -g cc-anywhere
cc-anywhere serve start
```

### Self-hosted relay (VPS)

Turnkey via `scripts/install-relay.sh` (docker + nginx + Let's Encrypt):

```bash
# On the VPS, as root:
curl -fsSL https://raw.githubusercontent.com/catli/cc-anywhere/main/scripts/install-relay.sh \
  | sudo bash -s -- relay.example.com
```

Or manual:

```bash
npm install -g cc-anywhere-relay
RELAY_PROXY_TOKEN=$(openssl rand -hex 24) PORT=3100 cc-anywhere-relay
# Put behind nginx/Caddy for TLS
```
