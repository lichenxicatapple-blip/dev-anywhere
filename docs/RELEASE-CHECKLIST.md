# 发布检查清单

这份清单只覆盖发布前必须确认的工程事实：包能构建、能安装、资产齐全、初始化路径正确。真实 relay/web/provider 行为继续由 `pnpm dev:health`、`pnpm dev:chaos` 和人工本地冒烟覆盖。

## 必跑命令

```bash
pnpm typecheck
pnpm test
pnpm format:check
pnpm knip
pnpm release:check
```

`pnpm release:check` 会执行：

1. 构建所有 workspace 包。
2. 对 `@dev-anywhere/proxy` 和 `@dev-anywhere/relay` 跑 `npm pack --dry-run`。
3. 检查 proxy 包内包含 `dist/index.js`、`dist/serve.js`、`dist/session-worker.js`、README、LICENSE 和终端字体分片。
4. 检查 relay 包内包含 `dist/index.js`、`dist/server.js`、README 和 LICENSE。
5. 使用隔离 `HOME` 运行 `dev-anywhere init` 与 `serve status`，确认不会污染真实 `~/.dev-anywhere`。
6. 验证字体 CSS 包含 `U+2022`，确保 Claude/Codex 常见项目符号能直接命中必备字体分片。

## 手工确认

发布包验证通过后，再跑本机真实链路：

```bash
pnpm dev:restart
pnpm dev:health
pnpm dev:chaos
```

最后按 `docs/LOCAL-SMOKE.md` 做一次 Claude 终端会话、Codex 终端会话、Claude 聊天会话的人工确认。

## 禁止事项

- 不恢复 `cc-anywhere` 或 `.cc-anywhere` 兼容路径。
- 不把协议词直接暴露成用户文案；用户侧说「终端」「聊天」，代码和治理文档里才使用 PTY/JSON。
- 不新增“保留但不用”的脚本。脚本要么在 `docs/SCRIPTS.md` 里登记为入口，要么删除。
