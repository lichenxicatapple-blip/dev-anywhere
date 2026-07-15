#!/usr/bin/env node
// iPad Safari WebKit remote-debug helper.
//
// 前置条件:
//   1. iPad 已开启 Safari Web Inspector, 且 Safari 里打开了目标页面
//   2. 本机已运行 ios_webkit_debug_proxy, 例如:
//      ios_webkit_debug_proxy -u <udid>:9222-9222 -F
//
// 用法 (从仓库根跑):
//   node scripts/tools/ipad-webkit-debug.mjs tabs
//   node scripts/tools/ipad-webkit-debug.mjs eval "location.href"
//   node scripts/tools/ipad-webkit-debug.mjs state
//   node scripts/tools/ipad-webkit-debug.mjs metrics
//   node scripts/tools/ipad-webkit-debug.mjs elements
//   node scripts/tools/ipad-webkit-debug.mjs click 新建
//   node scripts/tools/ipad-webkit-debug.mjs fill 工作目录 /Users/catli
//   node scripts/tools/ipad-webkit-debug.mjs wait-text 新建
//   node scripts/tools/ipad-webkit-debug.mjs screenshot /tmp/ipad.png
//   node scripts/tools/ipad-webkit-debug.mjs reload
//
// 选 tab: 默认挑 title/url 含 "dev-anywhere" 的第一个;
// 可用 IPAD_TAB_FILTER 环境变量改 substring.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const WEBKIT_PORT = Number(process.env.IPAD_WEBKIT_PORT ?? 9222);
const TAB_FILTER = (process.env.IPAD_TAB_FILTER ?? "dev").toLowerCase();
const TARGET_TYPE = process.env.IPAD_TARGET_TYPE ?? "page";
const REQUEST_TIMEOUT_MS = Number(process.env.IPAD_DEBUG_TIMEOUT_MS ?? 5000);
const SKIP_RUNTIME_ENABLE = process.env.IPAD_SKIP_RUNTIME_ENABLE === "1";

function requireWebSocket() {
  if (typeof WebSocket !== "function") {
    throw new Error("ipad-webkit-debug requires Node 22+ with global WebSocket support");
  }
}

async function listTabs() {
  const r = await fetch(`http://127.0.0.1:${WEBKIT_PORT}/json`);
  if (!r.ok) {
    throw new Error(
      `ios_webkit_debug_proxy /json HTTP ${r.status}. ` +
        `确认代理是否运行在 ${WEBKIT_PORT} 端口。`,
    );
  }
  return r.json();
}

async function pickTab() {
  const tabs = await listTabs();
  const pages = tabs.filter((tab) => tab.webSocketDebuggerUrl);
  const match = pages.find((tab) => {
    const haystack = `${tab.title ?? ""} ${tab.url ?? ""}`.toLowerCase();
    return haystack.includes(TAB_FILTER);
  });

  if (match) return match;

  throw new Error(
    `没找到匹配 "${TAB_FILTER}" 的 iPad Safari tab. 当前 targets:\n` +
      (tabs.length
        ? tabs.map((tab) => `  - ${tab.title || "(untitled)"}\t${tab.url}`).join("\n")
        : "  (empty; iPad 是否解锁并打开了 Safari 页面?)"),
  );
}

function readMessageData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  return Buffer.from(String(data)).toString("utf-8");
}

