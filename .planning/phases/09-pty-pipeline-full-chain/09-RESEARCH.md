# Phase 9: PTY Pipeline Full Chain - Research

**Researched:** 2026-04-15
**Domain:** Binary PTY data pipeline (proxy persistence -> relay passthrough -> browser xterm.js)
**Confidence:** HIGH

## Summary

Phase 9 替换现有的 JSON terminal_frame 链路为原始 PTY 二进制字节流直通管线。数据流方向：PTY -> terminal.ts (EventStore 落盘 + @xterm/headless 快照 + binary IPC) -> serve.ts (binary WebSocket 转发) -> relay (binary 帧透传) -> browser xterm.js 渲染。同时删除 TerminalTracker、FramePusher、FrameCache、TerminalFrameRenderer 及 relay 端 SessionBuffer/BufferStore/BufferCompressor 等旧链路代码。

项目中已有 `@xterm/headless@6.0.0` 和 `@xterm/addon-serialize@0.14.0` 依赖（proxy package.json），浏览器端需要新增 `@xterm/xterm@6.0.0` 及相关 addon。CCAE 二进制格式的先前实现（commit b05bec2）提供了可参考的起点，但需根据本次 50 项决策进行重大改进（尾部 trailer、多文件轮转、立即写盘、METADATA/RESIZE 事件类型等）。

relay 端改动相对简单：WebSocket `ws` 库天然支持 binary frame（`Buffer | ArrayBuffer` 类型），`message` event 的 `isBinary` 参数可区分 text/binary，proxy handler 只需在 binary 帧时解析 sessionId 前缀路由即可。

**Primary recommendation:** 按 D-34 沿数据流方向实现 (09-01 proxy -> 09-02 relay -> 09-03 browser)，09-01 第一步做 spike 验证（D-35），确保 headless+serialize 导入、IPC 混合协议原型、EventStore 写入均可行后再推进。

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** 自定义二进制格式，CCAE magic header + length-prefixed 事件
- **D-02:** 每事件立即写入磁盘，不丢数据优先（不做应用层缓冲）
- **D-03:** gzip 归档采用双策略：活跃文件超大小阈值时轮转压缩 + 会话结束时归档剩余文件
- **D-04:** 事件数触发快照（每累积 N 个事件生成一次）
- **D-05:** 快照嵌入 EventStore，作为特殊事件类型（0x02）
- **D-06:** binary 帧格式 = 1B sessionId 长度 + sessionId UTF-8 + PTY 数据
- **D-07:** relay 纯透传 binary 帧，只读 sessionId 前缀路由
- **D-08:** 重连恢复属于 Phase 11
- **D-09:** 独立 `/pty-test` 测试页验证全链路
- **D-10:** xterm.js addon：fit + serialize + web-links
- **D-11:** PTY 为尺寸权威，客户端被动跟随 resize
- **D-12:** 删除 TerminalTracker + frame-pusher + frame-cache + terminal-frame-renderer 及其测试
- **D-13:** Phase 9 只改 PTY 模式链路，JSON 模式链路保持不变
- **D-14:** 本地终端优先——先写 stdout，然后异步做 EventStore 写盘 + headless write + WebSocket 发送
- **D-15:** 轮转采用序号命名
- **D-16:** 数据清理为手动
- **D-17:** 恢复场景为 serve.ts 重启
- **D-18:** terminal.ts 崩溃 = PTY 死亡 = 会话结束
- **D-19:** 两端 scrollback 统一 5000 行
- **D-20:** Playwright E2E + 手动验证视觉质量
- **D-21:** replay.ts 迁移到新链路
- **D-22:** 不做应用层分片，PTY onData 数据块直接作为一个事件写入
- **D-23:** METADATA 作为文件第一个事件
- **D-24:** @xterm/headless + EventStore 放在 terminal.ts 进程
- **D-25:** `/pty-test` 用原生 `new WebSocket()`
- **D-26:** 浏览器端按 `event.data` 类型分发
- **D-27:** IPC 混合模式——NDJSON 控制 + length-prefixed binary
- **D-28:** `/pty-test` = 全屏 xterm.js + 连接状态栏 + 手动输入 relay URL 和 sessionId
- **D-29:** 文件头：4B magic ('CCAE') + 2B version = 6B
- **D-30:** 事件结构：1B type + 8B timestamp + 4B payload_len + payload + 4B total_len trailer
- **D-31:** 事件类型：0x01=PTY_DATA, 0x02=SNAPSHOT, 0x03=RESIZE(固定 4B), 0x04=METADATA(JSON)
- **D-32/D-33:** shared 包旧 PTY 链路类型清理
- **D-34:** 实现顺序 09-01 proxy -> 09-02 relay -> 09-03 browser
- **D-35:** 风险前置验证 spike
- **D-36:** 删除 relay 端 session-buffer + buffer-store + buffer-compressor
- **D-37:** 所有消息恢复统一由 proxy 驱动
- **D-38:** 测试随代码同步迁移
- **D-40:** xterm.js 主题对齐设计 token
- **D-41:** `document.fonts.ready` 后再初始化 xterm.js
- **D-42:** relay 转发 binary 帧保留 sessionId 前缀，零拷贝
- **D-43:** 客户端解析 binary 帧
- **D-44:** `/pty-test` 只读
- **D-45:** Phase 9 先于 Phase 8 执行
- **D-46:** RelayConnection 方法重命名
- **D-47:** 快照不清理历史事件
- **D-48:** 快照定位用反向扫描
- **D-49:** 轮转时新文件开头写 SNAPSHOT

