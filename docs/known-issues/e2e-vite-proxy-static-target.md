# vite proxy target 静态绑定阻碍 fixture 化的 web UI 端到端测试

## 现象

E2E fixture (`apps/web/e2e/fixtures/local-runtime.ts`) 起的 isolated relay+proxy 端口是动态的, 但 vite (apps/web/vite.config.ts) 的 proxy `target` 是 vite 启动时一次性读 `DEV_ANYWHERE_WEB_RELAY_TARGET` 环境变量绑死的. 一个 vite 实例只能 proxy 到一个 relay.

后果:

1. **mobile / pc spec 不能让 web UI 连 fixture 起的 isolated backend**. 现在 fixture 只能用作 protocol-level 测试 (通过 `ClientWs` 直接走 relay-control 协议, 不经 web UI), 看 `apps/web/e2e/pc/fixtures-contract.spec.ts` 即此用法.
2. **integration chaos spec 必须由 `pnpm dev:chaos` 编排** dev 环境 (起 default profile + 标准端口 3100), 才能让 web UI 通过 vite proxy 连过去. 这就是 `apps/web/e2e/pc/chaos/integration/*.spec.ts` 不能 fixture 化, 始终需要外部 dev:restart 路径的原因.

## 已评估方案

| 方案                                                                    | 可行性 | 不采纳原因                                                                |
| ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| vite proxy `target` 用 router function                                  | ✗      | vite server.proxy 不暴露 router option, 需 fork vite                      |
| vite plugin 写 middleware 自定义代理 + web 端 ws 连接带 query 选 target | ✓      | 要改前端业务代码 (ws connect 路径污染), 工程债扩散                        |
| per-spec-file vite restart with dynamic env                             | ✓      | ~3s/spec 启动开销, 跟当前 per-spec chrome reset (~10s) 同量级, 收益不显著 |
| http-proxy sidecar 独立服务                                             | ✓      | 多一个进程, 多一份 lifecycle 管理代码                                     |

## 当前规避方式

- E2E fixture 只用作 protocol-level 验证 (ClientWs 走 relay-control 协议).
- 需要 web UI 端到端的 spec 用 `installFakeRelay` 浏览器层 mock 协议 (browser-level fakeRelay, 见 `apps/web/e2e/helpers.ts`).
- integration chaos 由 `scripts/dev/chaos.sh` 在外部编排真后端 + 真 chaos provider 二进制注入, spec 通过 vite default proxy 连标准端口.

## 触发条件

- 想为 mobile / pc 加 "web UI 连真 stream-json / 真 PTY" 的端到端 spec
- 想让 integration chaos 能 fixture 自包含 (脱离 dev:chaos)

## 解锁路径 (将来真要做时的方向)

最可行的是 **方案 2 vite plugin + 前端 ws 连接带 query**:

1. vite plugin 在 dev mode 下 hook server.middlewares, 拦截 `/client?relayPort=N` 这类请求, 用 `http-proxy` 转发到 `ws://localhost:N`
2. 前端 `relay-client` 在 e2e mode 下读 `window.__devAnywhereE2ERelayPort` 拼到 ws URL
3. fixture 在 page.addInitScript 里 set `window.__devAnywhereE2ERelayPort = relayPort`

这条路径规模大概是 1-2 天工程, 需要的改动覆盖 vite plugin / web ws 连接逻辑 / fixture, 还要保证 prod build 上 query 不泄漏. 当前 e2e 治理没紧迫到必须做, 留给真 backend 业务 spec 的 ROI 真上来时再启动.