function withTimeout(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

class WebKitSession {
  constructor(wsUrl) {
    requireWebSocket();
    this.ws = new WebSocket(wsUrl);
    this.outerId = 0;
    this.innerId = 1000;
    this.pendingOuter = new Map();
    this.pendingInner = new Map();
    this.targets = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new Error("iPad WebKit WebSocket connection failed")),
        { once: true },
      );
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
  }

  handleMessage(event) {
    const msg = JSON.parse(readMessageData(event.data));

    if (msg.id && this.pendingOuter.has(msg.id)) {
      const pending = this.pendingOuter.get(msg.id);
      this.pendingOuter.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else pending.resolve(msg.result ?? {});
      return;
    }

    if (msg.method === "Target.targetCreated") {
      const targetInfo = msg.params?.targetInfo;
      if (targetInfo?.targetId) this.targets.set(targetInfo.targetId, targetInfo);
      return;
    }

    if (msg.method === "Target.targetDestroyed") {
      const targetId = msg.params?.targetId;
      if (targetId) this.targets.delete(targetId);
      return;
    }

    if (msg.method !== "Target.dispatchMessageFromTarget") return;

    const targetId = msg.params?.targetId;
    const inner = JSON.parse(msg.params?.message ?? "{}");
    if (!inner.id || !this.pendingInner.has(inner.id)) return;

    const pending = this.pendingInner.get(inner.id);
    this.pendingInner.delete(inner.id);
    if (inner.error) pending.reject(new Error(`${inner.error.message} (${inner.error.code})`));
    else pending.resolve({ targetId, result: inner.result ?? {} });
  }

  sendOuter(method, params = {}) {
    const id = ++this.outerId;
    const payload = JSON.stringify({ id, method, params });
    return withTimeout(
      new Promise((resolve, reject) => {
        this.pendingOuter.set(id, { resolve, reject });
        this.ws.send(payload);
      }),
      method,
    );
  }

  sendInner(targetId, method, params = {}) {
    const id = ++this.innerId;
    const innerMessage = JSON.stringify({ id, method, params });
    const result = withTimeout(
      new Promise((resolve, reject) => {
        this.pendingInner.set(id, { resolve, reject });
      }),
      method,
    );

    void this.sendOuter("Target.sendMessageToTarget", {
      targetId,
      message: innerMessage,
    }).catch((error) => {
      const pending = this.pendingInner.get(id);
      if (!pending) return;
      this.pendingInner.delete(id);
      pending.reject(error);
    });

    return result;
  }

  async waitForTarget(type = TARGET_TYPE) {
    const existing = [...this.targets.values()].find((target) => target.type === type);
    if (existing) return existing;

    const startedAt = Date.now();
    while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const target = [...this.targets.values()].find((candidate) => candidate.type === type);
      if (target) return target;
    }
    throw new Error(
      `没有收到 WebKit ${type} target. 当前 targets: ` + JSON.stringify([...this.targets.values()]),
    );
  }

  close() {
    this.ws.close();
  }
}

async function attach() {
  const tab = await pickTab();
  const session = new WebKitSession(tab.webSocketDebuggerUrl);
  await session.ready;
  const target = await session.waitForTarget();
  return { tab, session, target };
}

