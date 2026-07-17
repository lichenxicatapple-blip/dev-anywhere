# VPS 部署

本指南用于把 DEV Anywhere 长期运行在自己的 VPS 上。只想先体验功能时，使用 [Quick Tunnel](../README.md#方式一quick-tunnel体验) 即可，不需要 VPS、域名或 Cloudflare 账号。

## 准备工作

部署前需要：

- 一台有公网 IPv4 的 Linux VPS；
- 一个已经将 `A` 记录指向该 VPS 的域名；
- 可以通过 SSH 密钥登录，并能执行 `sudo` 的账户；
- 对公网开放的 `80` 和 `443` 端口；
- 本地安装 Git。

部署脚本支持使用 `apt-get` 或 `yum` 的发行版。缺少 Docker、Nginx 或 Certbot 时会自动安装，Docker Compose 必须为 v2。

先确认 DNS 已经生效：

```bash
dig +short dev-anywhere.example.com
```

输出应包含 VPS 的公网 IP。HTTPS 证书依赖正确的 DNS 记录。

## 部署 Relay

在本地电脑拉取仓库：

```bash
git clone https://github.com/lichenxicatapple-blip/dev-anywhere.git
cd dev-anywhere
```

通过 SSH 部署到 VPS：

```bash
bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  dev-anywhere.example.com
```

非 `root` 账户也可以使用，只要它能够免交互执行 `sudo`：

```bash
bash scripts/deploy/install-relay.sh \
  --ssh deploy@your-vps \
  dev-anywhere.example.com
```

如果仓库已经位于 VPS，可以直接在服务器上执行：

```bash
sudo bash scripts/deploy/install-relay.sh dev-anywhere.example.com
```

脚本会配置 Docker、Nginx 与 HTTPS，启动 Relay 容器，并请求公网健康检查。Relay 只监听 VPS 的 `127.0.0.1:3100`，公网流量由 Nginx 通过 HTTPS 转发。

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
      "url": "wss://dev-anywhere.example.com",
      "proxyToken": "部署输出中的 RELAY_PROXY_TOKEN"
    }
  }
}
```

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
https://dev-anywhere.example.com/
```

首次访问时，在设置中填写 `RELAY_CLIENT_TOKEN`。也可以在受信任设备上打开一次带 Token 的地址：

```text
https://dev-anywhere.example.com/#/?relayToken=你的_RELAY_CLIENT_TOKEN
```

页面会把 Token 保存到当前浏览器。带 Token 的 URL 等同于登录凭据，不要放进截图、聊天记录或公开书签。

如果手头只有开发机配置中的 Proxy Token，可以读取 Relay 当前的 Client Token：

```bash
dev-anywhere relay token --relay cloud
```

## 验证部署

检查公网入口：

```bash
curl -fsS https://dev-anywhere.example.com/health
```

响应应为 JSON，且 `status` 为 `ok`。

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
  dev-anywhere.example.com
npm install -g @dev-anywhere/proxy@latest
dev-anywhere serve restart --relay cloud
```

部署脚本会复用 `/opt/dev-anywhere/.env` 中已有的 Token。

需要固定版本时，在同一个终端执行：

```bash
VERSION=x.y.z
IMAGE_TAG="$VERSION" bash scripts/deploy/install-relay.sh \
  --ssh root@your-vps \
  dev-anywhere.example.com
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

1. `dig` 是否返回正确的 VPS IP；
2. `curl https://域名/health` 是否成功；
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

第二条命令会永久删除 Relay 数据。Nginx 配置和 Let's Encrypt 证书由宿主机管理，不会随 Docker volume 一起删除。

## 安全边界

- Relay 可以读取经过自己的终端、消息、文件和语音流量，应部署在受信任的服务器上。
- `RELAY_PROXY_TOKEN` 和 `RELAY_CLIENT_TOKEN` 都是持有者凭据；泄露后需要重新生成，并更新 VPS、开发机和浏览器。
- Proxy 以开发机当前用户的权限运行，远程操作具备该用户原有的文件和进程权限。
- `Always Yes` 与跳过审批模式会扩大误操作的影响范围。
- 不要把 Relay 的 `3100` 端口直接暴露到公网，公网入口应始终经过 HTTPS Nginx。
