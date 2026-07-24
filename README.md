<div align="center">
  <img src="./apps/web/public/brand-icon.svg" width="96" alt="DEV Anywhere 标志">
  <h1>DEV Anywhere</h1>
  <p>在浏览器中创建、接管和管理开发机上的 Claude Code、Codex 与 Shell 会话。</p>
  <p>
    <a href="./README.en.md">English</a>
    ·
    <a href="#快速开始">快速开始</a>
    ·
    <a href="./docs/DEPLOYMENT.md">VPS 部署</a>
  </p>
  <p>
    <a href="https://www.npmjs.com/package/@dev-anywhere/proxy"><img src="https://img.shields.io/npm/v/@dev-anywhere/proxy?label=npm" alt="npm 版本"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 许可证"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node.js 20 或更高版本">
  </p>
</div>

![DEV Anywhere 桌面端会话界面](./docs/assets/readme-hero-web.gif)

## 这是什么

DEV Anywhere 是一个自托管的远程 AI coding 工作台。你可以在任意设备的浏览器中，继续操作开发机终端里正在运行的 Claude Code 或 Codex，也可以恢复历史会话、远程启动新的 coding agent，或者直接使用 Shell。

想让本地启动的 Claude Code 或 Codex 随时能在浏览器中继续操作，只需在原命令前加上 `dev-anywhere`。除了多了这个前缀，其他都和你原来的开发体验完全一致；但启动后，对应会话会出现在 DEV Anywhere 的 Web 界面里，方便你随时随地继续开发。你也可以直接从 Web 创建新的 coding agent 会话。

DEV Anywhere 直接围绕远程 coding agent 工作流设计。除了查看 coding agent 的输出，你还可以跟踪运行状态、处理工具审批、上传或下载文件、搜索历史输出，并在任务完成时接收浏览器通知。代码仓库、coding agent CLI 和模型凭据仍然留在开发机上。

> **为什么做这个？**
>
> 离开电脑后，我还是想通过开发机上的 coding agent 继续 vibe coding。我想在吃饭时 🍜 看看 coding agent 干到哪了，坐在马桶上 🚽 顺手处理一次审批；甚至在开车使用辅助驾驶时，也能通过语音交互 🎙️ 听取结果、下达指令。能在任意位置进行 AI coding，就是我开发这个项目的初心。

## 快速开始

### 前置条件

在开发机上安装 [Node.js 20 或更高版本](https://nodejs.org/zh-cn/download)，npm 会随 Node.js 一起安装。可以用以下命令确认环境：

```bash
node --version
npm --version
```

如果要创建 coding agent 会话，还需要提前安装并登录 Claude Code 或 Codex。只使用 Shell 时可以跳过这一步。

### 1. 安装本地 Proxy

在开发机上安装 DEV Anywhere：

```bash
npm install -g @dev-anywhere/proxy
```

### 2. 建立连接

DEV Anywhere 提供两种连接方式。VPS（Virtual Private Server，虚拟专用服务器）是一台可通过公网访问的云服务器。

| 方式                              | 适合场景           | 需要准备                   |
| --------------------------------- | ------------------ | -------------------------- |
| Quick Tunnel                      | 首次体验、临时使用 | Node.js 20+、`cloudflared` |
| [VPS Relay](./docs/DEPLOYMENT.md) | 长期使用、稳定访问 | 有公网 IP 的 Linux VPS     |

#### 方式一：Quick Tunnel（体验）

Quick Tunnel 是给没有 VPS、又想先实际跑起来看一眼的用户准备的。它会在开发机上启动临时 Relay、Web 和 Proxy，再通过 Cloudflare 生成一个无需账号的随机 HTTPS 地址。

macOS 可以使用 Homebrew 安装 `cloudflared`：

```bash
brew install cloudflared
```

其他平台参见 Cloudflare 的 [`cloudflared` 安装说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)。

在开发机上启动临时链路：

```bash
dev-anywhere tunnel
```

首次运行会自动初始化 `~/.dev-anywhere`，不需要手动配置 Relay。

公网连通性检查通过后，命令会打印一个包含临时 Client Token 的访问地址。保持命令运行，在浏览器中打开该地址即可。按 `Ctrl+C` 会同时停止 Proxy、Relay 和隧道。

Quick Tunnel 的随机域名会变化，进程退出后地址立即失效，也没有可用性承诺。它适合体验，不适合长期依赖。

#### 方式二：VPS Relay（推荐）

长期使用时，推荐在有公网 IP 的 Linux VPS 上部署 Relay。你可以直接使用 VPS 的公网 IPv4，也可以使用指向该 VPS 的域名；部署脚本会识别两种入口并自动配置对应的 HTTPS 证书。公网环境只通过 HTTPS/WSS 提供服务，HTTP 端口仅用于证书验证和跳转。一个 Relay 容器会同时托管 Web、HTTP API、文件、语音和 WebSocket 服务。

部署 Relay 后，在开发机上初始化 DEV Anywhere：

```bash
dev-anywhere init
```

编辑 `~/.dev-anywhere/config.json`，填入 Relay 地址和部署脚本输出的 `RELAY_PROXY_TOKEN`：

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
      "url": "wss://203.0.113.10",
      "proxyToken": "部署输出中的 RELAY_PROXY_TOKEN"
    }
  }
}
```

使用域名时，将 `url` 换成 `wss://你的域名`。部署脚本会输出与当前入口匹配的配置示例。