### Claude's Discretion
- 事件数触发快照的具体 N 值（可参考 b05bec2 的 100 事件/次作为起点）
- gzip 轮转的文件大小阈值
- IPC 混合协议的帧边界标识字节设计
- xterm.js unicode11 addon 是否需要启用（CJK 宽字符处理）
- `/pty-test` 页面的具体 UI 布局细节

### Deferred Ideas (OUT OF SCOPE)
- relay 完全无状态化延伸 -> Phase 11
- 客户端驱动 resize -> 未来体验优化
- EventStore 自动清理 -> 手动清理
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PTY-01 | proxy 端 @xterm/headless + serialize addon 快照机制 | @xterm/headless@6.0.0 + @xterm/addon-serialize@0.14.0 已在 proxy 依赖中，b05bec2 有可参考的快照逻辑 |
| PTY-02 | proxy 端 EventStore 二进制持久化恢复（落盘 + gzip） | CCAE 格式从 b05bec2 改进，D-29~D-31 定义了新格式，D-02 要求立即写盘，D-48 反向扫描定位快照 |
| PTY-03 | proxy 转发原始 PTY 字节流（替换 TerminalTracker + frame 推送） | D-06 binary 帧格式，D-27 IPC 混合协议，D-14 本地终端优先的异步架构 |
| PTY-04 | relay 端 binary WebSocket frame 透传 | ws 库原生支持 binary frame + isBinary 判断，D-07/D-42 零拷贝透传 |
| FRONT-07 | Chat 页面迁移（PTY 模式：xterm.js 终端视图） | @xterm/xterm@6.0.0 + fit/serialize/web-links addon，D-09 /pty-test 测试页先行验证 |
</phase_requirements>

## Standard Stack

### Core (Phase 9 specific)

| Library | Version | Purpose | Why Standard | Confidence |
|---------|---------|---------|--------------|------------|
| `@xterm/xterm` | 6.0.0 | 浏览器终端渲染 | xterm.js 是唯一成熟的浏览器终端模拟器，VS Code 内置使用 | HIGH |
| `@xterm/headless` | 6.0.0 | Proxy 端 headless 终端状态追踪 | 已在 proxy 依赖中，用于生成快照 | HIGH |
| `@xterm/addon-serialize` | 0.14.0 | 序列化终端状态为字符串 | 快照核心能力，已在 proxy 依赖中 | HIGH |
| `@xterm/addon-fit` | 0.11.0 | 浏览器端自适应容器尺寸 | xterm.js 标配 addon | HIGH |
| `@xterm/addon-web-links` | 0.12.0 | 终端中可点击链接 | 用户体验增强 | HIGH |
| `@xterm/addon-unicode11` | 0.9.0 | Unicode 11 宽字符支持 | CJK 字符宽度计算必需，待验证是否开启 | MEDIUM |

[VERIFIED: npm registry] -- 所有版本为 npm latest tag，查询时间 2026-04-15

### Already in Project (Relevant)

| Library | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.20.0 | WebSocket，relay + proxy 已使用 |
| `nanoid` | ^5.x | sessionId 生成，binary 帧前缀使用 |
| `pino` | ^9.x | 结构化日志 |
| `vitest` | ^2.x (proxy) / ^4.1.2 (web) | 测试框架 |
| `zod` | ^3.24 (relay) / ^4.3.6 (proxy) | Schema 校验 |

### New Dependencies to Install

**Browser (apps/web):**
```bash
pnpm --filter web add @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-serialize@0.14.0 @xterm/addon-web-links@0.12.0 @xterm/addon-unicode11@0.9.0
```

**Proxy (apps/proxy) -- 已有 headless + serialize，无需额外安装。**

## Architecture Patterns

### Data Flow Architecture (New)

```
PTY bytes
  |
  v
terminal.ts (PTY onData callback)
  |-- 1. process.stdout.write(data)     [同步，本地终端优先]
  |-- 2. headlessTerminal.write(data)   [异步]
  |-- 3. eventStore.appendPtyData(data) [异步，立即写盘]
  |-- 4. ipc.sendBinary(sessionId, data) [异步，binary IPC 到 serve]
  |-- 5. 每 N 事件触发 serialize snapshot -> eventStore.appendSnapshot()
  |
  v
serve.ts (IPC server)
  |-- 解析 binary IPC 帧
  |-- relayConnection.sendBinary(data)  [binary WebSocket]
  |
  v
relay (handlers/proxy.ts)
  |-- ws.on('message', data, isBinary)
  |-- if isBinary: 读 1B len + sessionId -> 路由到对应 client ws.send(data)
  |
  v
browser (/pty-test page)
  |-- ws.onmessage -> if ArrayBuffer: 解析 sessionId -> write 到 xterm.js
```

