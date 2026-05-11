# PTY Blank Render (mobile, intermittent)

## Symptom

Mobile-only. Web 端进入一个长上下文的 PTY 会话, viewport 的上半段（30%–70% 不等）整块全黑, 下半段才显示真实终端内容。BackToBottom 按钮的"有新消息" amber 点可见, 滚动条位置在中段——视觉上像 host element 被压到 viewport 底部, 上方留出大块空白。

无法在桌面 (Chromium / Firefox) 复现。在真机上偶发, 没有稳定的触发步骤。

## Status

- 未拿到真机现场的诊断数据。
- 已修候选成因 (见下), 不能确认是哪一条 (或其它未发现的根因) 在起作用。
- 长上下文 e2e smoke (`apps/web/e2e/real-pty-long-context.spec.ts`) 对相关几何 invariant 有断言, 桌面环境跑通, 没复现 mobile 形态。

## What we already addressed

| Commit | 候选成因 |
| --- | --- |
| `f01cf45d` | WebGL context loss (sleep/wake / 标签后台) 后 atlas 指向 stale texture slot, 字符显示乱。`onContextLoss` 重新加载 WebGL addon 修复。 |
| `c9bd68a4` | reconnect 时 `wasAtBottom` 在 `updateSpacer` 之前算, 容器空 buffer 误判 atBottom 误清用户回看 intent。`notifyAtBottom` 改成只在 false→true 真实过渡清 intent + `pendingFrame=none` 分支去掉 `wasAtBottom ||`。 |
| `8478b48b` | `measureXtermCellSize` 那一帧拿不到尺寸 → `syncContainerScroll` 早返回, host 留在 stale ydisp。加 `pendingContainerSyncRetry` flag, `relayout` / `onRender` 在 cellH 恢复时按当前 `container.scrollTop` 补一次 sync。 |
| `f4899366` | 给 `__devAnywherePtyDebug` snapshot 加诊断字段 (`viewportHostCoverage`, `host.topDrift`, `pendingContainerSyncRetry`), 让线上现场可量化定位。 |
| `67914ce4` / `fd51f242` | scroll-controller invariant 边界: `expectedHostTop` 复刻 `positionHostAt` 公式, `scrollToBottom` 末尾清 retry flag, 等。 |

## Root cause confirmed (v0.2.1)

诊断 playbook 在一次真机现场拿到 snapshot:
`bufferLength=538 / rows=52 / viewportY=baseY=486 / cursorY=27 / canvasLastY=26 / hostPaddingTop=450`。

`computePtyHostLayout` (pty-scroll.ts) 把"光标余空"当成"冷启动留白":
`blankRows = rows - 1 - canvasLastY = 25` → `hostPaddingTop = 450px`。
但 `bufferLength(538) >> rows(52)` 已经是滚动缓冲区状态, 光标上方全是有效 buffer 行, 光标下方的空行只是普通"光标后未写"而非"屏幕未填满"。

paddingTop 把 host 内容向下推 450px, 而 `positionHostAt` 给出的 `host.top` (= `ydisp*cellH`) 仍按 host 顶部对齐内容计算, 两者拼起来在视窗顶部漏出 450px / 25 行 黑带 = 现场症状。

**Fix**: hostPaddingTop 改为仅在 `bufferLength <= rows` (真冷启动) 时计算, 否则恒 0。
回归测试覆盖现场参数 (pty-scroll.test.ts)。

## Diagnostic playbook

下次现场复现时, 请取以下数据:

### 1. Snapshot

在真机浏览器 console 跑:

```js
copy(JSON.stringify(window.__devAnywherePtyDebug(), null, 2))
```

(没有 `copy()` 的浏览器: 直接 `console.log(JSON.stringify(__devAnywherePtyDebug(), null, 2))` 然后长按复制。)

### 2. Snapshot 字段对照

| 字段 | 含义 | 健康值 | 故障特征 |
| --- | --- | --- | --- |
| `viewportHostCoverage` | viewport ∩ host / clientHeight | `1.0` | `< 1.0` 即可见区有空白带——blank-render 最直接的量化指标 |
| `host.topDrift` | `host.style.top - (viewportY*cellH + verticalOffset)` | `0` (±1 sub-pixel) | non-zero = host 卡在 stale ydisp 上 |
| `pendingContainerSyncRetry` | 上一次 `syncContainerScroll` 是否因 cellH=0 漏掉 | `false` | `true` 即 snapshot 瞬间还没 sync 上 |
| `cell.h` / `cell.w` | xterm 单格像素尺寸 | `> 0` | `0` = canvas 不可测 (xterm-screen 0 高 / WebGL 暂失效) |
| `spacerDrift` | `spacer.height - expectedSpacerHeight` | `0` (±1) | non-zero = updateSpacer 漏写或 cell 尺寸读错位 |
| `container.scrollTop` vs `host.top` | 几何对齐关系 | `host.top ∈ [scrollTop − host.height, scrollTop + clientHeight]` | host.top 远在 scrollTop 之外 = host 不在 viewport 范围 |
| `term.viewportY` vs `term.bufferLength` | xterm 内部 viewport 位置 | viewportY ≤ bufferLength − rows | 若 viewportY 远小于预期, 跟 user scrollTop 对照看是否同步 |

### 3. 旁路信息

不在 snapshot 里但下次也请记录:

- 浏览器 + 版本 (Chrome / iOS Safari / 其它), OS 版本
- 触发前 30 秒内的操作: 是否锁屏后唤醒 / 切后台再切回 (= WebGL context loss 候选)
- 状态条是否近期出现"连接中" → "空闲"过渡 (= reconnect 候选)
- 大致 buffer 长度 (滚动条比例可以估)
- 软键盘最近是否弹出过

### 4. Renderer 强制刷新

如果想本地试着恢复 (而不是只取数据), 可以在 console 跑:

```js
window.__devAnywherePtyRenderDebug.forceRedraw()
// 或者切回 DOM renderer (绕开 WebGL)
window.__devAnywherePtyRenderDebug.setRenderer("dom")
```

(注意: 这两条会让现场数据变, 取完 snapshot 再做。)

## Hypotheses NOT yet addressed

下面这些是审查中识别但**没有证据支撑**的方向, 不要先行投入修复, 等真机数据来再判断:

- iOS Safari 的 atlas cache eviction 机制 (跟桌面 Chrome 不同)
- `visualViewport` 偏移与 `containerPaddingBottom` 在软键盘 show/hide 时的交互窗口
- 滚动事件批处理: 用户 wheel / 触摸 scroll 触发的 RAF-relayout 与 native scroll event 之间的同步窗口
- Scroll-restoration / browser 自动 scrollTop clamp 在 buffer 收缩时的行为差异

## How we'd confirm a fix

不论是已修的某条候选成因还是未来的新修复, 真机数据需要:

1. `viewportHostCoverage >= 0.99` 在长时间会话里始终成立 (以分钟级窗口看)
2. `host.topDrift` 不超过 1 个 cellH, 不会持续偏离
3. `pendingContainerSyncRetry === true` 只在亚秒级窗口出现, 不持续
4. 出现上述任一不健康指标时, snapshot 能 reproducible 抓到, 而不是间歇性 transient

## Related code paths

- `apps/web/src/lib/pty-scroll-controller.ts` — host/viewport 几何同步的核心
- `apps/web/src/lib/pty-scroll-debug-snapshot.ts` — snapshot 字段计算
- `apps/web/src/lib/pty-render-debug.ts` — `forceRedraw` / renderer 切换
- `apps/web/e2e/real-pty-long-context.spec.ts` — 长上下文回归 (opt-in via `DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT=1`)
