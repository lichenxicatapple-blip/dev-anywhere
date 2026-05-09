# 脚本入口说明

本项目不保留“备用但不用”的运维脚本。脚本只有两种状态：正在使用，或删除。

## 日常开发

| 命令                          | 用途                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev:restart`            | 重启本地真实链路：先构建 shared 协议包，再启动 relay、web、proxy serve。 |
| `pnpm dev:health`             | 只读健康检查：端口、relay HTTP、proxy serve 状态、当前进程日志。         |
| `pnpm mobile:smoke`           | 运行本地优先的移动端 smoke：UI 合同 + 本地真实 relay/proxy 只读链路。    |
| `pnpm mobile:smoke:full`      | 在移动端 smoke 基础上创建/终止真实会话并等待模型回复。                   |
| `pnpm mobile:smoke:simulator` | 在移动端 smoke 基础上追加 iOS Simulator Safari 截图。                    |
| `pnpm desktop:smoke`          | 运行本地桌面 guard，保护共享 shell/session/input 改动不破坏 PC。         |
| `pnpm proxy -- claude`        | 开发态启动/attach 一个 Claude 终端会话。                                 |
| `pnpm proxy -- codex`         | 开发态启动/attach 一个 Codex 终端会话。                                  |

Agent CLI 二进制路径可通过环境变量覆盖：

| 环境变量     | 用途                              |
| ------------ | --------------------------------- |
| `CLAUDE_BIN` | 指定 Claude Code CLI 的二进制路径 |
| `CODEX_BIN`  | 指定 Codex CLI 的二进制路径       |

## 生产部署

发布后的本地命令不经过 pnpm：

| 命令                                     | 用途                                      |
| ---------------------------------------- | ----------------------------------------- |
| `dev-anywhere init`                      | 初始化 `~/.dev-anywhere/config.json`。    |
| `dev-anywhere serve start`               | 用 `defaultEnv` 启动本机 proxy daemon。   |
| `dev-anywhere serve start --env cloud`   | 用指定环境启动本机 proxy daemon。         |
| `dev-anywhere serve status`              | 查看本机 proxy daemon 和 relay 连接状态。 |
| `dev-anywhere serve restart`             | 用 `defaultEnv` 重启本机 proxy daemon。   |
| `dev-anywhere serve restart --env cloud` | 切换到指定环境并重启。                    |
| `dev-anywhere serve stop`                | 停止本机 proxy daemon。                   |
| `dev-anywhere claude [...参数]`          | 启动/attach Claude Code 终端会话。        |
| `dev-anywhere codex [...参数]`           | 启动/attach Codex 终端会话。              |

`claude` 或 `codex` 后面的参数会原样传给真实 CLI，例如：

```bash
dev-anywhere claude -c
dev-anywhere codex --model gpt-5.5
```

| 脚本                       | 用途                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| `scripts/install-relay.sh` | 使用预构建镜像部署 relay + web 到 VPS，支持本机 `--ssh` 或 VPS 上直接运行。 |

生产部署只走 `install-relay.sh`。旧的 rsync + 远端构建路径已删除。

## 代码治理

| 命令                    | 用途                                               |
| ----------------------- | -------------------------------------------------- |
| `pnpm lint`             | ESLint，并串联 source comment 引用检查。           |
| `pnpm lint:source-refs` | 单独运行 `scripts/check-source-comment-refs.mjs`。 |
| `pnpm format:check`     | Prettier 格式检查。                                |
| `pnpm typecheck`        | TypeScript build mode 检查。                       |
| `pnpm knip`             | 未使用依赖、入口和导出检查。                       |
| `pnpm release:check`    | 构建发布产物、检查 npm 包内容、用隔离 HOME 冒烟。  |

## 专项验证与采样

| 命令                                                                             | 用途                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts <relay-url>` | 对远端 relay 做 WebSocket 路由验证。                                 |
| `pnpm mobile:smoke:simulator`                                                    | 本地移动 smoke 后，在 iOS Simulator Safari 打开当前 Web 并保存截图。 |
| `pnpm --filter @dev-anywhere/proxy run sample:stream-json`                       | 采样真实 Claude stream-json 输出，更新 schema drift fixture。        |

这些不是日常开发入口，只有在验证远端 relay 或更新 fixture 时使用。
