# 开发指南

本文面向准备修改 DEV Anywhere 本身的贡献者。安装和部署请从根目录 [README](../README.md) 开始。

## 本地启动

需要：

- Node.js 20 或更高版本；CI 使用 Node.js 20；
- pnpm 9，与 CI 保持一致；
- macOS 或 Linux；
- 可选：已经登录的 Claude Code、Codex，用于验证真实 Agent 链路；
- 可选：`cloudflared`，用于验证 Quick Tunnel。

安装 pnpm 和项目依赖：

```bash
corepack enable
corepack prepare pnpm@9 --activate
pnpm install --frozen-lockfile
```

初始化本地配置。该命令只会在配置不存在时创建文件，不会覆盖已有配置：

```bash
pnpm --filter @dev-anywhere/proxy run dev -- init
```

默认配置包含指向 `ws://localhost:3100` 的 `local` profile。启动本地 Relay、Web 和 Proxy：

```bash
pnpm dev:restart -- --profile local --relay local
pnpm dev:health -- --profile local
```

脚本会打印 Web 地址和本轮日志位置。开发环境使用独立的 `local` profile，不会重启正在使用的 `default` profile。

如果已有配置中没有 `local` profile，先在 `~/.dev-anywhere/config.json` 中增加一个指向 `ws://localhost:3100` 的 Relay，并让 `local` profile 使用它。

## 常用开发命令

重启完整本地链路：

```bash
pnpm dev:restart -- --profile local --relay local
```

只重启 Relay：

```bash
pnpm dev:relay:restart
```

只启动 Web 开发服务器，需要已有 Relay 可供连接：

```bash
pnpm dev:web -- --relay local --port 5173
```

检查 Proxy 状态：

```bash
pnpm --filter @dev-anywhere/proxy run dev -- \
  --profile local \
  serve status
```

启动一个可被本地 Web 接管的 Claude Code 会话：

```bash
pnpm --filter @dev-anywhere/proxy run dev -- \
  --profile local \
  claude
```

Codex：

```bash
pnpm --filter @dev-anywhere/proxy run dev -- \
  --profile local \
  codex
```

测试 Agent 创建流程时，不要让它修改当前仓库。可以在 Web 中选择临时目录，或者为终端命令指定一次性工作目录：

```bash
DEV_ANYWHERE_CWD="$(mktemp -d)" \
  pnpm --filter @dev-anywhere/proxy run dev -- \
  --profile local \
  claude
```

## 仓库结构

```text
apps/
  proxy/    开发机服务、PTY、Agent 适配、文件与会话管理
  relay/    Relay、Web 托管、认证、文件和语音端点
  web/      React 界面、终端与聊天视图
packages/
  shared/   Proxy、Relay 与 Web 共用的协议、类型和日志能力
scripts/
  deploy/   VPS 部署
  dev/      本地开发环境与健康检查
  quality/  格式、静态检查和单元测试
  release/  发布检查、打包和发版
  test/     浏览器、移动端与集成测试
docs/       长期维护的中文文档和 README 媒体资源
```

`shared` 不依赖应用。Proxy、Relay 和 Web 通过共享协议协作，不直接读取彼此的内部状态。

## 配置

用户配置位于 `~/.dev-anywhere/config.json`，顶层字段包括：

- `defaultProfile`
- `profiles`
- `relays`
- `agentCli`
- `logLevel`

`profiles` 选择 Relay，`relays` 保存 URL 与 Proxy Token。`agentCli` 可以指定 Claude Code、Codex 的绝对路径。

配置由 Zod schema 校验。新增字段时应同时修改 schema、默认配置、相关测试和用户文档。

## 测试

### 静态检查与单元测试

```bash
pnpm quality:check
```

该命令并行运行格式检查、ESLint、TypeScript、Knip 和单元测试。需要单独定位问题时，可以运行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm knip
pnpm test:unit
```

验证全部 workspace 能否构建：

```bash
pnpm build
```

### 桌面浏览器

```bash
pnpm test:pc
```

桌面 E2E 覆盖会话创建、聊天与 PTY、文件、审批、设置和布局。观察目标用例时可以使用 Playwright headed 模式：

```bash
pnpm --filter @dev-anywhere/web exec playwright test \
  e2e/pc/functional-walkthrough.spec.ts \
  --headed
```

### 移动端

并行运行移动端测试：

```bash
pnpm test:mobile
```

设备资源冲突时改为串行：

```bash
pnpm test:mobile:serial
```

Android 测试环境管理：

```bash
pnpm test:mobile:emulators:list
pnpm test:mobile:emulators:create
pnpm test:mobile:emulators:start
pnpm test:mobile:emulators:stop
```

调试工具：

```bash
pnpm tools:emu-debug
pnpm tools:ipad-debug
```

Playwright 的移动 viewport 可以验证响应式布局。软键盘、系统输入法、音频路由和实体键盘还需要在对应操作系统与浏览器中验证。

### 集成与稳定性

```bash
pnpm test:integration
pnpm dev:chaos
```

集成测试覆盖 Relay 与 Proxy 的真实连接。Chaos 测试覆盖进程退出、重连、PTY 和 Agent 生命周期，运行时间与资源开销更高。

提交前至少运行与改动范围对应的测试。修改共享协议、Relay 鉴权、PTY 生命周期、移动输入或 Voice Pilot 时，不能只依赖单个单元测试。

## 调试与产物

先取得可复现步骤、DOM 状态、事件 trace 或 Proxy/Relay 日志，再修改实现。

- 不用设备尺寸常量推断软键盘、实体键盘或浏览器工具栏；使用浏览器实际暴露的 viewport、focus 和输入事件。
- PTY 滚动、触摸与键盘行为由状态机和控制器统一管理，避免在多个事件回调中增加互相覆盖的例外。
- 会重启服务、清理会话或注入故障的测试只能使用隔离 profile。
- 临时探针和诊断产物放入 `artifacts/` 或系统临时目录，不进入正式产品路由。

常用日志与测试产物：

```text
~/.dev-anywhere/logs/
~/.dev-anywhere/profiles/local/logs/
artifacts/
apps/web/test-results/
apps/web/artifacts/
```

默认 profile 的 Proxy 服务日志位于：

```text
~/.dev-anywhere/logs/service.log
```

浏览器诊断包可能包含会话 ID、开发机名称和布局信息。提交 issue 或公开测试产物前，先检查其中是否包含 Token 或其他敏感内容。

## 发布

本节供维护者使用。发布前先在 `CHANGELOG.md` 中增加目标版本，提交普通改动，并确保本地 `main` 与 `origin/main` 一致。

执行完整发布流程：

```bash
pnpm release <version>
```

脚本会运行发布检查与 smoke 测试、更新 package 版本、创建 release commit 和 tag，然后推送。需要单独执行门禁时使用：

```bash
pnpm release:check
pnpm release:smoke
```

tag 推送后，GitHub Actions 发布 `@dev-anywhere/proxy`、`@dev-anywhere/relay` 和 Relay Docker 镜像。发布完成后还应验证一次 Quick Tunnel，并用现有 Token 执行一次 VPS 幂等升级。
