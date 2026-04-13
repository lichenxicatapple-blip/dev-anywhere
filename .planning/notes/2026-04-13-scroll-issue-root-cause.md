---
date: "2026-04-13 17:30"
promoted: false
---

# 滚动问题根因

## 症状
chat 页面打开后黑屏，无法滚动。

## 根因（两个叠加）

1. **Terminal 进程已退出**：PTY session 在 SessionManager 里还活着（从持久化恢复），但 terminal 进程已经不在了。没有进程在推帧，frameCache 永远为空。

2. **Relay 用旧 shared 包**：relay 进程用的是 shared 包 rebuild 之前的 RelayControlSchema。terminal_frame 消息虽然在 schema 里定义了，但 relay 的旧 schema 校验不匹配，帧被当作 Invalid message 拒绝。

## 验证
重启 relay（加载新 shared 包）+ 创建新的活跃 terminal session 后，帧从 terminal → serve → relay → client 全链路通畅，30 行终端内容正常渲染。

## 教训
- shared 包 rebuild 后，所有依赖它的进程（relay、proxy）都必须重启
- 孤儿 PTY session 需要有检测和清理机制（目前 reaper 只检测 JSON session 的 worker pid）
