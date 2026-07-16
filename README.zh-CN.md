<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="DEV Anywhere logo" />
</p>

<h1 align="center">DEV Anywhere</h1>

<p align="center">
  <strong>用任意浏览器在自己的开发机上创建并控制 Claude Code、Codex 和普通 Shell 会话。</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <img src="https://img.shields.io/npm/v/@dev-anywhere/proxy?label=proxy" alt="@dev-anywhere/proxy on npm" />
  <img src="https://img.shields.io/npm/v/@dev-anywhere/relay?label=relay" alt="@dev-anywhere/relay on npm" />
</p>

DEV Anywhere 是一个自托管的浏览器控制层，用来操作本机开发会话。它可以在指定项目目录里启动 Claude Code 或 Codex，打开普通 Shell，接管从本地 CLI 启动的会话，处理工具审批，并在浏览器和开发机之间传文件。

你的仓库、Shell 状态、Agent CLI、API Key 和本地凭据都留在原本的开发机上。Relay 只负责在这台机器和桌面、iPad、手机或已安装的 PWA 之间转发已认证的 WebSocket 与文件流量。

```text
浏览器 / PWA
    <-> Relay + Web 客户端
    <-> 本地 Proxy daemon
    <-> Claude Code / Codex / Shell
```

## 为什么需要它

