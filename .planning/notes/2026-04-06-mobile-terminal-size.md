---
date: "2026-04-06 04:35"
promoted: false
---

手机端渲染终端时必须使用电脑端的实际终端尺寸（来自SIZE事件），不能自定义cols/rows。手机只是viewer+input forwarder，PTY尺寸完全由电脑端决定。横竖屏切换只影响CSS缩放比例，不影响终端内容。
