#!/usr/bin/env node
// emu-debug — Android emulator + Chrome 远程调试小工具集合.
//
// 前置条件:
//   1. emulator 已启动 (`emulator -list-avds` 选一个跑起来)
//   2. `adb reverse tcp:5173 tcp:5173` 已建 (web dev server 直通)
//   3. 已在 Chrome 里 `chrome://inspect` 见到 tab 即说明 devtools 通了
//
// 用法 (从仓库根跑):
//   node scripts/tools/emu-debug.mjs forward            # 起 adb forward 9222 -> chrome
//   node scripts/tools/emu-debug.mjs nav <url>          # 用 intent 在模拟器 Chrome 打 URL
//   node scripts/tools/emu-debug.mjs tabs               # 列出当前 Chrome tabs
//   node scripts/tools/emu-debug.mjs screenshot [path]  # 截屏到本机 (默认 /tmp/emu-<ts>.png)
//   node scripts/tools/emu-debug.mjs eval "<js>"        # 在选中 tab 里跑 JS, 结果 JSON.stringify
//   node scripts/tools/emu-debug.mjs metrics            # 读 PTY 容器/spacer/host/buffer 关键尺寸
//   node scripts/tools/emu-debug.mjs trace [n]          # 读 window.__ptyScrollTrace 最后 n 条 (默认 30)
//   node scripts/tools/emu-debug.mjs console [ms]       # 订阅 console 消息 ms 毫秒 (默认 5000)
//   node scripts/tools/emu-debug.mjs scroll <px>        # 把 PTY 容器 scrollTop 设到 px (用于复现)
//   node scripts/tools/emu-debug.mjs tap <x> <y>        # adb tap, 用绝对坐标
//   node scripts/tools/emu-debug.mjs reload             # tab reload
//
// 选 tab: 默认挑 url 含 "localhost:5173" 的第一个; 可用 EMU_TAB_FILTER 环境变量改 substring.
// 例: EMU_TAB_FILTER=chat node scripts/tools/emu-debug.mjs metrics
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = Number(process.env.EMU_CDP_PORT ?? 9222);
const TAB_FILTER = process.env.EMU_TAB_FILTER ?? "localhost:5173";

function adb(args, opts = {}) {
  const r = spawnSync("adb", args, { encoding: "utf-8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`adb ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

async function listTabs() {
  const r = await fetch(`http://localhost:${CDP_PORT}/json`);
  if (!r.ok) throw new Error(`CDP /json HTTP ${r.status} - 是不是没跑 forward?`);
  return r.json();
}

async function pickTab() {
  const tabs = await listTabs();
  const match = tabs.find((t) => (t.url ?? "").includes(TAB_FILTER));
  if (!match) {
    throw new Error(
      `没找到匹配 "${TAB_FILTER}" 的 tab. 当前 tabs:\n` +
        tabs.map((t) => `  - ${t.id} ${t.url}`).join("\n"),
    );
  }
  return match;
}

class CdpSession {
  constructor(wsUrl) {
    if (typeof WebSocket !== "function") {
      throw new Error("emu-debug requires Node 22+ with global WebSocket support");
    }
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleHandlers = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket connection failed")),
        {
          once: true,
        },
      );
    });
    this.ws.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(
              event.data instanceof ArrayBuffer ? event.data : String(event.data),
            ).toString();
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} (${m.error.code})`));
        else p.resolve(m.result);
      } else if (m.method === "Runtime.consoleAPICalled") {
        for (const h of this.consoleHandlers) h(m.params);
      } else if (m.method === "Log.entryAdded") {
        for (const h of this.consoleHandlers)
          h({ type: "log", args: [{ value: m.params.entry.text }] });
      }
    });
  }
  send(method, params = {}) {
    const i = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(i, { resolve, reject });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  onConsole(h) {
    this.consoleHandlers.push(h);
  }
  close() {
    this.ws.close();
  }
}

async function attach() {
  const tab = await pickTab();
  const sess = new CdpSession(tab.webSocketDebuggerUrl);
  await sess.ready;
  await sess.send("Runtime.enable");
  return { tab, sess };
}

async function evalExpr(expr, { awaitPromise = false } = {}) {
  const { sess } = await attach();
  const r = await sess.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    timeout: 5000,
  });
  sess.close();
  if (r.exceptionDetails) {
    throw new Error(
      `eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  }
  return r.result?.value;
}