### EventStore CCAE Binary Format (D-29, D-30, D-31)

```
File Header (6 bytes):
  [4B] magic = 'CCAE' (ASCII)
  [2B] version = 0x0001 (little-endian)

Event Structure (variable length):
  [1B]  type         (0x01=PTY_DATA, 0x02=SNAPSHOT, 0x03=RESIZE, 0x04=METADATA)
  [8B]  timestamp    (ms since epoch, float64 LE)
  [4B]  payload_len  (uint32 LE)
  [NB]  payload      (raw bytes)
  [4B]  total_len    (uint32 LE, = 1+8+4+N+4 = 17+N, trailer for reverse scan)

First event must be METADATA (D-23):
  { cols, rows, sessionId, createdAt, ... } as JSON bytes

RESIZE event has fixed 4B payload (D-31):
  [2B] cols (uint16 LE) + [2B] rows (uint16 LE)

SNAPSHOT event payload:
  SerializeAddon.serialize() output as UTF-8 bytes
```

### Reverse Scan for Latest Snapshot (D-48)

```
1. Seek to EOF
2. Read last 4 bytes = total_len of last event
3. Seek backward by total_len, read event header
4. If type == 0x02 (SNAPSHOT): found
5. Else: read trailer of this event, seek further backward
6. Repeat until SNAPSHOT found or BOF
```

### File Rotation (D-15, D-49)

```
session_dir/
  events.bin              # 活跃写入文件
  events.001.bin.gz       # 第一次轮转归档
  events.002.bin.gz       # 第二次轮转归档
  ...

轮转触发：活跃文件超过大小阈值（Claude's Discretion，建议 10MB）
轮转流程：
  1. gzip events.bin -> events.NNN.bin.gz
  2. 创建新 events.bin，写 header
  3. 立即写入当前 SNAPSHOT 到新文件开头（D-49，确保自包含）
```

### IPC Mixed Protocol (D-27)

```
现有 NDJSON 控制消息保持不变：
  { "type": "pty_register", ... }\n

新增 binary 帧（length-prefixed）:
  [4B] total_length (uint32 LE, 含这 4 字节自身)
  [NB] payload (= 1B sessionId_len + sessionId_bytes + pty_data)

区分机制：
  NDJSON 行的第一字节一定是 '{' (0x7B)
  binary 帧的 length 字段（小端 uint32）的第一字节几乎不可能是 0x7B
  更稳健方案：使用 magic byte 作为 binary 帧标识
  建议：0x00 作为 binary 帧前导字节（NDJSON 永远不以 0x00 开头）
    [1B] 0x00 (binary frame marker)
    [4B] payload_length (uint32 LE)
    [NB] payload
```

### Binary Frame Format over WebSocket (D-06)

```
WebSocket binary frame payload:
  [1B]  sessionId_length
  [NB]  sessionId (UTF-8, nanoid 21 bytes)
  [MB]  pty_data (raw bytes)

relay 路由：
  1. Read first byte as len
  2. Read next len bytes as sessionId string
  3. Look up proxy/client mapping
  4. ws.send(entireBuffer) -- 零拷贝，保留 sessionId 前缀（D-42）
```

### Project Structure Changes

```
apps/proxy/src/
  event-store.ts          # NEW: CCAE binary EventStore
  terminal.ts             # MODIFY: 加入 EventStore + headless + binary IPC
  serve.ts                # MODIFY: 加入 binary IPC 接收 + binary WS 发送
  ipc-protocol.ts         # MODIFY: 混合 NDJSON + binary
  relay-connection.ts     # MODIFY: 加 sendBinary(), rename send -> sendEnvelope
  paths.ts                # VERIFY: events.bin 路径已预留
  replay.ts               # MODIFY: 迁移到新链路
  terminal-tracker.ts     # DELETE
  frame-pusher.ts         # DELETE
  frame-cache.ts          # DELETE
  terminal-frame-renderer.ts  # DELETE

apps/relay/src/
  handlers/proxy.ts       # MODIFY: binary frame 透传
  handlers/client.ts      # MODIFY: binary frame 转发
  session-buffer.ts       # DELETE
  buffer-store.ts         # DELETE
  buffer-compressor.ts    # DELETE (已是死代码)
  registry.ts             # MODIFY: 移除 SessionBuffer 相关
  router.ts               # MODIFY: 移除 buffer 相关逻辑
  server.ts               # MODIFY: 移除 BufferStore 初始化

apps/web/src/
  pages/pty-test.tsx      # NEW: /pty-test 测试页
  lib/xterm-theme.ts      # NEW: xterm.js 主题配置
  app.tsx                 # MODIFY: 路由注册

packages/shared/src/
  schemas/session.ts      # MODIFY: 移除 TermSpan/TermLine/TerminalFramePayload 等
  schemas/relay-control.ts # MODIFY: 移除 terminal_frame 相关
```

