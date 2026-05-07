# 本地真实链路冒烟清单

这份清单用于在人工测试前确认真实 `relay + proxy serve + web + Claude/Codex PTY` 链路健康。Fake relay e2e 负责自动化主路径，本文只覆盖本机真实进程和真实 Agent CLI。

## 启动与诊断

1. 重启本地开发链路：

```bash
pnpm dev:restart
```

2. 检查健康状态：

```bash
pnpm dev:health
```

期望结果：

- Relay 监听 `:3100`。
- Web 监听 `:5173`。
- Relay `/health` 返回 `status=ok`。
- Proxy serve 显示 `Service: running`。
- Proxy serve 显示 `Relay: connected`，且 queue depth 为 `0`。
- `service.log` 最近没有 `hook failed`、`invalid JSON`、`failed to start`。

## Claude PTY

1. 打开 `http://localhost:5173`。
2. 新建会话。
3. 交互模式选择 `PTY`。
4. Agent CLI 选择 `Claude Code`。
5. 工作目录选择一个小项目目录。
6. 创建会话。
7. 在 Web 终端里输入一条短消息。
8. 验证 `Shift+Enter` 是换行，`Enter` 是提交给 Claude Code。
9. 从右上角菜单发送 `Ctrl+C`。
10. 回看历史输出，再触发新输出，确认不会被强行拉到底部。
11. 终止会话，确认页面显示“会话已终止”，且不能继续输入。

## Codex PTY

1. 打开 `http://localhost:5173`。
2. 新建会话。
3. 交互模式选择 `PTY`。
4. Agent CLI 选择 `Codex`。
5. 工作目录选择一个小项目目录。
6. 创建会话。
7. 验证终端区域高度正常，不是只显示一小块。
8. 输入一条短消息，确认逐键输入能到达 Codex。
9. 终止会话，确认页面显示“会话已终止”，且不能继续输入。
10. 回到全部会话，确认 Codex 会话在 Codex 分组下展示。

## 日志定位

常用日志：

- Relay: `~/.dev-anywhere/logs/relay-dev.log`
- Web: `~/.dev-anywhere/logs/web-dev.log`
- Proxy serve: `~/.dev-anywhere/logs/service.log`
- 本地 terminal/proxy attach: `~/.dev-anywhere/logs/terminal.log`

常见异常关键词：

- `hook returned invalid`
- `invalid session start JSON output`
- `invalid user prompt submit JSON output`
- `Serve daemon failed to start`
- `EADDRINUSE`
- `session_create_response` 缺失或报错

先跑 `pnpm dev:health`，再根据提示查看对应日志。