const cmds = {
  async forward() {
    adb(["forward", "tcp:" + CDP_PORT, "localabstract:chrome_devtools_remote"]);
    console.log(`adb forward tcp:${CDP_PORT} -> chrome_devtools_remote 已建`);
  },
  async tabs() {
    const tabs = await listTabs();
    for (const t of tabs) console.log(`${t.id}\t${t.type}\t${t.url}`);
  },
  async nav(url) {
    if (!url) throw new Error("用法: nav <url>");
    adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
    console.log("intent 已发, 等 ~2s 让 Chrome 加载...");
    await new Promise((r) => setTimeout(r, 2000));
  },
  async screenshot(path) {
    const out = path ?? `/tmp/emu-${Date.now()}.png`;
    const r = adb(["exec-out", "screencap", "-p"], { encoding: "buffer" });
    writeFileSync(out, r.stdout);
    console.log(out);
  },
  async eval(expr) {
    if (!expr) throw new Error("用法: eval <js>");
    const v = await evalExpr(expr);
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  },
  async metrics() {
    const expr = `(() => {
      const sel = (s) => document.querySelector(s);
      const c = sel('[data-pty-scroll-container]') ?? sel('.pty-host')?.parentElement;
      const host = sel('.pty-host') ?? sel('.xterm');
      const xtermViewport = sel('.xterm-viewport');
      const xtermScreen = sel('.xterm-screen');
      const term = window.__ptyTerminal ?? null;
      const buf = term?.buffer?.active;
      const dims = (e) => e ? { w: e.clientWidth, h: e.clientHeight, sw: e.scrollWidth, sh: e.scrollHeight, st: e.scrollTop, sl: e.scrollLeft, rect: e.getBoundingClientRect().toJSON() } : null;
      return {
        viewport: { iw: window.innerWidth, ih: window.innerHeight, vv: window.visualViewport ? { w: window.visualViewport.width, h: window.visualViewport.height, ot: window.visualViewport.offsetTop } : null },
        container: dims(c),
        host: dims(host),
        xtermViewport: dims(xtermViewport),
        xtermScreen: dims(xtermScreen),
        term: term ? {
          rows: term.rows, cols: term.cols,
          bufferLength: buf?.length, viewportY: buf?.viewportY, baseY: buf?.baseY, cursorX: buf?.cursorX, cursorY: buf?.cursorY,
        } : null,
      };
    })()`;
    const v = await evalExpr(expr);
    console.log(JSON.stringify(v, null, 2));
  },
  async trace(n) {
    const limit = Number(n ?? 30);
    const expr = `(() => {
      const t = window.__devAnywherePtyScrollTrace;
      if (!t) return { error: 'no __devAnywherePtyScrollTrace; 是否带了 ?ptyScrollTrace=1?' };
      const list = Array.isArray(t) ? t : (typeof t.entries === 'function' ? Array.from(t.entries()) : []);
      return { total: list.length, last: list.slice(-${limit}) };
    })()`;
    const v = await evalExpr(expr);
    console.log(JSON.stringify(v, null, 2));
  },
  async console(ms) {
    const dur = Number(ms ?? 5000);
    const { sess } = await attach();
    sess.onConsole((p) => {
      const args = (p.args ?? []).map(
        (a) => a.value ?? a.description ?? a.unserializableValue ?? "?",
      );
      console.log(`[${p.type}] ${args.join(" ")}`);
    });
    await sess.send("Log.enable");
    console.log(`订阅 ${dur}ms ...`);
    await new Promise((r) => setTimeout(r, dur));
    sess.close();
  },
  async scroll(px) {
    if (px == null) throw new Error("用法: scroll <px>");
    const expr = `(() => {
      const c = document.querySelector('[data-pty-scroll-container]') ?? document.querySelector('.xterm-viewport');
      if (!c) return { error: 'container not found' };
      c.scrollTop = ${Number(px)};
      return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
    })()`;
    console.log(JSON.stringify(await evalExpr(expr), null, 2));
  },
  async tap(x, y) {
    if (x == null || y == null) throw new Error("用法: tap <x> <y>");
    adb(["shell", "input", "tap", String(x), String(y)]);
  },
  async reload() {
    const { sess } = await attach();
    await sess.send("Page.enable");
    await sess.send("Page.reload", { ignoreCache: false });
    sess.close();
  },
};

const [, , cmd, ...args] = process.argv;
const fn = cmds[cmd];
if (!fn) {
  const list = Object.keys(cmds).join(", ");
  console.error(`未知子命令 '${cmd ?? ""}'. 可用: ${list}`);
  process.exit(2);
}
fn(...args).catch((e) => {
  console.error(String(e));
  process.exit(1);
});
