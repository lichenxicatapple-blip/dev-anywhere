# Testing

四层测试体系。每层职责清楚, 加新 spec 时按职责选层落点。

```
                 ┌─────────────────────────────────────────────────────┐
                 │  release:smoke / release:check / dev:chaos          │  组合
                 └────────┬───────────────┬─────────────┬──────────────┘
                          │               │             │
       ┌──────────┬───────┼───────┬───────┼─────────────┼──────────┐
       │          │       │       │       │             │          │
  ┌────▼────┐ ┌──▼──┐ ┌──▼───┐ ┌──▼────┐ ┌▼─────────────▼──┐  单层入口
  │  L1     │ │ L2  │ │ L3   │ │ L4    │ │  dev:chaos       │
  │ unit    │ │layout│ │ pc  │ │mobile │ │  (integration    │
  │ vitest  │ │playw │ │playw│ │playw  │ │   chaos 编排)    │
  │ jsdom   │ │chrom │ │chrom│ │真Andro│ │                  │
  │         │ │视口模│ │PC交 │ │id emu │ │                  │
  │         │ │拟    │ │互   │ │+CDP   │ │                  │
  └────┬────┘ └──┬──┘ └──┬──┘ └──┬────┘ └──────────────────┘
       │         │       │       │
   src/**/*    e2e/      e2e/    e2e/
   .test.ts    layout/   pc/     mobile/
```

## 各层职责

| 层            | 入口               | 跑啥                                                             | 不该测的                            | 跑时长 |
| ------------- | ------------------ | ---------------------------------------------------------------- | ----------------------------------- | ------ |
| **L1 unit**   | `pnpm test:unit`   | 纯函数, 模块边界, 协议解码, hook 行为 (jsdom)                    | 跨多组件流程, 真 DOM 渲染, 网络     | ~20s   |
| **L2 layout** | `pnpm test:layout` | viewport 契约: 触摸目标 ≥44px, 不水平溢出, 软键盘伪 viewport     | 业务流程, 真后端, 真 IME            | ~10s   |
| **L3 pc**     | `pnpm test:pc`     | PC 桌面 chromium 全交互: 输入/滚动/几何/审批/链接/会话切换       | mobile 视口契约 (归 L2), 真 Android | ~3 min |
| **L4 mobile** | `pnpm test:mobile` | 真 Android emu + Chrome over CDP: 真触屏/IME/visualViewport/几何 | emulation 已能复现的 layout (归 L2) | ~4 min |

每层不该越界。比如"PC 桌面字体大小键盘交互"→ L3, **不要**在 L2 写 (layout 不该断言键盘行为); "mobile 软控制按键长按 repeat"→ L4 (真 PointerEvent timing), **不要** L2 mock chromium 模拟.

## chaos 子分类

L3 下 `e2e/pc/chaos/` 进一步分两种:

```
e2e/pc/chaos/
├── protocol-chaos.spec.ts        ┐
├── pty-render-chaos.spec.ts      │  mock chaos: fakeRelay 注入故障事件,
├── websocket-chaos.spec.ts       ┘  CI / pnpm test:pc 默认跑.
└── integration/
    ├── hosted-pty-chaos.spec.ts            ┐
    ├── real-chaos.spec.ts                  │  integration chaos: 需要真 backend
    ├── real-local-pty-chaos.spec.ts        │  + dev:chaos 编排, 缺省 skip 并提示.
    └── real-json-worker-chaos.spec.ts      ┘
```

**mock chaos**: 浏览器层 fakeRelay 模拟协议级故障 (重连 / 乱序 / stale snapshot / dedupe). 自给自足, 任何 vite 在线即可跑.

**integration chaos**: 真 relay/proxy daemon + 真 chaos provider 二进制注入 (provider 自杀 / 进程重启 / relay duplicate-delay-reorder). 由 `scripts/dev-chaos.sh` 编排环境后驱动 spec 跑. 当前架构 (vite proxy target 启动时静态读 env) 决定它们没法 fixture 化 — 详见 `apps/web/e2e/fixtures/cdp.ts` 注释.

