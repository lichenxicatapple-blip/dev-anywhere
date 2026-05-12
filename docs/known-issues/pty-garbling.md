# PTY Rendering Garbling (intermittent)

## Symptom

PTY 终端渲染偶发出现"乱码", 通常是以下几类形态之一:

- 单个或多个 cell 上叠字 / 残留前一帧字符 (像两层字符叠在一起), 鼠标选中或滚动经过那个区域后就恢复正常
- CJK 字符显示为 `�` (U+FFFD REPLACEMENT CHARACTER) 或被拆成两个错位的格子
- 一段连续区域字符错位 (右移 / 左移一格), 看起来像 cell width 算错了

视觉上的共同点: 内容是有的, 但显示错乱; 跟 [pty-blank-render](pty-blank-render.md) 的整块全黑不同。

桌面 / 移动都见过, 没有稳定触发步骤。CJK 高频颜色场景 (claude / codex 输出 + 中文) 出现概率更高。

## Status

- 已修若干已知成因 (见下), 仍偶发, 不排除还有未识别根因。
- 没拿到现场可复现的数据 (snapshot / serialize dump / 截图), 推断仅基于 xterm + WebGL 已知 atlas 行为。
- 长上下文 e2e (`apps/web/e2e/real-pty-long-context.spec.ts`) 对 buffer 中 U+FFFD 数量有断言, 桌面环境跑通无 U+FFFD。

## What we already addressed

| Commit     | 候选成因                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f01cf45d` | WebGL context loss (sleep/wake / 标签后台 / GPU 进程崩溃) 后 atlas 指向 stale texture slot, 重绘时显示前一帧残留字符。`onContextLoss` 重新加载 WebGL addon, 触发 atlas 重建。     |
| `c51fd815` | 引入 `__devAnywherePtyRenderDebug`: `setRenderer("dom")` 切回 DOM renderer 绕开 atlas, `forceRedraw()` 强制 `xterm.refresh()` 整屏重绘。给现场一条无须发版的恢复路径 + 验证手段。 |
| ——         | xterm `UnicodeGraphemesAddon` 启用, 让 grapheme cluster (含 CJK / emoji ZWJ) 的 cell width 计算用最新 Unicode 表, 减少 atlas 把双字节 cell 拆错的概率。                           |

## Diagnostic playbook

下次现场复现时, 请按顺序取以下数据。**前两步不要刷新页面, 不要切换路由**, 一旦刷新现场就丢了。

### 1. 截图 (最重要)

截一张包含乱码区域的全屏截图。光是文字描述很难判断到底是 atlas 叠字、UTF-8 拆错还是 cell width 错位。

### 2. Serialize dump

控制台跑:

```js
window.__devAnywherePtyRenderDebug.dumpState();
```

会自动 copy 到剪贴板 (含 ANSI 序列 + 元信息)。粘进 issue。

dump 里要看的几条:

| 信号                                | 含义                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `serialized` 含 `�` (即 `�`)        | UTF-8 解码错位 / atlas 把双字节 cell 拆错 — **乱码最可观测的指纹** |
| `serialized` 完全正常但截图显示错乱 | xterm 内部 buffer 是对的, 是渲染层 (atlas) 在出问题                |
| `serialized` 本身就错乱             | 是数据层 (PTY 字节流 / 解码) 在出问题, 跟 renderer 无关            |

### 3. 切 DOM renderer 验证

```js
window.__devAnywherePtyRenderDebug.setRenderer("dom");
// 然后刷新 (DOM renderer 在新建 terminal 时生效)
location.reload();
```

刷新后乱码消失 → 几乎可以确定是 WebGL atlas 嫌疑 (atlas eviction / 双字节 cell 拆错 / context loss 漏检)。
刷新后乱码仍在 → 不是 atlas, 看数据层 (PTY 字节流 / UTF-8 解码 / xterm parser)。

排查完恢复:

```js
window.__devAnywherePtyRenderDebug.setRenderer("webgl");
location.reload();
```

### 4. forceRedraw 试恢复

如果不想刷新 (想保留现场再多取数据), 可以试:

```js
window.__devAnywherePtyRenderDebug.forceRedraw();
```

会调用 `xterm.refresh(0, rows-1)` 整屏强刷。

- 强刷后乱码消失 → atlas 缓存命中错误 (重绘后会重建 atlas slot)
- 强刷后仍在 → 不是简单的 atlas slot 错位, 可能是 atlas texture 整体损坏 / context 状态乱

### 5. 旁路信息

不在 dump 里但请同时记:

- 浏览器 + 版本 (Chrome / Safari / iOS Safari / Firefox), OS 版本
- 触发前 30 秒内: 是否锁屏 → 唤醒 / 切后台 → 切回 / GPU 切换 (外接显示器插拔) → 这些都是 WebGL context loss 候选
- 内容形态: 纯 CJK / CJK + ANSI 颜色 / emoji / box-drawing 字符 / 仅 ASCII?
- 终端 cols × rows (从 dump 的 meta 里拿)
- 是否在 claude / codex 长输出中途 (这两个会高频 stream output, 触发 atlas slot 大量轮换)

## Hypotheses NOT yet addressed

下面这些是审查中识别但**没有证据支撑**的方向, 不要先行投入修复, 等真机数据来再判断:

- iOS Safari 的 atlas texture eviction 策略与桌面 Chrome 不同, 在内存紧张时会主动回收, xterm WebGL addon 不一定能感知
- PTY 字节流被 binary frame 拆分时, 多字节 UTF-8 字符跨帧边界的处理 — 如果某帧最后 1 字节是 0xE4 (中文首字节), 下一帧最先 2 字节没及时拼上, xterm parser 就会吐 U+FFFD
- 高频颜色场景下 atlas 同一 cell 多个色变体爆量, 超过 atlas 容量后 LRU 拆错 → 同一字符在不同色彩下显示残影
- xterm parser 在收到非法 ANSI 序列 (proxy / claude / codex 输出错配) 时的 fallback 行为, 在某些边界 case 下会把后续字节当显示字符

## How we'd confirm a fix

不论是已修候选还是未来新修复, 真机数据需要:

1. `serialized` 中 `�` 计数稳定为 0 (在 CJK 高频场景下分钟级窗口)
2. `setRenderer("dom")` 与 `setRenderer("webgl")` 在同一会话同一内容下视觉一致
3. `forceRedraw()` 不再能"恢复"任何叠字 — 即正常状态下不会有 atlas slot 错位累积

## Related code paths

- `apps/web/src/lib/create-xterm.ts` — WebGL addon 装载, `onContextLoss` 处理, UnicodeGraphemesAddon
- `apps/web/src/lib/pty-render-debug.ts` — `setRenderer` / `forceRedraw` / `dumpState` 调试入口
- `apps/web/e2e/real-pty-long-context.spec.ts` — U+FFFD 计数断言 (opt-in via `DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT=1`)
- `packages/shared/src/binary-frame.ts` — binary frame 编解码, sessionId + outputSeq + payload 布局
- `apps/web/src/lib/pty-recovery.ts` (相关) — binary frame 与 snapshot 的乱序缓冲, 涉及帧顺序保证
