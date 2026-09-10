# VPS 部署

本指南用于把 DEV Anywhere 长期运行在自己的 VPS 上。只想先体验功能时，使用 [Quick Tunnel](../README.md#方式一quick-tunnel体验) 即可，不需要 VPS、域名或 Cloudflare 账号。

## 准备工作

部署前需要：

- 一台有公网 IPv4 的 Linux VPS；
- VPS 的 root 账户，或能执行 `sudo` 的普通账户；
- 对公网开放的 `80` 和 `443` 端口；
- 直接在 VPS 部署时需要 Bash 和 `curl`；从本地部署时，macOS/Linux 使用 Bash、`curl` 和 SSH，Windows 使用原生 PowerShell 和 OpenSSH 客户端。

公网入口可以直接使用 VPS 的 IPv4 地址，也可以使用一个已经将 `A` 记录指向该 VPS 的域名。两种方式都只提供 HTTPS/WSS，不会把应用直接暴露在 HTTP 上。

无需安装 Git 或克隆仓库。macOS、Linux 和 Windows 都可以发起 SSH 部署；运行 Relay 的 VPS 仍须为 Linux。

部署脚本支持使用 `apt-get` 或 `yum` 的发行版。缺少 Docker、Nginx 或 Certbot 时会自动安装，Docker Compose 必须为 v2。公网 IP 模式需要 Certbot 5.4 或更高版本；系统版本过低时，脚本会在独立虚拟环境中安装新版本，这要求系统提供 Python 3.10 或更高版本。

使用域名时，先确认 DNS 已经生效：

```bash
dig +short dev-anywhere.example.com
```

输出应包含 VPS 的公网 IP。直接使用公网 IP 时不需要 DNS 或域名。

## 配置 SSH 免密登录

从本地发起部署前，需要确保本机可以通过 SSH 密钥登录 VPS。直接登录 VPS 部署时可跳过本节。下文使用 `203.0.113.10` 代表 VPS 的公网 IPv4，使用 `dev-anywhere.example.com` 代表指向 VPS 的域名。两者都是文档专用的示例地址；执行命令前必须替换为自己的实际地址。

如果本机还没有 SSH 密钥，先生成一对密钥：

```bash
ssh-keygen -t ed25519
```

将 `~/.ssh/id_ed25519.pub` 的内容添加到云服务商提供的 SSH 公钥配置中，或写入 VPS 登录账户的 `~/.ssh/authorized_keys`。系统提供 `ssh-copy-id` 时，也可以直接上传：

```bash
ssh-copy-id root@203.0.113.10
```

确认本地可以在不输入密码的情况下执行远程命令：

```bash
ssh -o BatchMode=yes root@203.0.113.10 'echo SSH ready'
```

看到 `SSH ready` 后即可继续。使用普通账户时，该账户还必须能够免交互执行 `sudo`。

## 部署 Relay

根据当前使用的终端，选择下面一种方式。最后的公网入口可使用域名，也可直接使用 VPS 的公网 IPv4。

### 直接在 VPS 上运行

以 root 登录 Linux VPS 后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.sh | bash -s -- dev-anywhere.example.com
```

使用普通账户时，让 `sudo` 执行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.sh | sudo bash -s -- dev-anywhere.example.com
```

### 从 macOS 或 Linux 本地部署

在本地终端执行，替换 SSH 目标和公网入口：

```bash
curl -fsSL https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.sh | bash -s -- --ssh root@203.0.113.10 dev-anywhere.example.com
```

也可以将 SSH 目标换成普通账户，例如 `deploy@203.0.113.10`，但该账户必须能够免交互执行 `sudo`。

### 从 Windows PowerShell 本地部署

在原生 PowerShell 中执行，无需 Bash 或 WSL：

```powershell
irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1 | iex
```

按提示输入 SSH 目标（例如 `root@203.0.113.10`）和公网域名/IP。也可以直接传入参数：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1))) -SshTarget root@203.0.113.10 -PublicHost dev-anywhere.example.com
```

### 确认部署结果

脚本会识别最后一个参数是域名还是公网 IP，配置 Docker、Nginx 与对应的 HTTPS 证书，启动 Relay 容器，并请求公网健康检查。Relay 只监听 VPS 的 `127.0.0.1:3100`，公网流量由 Nginx 通过 HTTPS 转发；`80` 端口仅响应证书验证并跳转到 HTTPS。

[公网 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)的有效期为六天。脚本会创建每天运行两次的续期任务，并在证书更新后重新加载 Nginx。域名证书沿用系统 Certbot 的状态目录；公网 IP 证书使用 `/opt/dev-anywhere/certbot-ip` 中的独立状态和续期任务，不会接管同一台 VPS 上其他站点的证书。

部署成功后，终端会打印：

- Web 地址；
- `RELAY_PROXY_TOKEN`，供开发机连接 Relay；
- `RELAY_CLIENT_TOKEN`，供浏览器访问 Web；
- 开发机配置示例。

两个 Token 也会保存在 VPS 的 `/opt/dev-anywhere/.env` 中。它们都是访问凭据，不要公开传播。

## 连接开发机

开发机支持 macOS、Linux 和原生 Windows 11，Windows 无需安装 WSL。在运行 Claude Code、Codex、Kimi Code 或 Shell 的开发机上安装 Proxy：

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
```