## fixture 选型

`apps/web/e2e/fixtures/` 下三个 fixture, 按需要的依赖深度选:

| Fixture        | 起什么                                                        | 何时用                                                  |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `localRuntime` | 隔离 relay + proxy daemon (worker scope)                      | spec 只需要后端协议响应, 不需要真 claude CLI            |
| `hostedPty`    | localRuntime + 一个 mode=pty session (真 claude PTY)          | spec 需要真 PTY 输出流 (PATH 缺 claude 自动 skip)       |
| `jsonMode`     | localRuntime + 一个 mode=json session (真 claude stream-json) | spec 需要真 stream-json 协议 (PATH 缺 claude 自动 skip) |

不需要真后端协议的 spec 应该用浏览器层 `installFakeRelay` (`apps/web/e2e/helpers.ts`) — 比 fixture 快几十倍.

`fixtures-contract.spec.ts` 自检三个 fixture 的最小协议契约, 别处 spec 用 fixture 出错时先看这条是否过.

## PTY scroll intent 测试边界

PTY vertical intent 的 set / clear / keep 语义属于纯状态机:

- 纯 "should intent set/clear?" 行为写在 `apps/web/src/lib/pty-vertical-intent-fsm.test.ts`。
- 每新增一个 intent transition, 必须补一条 transition table case, 并让 transition id 覆盖守卫通过。
- `apps/web/src/lib/pty-scroll-controller.test.ts` 只测 DOM / xterm 集成副作用: scrollTop 写入、viewportY 同步、host/spacer 几何、pending sync retry、cursor-aware bottom、事件 wiring。
- 只有当 intent transition 会产生 DOM/xterm 可观察副作用时, 才额外加 controller integration test。

不要把每个历史 incident 都复制成 controller test。历史 incident 的根因如果是 intent 仲裁, 应该落到 FSM transition table; controller 只保留少量端到端接线保护。

### PTY 测试 inventory

当前 PTY 测试按职责分成这些桶。新增或清理测试时先找桶, 不要因为某个线上事故直接新增一条横跨多层的大测试。

| 桶                            | 文件                                                                                                                         | 保留理由                                                                            | 新增规则                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Intent FSM                    | `src/lib/pty-vertical-intent-fsm.test.ts`                                                                                    | 唯一验证 vertical intent set/clear/keep transition table 的地方                     | 每个新 transition 加 1 条 table case; 不写 DOM/xterm |
| Scroll geometry pure funcs    | `src/lib/pty-scroll.test.ts`                                                                                                 | 验证 spacer/host/anchor/ydisp 纯几何                                                | 几何公式变化才加                                     |
| Scroll controller integration | `src/lib/pty-scroll-controller.test.ts`                                                                                      | 验证 DOM scrollTop、host style、xterm viewportY、ResizeObserver、pending retry 接线 | 只加有 DOM/xterm 副作用的用例                        |
| Trace/debug observability     | `src/lib/pty-scroll-trace.test.ts`, `src/lib/pty-scroll-debug-snapshot.test.ts`                                              | 保证用户复制出来的 trace/snapshot 能定位问题                                        | 新字段必须有格式化断言                               |
| PTY protocol/session unit     | `src/lib/pty-session-transport.test.ts`, `src/lib/pty-frame-write-buffer.test.ts`, `src/lib/pty-terminal-controller.test.ts` | 协议、buffer、terminal lifecycle 的 L1 边界                                         | 不测视觉滚动                                         |
| PC browser behavior           | `e2e/pc/pty-*.spec.ts`                                                                                                       | 浏览器真实事件、fakeRelay 下的用户流程                                              | 同一风险已有 L1 覆盖时只保留 1 条 smoke              |
| Mobile browser behavior       | `e2e/mobile/pty-*.spec.ts`, `e2e/layout/pty-*.spec.ts`                                                                       | 触屏、IME、visualViewport、布局契约                                                 | 只测 PC/desktop 无法代表的移动差异                   |
| Real backend / chaos          | `e2e/pc/real-pty-*.spec.ts`, `e2e/pc/chaos/**/pty*.spec.ts`                                                                  | 真 PTY、daemon restart、relay/proxy 故障                                            | 缺真实进程或重连语义时才放这里                       |

