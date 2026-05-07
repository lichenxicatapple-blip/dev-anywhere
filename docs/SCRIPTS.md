# 脚本入口说明

本项目不保留“备用但不用”的运维脚本。脚本只有两种状态：正在使用，或删除。

## 日常开发

| 命令                              | 用途                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev:restart`                | 重启本地真实链路：先构建 shared 协议包，再启动 relay、web、proxy serve。 |
| `pnpm dev:health`                 | 只读健康检查：端口、relay HTTP、proxy serve 状态、当前进程日志。         |
| `pnpm proxy -- --provider claude` | 从本地终端 attach 一个 Claude PTY 会话。                                 |
| `pnpm proxy -- --provider codex`  | 从本地终端 attach 一个 Codex PTY 会话。                                  |

## 生产部署

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

## 专项验证与采样

| 命令                                                                             | 用途                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts <relay-url>` | 对远端 relay 做 WebSocket 路由验证。                          |
| `pnpm --filter @dev-anywhere/proxy run sample:stream-json`                       | 采样真实 Claude stream-json 输出，更新 schema drift fixture。 |

这些不是日常开发入口，只有在验证远端 relay 或更新 fixture 时使用。