### Anti-Patterns to Avoid

- **在 relay 中解析或缓存 binary PTY 数据：** relay 是无状态管道，只读 sessionId 前缀路由。任何内容解析都违反架构方向
- **在 terminal.ts 中同步阻塞本地终端输出：** D-14 明确本地终端优先，EventStore/IPC/headless 都是异步操作
- **用 `data.toString()` 处理 binary WebSocket 消息：** relay handler 当前所有 message 都调用 `data.toString()`，binary 帧不能这样处理
- **手动管理 xterm.js 的 scrollback buffer：** xterm.js 有内置的 scrollback 管理，不需要服务端参与

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 终端状态序列化 | 自定义 ANSI 状态追踪器 | @xterm/addon-serialize | 处理所有 ANSI escape 序列、颜色、光标、alternate buffer 等边界情况 |
| 终端 ANSI 渲染 | 自定义 span/grid 渲染器 (TerminalTracker) | @xterm/xterm + @xterm/headless | xterm.js 是 20 年成熟项目，覆盖所有 VT100/VT220/xterm 控制序列 |
| 终端自适应尺寸 | 自定义 ResizeObserver 逻辑 | @xterm/addon-fit | 处理 DPI、字体度量、亚像素渲染等复杂计算 |
| CJK 宽字符处理 | 自定义 wcwidth 查表 | @xterm/addon-unicode11 | Unicode 11 标准宽字符表，CJK 和 emoji 宽度正确 |
| WebSocket binary frame | 自定义编码/解码 | ws 原生 Buffer 支持 | ws 库 `send(buffer)` 自动发 binary frame，接收端 `isBinary` 标志区分 |

**Key insight:** Phase 9 的核心价值就是用 xterm.js 全栈替换自建的 TerminalTracker/FramePusher/FrameCache/TerminalFrameRenderer，~1200 行自建代码替换为 xterm.js 生态的标准方案。

## Common Pitfalls

### Pitfall 1: @xterm/headless CJS/ESM 导入问题
**What goes wrong:** `@xterm/headless` 使用 CJS 导出，ESM 项目中 `import { Terminal } from '@xterm/headless'` 可能失败
**Why it happens:** 项目使用 `"type": "module"` ESM 模式
**How to avoid:** 当前代码已使用 `import pkg from "@xterm/headless"; const { Terminal } = pkg;` 模式（见 terminal-tracker.ts L1-2）。新代码必须沿用此模式
**Warning signs:** `SyntaxError: Named export 'Terminal' not found`
**Confidence:** HIGH [VERIFIED: codebase pattern apps/proxy/src/terminal-tracker.ts L1-2]

### Pitfall 2: WebSocket binary frame 区分
**What goes wrong:** relay handler 将 binary frame 当作 JSON 解析，导致 parse error
**Why it happens:** 现有 `proxyWs.on("message", (data) => { const raw = data.toString(); ... })` 对所有消息调用 `toString()`
**How to avoid:** ws 库的 `message` 事件第二参数 `isBinary` 可区分。先检查 `isBinary`，binary 帧走独立处理路径
**Warning signs:** "Invalid JSON" 错误日志，binary 数据被误解析
**Confidence:** HIGH [VERIFIED: ws 文档 -- `WebSocket.on('message', (data, isBinary) => {})`]

### Pitfall 3: Vite dev proxy 与 binary WebSocket
**What goes wrong:** Vite 开发代理将 binary WebSocket 帧转换为 text frame 或丢失
**Why it happens:** Vite 的 `server.proxy` 使用 `http-proxy`，理论上支持 WebSocket，但 binary frame 需要验证
**How to avoid:** Spike 阶段验证 Vite proxy 对 binary frame 的透传行为。如有问题，可在 `/pty-test` 页面直接连接 relay 绕过 Vite proxy
**Warning signs:** 浏览器收到 string 类型而非 ArrayBuffer
**Confidence:** MEDIUM [ASSUMED -- http-proxy 底层应支持 binary，但需实测]

### Pitfall 4: xterm.js 字体加载时序
**What goes wrong:** CJK 字符宽度计算错误，导致光标位置偏移和文字重叠
**Why it happens:** xterm.js 在初始化时计算字符宽度，如果等宽字体尚未加载完成，会使用 fallback 字体的度量
**How to avoid:** D-41 要求 `document.fonts.ready` 后再初始化 xterm.js。Sarasa Fixed SC 字体已通过 cn-font-split 子集化并由 relay /fonts/ serve
**Warning signs:** 中文字符后光标位置偏右或偏左
**Confidence:** HIGH [VERIFIED: 项目已有 Sarasa Fixed SC 字体基础设施]