async function evalExpr(expression, { awaitPromise = false } = {}) {
  const { session, target } = await attach();
  try {
    if (!SKIP_RUNTIME_ENABLE) {
      await session.sendInner(target.targetId, "Runtime.enable");
    }
    const { result } = await session.sendInner(target.targetId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `eval threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  } finally {
    session.close();
  }
}

async function runPageMethod(method, params = {}) {
  const { session, target } = await attach();
  try {
    const { result } = await session.sendInner(target.targetId, method, params);
    return result;
  } finally {
    session.close();
  }
}

function jsString(value) {
  return JSON.stringify(String(value));
}

const SUPPORT_EXPR = `(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      left: Math.round(r.left),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };
  const visible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && r.width > 0 && r.height > 0;
  };
  const textOf = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    const labelledText = labelledBy
      ? labelledBy
          .split(/\\s+/)
          .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '')
          .join(' ')
      : '';
    return [
      el.getAttribute('aria-label'),
      labelledText,
      el.getAttribute('title'),
      el.innerText,
      el.textContent,
      el.value,
      el.placeholder,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim();
  };
  const interactiveSelector = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="switch"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const interactive = () =>
    [...document.querySelectorAll(interactiveSelector)]
      .filter(visible)
      .map((el, index) => ({
        index,
        tag: el.tagName,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        ariaLabel: el.getAttribute('aria-label'),
        dataSlot: el.getAttribute('data-slot'),
        text: textOf(el).slice(0, 180),
        rect: rect(el),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }));
  const findInteractive = (needle) => {
    const query = String(needle).trim().toLowerCase();
    const candidates = interactive();
    const exact = candidates.find((item) => item.text.toLowerCase() === query || item.ariaLabel?.toLowerCase() === query);
    if (exact) return exact;
    return candidates.find((item) => item.text.toLowerCase().includes(query) || item.ariaLabel?.toLowerCase().includes(query));
  };
  const elementByInteractiveIndex = (targetIndex) =>
    [...document.querySelectorAll(interactiveSelector)].filter(visible)[targetIndex] ?? null;
  const labelTarget = (needle) => {
    const query = String(needle).trim().toLowerCase();
    const fields = [...document.querySelectorAll('input, textarea, select')].filter(visible);
    for (const field of fields) {
      const fieldText = textOf(field).toLowerCase();
      if (fieldText === query || fieldText.includes(query)) return field;
      const id = field.id;
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        const labelText = label ? textOf(label).toLowerCase() : '';
        if (labelText === query || labelText.includes(query)) return field;
      }
      const parentLabel = field.closest('label');
      const parentText = parentLabel ? textOf(parentLabel).toLowerCase() : '';
      if (parentText === query || parentText.includes(query)) return field;
    }
    return null;
  };
  return { rect, visible, textOf, interactive, findInteractive, elementByInteractiveIndex, labelTarget };
})()`;

function interactiveScript(body) {
  return `(() => {
    const support = ${SUPPORT_EXPR};
    ${body}
  })()`;
}

const STATE_EXPR = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top, right: r.right, bottom: r.bottom, left: r.left,
      width: r.width, height: r.height,
    };
  };
  const node = (el) => {
    if (!el) return null;
    return {
      tag: el.tagName,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      dataSlot: el.getAttribute('data-slot'),
      text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      rect: rect(el),
    };
  };
  const q = (selector) => document.querySelector(selector);
  const active = document.activeElement;
  const ptyContainer = q('[data-pty-scroll-container]');
  const ptyTextarea = q('.xterm-helper-textarea');
  const chatRoot = q('[data-keyboard-offset], [data-keyboard-layout-inset]');
  return {
    href: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    viewport: {
      innerWidth,
      innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      visualViewport: window.visualViewport ? {
        width: visualViewport.width,
        height: visualViewport.height,
        offsetTop: visualViewport.offsetTop,
        offsetLeft: visualViewport.offsetLeft,
        pageTop: visualViewport.pageTop,
        pageLeft: visualViewport.pageLeft,
        scale: visualViewport.scale,
      } : null,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        orientation: screen.orientation ? {
          type: screen.orientation.type,
          angle: screen.orientation.angle,
        } : null,
      },
    },
    media: {
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      pointerFine: matchMedia('(pointer: fine)').matches,
      anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
      anyPointerFine: matchMedia('(any-pointer: fine)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      hoverHover: matchMedia('(hover: hover)').matches,
      anyHoverNone: matchMedia('(any-hover: none)').matches,
      anyHoverHover: matchMedia('(any-hover: hover)').matches,
    },
    activeElement: node(active),
    pty: {
      container: ptyContainer ? {
        scrollTop: ptyContainer.scrollTop,
        scrollLeft: ptyContainer.scrollLeft,
        scrollHeight: ptyContainer.scrollHeight,
        scrollWidth: ptyContainer.scrollWidth,
        clientHeight: ptyContainer.clientHeight,
        clientWidth: ptyContainer.clientWidth,
        rect: rect(ptyContainer),
      } : null,
      textarea: node(ptyTextarea),
    },
    keyboardDom: chatRoot ? {
      keyboardOffset: chatRoot.getAttribute('data-keyboard-offset'),
      keyboardLayoutInset: chatRoot.getAttribute('data-keyboard-layout-inset'),
      rect: rect(chatRoot),
    } : null,
  };
})()`;

const METRICS_EXPR = `(() => {
  const q = (selector) => document.querySelector(selector);
  const dims = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      rect: {
        top: r.top, right: r.right, bottom: r.bottom, left: r.left,
        width: r.width, height: r.height,
      },
    };
  };
  const term = window.__ptyTerminal ?? null;
  const buffer = term?.buffer?.active;
  return {
    viewport: {
      innerWidth,
      innerHeight,
      visualViewport: window.visualViewport ? {
        width: visualViewport.width,
        height: visualViewport.height,
        offsetTop: visualViewport.offsetTop,
        scale: visualViewport.scale,
      } : null,
    },
    container: dims(q('[data-pty-scroll-container]')),
    host: dims(q('.pty-host')),
    xterm: dims(q('.xterm')),
    xtermScreen: dims(q('.xterm-screen')),
    xtermViewport: dims(q('.xterm-viewport')),
    term: term ? {
      rows: term.rows,
      cols: term.cols,
      bufferLength: buffer?.length,
      viewportY: buffer?.viewportY,
      baseY: buffer?.baseY,
      cursorX: buffer?.cursorX,
      cursorY: buffer?.cursorY,
    } : null,
  };
})()`;

