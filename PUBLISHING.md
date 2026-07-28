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

普通改动合并到 `main` 后，`.github/workflows/release-please.yml` 会创建或更新一个 Release PR。这个 PR 集中维护：

- 下一个语义化版本；
- 根目录和四个 workspace package 的版本号；
- `.release-please-manifest.json`；
- `CHANGELOG.md`。

所有贡献 PR 都会通过 `.github/workflows/ci.yml` 运行单元测试和发布包检查。Release PR 合并到 `main` 后还会复用同一门禁；只有门禁通过，Release Please 才会创建 tag 和 GitHub Release。

合并 Release PR 后，Release Please 会创建 `vX.Y.Z` tag 和 GitHub Release，并直接调用 `.github/workflows/release.yml`：

1. `publish-images` 构建 `dev-anywhere-relay`，向 GHCR 以及可选的阿里云 ACR 推送 `latest`、`vX.Y.Z`、`X.Y.Z`、`X.Y` 和 `X`。
2. `publish-npm` 构建 workspace，先发布 `@dev-anywhere/relay`，再发布依赖相同 Relay 版本的 `@dev-anywhere/proxy`。
3. `ensure-github-release` 确保手工 tag 的应急发布同样具有 GitHub Release。

发布 workflow 仍监听手工推送的 `v*.*.*` tag，作为 Release Please 无法使用时的兜底。Release Please 直接调用发布 workflow，是因为它用仓库的 `GITHUB_TOKEN` 创建 tag 时，GitHub 不会为该 tag 再触发一轮 workflow。

GHCR 使用 workflow 的 `GITHUB_TOKEN`；npm 发布需要 `NPM_TOKEN`。阿里云 ACR 发布需要 `ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME` 和 `ACR_PASSWORD`。

## Preparing changes

Release Please 根据 Conventional Commits 判断版本：

- `fix:` 生成 patch 版本；
- `feat:` 生成 minor 版本；
- `feat!:`、`fix!:` 或包含 `BREAKING CHANGE:` 的提交生成 breaking release；在 `1.0.0` 之前，本项目将它映射为 minor 版本；
- `docs:`、`test:`、`chore:` 等维护提交不会单独生成版本。

提交和 PR 标题都建议使用这个格式，尤其是在使用 squash merge 时：

```text
fix(proxy): restore Codex session titles
feat(web): add attachment previews
```

日常发布不再手工修改版本号、CHANGELOG 或 tag。确认 Release PR 内容和发布门禁后，合并它即可发布。

涉及移动端行为时，在合并 Release PR 前仍需完成 Android 或 iPad 对应验收。

发布开始后可以这样跟踪：

```bash
gh run list --workflow "Release Please" --limit 5
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

如果发布 workflow 失败，可在 GitHub Actions 中重新运行失败任务；发布步骤会跳过已经存在的 npm 版本。不要移动或覆盖已经公开的 tag。

## Emergency manual release

需要明确指定版本并绕过 Release PR 时，先补充 CHANGELOG 条目，再运行：

```bash
pnpm release X.Y.Z
```

脚本仍会执行完整发布检查，并同步 Release Please manifest、所有 package 版本、release commit 和 tag。`--emergency` 只跳过耗时的 release smoke，不会跳过构建和包完整性检查：

```bash
pnpm run release -- --emergency X.Y.Z
```

## First-time repo setup

1. 在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中添加 `NPM_TOKEN`，它需要能够发布两个 npm 包。
2. Settings -> Actions -> General 中允许 workflow 使用写权限，并启用 “Allow GitHub Actions to create and approve pull requests”。
3. 阿里云 ACR 发布需要 `ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME` 和 `ACR_PASSWORD`。
4. 保持阿里云 ACR 仓库公开，VPS 才能在未登录时执行 `docker pull`。
5. 第一次发布会创建 GHCR package；如果要通过 `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip` 使用它，需要将 package 设为公开。

## Version policy

- DEV Anywhere 只使用一个产品版本；Release Please 会同步根 package、Proxy、Relay、Web 和 Shared 的版本。
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