[code-server](https://github.com/coder/code-server) 和 [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server) 把完整 IDE 带到浏览器里。[ttyd](https://github.com/tsl0922/ttyd) 把终端暴露到 Web 上。[OpenHands](https://github.com/OpenHands/openhands) 更偏向 Agent 驱动的软件开发平台。

DEV Anywhere 的范围更窄：它不是云端 IDE，也不试图替代你的本地终端配置。它给浏览器提供一个干净的控制面，专门服务于你写代码时真正会用到的会话：Agent CLI、普通 Shell、审批、移动端控制和文件传输。

## 核心工作流

### 创建 Agent 会话

在 Web 客户端里创建 Claude Code 或 Codex 会话，选择工作目录、终端模式或聊天模式，并在进程启动前选定权限模式。

<p>
  <img src="docs/assets/readme-create-agent.png" alt="在真实 DEV Anywhere 仓库中创建 Agent 会话" />
</p>

也可以从本地 CLI 启动：

```bash
dev-anywhere claude
dev-anywhere codex
```

这些会话会出现在浏览器侧边栏里，刷新页面、切换网络或更换浏览器后都可以继续恢复。

### 打开普通终端

不需要 Agent 回合时，可以直接从浏览器创建终端会话。它会在开发机上打开一个普通 Shell，显示在同一个侧边栏里，并使用和 Agent 终端模式一致的 PTY 控制。

终端会话适合查看日志、重启服务、跑一次性命令，或者在手机上盯着长时间运行的命令，而真正的进程仍然留在开发机上。

### 在手机或平板上工作

移动端沿用同一套会话模型，但不是把桌面界面直接缩小。新建会话、会话切换、终端辅助按键、文件操作和 PWA 使用方式都会适配触摸操作。

<p>
  <img src="docs/assets/readme-mobile-create.png" alt="移动端连接真实本地 Proxy 后的新建会话 sheet" width="360" />
</p>

### 处理审批和管理客户端

Agent 工具审批会先发到浏览器，再决定是否继续执行对应的本地命令。遇到连续重复审批时，可以对单个会话开启 Always Yes。

设置面板里也可以查看当前连到 Relay 的浏览器和 PWA 客户端，断开不再使用的客户端时不需要动 Proxy daemon。

<p>
  <img src="docs/assets/readme-client-management.png" alt="连接真实本地 Proxy 的客户端管理弹窗" />
</p>

### 通过 Relay 传文件

DEV Anywhere 处理的是具体文件路径，而不是目录浏览：

- 把图片粘贴到聊天或 PTY 会话中，会上传到开发机；
- 点击终端或聊天输出里的受支持图片路径，可以直接预览；
- 点击受支持文件路径，可以通过 Relay 下载；
- 如果需要预览当前项目目录或系统临时目录之外的图片，可以配置 `previewRoots`。

## 快速开始

### 无需 VPS 临时体验

临时体验时，先安装
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
和 DEV Anywhere CLI：

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere tunnel
```

这个命令会：

- 启动相互隔离的本地 Relay、Web 客户端和 Proxy profile；
- 无需 Cloudflare 账号，创建随机的 `trycloudflare.com` HTTPS 地址；
- 自动验证公网 Web 页面、健康检查和 WebSocket 连接；
- 输出一个通过 URL fragment 安全导入临时 Client Token 的访问地址。

体验期间需要保持命令运行，按 `Ctrl+C` 会关闭 Tunnel 和临时 Proxy。Cloudflare Quick
Tunnel 不提供可用性保证，同时最多处理 200 个进行中的请求，仅适合测试和开发。日常使用请采用下面的 VPS 部署。

### 推荐的 VPS 部署

托管部署由两部分组成：

1. VPS 运行合并后的 Relay 和 Web 服务；
2. 开发机运行本地 Proxy daemon 和 Agent CLI。

#### 1. 部署 Relay 和 Web

在本仓库 checkout 中运行：

```bash
IMAGE_TAG=latest ./scripts/deploy/install-relay.sh --ssh ubuntu@dev-anywhere.example.com dev-anywhere.example.com
```

安装脚本会配置 Docker、nginx、TLS 和合并后的 Relay 容器，并输出：

- 给本地 Proxy daemon 使用的 `RELAY_PROXY_TOKEN`；
- 给浏览器和 PWA 使用的 `RELAY_CLIENT_TOKEN`；
- Web 地址，例如 `https://dev-anywhere.example.com/`。

#### 2. 配置开发机

在已经放着项目仓库、Claude Code 和 Codex 的开发机上安装 Proxy：

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
```

编辑 `~/.dev-anywhere/config.json`：

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "relay": "cloud"
    }
  },
  "relays": {
    "cloud": {
      "url": "wss://dev-anywhere.example.com",
      "proxyToken": "<RELAY_PROXY_TOKEN>"
    }
  },
  "previewRoots": []
}
```

启动 daemon：

```bash
dev-anywhere serve start --relay cloud
dev-anywhere serve status
```

#### 3. 打开 Web 客户端

打开安装脚本输出的 Web 地址。在 **设置 -> Relay Token** 中粘贴 `RELAY_CLIENT_TOKEN`，重新连接，然后选择你的开发机。

如果想在 iPhone 或 iPad 上像 App 一样使用，可以把站点添加到主屏幕。

#### 4. 开始工作

可以在 Web 客户端里创建 Agent 会话或终端会话，也可以从本地 CLI 启动 Agent 会话：

```bash
dev-anywhere claude
dev-anywhere codex
```

## 本地开发 Relay

如果只想在本机测试，不需要 VPS，可以直接运行 Relay：

```bash
npm install -g @dev-anywhere/relay
RELAY_PROXY_TOKEN="$(openssl rand -hex 24)" \
RELAY_CLIENT_TOKEN="$(openssl rand -hex 24)" \
PORT=3100 dev-anywhere-relay
```

npm Relay 包会从同一个端口提供 Web/PWA 客户端、HTTP API、文件、语音端点和 WebSocket。公开部署仍建议使用 Docker 安装脚本，由 nginx 终止 TLS 并管理证书。

## 安全模型

- Relay 不需要仓库访问权限，也不会运行 Agent CLI。
- CLI 进程、Shell 状态、本地路径、API Key 和凭据都留在开发机上。
- 公开 Relay 必须同时配置 `RELAY_PROXY_TOKEN` 和 `RELAY_CLIENT_TOKEN`，并建议放在 HTTPS 后面。
- 工具审批会先发到浏览器，再决定是否继续执行对应的本地命令。
- 文件预览和下载需要显式路径；DEV Anywhere 不提供目录浏览。
- 额外预览目录必须通过 `previewRoots` 主动配置。

不要把未认证 Relay 暴露到公网。任何能访问它的人，都可能列出已连接的 Proxy，或者尝试绑定到这些 Proxy。

## 软件包

| Package               | 用途                                                        |
| --------------------- | ----------------------------------------------------------- |
| `@dev-anywhere/proxy` | 本地 daemon、CLI 封装、PTY/会话运行时和文件桥接。           |
| `@dev-anywhere/relay` | 连接 Proxy daemon、浏览器客户端和文件流的 WebSocket Relay。 |
| `@dev-anywhere/web`   | React 浏览器/PWA 客户端，以 Docker 镜像发布。               |

## 仓库结构

```text
apps/proxy       本地 daemon 和会话运行时
apps/relay       WebSocket Relay 服务
apps/web         React Web/PWA 客户端
packages/shared  共享协议 schema 和工具
docs             公开文档和 README 素材
scripts          开发、验证、部署和发布脚本
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm release:check
```

常用本地循环：

```bash
pnpm dev:web -- --relay cloud --port 5174
pnpm dev:restart
pnpm dev:health
```

`dev:web` 用本地 Web 代码连接 Relay。`dev:restart` 和 `dev:health` 会用隔离的 `local` profile 跑本地 proxy/relay/web 链路。

## 文档

- [部署指南](docs/DEPLOYMENT.md)
- [配置参考](docs/CONFIG.md)
- [PWA 安装指南](docs/PWA.md)
- [测试指南](docs/TESTING.md)
- [脚本指南](docs/SCRIPTS.md)
- [Proxy 包 README](apps/proxy/README.md)
- [Relay 包 README](apps/relay/README.md)
- [发布说明](PUBLISHING.md)
- [Changelog](CHANGELOG.md)

## 许可证

MIT
