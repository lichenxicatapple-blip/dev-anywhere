# VPS 部署

本指南用于把 DEV Anywhere 长期运行在自己的 VPS 上。只想先体验功能时，使用 [Quick Tunnel](../README.md#方式一quick-tunnel体验) 即可，不需要 VPS、域名或 Cloudflare 账号。

## 准备工作

部署前需要：

- 一台有公网 IPv4 的 Linux VPS；
- 可以通过 SSH 密钥登录，并能执行 `sudo` 的账户；
- 对公网开放的 `80` 和 `443` 端口；
- 本地安装 Git。

公网入口可以直接使用 VPS 的 IPv4 地址，也可以使用一个已经将 `A` 记录指向该 VPS 的域名。两种方式都只提供 HTTPS/WSS，不会把应用直接暴露在 HTTP 上。

部署脚本支持使用 `apt-get` 或 `yum` 的发行版。缺少 Docker、Nginx 或 Certbot 时会自动安装，Docker Compose 必须为 v2。公网 IP 模式需要 Certbot 5.4 或更高版本；系统版本过低时，脚本会在独立虚拟环境中安装新版本，这要求系统提供 Python 3.10 或更高版本。

使用域名时，先确认 DNS 已经生效：

```bash
dig +short dev-anywhere.example.com
```

输出应包含 VPS 的公网 IP。直接使用公网 IP 时不需要 DNS 或域名。

## 配置 SSH 免密登录

从本地执行部署脚本前，需要确保本机可以通过 SSH 密钥登录 VPS。下文使用 `203.0.113.10` 代表 VPS 的公网 IPv4，使用 `dev-anywhere.example.com` 代表指向 VPS 的域名。两者都是文档专用的示例地址，不会指向真实服务器；执行命令前必须替换为自己的实际地址。

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

在本地电脑拉取仓库：

```bash
git clone https://github.com/lichenxicatapple-blip/dev-anywhere.git
cd dev-anywhere
```

可以先检查目标 VPS 是否满足部署条件。最后一个参数使用计划中的公网入口：

```bash
bash scripts/deploy/check-prerequisite.sh root@your-vps 203.0.113.10
```

通过 SSH 部署到 VPS。直接使用公网 IP：

```bash
bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  203.0.113.10
```

使用域名：

```bash
bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  dev-anywhere.example.com
```

也可以将 `root@your-vps` 换成其他 SSH 账户，例如 `deploy@your-vps`，但该账户必须能够免交互执行 `sudo`。

上述命令会从本地电脑通过 SSH 完成部署。如果你选择直接操作服务器，也可以先登录 VPS、克隆仓库，然后在仓库目录中执行：

```bash
sudo bash scripts/deploy/install-relay.sh dev-anywhere.example.com
```

脚本会识别最后一个参数是域名还是公网 IP，配置 Docker、Nginx 与对应的 HTTPS 证书，启动 Relay 容器，并请求公网健康检查。Relay 只监听 VPS 的 `127.0.0.1:3100`，公网流量由 Nginx 通过 HTTPS 转发；`80` 端口仅响应证书验证并跳转到 HTTPS。

[公网 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)的有效期为六天。脚本会创建每天运行两次的续期任务，并在证书更新后重新加载 Nginx。域名证书沿用系统 Certbot 的状态目录；公网 IP 证书使用 `/opt/dev-anywhere/certbot-ip` 中的独立状态和续期任务，不会接管同一台 VPS 上其他站点的证书。

部署成功后，终端会打印：

- Web 地址；
- `RELAY_PROXY_TOKEN`，供开发机连接 Relay；
- `RELAY_CLIENT_TOKEN`，供浏览器访问 Web；
- 开发机配置示例。

两个 Token 也会保存在 VPS 的 `/opt/dev-anywhere/.env` 中。它们都是访问凭据，不要公开传播。

## 连接开发机

在运行 Claude Code、Codex 或 Shell 的开发机上安装 Proxy：

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

如果 Claude Code 或 Codex 不在普通的 `PATH` 中，将下面的字段合并到配置顶层：

```json
{
  "agentCli": {
    "claudeBin": "/absolute/path/to/claude",
    "codexBin": "/absolute/path/to/codex"
  }
}
```

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

升级到最新版本：

```bash
git pull --ff-only
bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  203.0.113.10
npm install -g @dev-anywhere/proxy@latest
dev-anywhere serve restart --relay cloud
```

部署脚本会复用 `/opt/dev-anywhere/.env` 中已有的 Token。

升级命令的最后一个参数应与首次部署保持一致：首次使用域名就继续传域名，首次使用公网 IP 就继续传公网 IP。

需要固定版本时，在同一个终端执行：

```bash
VERSION=x.y.z
IMAGE_TAG="$VERSION" bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  203.0.113.10
npm install -g "@dev-anywhere/proxy@$VERSION"
dev-anywhere serve restart --relay cloud
```

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