const cmds = {
  async tabs() {
    const tabs = await listTabs();
    for (const tab of tabs) {
      console.log(`${tab.title || "(untitled)"}\t${tab.url}\t${tab.webSocketDebuggerUrl || ""}`);
    }
  },
  async eval(expression) {
    if (!expression) throw new Error("用法: eval <js>");
    const value = await evalExpr(expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  },
  async elements() {
    const value = await evalExpr(interactiveScript(`return support.interactive();`));
    console.log(JSON.stringify(value, null, 2));
  },
  async click(...queryParts) {
    const query = queryParts.join(" ");
    if (!query) throw new Error("用法: click <text-or-aria-label>");
    const value = await evalExpr(
      interactiveScript(`
        const item = support.findInteractive(${jsString(query)});
        if (!item) return { ok: false, error: 'not-found', query: ${jsString(query)}, candidates: support.interactive().slice(0, 30) };
        const el = support.elementByInteractiveIndex(item.index);
        if (!el) return { ok: false, error: 'stale', item };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          el.dispatchEvent(new MouseEvent(type, init));
        }
        el.click();
        return { ok: true, clicked: item, active: document.activeElement ? support.textOf(document.activeElement) : null };
      `),
    );
    console.log(JSON.stringify(value, null, 2));
  },
  async fill(label, ...valueParts) {
    const value = valueParts.join(" ");
    if (!label || valueParts.length === 0)
      throw new Error("用法: fill <label-or-aria-label> <value>");
    const result = await evalExpr(
      interactiveScript(`
        const el = support.labelTarget(${jsString(label)});
        if (!el) return { ok: false, error: 'not-found', label: ${jsString(label)}, candidates: support.interactive().filter((item) => ['INPUT','TEXTAREA','SELECT'].includes(item.tag)) };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        const previous = el.value;
        const prototype = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (valueSetter) valueSetter.call(el, ${jsString(value)});
        else el.value = ${jsString(value)};
        if (!(el instanceof HTMLSelectElement)) {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${jsString(value)} }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, label: ${jsString(label)}, previous, value: el.value, active: support.textOf(document.activeElement) };
      `),
    );
    console.log(JSON.stringify(result, null, 2));
  },
  async waitText(...textParts) {
    const text = textParts.join(" ");
    if (!text) throw new Error("用法: wait-text <text>");
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
      last = await evalExpr(`(() => document.body.innerText.includes(${jsString(text)}))()`);
      if (last) {
        console.log(JSON.stringify({ ok: true, text, elapsedMs: Date.now() - startedAt }, null, 2));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify({ ok: false, text, elapsedMs: Date.now() - startedAt }, null, 2));
    process.exitCode = 1;
  },
  async screenshot(path) {
    const out = path ?? `/tmp/ipad-webkit-${Date.now()}.png`;
    const viewport = await evalExpr(`(() => ({ width: innerWidth, height: innerHeight }))()`);
    const result = await runPageMethod("Page.snapshotRect", {
      x: 0,
      y: 0,
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
      coordinateSystem: "Viewport",
    });
    const dataUrl = result.dataURL;
    if (!dataUrl?.startsWith("data:image/png;base64,")) {
      throw new Error("Page.snapshotRect did not return a PNG dataURL");
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    console.log(out);
  },
  async state() {
    console.log(JSON.stringify(await evalExpr(STATE_EXPR), null, 2));
  },
  async metrics() {
    console.log(JSON.stringify(await evalExpr(METRICS_EXPR), null, 2));
  },
  async reload() {
    const { session, target } = await attach();
    try {
      await session.sendInner(target.targetId, "Page.enable");
      await session.sendInner(target.targetId, "Page.reload", { ignoreCache: false });
    } finally {
      session.close();
    }
  },
};

const [, , cmd, ...args] = process.argv;
const fn = cmds[cmd];
if (!fn) {
  const list = Object.keys(cmds).join(", ");
  console.error(`未知子命令 '${cmd ?? ""}'. 可用: ${list}`);
  process.exit(2);
}

fn(...args).catch((error) => {
  console.error(String(error));
  process.exit(1);
});
