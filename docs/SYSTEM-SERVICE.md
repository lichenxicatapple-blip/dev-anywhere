# 无需桌面登录运行开发机

本指南适用于已安装并配置 DEV Anywhere 的开发机。启用后，Proxy 会在开机时以你的用户账户运行，新建的 Shell 和 Agent 会话可以在退出桌面登录后继续使用。支持 macOS、使用 systemd 的 Linux，以及 Windows。

## 启用系统服务

先按[开发机配置步骤](./DEPLOYMENT.md#连接开发机)配置 Relay，确认 `dev-anywhere serve start` 能正常连接。Relay 地址、Token 和 Agent CLI 路径应写入配置文件；仅在当前终端生效的配置无法用于开机启动。

在你平时使用 DEV Anywhere 的账户下执行：

```bash
dev-anywhere serve autostart enable --system --now
dev-anywhere serve autostart status --system
dev-anywhere serve status
```

`--now` 会立即启动系统服务并重启当前 Proxy。`serve status` 显示 `Manager: system service` 和 `Service: ready` 表示已启动成功。需要在退出桌面后继续使用的 Shell 或 Agent 会话，请在启用服务后新建；启用前的会话可能随桌面退出而结束。

只设置下一次开机启动、不立即重启 Proxy 时，省略 `--now`：

```bash
dev-anywhere serve autostart enable --system
```

当前 Proxy 会继续运行，新设置从下次开机起生效。

使用其他 profile 时，将 `--profile 名称` 放在 `serve` 前，例如：

```bash
dev-anywhere --profile work serve autostart enable --system --now
```

设置只对所选 profile 生效。启用系统服务后，该 profile 原来的登录自启动会自动取消。

### macOS 和 Linux

安装和取消服务时，命令会按需提示输入 `sudo` 密码。

### Windows

按提示允许管理员授权。首次安装还需要输入当前账户的密码，Windows Hello PIN 不适用；后续启用无需重复输入。

账户密码改变后，在 Windows“服务”中找到 `serve autostart status --system` 输出的服务名称，在“登录”页更新密码。

## 平时如何启停

继续使用原来的命令：

```bash
dev-anywhere serve stop
dev-anywhere serve start
dev-anywhere serve restart
dev-anywhere serve restart --relay cloud
```

`serve stop` 会停止 Proxy，下次开机仍会自动启动。手动重启和自动更新不影响系统服务设置。

## 验证退出登录后的连接

1. 确认 `serve status` 显示 `Manager: system service` 和 `Service: ready`。
2. 在手机或另一台电脑的浏览器中新建一个 Shell，运行 `whoami`；应显示配置服务时的用户。
3. 退出开发机的桌面登录，保持机器开机和联网。
4. 在远端继续操作刚创建的 Shell，并新建另一个会话，确认原会话和新会话都可用。
5. 重启开发机，在不登录桌面的情况下再次验证连接。

开发机需保持开机、联网且不进入睡眠。启用了 FileVault 等磁盘加密时，重启后可能需要先解锁磁盘。依赖桌面窗口、登录钥匙串或桌面 SSH agent 的工具，可能仍需要登录或额外配置。

## 取消或切回登录自启动

只取消之后的开机启动：

```bash
dev-anywhere serve autostart disable --system
```

当前 Proxy 会继续运行。需要同时停止时，再执行 `dev-anywhere serve stop`。

切回登录后自动启动：

```bash
dev-anywhere serve autostart enable
```

按提示完成管理员授权后，从下次开机起，Proxy 会在登录桌面后启动。

## 服务没有启动时

先运行 `dev-anywhere serve autostart status --system`，记录输出的服务名称。再检查 `dev-anywhere serve status` 和当前 profile 的日志（默认 `~/.dev-anywhere/logs/service.log`）。

- macOS：使用 `launchctl print system/服务名称` 查看状态和上次退出原因。
- Linux：使用 `systemctl status 服务名称.service` 和 `journalctl -u 服务名称.service` 查看启动错误。
- Windows：在“服务”中按名称查看状态；检查该 profile 的 `logs/system-service.log`。若提示登录失败，检查服务账户密码及“作为服务登录”权限。

如果移动过 Node 或 DEV Anywhere 的安装目录，请重新运行启用命令并重启电脑。

重试启动：

```bash
dev-anywhere serve autostart enable --system --now
```
