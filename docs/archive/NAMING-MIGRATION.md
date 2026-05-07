# 命名迁移计划

最后更新：2026-05-06

## 结论

项目新名确定为 **Dev Anywhere**。

技术命名：

| 对象           | 新值                                     |
| -------------- | ---------------------------------------- |
| 产品名         | Dev Anywhere                             |
| 根 package     | `dev-anywhere`                           |
| 主 CLI         | `dev-anywhere`                           |
| proxy package  | `@dev-anywhere/proxy`                    |
| relay package  | `@dev-anywhere/relay`                    |
| web package    | `@dev-anywhere/web`                      |
| shared package | `@dev-anywhere/shared`                   |
| 配置目录       | `~/.dev-anywhere`                        |
| 日志目录       | `~/.dev-anywhere/logs`                   |
| 运行目录       | `~/.dev-anywhere/run`                    |
| IPC socket     | `~/.dev-anywhere/run/dev-anywhere.sock`  |
| env 前缀       | `DEV_ANYWHERE_`                          |
| Docker 镜像    | `dev-anywhere-relay`、`dev-anywhere-web` |
| 部署目录       | `/opt/dev-anywhere`                      |

## 命名依据

- 延续 `CC Anywhere` 的“随时随地”气质。
- 不绑定 Claude Code 或 Codex。
- 比 `Agent Anywhere` 更少 AI agent 生态重名压力。
- 比 `CLI Anywhere` 更像产品，不只是一个命令行工具。
- npm 当前未发现 `dev-anywhere` 包。
- 本机未发现 `dev-anywhere`、`devanywhere`、`da` 命令冲突。
- GitHub 上存在少量 `dev-anywhere` / `DevAnywhere` 小 repo，但没有明显强占位项目。

## 迁移原则

1. 不保留旧名兼容。
2. 不新增旧 `cc-anywhere` alias。
3. 不读取旧 `CC_ANYWHERE_*` 环境变量。
4. 不自动迁移旧 `~/.cc-anywhere`，因为项目未上线。
5. 旧目录只在 doctor/cleanup 命令中提示用户可删除。
6. 测试 fixture 中作为历史 Claude 输出样本出现的旧名不做机械替换，避免破坏真实协议样本。
7. `.planning/` 历史文档不参与源码级重命名，只在需要时归档。
8. 本地仓库目录 `/Users/admin/workspace/cc_anywhere` 最后再改，避免中途破坏当前工作会话。

## 第一轮修改范围

必须修改：

- `package.json` 根 package name 和 scripts。
- `apps/proxy/package.json`、`apps/relay/package.json`、`apps/web/package.json`、`packages/shared/package.json`。
- workspace import：`@cc-anywhere/shared`、`@lichenxi.cat/cc-anywhere-relay`。
- bin：`cc-anywhere` -> `dev-anywhere`，`cc-anywhere-relay` -> `dev-anywhere-relay`。
- 配置路径：`~/.cc-anywhere` -> `~/.dev-anywhere`。
- socket/pid/log 文件名：`cc-anywhere` -> `dev-anywhere`。
- env：`CC_ANYWHERE_*` -> `DEV_ANYWHERE_*`。
- Docker container/image/deploy path。
- Web title、PWA name、UI 空态文案。
- `CLAUDE.md`、`README`、`PUBLISHING.md`、部署脚本文档。

暂不修改：

- `reference/LinkShell`。
- `.planning/` 历史材料。
- `apps/proxy/src/__tests__/fixtures/stream-json/**` 中作为 provider 原始输出的历史文本。
- 本地仓库目录 `/Users/admin/workspace/cc_anywhere`。

## 执行顺序

1. 修改 package/bin/import 名。
2. 修改运行时路径、env 和日志路径。
3. 修改 Docker、部署脚本和发布文档。
4. 修改 Web/PWA 展示名。
5. 运行 `pnpm install` 更新 lockfile。
6. 运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build`。
7. 用 `rg` 检查源码、文档和 package 中不再出现旧名。
8. 最后再处理仓库目录名和远端 repo 名。

## 验证标准

- `dev-anywhere --help` 可用。
- `dev-anywhere-relay --help` 可用。
- `pnpm --filter @dev-anywhere/proxy run build` 通过。
- `pnpm --filter @dev-anywhere/relay run build` 通过。
- `pnpm --filter @dev-anywhere/web run build` 通过。
- 新配置默认写入 `~/.dev-anywhere`。
- 源码、package、README、部署脚本中不再出现 `cc-anywhere`、`CC Anywhere`、`CC_ANYWHERE`、`@cc-anywhere`、`@lichenxi.cat/cc-anywhere`。
- 旧名只允许出现在本迁移文档、救援文档和 provider 历史 fixture 中。

## 风险

- package scope 改动会影响所有 workspace import，必须同步改 lockfile。
- bin 改名会影响部署脚本和 README，不能只改 `package.json`。
- 配置目录改名会影响测试中对 homedir 的 mock。
- Docker 镜像名改动会影响 GHCR 发布和 VPS 部署脚本。
- UI 文案改名后仍要避免把产品写成“只支持 Claude Code”。