编辑 `~/.dev-anywhere/config.json`（Windows 为 `%USERPROFILE%\.dev-anywhere\config.json`）：

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

使用域名时，将 `url` 改为 `wss://dev-anywhere.example.com`。部署脚本会在结束时打印与当前入口匹配的完整配置示例。

让 Proxy 在后台连接 Relay：

```bash
dev-anywhere serve start --relay cloud
dev-anywhere serve status
```

`status` 应显示 Relay 已连接。默认 profile 的服务日志位于 `~/.dev-anywhere/logs/service.log`。

如果 DEV Anywhere 没有自动识别某个 CLI，可以在新建会话时选择它的可执行文件，也可以将对应路径写入配置顶层：

```json
{
  "agentCli": {
    "claudeBin": "/absolute/path/to/claude",
    "codexBin": "/absolute/path/to/codex",
    "kimiBin": "/absolute/path/to/kimi"
  }
}
```

也可以分别使用 `CLAUDE_BIN`、`CODEX_BIN` 和 `KIMI_BIN` 临时覆盖这些路径。

Kimi Code 同时支持终端与 ACP 聊天会话。可以运行 `dev-anywhere kimi ...` 接管原生终端，也可以在 Web 中新建终端或聊天会话；ACP 聊天支持流式输出、工具调用与审批、取消当前回合和恢复历史会话。

### 可选：登录后自动启动

配置好 Relay 后，可以设置登录系统时自动启动 Proxy：

```bash
dev-anywhere serve autostart enable
dev-anywhere serve autostart status
```

取消自动启动：

```bash
dev-anywhere serve autostart disable
```

这些设置只影响之后的登录，不会启动、重启或停止当前 Proxy。支持 macOS、提供 systemd 用户服务的 Linux，以及 Windows。使用其他 profile 时，将 `--profile 名称` 放在 `serve` 前。

### 可选：无需桌面登录的系统服务

macOS、systemd Linux 和 Windows 开发机可使用系统服务，在开机后、尚未登录桌面时连接 Relay：

```bash
dev-anywhere serve autostart enable --system --now
dev-anywhere serve autostart status --system
dev-anywhere serve status
```

安装时请求管理员权限，服务使用你的用户账户运行。`--now` 会重启 Proxy 并立即生效；省略时只设置下一次开机启动。Windows 首次安装还需要账户密码。退出桌面后需要继续使用的会话，请在启用服务后新建。配置、验证和取消方式见[系统服务指南](./SYSTEM-SERVICE.md)。

## 连接浏览器

打开部署后的 Web 地址：

```text
https://203.0.113.10/
```

使用域名时打开 `https://dev-anywhere.example.com/`。

首次访问时，在“设置 → Relay Token”中填写 `RELAY_CLIENT_TOKEN`。页面会将 Token 保存在当前浏览器中，以后无需重复填写。

如果手头只有开发机配置中的 Proxy Token，可以读取 Relay 当前的 Client Token：

```bash
dev-anywhere relay token --relay cloud
```

## 验证部署

检查公网入口：

```bash
curl -fsS https://203.0.113.10/health
```

使用域名时将地址替换为自己的域名。响应应为 JSON，且 `status` 为 `ok`。

检查开发机连接：

```bash
dev-anywhere serve status
```

检查 VPS 容器：

```bash
ssh root@your-vps \
  'cd /opt/dev-anywhere && docker compose ps'
```

`dev-anywhere-relay` 应处于运行和健康状态。最后在 Web 中确认能够看到开发机，并创建一个 Shell 会话。

## 升级