让开发机连接 Relay：

```bash
dev-anywhere serve start --relay cloud
dev-anywhere serve status
```

打开部署脚本输出的 Web 地址，首次访问时在“设置 → Relay Token”中填写 `RELAY_CLIENT_TOKEN`。

部署、升级和排障步骤见 [VPS 部署指南](./docs/DEPLOYMENT.md)。

### 3. 启动或接管会话

连接建立后，可以在浏览器中接管开发机终端里启动的 coding agent 会话，或直接启动新会话。

#### 从浏览器接管开发机终端中的会话

启动 Claude Code 或 Codex 时，只需在原命令前加上 `dev-anywhere`：

例如，原来运行 `claude --permission-mode plan`，接入后只需改为 `dev-anywhere claude --permission-mode plan`。除了增加 `dev-anywhere` 前缀，CLI 参数和本地终端的使用体验保持不变，之后还可以在 Web 中继续同一个会话。

本地启动的 DEV Anywhere 会话会自动连接 Proxy，无需手动启动 Proxy 服务。

**使用 VPS Relay 部署时**

```bash
dev-anywhere claude
dev-anywhere codex
```

**使用 Quick Tunnel 时**

保持 `dev-anywhere tunnel` 运行，并在另一个终端执行：

```bash
dev-anywhere --profile quick-tunnel claude
dev-anywhere --profile quick-tunnel codex
```

#### 从浏览器启动新会话

打开 DEV Anywhere，选择开发机后点击“新建”，即可在该开发机的指定目录中启动 Claude Code、Codex 或 Shell。

## 主要功能

### 会话管理

- 直接从浏览器创建 Claude Code、Codex 和 Shell 会话。
- 创建 coding agent 会话时，可以选择工作目录、终端或聊天交互方式，以及权限模式。
- 接入从本地终端启动的会话，也可以恢复历史会话。
- 重命名、终止或分离会话；托管终端在 Proxy 重启后可以重新连接。
- 在多台开发机之间切换，并查看、断开当前连接到 Relay 的客户端。

![从浏览器创建真实 coding agent 会话](./docs/assets/readme-create-session.gif)

### 终端与聊天视图

**终端视图**直接呈现 CLI 的原始界面，保留颜色、光标、键盘交互和全屏程序。**聊天视图**将 coding agent 输出、工具调用、审批和最终回复整理为更易阅读和触摸操作的消息。

![DEV Anywhere 的终端与聊天视图](./docs/assets/readme-session-modes.gif)

### 审批、搜索与文件

- 实时显示会话的工作、空闲、等待审批和连接状态。
- 在页面中处理工具审批；`Always Yes` 可以为指定会话自动确认后续审批。
- 开启“会话空闲通知”后，coding agent 完成工作并进入空闲状态时，浏览器会发送提醒。
- 使用 `Cmd/Ctrl + F` 或菜单入口搜索终端与聊天记录，并定位到命中位置。
- 通过文件选择器、拖放或剪贴板上传图片和文件；点击 coding agent 输出中的文件路径，可以直接在浏览器中预览图片或下载文件。

![PTY 会话中的审批、搜索与文件下载](./docs/assets/readme-workflow.gif)

### Voice Pilot

Voice Pilot 面向不方便持续盯着或操作屏幕的场景。开启后，它会监听你的语音；你说完后，识别结果会自动发送给 coding agent，coding agent 回复后，Voice Pilot 会自动播报回复内容。你还可以通过语音处理权限审批、生成阶段性总结或复述上一条回复。说“退出语音助手”等自然表达即可退出，需要精细编辑时仍可使用键盘或触摸操作。