清理优先级:

1. 如果 test 只断言 intent 是否 set/clear, 移到 FSM table 或删除重复项。
2. 如果 test 同时断言 scrollTop / viewportY / host.style, 留在 controller integration。
3. 如果 E2E 与 L1/L2 覆盖同一事实, E2E 只保留一条用户路径 smoke。
4. 不因一次 incident 同时在 FSM、controller、PC E2E、mobile E2E 各加一条; 先定位根因属于哪个桶。

## 添加新 spec 决策树

```
新 spec 要测什么?

├─ 纯函数 / 协议编解码 / hook
│    → src/**/*.test.ts (L1)
│
├─ "在 X 视口下布局不溢出 / 触摸目标 >= 44px"
│    → e2e/layout/*.spec.ts (L2 mobile-contract.spec.ts 内 describe 里加 test)
│
├─ "PC 桌面真交互 (输入/滚动/键盘/审批)"
│    → e2e/pc/*.spec.ts (L3, 复用 installFakeRelay 不依赖真后端)
│
├─ "真 Android 上的触屏/IME/键盘弹起/几何"
│    → e2e/mobile/*.spec.ts (L4, 复用 installFakeRelay; 需要真后端时切 fixture)
│
├─ "故障注入 / 重连 / 乱序"
│    │
│    ├─ 浏览器协议层能模拟 (fakeRelay 注入 stale / dedupe)
│    │    → e2e/pc/chaos/*.spec.ts (mock chaos)
│    │
│    └─ 必须真后端进程级故障 (杀 daemon / 注入 chaos agent)
│         → e2e/pc/chaos/integration/*.spec.ts (integration chaos, dev:chaos 驱动)
│
└─ "真 backend stream-json / 真 PTY / 真 worker"
     → e2e/pc/*.spec.ts 用 hostedPty / jsonMode fixture (真 claude PATH 是必需)
```

## 跑测命令速查

```
pnpm test:unit                            # L1 vitest 全套
pnpm test:layout                          # L2 layout 契约
pnpm test:pc                              # L3 PC 桌面 chromium 全 spec
pnpm test:mobile                          # L4 真 Android emu (没 emu 自动 skip 退 0)
pnpm dev:chaos                            # integration chaos 编排 + 驱动 spec
pnpm release:smoke                        # L2 + L3 + L4 + dev:chaos 串起来
pnpm release:check                        # 构建产物校验 + 安装包冒烟

# 单 spec 快速跑:
WEB_BASE_URL=http://127.0.0.1:5173 bash scripts/test-pc.sh e2e/pc/pty-input.spec.ts
bash scripts/test-mobile.sh e2e/mobile/pty-cursor-visible.spec.ts
```

## L4 mobile 工程注意

Android Chrome over CDP 三条平台限制 (cdp.ts 注释里有详): newContext 不支持 / page.close 不真删 tab / addInitScript 不能 unregister. `scripts/test-mobile.sh` 通过 per-spec-file force-stop chrome + CDP `/json/close` 真删 stale tab 来规避. 同 spec file 内多 test 共享 page (worker scope), spec 自己用 `setupPtyChat` / `installFakeRelay+reload` reset state.

如果在 emu 上看到 `Target page, context or browser has been closed`, 一般是 chrome session 累积了几十个 stale tab, 手动 `adb shell am force-stop com.android.chrome` 后再跑 (test-mobile.sh 会自动 reset).