> **历史版本迁移：** 仍使用 0.9.2 之前版本时，需要先用旧 CLI 在每台开发机执行 `dev-anywhere serve stop`，再升级 Relay，最后手动安装 `@dev-anywhere/proxy@latest` 并启动 Proxy。此次迁移会结束旧终端会话，更新后需重新启动。背景见 [0.9.2 升级说明](../CHANGELOG.md#092---2026-09-05)。

重新执行对应平台的 [部署命令](#部署-relay)，即可拉取最新发布的 Relay 镜像。SSH 目标与公网域名/IP 应与首次部署一致。例如从 macOS/Linux 本地升级：

```bash
curl -fsSL https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.sh | bash -s -- --ssh root@203.0.113.10 dev-anywhere.example.com
```

Windows PowerShell 仍使用同一个入口，并填写原来的 SSH 目标与公网入口：

```powershell
irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1 | iex
```

脚本默认拉取 `latest` 镜像，并复用 `/opt/dev-anywhere/.env` 中已有的 Token。通过 npm 全局安装的 Proxy 默认开启自动更新，会跟随 Relay 的新版本完成升级并重新连接。完成后刷新浏览器，并运行 `dev-anywhere serve status` 确认版本及连接状态。

如果开发机设置了 `"autoUpdate": false`，请在该开发机上先执行 `dev-anywhere serve stop`，再运行 `npm install -g @dev-anywhere/proxy@latest` 和 `dev-anywhere serve start --relay cloud`。

### 固定版本

将 `x.y.z` 替换为需要的发布版本。在 macOS/Linux 本地终端执行；`IMAGE_TAG` 必须传给管道右侧的安装脚本：

```bash
VERSION=x.y.z
curl -fsSL https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.sh | env IMAGE_TAG="$VERSION" bash -s -- --ssh root@203.0.113.10 dev-anywhere.example.com
```

Windows PowerShell：

```powershell
$env:IMAGE_TAG = "x.y.z"
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/main/install.ps1))) -SshTarget root@203.0.113.10 -PublicHost dev-anywhere.example.com
Remove-Item Env:IMAGE_TAG
```

若需固定开发机版本，在 `~/.dev-anywhere/config.json` 顶层设置 `"autoUpdate": false`，然后停止 Proxy，运行 `npm install -g @dev-anywhere/proxy@x.y.z` 并重新启动。Proxy 自动更新只会升级，不会随 Relay 自动降级；回退版本时需要手动安装匹配的 Proxy。

## 排障

查看 Relay 日志：

```bash
ssh root@your-vps \
  'cd /opt/dev-anywhere && sudo docker compose logs -f relay'
```

检查 Nginx：

```bash
ssh root@your-vps \
  'sudo nginx -t && sudo systemctl status nginx --no-pager'
```

查看开发机日志：

```bash
tail -f ~/.dev-anywhere/logs/service.log
```

Windows PowerShell 使用：

```powershell
Get-Content "$env:USERPROFILE\.dev-anywhere\logs\service.log" -Tail 50 -Wait
```

自动升级异常记录在 `~/.dev-anywhere/logs/auto-update.log`。

连接失败时依次检查：

1. 使用域名时，`dig` 是否返回正确的 VPS IP；
2. `curl https://域名或公网IP/health` 是否成功；
3. Relay 容器是否健康；
4. `dev-anywhere serve status` 是否连接到预期 Relay；
5. 开发机是否使用 Proxy Token，浏览器是否使用 Client Token；
6. VPS 防火墙或云安全组是否开放 `80/443`。

## 数据与卸载

部署文件和 Token 位于 `/opt/dev-anywhere`，Relay 持久数据位于 Docker 的 `relay-data` volume。

停止服务并保留数据：

```bash
ssh root@your-vps \
  'cd /opt/dev-anywhere && sudo docker compose down'
```

删除容器和 Relay 数据：

```bash
ssh root@your-vps \
  'cd /opt/dev-anywhere && sudo docker compose down -v'
```

第二条命令会永久删除 Relay 数据。Nginx 配置和 Let's Encrypt 证书由宿主机管理，不会随 Docker volume 一起删除。域名证书通常位于 `/etc/letsencrypt`；公网 IP 证书位于 `/opt/dev-anywhere/certbot-ip`。

## 安全边界

- Relay 可以读取经过自己的终端、消息、文件和语音流量，应部署在受信任的服务器上。
- `RELAY_PROXY_TOKEN` 和 `RELAY_CLIENT_TOKEN` 都是持有者凭据；泄露后需要重新生成，并更新 VPS、开发机和浏览器。
- Proxy 以开发机当前用户的权限运行，远程操作具备该用户原有的文件和进程权限。
- `Always Yes` 与跳过审批模式会扩大误操作的影响范围。
- 不要把 Relay 的 `3100` 端口直接暴露到公网，公网入口应始终经过 HTTPS Nginx。