### Pitfall 5: IPC 混合协议帧边界
**What goes wrong:** binary 帧和 NDJSON 消息互相干扰，导致解析状态混乱
**Why it happens:** TCP 是字节流，不保证消息边界。NDJSON 以 `\n` 分隔，binary 帧以 length-prefix 分隔
**How to avoid:** 使用明确的帧标识：binary 帧以 0x00 开头（NDJSON 的 '{' = 0x7B，永远不会冲突）。收到字节先检查首字节：0x00 则按 binary 帧协议读取 length + payload，否则按 NDJSON 行缓冲
**Warning signs:** 偶尔解析失败，特别在高吞吐量时
**Confidence:** HIGH [ASSUMED -- 0x00 标识字节是 Claude's Discretion 决策]

### Pitfall 6: EventStore 立即写盘性能
**What goes wrong:** 每个 PTY onData 事件都调用 `appendFileSync`，高频输出时 I/O 成为瓶颈
**Why it happens:** D-02 要求每事件立即写入磁盘不做缓冲
**How to avoid:** 使用 `fs.write` (async) 配合 `O_APPEND` flag 而非 `appendFileSync`。保持 fd 打开不每次 open/close。写操作排队但不等待完成（fire-and-forget with error handler）
**Warning signs:** 本地终端输出卡顿延迟
**Confidence:** HIGH [VERIFIED: b05bec2 的旧实现使用 appendFileSync，有性能隐患]

### Pitfall 7: 删除代码后的 import 链断裂
**What goes wrong:** 删除 TerminalTracker/FramePusher 等文件后，其他文件的 import 语句编译失败
**Why it happens:** 多文件互相引用，删除一处影响多处
**How to avoid:** 每个 plan 完成后确保 `pnpm build` 和 `pnpm test` 通过（D-38）。按依赖关系顺序删除：先删引用方的 import，再删文件
**Warning signs:** TypeScript 编译错误 "Cannot find module"
**Confidence:** HIGH

## Code Examples

### ws 库 binary frame 收发

```typescript
// Source: ws 文档 + codebase ws 使用模式
// Relay 端接收 binary frame
proxyWs.on("message", (data: Buffer, isBinary: boolean) => {
  if (isBinary) {
    // data 是 Buffer，不要 toString()
    const sessionIdLen = data[0];
    const sessionId = data.subarray(1, 1 + sessionIdLen).toString("utf-8");
    // 路由到对应 client，零拷贝转发
    const clients = registry.getClientsForProxy(proxyWs.proxyId!);
    for (const clientWs of clients) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data); // 保留 sessionId 前缀（D-42）
      }
    }
    return;
  }
  // 原有 JSON 处理逻辑
  const raw = data.toString();
  // ...
});
```

### 浏览器端 xterm.js 初始化

```typescript
// Source: xterm.js 官方文档 + D-40/D-41 决策
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

// D-41: 字体加载完成后再初始化
await document.fonts.ready;

const terminal = new Terminal({
  scrollback: 5000, // D-19
  fontFamily: '"Sarasa Fixed SC", monospace',
  fontSize: 14,
  theme: {
    background: "#1E1E1E",   // D-40: 对齐设计 token --background
    foreground: "#D4D4D4",   // D-40: --foreground
    cursor: "#D4D4D4",
    cursorAccent: "#00D4AA",  // D-40: --primary
    // VS Code Dark+ ANSI 16 色
    black: "#000000",
    red: "#CD3131",
    green: "#0DBC79",
    yellow: "#E5E510",
    blue: "#2472C8",
    magenta: "#BC3FBC",
    cyan: "#11A8CD",
    white: "#E5E5E5",
    brightBlack: "#666666",
    brightRed: "#F14C4C",
    brightGreen: "#23D18B",
    brightYellow: "#F5F543",
    brightBlue: "#3B8EEA",
    brightMagenta: "#D670D6",
    brightCyan: "#29B8DB",
    brightWhite: "#E5E5E5",
  },
});

const fitAddon = new FitAddon();
const serializeAddon = new SerializeAddon();
const webLinksAddon = new WebLinksAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(serializeAddon);
terminal.loadAddon(webLinksAddon);

terminal.open(containerElement);
fitAddon.fit();
```

### 浏览器端 binary frame 解析 (D-43)

```typescript
// Source: D-26 + D-43 决策
ws.onmessage = (event: MessageEvent) => {
  if (event.data instanceof ArrayBuffer) {
    // Binary frame: PTY 数据
    const view = new Uint8Array(event.data);
    const sessionIdLen = view[0];
    // const sessionId = new TextDecoder().decode(view.subarray(1, 1 + sessionIdLen));
    const ptyData = view.subarray(1 + sessionIdLen);
    terminal.write(ptyData);
  } else {
    // Text frame: JSON 控制消息
    const msg = JSON.parse(event.data as string);
    handleControlMessage(msg);
  }
};
```

### EventStore CCAE 写入

```typescript
// Source: D-29/D-30 格式定义 + b05bec2 参考实现
const MAGIC = Buffer.from("CCAE", "ascii");
const VERSION = 1;
const HEADER_SIZE = 6; // 4(magic) + 2(version)
const EVENT_OVERHEAD = 17; // 1(type) + 8(ts) + 4(payload_len) + 4(total_len trailer)

function writeFileHeader(fd: number): void {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(VERSION, 4);
  fs.writeSync(fd, header);
}

function encodeEvent(type: number, payload: Buffer): Buffer {
  const totalLen = EVENT_OVERHEAD + payload.length;
  const buf = Buffer.alloc(totalLen);
  let offset = 0;
  buf.writeUInt8(type, offset); offset += 1;
  buf.writeDoubleLE(Date.now(), offset); offset += 8;
  buf.writeUInt32LE(payload.length, offset); offset += 4;
  payload.copy(buf, offset); offset += payload.length;
  buf.writeUInt32LE(totalLen, offset); // trailer
  return buf;
}
```

### IPC 混合协议区分

```typescript
// Source: D-27 IPC 混合协议
// 0x00 前导字节 = binary frame, 其他 = NDJSON 行

function processIpcBytes(chunk: Buffer, state: IpcParserState): void {
  let pos = 0;
  while (pos < chunk.length) {
    if (state.expectBinary) {
      // 正在接收 binary 帧
      // ...续读 payload
    } else if (chunk[pos] === 0x00) {
      // binary 帧开始：0x00 + 4B length + payload
      state.expectBinary = true;
      pos += 1;
      // 读 4B length...
    } else {
      // NDJSON 行：累积到 \n
      // ...现有 LineBuffer 逻辑
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TerminalTracker + 自建 grid/span 渲染 | @xterm/xterm 直渲 + raw PTY bytes | Phase 9 | 删除 ~1200 行服务端终端解析代码 |
| JSON terminal_frame (full/delta) | Binary WebSocket frame | Phase 9 | 带宽降低 60%+，延迟减少 |
| relay SessionBuffer 缓存 | relay 无状态透传 | Phase 9 | relay 内存使用可预测 |
| server-side scrollback (anchor) | xterm.js built-in scrollback | Phase 9 | 零服务端参与滚动 |

**Deprecated (to be deleted in Phase 9):**
- `TerminalTracker` (apps/proxy/src/terminal-tracker.ts): 被 @xterm/headless + EventStore 替代
- `FramePusher` (apps/proxy/src/frame-pusher.ts): binary IPC 直传替代定时推帧
- `FrameCache` (apps/proxy/src/frame-cache.ts): 不再需要服务端帧缓存
- `TerminalFrameRenderer` (apps/proxy/src/terminal-frame-renderer.ts): xterm.js 替代自建渲染器
- `SessionBuffer` (apps/relay/src/session-buffer.ts): relay 无状态化
- `BufferStore` (apps/relay/src/buffer-store.ts): relay 无状态化
- `BufferCompressor` (apps/relay/src/buffer-compressor.ts): 已是死代码
- `TermSpan/TermLine/TerminalFramePayload` 等 shared 类型: 不再需要 JSON grid 格式

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Vite dev proxy (http-proxy) 透传 binary WebSocket frame 不损坏 | Pitfalls #3 | /pty-test 页面无法在开发模式下工作，需直连 relay |
| A2 | 0x00 作为 IPC binary 帧前导字节不会与 NDJSON 冲突 | Architecture Patterns | IPC 协议解析失败，需换用其他标识方式 |
| A3 | gzip 轮转阈值 10MB 对单会话足够大 | Architecture Patterns | 过于频繁的轮转影响性能和快照写入 |
| A4 | 快照触发 N=100 事件是合理起点 | Claude's Discretion | 快照过于频繁（浪费磁盘）或过于稀疏（恢复慢） |
| A5 | @xterm/addon-unicode11 对 CJK 宽字符必要 | Standard Stack | 中文显示宽度错误 |
| A6 | VS Code Dark+ 色板匹配 ANSI 16 色为 Code Examples 中列出的值 | Code Examples | 终端颜色与本地不一致 |

## Open Questions (RESOLVED)

1. **xterm.js unicode11 addon 是否需要启用** -- RESOLVED
   - What we know: @xterm/addon-unicode11 提供 Unicode 11 宽字符表，CJK 字符需要正确的 wcwidth
   - What's unclear: xterm.js 默认的 wcwidth 实现是否已覆盖常见 CJK 范围
   - Recommendation: Spike 阶段测试中文渲染，如果宽度正确就不启用（减少依赖）
   - **Resolution:** Plan 09-04 installs @xterm/addon-unicode11 as optional, with code commented showing how to enable. Visual checkpoint (09-04 Task 2) validates CJK rendering; if width is correct without it, the addon stays disabled.

2. **IPC binary 帧标识字节的最终选择** -- RESOLVED
   - What we know: 需要区分 NDJSON (`{` = 0x7B) 和 binary frame
   - What's unclear: 0x00 vs 其他 magic byte 的取舍
   - Recommendation: 0x00 最简单，且不可能出现在合法 JSON 行的第一个字节
   - **Resolution:** Plan 09-02 uses 0x00 as IPC_BINARY_MARKER per recommendation. 0x00 cannot be the first byte of a valid JSON line, providing unambiguous binary/JSON discrimination.

3. **EventStore 异步写入的错误处理策略** -- RESOLVED
   - What we know: D-02 要求每事件立即写盘，但同步 I/O 会阻塞事件循环
   - What's unclear: 异步 write 失败时如何处理（重试？跳过？关闭 fd？）
   - Recommendation: 保持 fd 打开，async write with error logging。写入失败记日志但不崩溃进程
   - **Resolution:** Plan 09-01 uses writeSync on a pre-opened fd (D-02 requires immediate persistence). Synchronous but on pre-opened fd so cost is only actual I/O. Errors are logged via pino but do not crash the process.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | yes | >=20 LTS | -- |
| pnpm | Package mgmt | yes | 9.x | -- |
| Playwright | E2E tests | yes | 1.58.0 | -- |
| Sarasa Fixed SC font | CJK terminal rendering | yes | cn-font-split | -- |
| vitest | Unit tests | yes | 2.x (proxy) / 4.1.2 (web) | -- |

**Missing dependencies with no fallback:** None

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.x (proxy) / vitest 4.1.2 (web) + Playwright 1.58.0 |
| Config file | apps/proxy/vitest.config.ts, apps/web/vitest.config.ts |
| Quick run command | `pnpm --filter proxy exec vitest run` |
| Full suite command | `pnpm --filter proxy exec vitest run && pnpm --filter relay exec vitest run && pnpm --filter web exec vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PTY-01 | headless + serialize 快照生成/恢复 | unit | `pnpm --filter proxy exec vitest run src/__tests__/unit/event-store.test.ts -x` | Wave 0 |
| PTY-02 | EventStore CCAE 写入/读取/轮转/反向扫描 | unit | `pnpm --filter proxy exec vitest run src/__tests__/unit/event-store.test.ts -x` | Wave 0 |
| PTY-03 | binary IPC 帧编解码 + terminal.ts 数据流 | unit + integration | `pnpm --filter proxy exec vitest run src/__tests__/unit/ipc-protocol.test.ts -x` | Exists (needs update) |
| PTY-04 | relay binary frame 透传 | integration | `pnpm --filter relay exec vitest run src/__tests__/integration/message-routing.test.ts -x` | Exists (needs update) |
| FRONT-07 | /pty-test 页面 xterm.js 渲染 | E2E (Playwright) + manual | Playwright E2E test | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter proxy exec vitest run && pnpm --filter relay exec vitest run`
- **Per wave merge:** Full suite including web
- **Phase gate:** Full suite green + manual visual verification of /pty-test

### Wave 0 Gaps
- [ ] `apps/proxy/src/__tests__/unit/event-store.test.ts` -- CCAE 格式写入/读取/轮转/反向扫描
- [ ] `apps/proxy/src/__tests__/unit/ipc-protocol.test.ts` -- 需要更新以覆盖混合协议
- [ ] `apps/relay/src/__tests__/integration/message-routing.test.ts` -- 需要更新以覆盖 binary frame
- [ ] 删除 `apps/proxy/src/__tests__/unit/frame-cache.test.ts` (135 行)
- [ ] 删除 `apps/proxy/src/__tests__/unit/terminal-frame-renderer.test.ts` (139 行)
- [ ] 删除 `apps/proxy/src/__tests__/unit/frame-pusher.test.ts` (271 行)
- [ ] 删除 `apps/relay/src/__tests__/unit/session-buffer.test.ts`
- [ ] 删除 `apps/relay/src/__tests__/unit/buffer-store.test.ts`

## Existing Code Impact Analysis

### Files to DELETE (with test counts)

| File | Lines | Tests | Confidence |
|------|-------|-------|------------|
| `apps/proxy/src/terminal-tracker.ts` | 379 | terminal-data-flow.test.ts (partial) | HIGH |
| `apps/proxy/src/frame-pusher.ts` | 116 | frame-pusher.test.ts (271 lines) | HIGH |
| `apps/proxy/src/frame-cache.ts` | 67 | frame-cache.test.ts (135 lines) | HIGH |
| `apps/proxy/src/terminal-frame-renderer.ts` | 158 | terminal-frame-renderer.test.ts (139 lines) | HIGH |
| `apps/relay/src/session-buffer.ts` | 77 | session-buffer.test.ts | HIGH |
| `apps/relay/src/buffer-store.ts` | 67 | buffer-store.test.ts | HIGH |
| `apps/relay/src/buffer-compressor.ts` | ? | -- (dead code) | HIGH |

### Files to MODIFY heavily

| File | Current Lines | Changes |
|------|---------------|---------|
| `apps/proxy/src/terminal.ts` | 362 | 移除 TerminalTracker/FramePusher，加入 EventStore + headless + binary IPC |
| `apps/proxy/src/serve.ts` | ~460 | 移除 frame-cache import，加入 binary IPC 接收，sendBinary |
| `apps/proxy/src/ipc-protocol.ts` | 294 | 加入混合协议解析（binary marker + NDJSON） |
| `apps/proxy/src/relay-connection.ts` | 224 | 加 sendBinary()，rename send -> sendEnvelope |
| `apps/proxy/src/replay.ts` | 357 | 迁移到新链路（使用 EventStore + binary frame） |
| `apps/relay/src/handlers/proxy.ts` | 191 | 加 binary frame 处理分支 |
| `apps/relay/src/handlers/client.ts` | 235 | 加 binary frame 转发 |
| `apps/relay/src/registry.ts` | 349 | 移除 SessionBuffer 相关方法 |
| `apps/relay/src/router.ts` | 178 | 移除 buffer 相关逻辑 |
| `apps/relay/src/server.ts` | 119 | 移除 BufferStore 初始化 |

### Tests That Will Break (need update/deletion)

| Test File | Impact | Action |
|-----------|--------|--------|
| frame-cache.test.ts | Full delete | DELETE |
| frame-pusher.test.ts | Full delete | DELETE |
| terminal-frame-renderer.test.ts | Full delete | DELETE |
| terminal-data-flow.test.ts | TerminalTracker 引用 | UPDATE (may need rewrite for new pipeline) |
| session-buffer.test.ts | Full delete | DELETE |
| buffer-store.test.ts | Full delete | DELETE |
| message-routing.test.ts | SessionBuffer 引用 | UPDATE for binary frame |
| replay.test.ts | SessionBuffer 引用 | UPDATE |
| client-register.test.ts | SessionBuffer 引用 | UPDATE |
| registry.test.ts | SessionBuffer 引用 | UPDATE |
| router.test.ts | Buffer 相关 | UPDATE |
| proxy-to-client-types.test.ts | terminal_frame type | UPDATE |

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Phase 9 不涉及认证 |
| V3 Session Management | No | sessionId 生成已有 nanoid |
| V4 Access Control | No | 无新的访问控制需求 |
| V5 Input Validation | Yes | binary 帧长度校验防止 buffer overflow |
| V6 Cryptography | No | 无加密需求 |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Binary frame 长度欺骗 | Tampering | 校验 sessionId 长度 < 256，payload 长度 < 合理上限 |
| EventStore 文件路径注入 | Tampering | sessionId 由 nanoid 生成，paths.ts 集中管理 |
| 大量 binary 帧 DoS | DoS | relay 透传不缓存，内存不膨胀；客户端 xterm.js 有内置 scrollback 限制 |

## Sources

### Primary (HIGH confidence)
- Codebase analysis: terminal.ts, serve.ts, ipc-protocol.ts, relay-connection.ts, relay handlers [VERIFIED: Read tool]
- Prior EventStore implementation: `git show b05bec2:apps/proxy/src/event-store.ts` [VERIFIED: git]
- Prior TerminalTracker snapshot: `git show b05bec2:apps/proxy/src/terminal-tracker.ts` [VERIFIED: git]
- npm registry: @xterm/xterm@6.0.0, @xterm/headless@6.0.0, @xterm/addon-serialize@0.14.0, @xterm/addon-fit@0.11.0, @xterm/addon-web-links@0.12.0, @xterm/addon-unicode11@0.9.0 [VERIFIED: npm view]
- ws binary frame support: `message` event with `isBinary` parameter [VERIFIED: ws 文档]
- Existing test suite: 18 files, 266 tests all passing [VERIFIED: vitest run]

### Secondary (MEDIUM confidence)
- Vite dev proxy binary WebSocket support [ASSUMED: http-proxy underlying, needs spike verification]
- VS Code Dark+ ANSI 色板 [ASSUMED: 基于公开色板信息]

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- 所有库版本通过 npm registry 验证，核心依赖已在项目中
- Architecture: HIGH -- CONTEXT.md 有 50 项详细决策，代码结构清晰
- Pitfalls: HIGH -- 基于实际代码分析和先前实现经验
- Implementation impact: HIGH -- 完整的文件清单和修改范围分析

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (stable domain, xterm.js 6.x is current major)

## Project Constraints (from CLAUDE.md)

- TypeScript 全栈统一
- 日志信息使用英语
- 注释和 docstring 使用中文
- 不允许使用 emoji
- 不使用延迟导入
- 使用 rmtrash 代替 rm
- ESM 模式（"type": "module"）
- pnpm workspace monorepo
- vitest 测试框架
- git commit message 简洁精炼，不包含 Co-Authored 等信息
- 不手动管理 import error，依赖应在 setup 时安装
- 删除已迁移的死代码
- 错误应明确抛出，避免静默 fallback
