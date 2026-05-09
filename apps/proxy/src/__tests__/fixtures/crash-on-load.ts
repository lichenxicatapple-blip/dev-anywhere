// 模拟"子进程 logger 还没准备好就崩"的场景：top-level throw 发生在 module 加载期间，
// 子进程里任何用户代码（含 logger 初始化）都来不及跑。Node runtime 把 Error 栈写到 stderr 后退出 1。
throw new Error("crash-on-load");
