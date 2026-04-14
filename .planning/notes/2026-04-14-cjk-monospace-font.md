---
date: "2026-04-14 10:40"
promoted: false
---

终端表格中文对齐问题：CJK 字符在浏览器 monospace 字体下宽度不是 ASCII 的 2 倍，导致表格线错位。需要找一个 web + 移动端都能用的 CJK 等宽字体。候选：Sarasa Mono SC（更纱黑体）、Noto Sans Mono CJK SC。可能需要用 webfont 加载确保跨平台一致。如果字体方案不够精确，退路是对 CJK 字符逐字包 span + width:2ch。