![Voice Pilot 真实交互](./docs/assets/readme-voice-pilot.gif)

### 跨设备访问

DEV Anywhere 支持桌面、Android、iPhone 和 iPad。移动端界面针对触摸选择、软键盘、终端辅助键、文件操作和会话创建进行了适配；针对 iPad 搭配妙控键盘等实体键盘的使用场景，也做了专门适配。

<table>
  <tr>
    <td width="56%"><strong>iPad · Safari</strong></td>
    <td width="22%"><strong>Android · Chrome</strong></td>
    <td width="22%"><strong>iPhone · Safari</strong></td>
  </tr>
  <tr>
    <td><img src="./docs/assets/readme-ipad-safari.png" alt="iPad Safari 上的 DEV Anywhere" /></td>
    <td><img src="./docs/assets/readme-android-chrome.jpg" alt="Android Chrome 上的 DEV Anywhere" /></td>
    <td><img src="./docs/assets/readme-iphone-safari.png" alt="iPhone Safari 上的 DEV Anywhere PTY" /></td>
  </tr>
</table>

## 工作方式

```mermaid
flowchart LR
  subgraph clients["浏览器"]
    direction TB
    desktop["桌面"]
    phone["手机"]
    tablet["平板"]
  end

  relay["Relay<br/>Web · 认证 · 实时转发<br/>文件 · 语音"]

  subgraph machine["开发机"]
    direction TB
    proxy["Proxy<br/>会话 · 终端 · 文件"]
    agent["Claude Code / Codex"]
    shell["Shell"]
    local["代码仓库 · CLI 配置 · 本地权限"]

    proxy --> agent
    proxy --> shell
    agent --> local
    shell --> local
  end

  desktop -->|"HTTPS / WSS"| relay
  phone -->|"HTTPS / WSS"| relay
  tablet -->|"HTTPS / WSS"| relay
  relay <-->|"会话与终端数据"| proxy
```

- **Web 客户端**：提供会话列表、终端与聊天界面、审批、文件操作和 Voice Pilot。
- **Relay**：托管 Web，认证并转发浏览器与开发机之间的实时流量。
- **Proxy**：运行在开发机上，管理 coding agent、终端、会话历史和文件访问。
- **Coding agent / Shell**：继续使用开发机上的 CLI、环境变量、仓库和本地权限。

代码仓库和 coding agent 进程都留在开发机上。Relay 服务器会转发终端、消息、文件和语音数据，并且能够读取这些内容，因此必须部署在受信任的服务器上。当前版本不提供端到端加密。

## 平台支持

| 平台    | 系统版本   | 浏览器                       |
| ------- | ---------- | ---------------------------- |
| macOS   | 26+        | Chrome、Edge、Safari         |
| Windows | 11+        | Chrome、Edge                 |
| Android | 16+        | Chrome、Edge                 |
| iPhone  | iOS 26+    | Safari、Chrome、Edge         |
| iPad    | iPadOS 26+ | Safari；暂不支持第三方浏览器 |

## 安全边界

- Coding agent 与 Shell 以开发机当前用户的权限运行。DEV Anywhere 不提供沙箱隔离。
- `RELAY_PROXY_TOKEN` 用于认证开发机，写入 `~/.dev-anywhere/config.json` 中对应 Relay 的 `proxyToken`；`RELAY_CLIENT_TOKEN` 用于认证浏览器，首次访问时填入“设置 → Relay Token”。VPS 部署脚本会生成两者，具体见 [部署指南](./docs/DEPLOYMENT.md#连接开发机)。
- 公网 Relay 服务器必须使用 HTTPS/WSS。Token 是持有者凭据，泄露后应立即轮换。
- Relay 服务器会转发终端、消息、文件和语音数据，应部署在你信任的服务器上。
- 工具审批仍然是重要的安全边界。`Always Yes` 和跳过审批模式会减少确认，也会扩大误操作的影响范围。
- 不要把带 Token 的访问链接发给不受信任的人，也不要将 `~/.dev-anywhere/config.json` 提交到版本库。

## 开发

仓库结构、本地隔离环境、测试矩阵和发布门禁见 [开发指南](./docs/DEVELOPMENT.md)。

## 许可证

[MIT License](./LICENSE)
