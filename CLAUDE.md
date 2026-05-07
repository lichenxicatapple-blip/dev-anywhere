# Dev Anywhere

Dev Anywhere 是本地 AI CLI 的透明代理和远程控制系统。当前目标是让 Claude Code 和 Codex 的本地 PTY 会话可以被 Web 端实时查看、接管和恢复，同时保留原生 CLI 的行为边界。

## 当前定位

- 本地入口：proxy/terminal 负责启动或附着 Agent CLI 进程。
- 本地服务：serve 负责 IPC、hook server、provider status、permission broker、relay 连接。
- 云端入口：relay 只负责鉴权、会话绑定、WebSocket 转发、last status replay。
- 远端入口：Web SPA 负责会话列表、PTY 渲染、JSON timeline、权限操作和状态展示。
- 首批 provider：Claude Code、Codex。不要再把项目写成 Claude-only。

## 架构边界

模块 owner 和治理规则见 `docs/governance/ARCHITECTURE-GOVERNANCE.md`。协议、状态机、permission/status 规则见 `docs/governance/PROTOCOL-STATE-GOVERNANCE.md`。

硬约束：

- 一个能力只能有一个 owner。
- 一个状态只能有一个主来源。
- `packages/shared` 只能放跨进程协议 schema、builders、常量。
- relay 不理解 provider 业务语义。
- Web 组件不直接解析 relay raw message。
- PTY bytes 只用于渲染和 snapshot，不用于判断 agent phase。
- 不新增“保留但不用”的脚本、fallback 或兼容路径；废弃路径直接删除并更新文档。

## 术语

| 术语     | 含义                                                                  |
| -------- | --------------------------------------------------------------------- |
| terminal | 本地终端侧进程，负责 PTY 进程、stdin/stdout、resize、snapshot。       |
| serve    | 本地 daemon，负责 IPC、relay client、hook server、session lifecycle。 |
| proxy    | terminal + serve 组成的本地侧整体。                                   |
| relay    | 云端中转服务，桥接 proxy 和 Web client。                              |
| client   | Web SPA，不指本地 terminal 进程。                                     |
| provider | Claude Code、Codex 等 Agent CLI 适配层。                              |

## 本地开发

脚本入口和保留理由见 `docs/SCRIPTS.md`。

常用命令：

```bash
pnpm install
pnpm build:shared
pnpm dev:restart
pnpm dev:health
```

Web SPA：

```bash
pnpm --filter @dev-anywhere/web run dev
pnpm --filter @dev-anywhere/web run build
pnpm --filter @dev-anywhere/web test:e2e
```

Proxy：

```bash
pnpm proxy -- claude
pnpm proxy -- codex
pnpm --filter @dev-anywhere/proxy run serve restart
```

Relay：

```bash
pnpm --filter @dev-anywhere/relay run dev
```

## 测试与验证

优先跑和改动相关的测试，不为了覆盖率堆低价值测试。

常用检查：

```bash
pnpm lint
pnpm typecheck
pnpm knip
pnpm dev:health
```

真实链路手测清单见 `docs/LOCAL-SMOKE.md`。涉及 PTY 渲染、滚动、输入、resize、会话终止、hook/status/permission 的改动，必须尽量用真实 Claude/Codex PTY 会话验证。

## 部署

发布和 VPS 部署流程见 `PUBLISHING.md`。现行部署路径是 tag release + GHCR/ACR 预构建镜像 + `scripts/install-relay.sh --ssh`。

不要恢复旧的 rsync + 远端构建部署脚本。

## 文档入口

文档索引见 `docs/README.md`。

- 当前事实以源码、测试、`docs/governance/`、`docs/SCRIPTS.md`、`docs/LOCAL-SMOKE.md` 为准。
- LinkShell 技术差异审计在 `docs/research/TECH-DIFF-LINKSHELL.md`。
- 救援期和命名迁移材料在 `docs/archive/`，仍可用于未完成事项追踪，但不能覆盖当前代码事实。
- `.planning/notes/` 暂时保留；只有确认某条 note 已完成并被当前代码、测试或正式文档吸收后才删除。
