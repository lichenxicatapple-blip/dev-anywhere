# PTY Streaming Architecture Redesign

> 2026-04-16 设计讨论结论，用于后续实现追溯。

## 问题

旧设计把 PTY 数据的「实时转发」和「状态恢复」混在一起，导致架构纠结：

- **双数据源**：EventStore（文件）和 IPC（进程间通信）是两条独立管道，同步靠祈祷
- **双通道**：snapshot 走 JSON，PTY data 走 binary，两者无共享序号，对齐困难
- **职责混乱**：EventStore 既用于崩溃恢复又用于实时订阅，两个场景需求不同却共用一套机制

本质上这是个经典的 IM 消息追赶场景（服务端有完整消息，客户端按需追赶），但旧设计没有按这个模式来。

## 核心决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 实时订阅的数据源 | HeadlessTerminal.serialize() | 内存中的实时状态，不依赖文件 I/O |
| EventStore | 删除 | PTY 会话崩溃后 node-pty 进程已死，恢复终端内容无意义；Claude Code 会话通过 `claude --resume` 恢复 |
| snapshot 投递方式 | JSON 定向发给请求方 | per-client 按需生成，不干扰其他 client |
| PTY data 投递方式 | binary 广播 | 所有 client 共享同一条增量流 |
| 同步保证 | 同一条 WebSocket 的 text/binary 消息天然有序 | 不需要暂停、不需要序号、不需要双通道协调 |
| binary 帧格式 | 不变：`[1B sidLen][sid][ptyData]` | 不需要加 type 字节 |

## 进程架构

```
Terminal(terminal.ts)  ←→  Serve(serve.ts)  ←→  Relay  ←→  Client A
    独立进程                   独立进程                       Client B
    Unix socket 通信           WebSocket 通信                 Client C
    detached, unref()          detached, unref()
```

- Terminal 和 Serve 通过 Unix domain socket 双向通信，互相独立
- Serve 崩溃后 Terminal 存活，Serve 重启后通过 `reconnectWorkers()` 重连
- Terminal 不感知 client 的存在，只做两件事：持续推 PTY data + 收到请求就 serialize()

## 场景时序

### 场景 1：首次订阅

```
Client A             Relay            Serve             Terminal
  |                    |                |                   |
  | subscribe(sid) --->| forward ------>|                   |
  |                    |                | IPC: subscribe -->|
  |                    |                |                   | serialize() [同步]
  |                    |                |<-- snapshot JSON --|
  |<-- JSON snapshot --|<-- JSON -------|                   |
  | apply snapshot     |                |                   |
  |                    |                |  [下一tick: PTY输出]
  |                    |                |<-- binary 0x00 ---|
  |<-- binary 0x00 ----|<-- binary -----|                   |
  | write to xterm     |                |                   |
```

Client 逻辑：subscribe 后丢弃所有 binary，收到 JSON snapshot 后 apply，之后 binary 写入 xterm。

### 场景 2：用户远程输入

```
Client A             Relay            Serve             Terminal
  |                    |                |                   |
  | binary [sid+input]>| forward ------>|                   |
  |                    |                | IPC: input ------>|
  |                    |                |                   | pty.write(input)
  |                    |                |                   | [PTY 产生输出]
  |                    |                |<-- binary 0x00 ---|
  |<-- binary 0x00 ----|<-- binary -----|                   |
```

需新增：relay client->proxy binary 转发（目前 client.ts 里是 `return` 丢弃的）。

### 场景 3：client 断线重连

和场景 1 完全一致。HeadlessTerminal 始终在内存中保持最新状态，重连就是再做一次 subscribe。

### 场景 4：serve 崩溃重启

```
Terminal                  Serve(new)        Relay           Client
  | [存活]                  | [启动]          |                |
  | [sock 仍在监听]          |                |                |
  |                        | reconnect ----->|                |
  |<-- 重连 Unix socket ----|                |                |
  |                        | proxy_register->|                |
  |                        |                |-- proxy_online->|
  |                        |                |                |
  |                        |                |<- subscribe ----|
  |                        |<-- forward ----|                |
  |<-- IPC: subscribe -----|                |                |
  | serialize()            |                |                |
  |-- snapshot JSON ------>|-- JSON ------->|-- forward ---->|
  |-- binary 0x00 -------->|-- binary ----->|-- broadcast -->|
```

HeadlessTerminal 在 Terminal 进程内存里，不受 Serve 崩溃影响。

### 场景 5：终端尺寸变化

```
Terminal              Serve            Relay           Client
  | [本地窗口 resize]   |                |                |
  | pty.resize(c,r)    |                |                |
  | headless.resize(c,r)|               |                |
  | IPC: resize ------->|                |                |
  |                     | terminal_resize>|                |
  |                     |                |-- forward ---->|
  |                     |                |                | xterm.resize(c,r)
```

resize 从 Terminal 发出，client 被动接受。

## 多 client 行为

- snapshot 是 per-client 的：每个 client 订阅时独立触发一次 serialize()，JSON 只发给请求方
- broadcast 是共享的：所有已连接的 client 收到相同的 PTY data binary 帧
- client 之间完全不影响：A 断线重连不影响 B，B 订阅不影响 A
- 每个 client 的逻辑独立：snapshot(自己时间点的全量) + 之后的增量 = 当前终端状态

## 需要改动的点

| 改动 | 说明 |
|------|------|
| 删除 EventStore | `apps/proxy/src/event-store.ts` 及所有引用 |
| Terminal 处理 subscribe IPC | 收到后同步 serialize()，返回 snapshot 数据 |
| Serve 转发 snapshot | 收到 Terminal 的 snapshot 后作为 JSON 发给请求方 client |
| relay client->proxy binary | `apps/relay/src/handlers/client.ts` 打通 binary 转发，支持远程输入 |
| 删除 snapshot JSON 协议 | `terminal_snapshot_request/response` 从 RelayControlSchema 移除，替换为 `session_subscribe` |
| Client subscribe 逻辑 | subscribe 后丢弃 binary 直到 snapshot 到达，之后正常写入 |

## 不需要改动的点

- binary 帧格式：`[1B sidLen][sid][ptyData]` 保持不变
- relay binary 广播逻辑：保持 proxy->client 广播，不做 per-session 过滤
- Terminal 进程生命周期：已经是 detached + Unix socket，不需要改
- reconnectWorkers()：已支持 serve 重启后重连 worker
