# 切阿里云 VPS 部署素材记录 (v0.2.4 / 2026-05-12)

> 原始事件笔记, 不是正式部署文档. 留给未来文档整体重做时直接拿素材用.

## 时间线

1. 用户从腾讯云换到阿里云全新 Ubuntu 22.04 VPS, 域名 + ssh key 文件本身没变
2. `pnpm release 0.2.4` 跑通本地 verification + tag push, GitHub Actions workflow 25727010599 success: 推 docker image 到阿里云 ACR + 发 npm `@dev-anywhere/proxy@0.2.4` / `@dev-anywhere/relay@0.2.4`
3. `IMAGE_TAG=0.2.4 bash scripts/install-relay.sh --ssh dev-anywhere ...` 撞 3 个"惊喜":
   - 旧机器 host key 还在 `~/.ssh/known_hosts`, ssh strict check 拒
   - 公钥不在新 vps `authorized_keys`, ssh `Permission denied (publickey)`
   - `~/.ssh/config` 里 `User ubuntu`, 但阿里云 Ubuntu 镜像默认 ssh user 是 `root`
   - 安全组入方向没放行 80 / 443, certbot LE HTTP-01 challenge timeout
4. 全部解掉后 install-relay.sh 一次跑通, /health 返回 200 + version 0.2.4

## 撞的坑 + 解决方案

### 坑 1: 旧 host key 残留

```
WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!
Offending ECDSA key in /Users/catli/.ssh/known_hosts:10
Host key for dev-anywhere.vita-tools.top has changed and you have requested strict checking.
```

**解**: `ssh-keygen -R <host>` 删 known_hosts 里旧 entry. 第一次 ssh 时 `-o StrictHostKeyChecking=accept-new` 自动信任新 key.

### 坑 2: 公钥不在新 vps authorized_keys

```
Permission denied (publickey).
```

**解**: 通过阿里云控制台 Workbench (web shell, 不需要 ssh) 进 vps, 把本地 `~/.ssh/id_ed25519.pub` 内容追加到 `~/.ssh/authorized_keys`. 或用阿里云"密钥对"功能导入公钥并绑定实例.

### 坑 3: ssh User 不是 ubuntu 而是 root

不同云厂商 + 不同镜像默认 ssh user 不一致, 项目 `~/.ssh/config` 里 `User ubuntu` 是从腾讯云时代留下的, 切阿里云 Ubuntu 22.04 后默认 user 变成 `root`. 几个常见情况 (本项目不假设, 由用户根据自己 vps 实际填):

| 云 / 镜像                | 默认 user        |
| ------------------------ | ---------------- |
| 阿里云 Ubuntu / CentOS   | `root`           |
| AWS Ubuntu / Debian      | `ubuntu` / `admin` |
| AWS Amazon Linux / RHEL  | `ec2-user`       |
| GCP                      | 用户名 (创建时自定义) |
| 自建 / VPS provider      | 看管理员配置      |

**解**: 改 `~/.ssh/config` 的 `User <对应值>`, 或 `--ssh user@host` 显式覆盖. install-relay.sh 和 check-prerequisite.sh 都接受 `user@host` 形式.

### 坑 4: 安全组入方向 80/443 默认关闭

```
Detail: Fetching http://dev-anywhere.vita-tools.top/.well-known/acme-challenge/...:
  Timeout during connect (likely firewall problem)
```

LE HTTP-01 challenge 需要 LE 服务器从公网拉 80 端口的临时文件. 阿里云 ECS 默认安全组只放 22 / 3389, 80 / 443 都关. **必须**手动加入方向规则:

| 协议 | 端口    | 来源      |
| ---- | ------- | --------- |
| TCP  | 80/80   | 0.0.0.0/0 |
| TCP  | 443/443 | 0.0.0.0/0 |

出方向阿里云默认全开, 不用动.

## 自动化 (本次产出)

- `scripts/check-prerequisite.sh <ssh-host> <domain>` — 跑 install-relay.sh 之前 dry-run 检查上面 4 个坑 + docker / docker compose v2 / certbot / DNS 解析. 不修改远端任何东西, 只报告 PASS/WARN/FAIL.

跑完它绿了再跑 install-relay.sh, 能省一轮"撞 → 改 → 重跑"循环.

## 给未来文档重做的提示

1. PUBLISHING.md 里 "VPS deploy" 一节假设 ssh + sudo + docker 都已就绪, 实际新阿里云只有 docker (有时候连 docker 都没). prerequisite 这一段缺.
2. `--ssh <host>` 没说明 user 怎么传, 默认走 ssh config. 应该例子里显式 `--ssh root@host` 加注释 "阿里云 Ubuntu 22.04 镜像默认 root, 不是 ubuntu".
3. 安全组规则没单独章节. 应该独立 "Cloud provider firewall checklist" 章, 列各家云 (阿里云 / 腾讯云 / AWS / GCP) 的入方向规则路径 + 必开端口.
4. `RELAY_PROXY_TOKEN` / `RELAY_CLIENT_TOKEN` 在 `/opt/dev-anywhere/.env` 不存在时 install-relay 会重新生成. 文档应该警示: 旧机器 .env 不带过来, 本地 proxy `~/.dev-anywhere/config.json` 的 `cloud.proxyToken` 也要换. 当前文档只写了 install-relay 末尾 hint, 容易漏.
5. "切换 vps" 这条用户路径 (跟"首次部署"路径并列) 没单独 section. 应该写一条 "Migrating to a new VPS" runbook, 包含本文档 4 个坑.

## 原始命令 (复盘 + 验证用)

```bash
# 1. 删旧 host key
ssh-keygen -R dev-anywhere.vita-tools.top

# 2. 第一次连接信任新 host key
ssh -o StrictHostKeyChecking=accept-new -o User=root dev-anywhere "echo connected"

# 3. dry-run 检查
bash scripts/check-prerequisite.sh root@dev-anywhere.vita-tools.top dev-anywhere.vita-tools.top

# 4. 部署
IMAGE_TAG=0.2.4 bash scripts/install-relay.sh --ssh root@dev-anywhere.vita-tools.top dev-anywhere.vita-tools.top

# 5. 本地 proxy 升级 + 用新 token 重连
npm install -g @dev-anywhere/proxy@0.2.4
# 编辑 ~/.dev-anywhere/config.json relays.cloud.proxyToken = <install-relay 末尾打印的 PROXY_TOKEN>
dev-anywhere serve restart --relay cloud
dev-anywhere serve status   # 看 Relay: connected
```
