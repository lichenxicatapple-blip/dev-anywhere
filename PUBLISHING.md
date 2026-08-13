# Publishing DEV Anywhere

## Release artifacts

A single `vX.Y.Z` git tag produces three public artifacts:

| Kind   | Name                                                                                                         | What it's for                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| npm    | `@dev-anywhere/proxy`                                                                                        | Local proxy CLI, including the account-free Quick Tunnel command |
| npm    | `@dev-anywhere/relay`                                                                                        | Combined Relay and Web server                                    |
| Docker | `crpi-ibzynlurwxb2ye5w.cn-guangzhou.personal.cr.aliyuncs.com/lichenxicatapple-blip/dev-anywhere-relay:<tag>` | Production combined Relay and Web container                      |

`@dev-anywhere/shared` stays `private: true` and is bundled into the published npm packages via tsup `noExternal`.

## Release pipeline

本地 `pnpm release X.Y.Z` 是唯一创建版本的入口。脚本会：

1. 确认当前分支是与 `origin/main` 一致的 `main`，并校验目标版本和 CHANGELOG。
2. 运行发布检查、快速 smoke、进程/网络 Chaos 和完整 Android Chrome 门禁。
3. 同步根目录和四个 workspace package 的版本号。
4. 创建 release commit 和 `vX.Y.Z` tag，再推送 commit 与 tag。

所有贡献 PR 都会通过 `.github/workflows/ci.yml` 运行单元测试和发布包检查。普通改动推送到 `main` 后，`.github/workflows/main.yml` 会再次运行同一套 CI 和独立 Chaos 检查，但不会修改版本、创建 PR、创建 tag 或发布产物。

本地脚本推送 `vX.Y.Z` tag 后，`.github/workflows/release.yml` 会执行：

1. `publish-images` 构建 `dev-anywhere-relay`，向 GHCR 以及可选的阿里云 ACR 推送 `latest`、`vX.Y.Z`、`X.Y.Z`、`X.Y` 和 `X`。
2. `publish-npm` 构建 workspace，先发布 `@dev-anywhere/relay`，再发布依赖相同 Relay 版本的 `@dev-anywhere/proxy`。
3. `ensure-github-release` 确保手工 tag 的应急发布同样具有 GitHub Release。

发布 workflow 的正常入口只有 `v*.*.*` tag push。`workflow_dispatch` 仅用于对已经存在的 tag 做故障恢复，不负责决定版本或创建 tag。

GHCR 使用 workflow 的 `GITHUB_TOKEN`；npm 发布需要 `NPM_TOKEN`。阿里云 ACR 发布需要 `ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME` 和 `ACR_PASSWORD`。

## Preparing changes

提交和 PR 标题建议使用 Conventional Commits 格式，方便理解变更范围：

```text
fix(proxy): restore Codex session titles
feat(web): add attachment previews
```

发布前先决定明确的 `X.Y.Z` 版本，并在 `CHANGELOG.md` 添加 `## [X.Y.Z] - YYYY-MM-DD`。不要手工修改 package 版本或创建 tag，发布脚本会统一处理。

涉及移动端行为时，在正式发布前仍需完成 Android 或 iPad 对应验收。

发布开始后可以这样跟踪：

```bash
gh run list --workflow "Main Verification" --limit 5
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

如果发布 workflow 失败，可在 GitHub Actions 中重新运行失败任务；发布步骤会跳过已经存在的 npm 版本。不要移动或覆盖已经公开的 tag。

## Local release

补充 CHANGELOG 条目后，在与远端一致的本地 `main` 运行：

```bash
pnpm release X.Y.Z
```

脚本会执行完整发布检查，并同步所有 package 版本、release commit 和 tag。`--emergency` 只跳过快速 smoke，不会跳过 `release:check`、Chaos 或 Android 门禁：

```bash
pnpm run release -- --emergency X.Y.Z
```

## First-time repo setup

1. 在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加 `NPM_TOKEN`，它需要能够发布两个 npm 包。
2. GitHub Actions 默认保持只读；只有 Release workflow 的 npm、镜像和 GitHub Release 步骤使用所需的最小写权限。
3. 阿里云 ACR 发布需要 `ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME` 和 `ACR_PASSWORD`。
4. 保持阿里云 ACR 仓库公开，VPS 才能在未登录时执行 `docker pull`。
5. 第一次发布会创建 GHCR package；如果要通过 `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip` 使用它，需要将 package 设为公开。

## Version policy

- DEV Anywhere 只使用一个产品版本；本地发布脚本会同步根 package、Proxy、Relay、Web 和 Shared 的版本。
- Pre-`1.0.0`: minor bumps may include breaking changes. Document user-facing breakage in release notes or the changelog.

## VPS deploy

Production deploys must use published images. Do not deploy from local-only images or installer bypasses.

The installer defaults to Aliyun ACR:

```bash
IMAGE_TAG=X.Y.Z ./scripts/deploy/install-relay.sh --ssh ubuntu@dev-anywhere.example.com dev-anywhere.example.com
```

To deploy from GHCR explicitly, pass `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip`.

The installer reuses `/opt/dev-anywhere/.env` when relay tokens already exist, pulls the requested image tag, restarts Docker Compose, and verifies:

```bash
curl -fsS https://dev-anywhere.example.com/health
```

Direct VPS mode is also supported:

```bash
sudo ./scripts/deploy/install-relay.sh dev-anywhere.example.com
```

The installer prints two credentials:

- `RELAY_PROXY_TOKEN`: put this in each developer machine's `~/.dev-anywhere/config.json` as `relays.cloud.proxyToken`.
- `RELAY_CLIENT_TOKEN`: open `https://dev-anywhere.example.com/`, then paste this value in Settings -> Relay Token.

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

## Standalone Relay And Web Without TLS

For local development only:

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN=$(openssl rand -hex 24) \
RELAY_CLIENT_TOKEN=$(openssl rand -hex 24) \
PORT=3100 dev-anywhere-relay
```
