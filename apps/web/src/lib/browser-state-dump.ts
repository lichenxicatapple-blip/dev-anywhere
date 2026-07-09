type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SerializedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface SerializedDomNode {
  kind: "element" | "text" | "truncated";
  path?: string;
  tag?: string;
  text?: string;
  attrs?: Record<string, string>;
  rect?: SerializedRect;
  scroll?: {
    top: number;
    left: number;
    height: number;
    width: number;
    clientHeight: number;
    clientWidth: number;
  };
  style?: Record<string, string>;
  value?: {
    length: number;
    preview: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  };
  children?: SerializedDomNode[];
  omittedChildren?: number;
}

export interface BrowserStateDump {
  schemaVersion: 1;
  createdAt: string;
  trigger: string;
  url: {
    href: string;
    origin: string;
    pathname: string;
    search: string;
    hash: string;
  };
  browser: {
    userAgent: string;
    language: string;
    languages: string[];
    platform: string;
    maxTouchPoints: number;
    cookieEnabled: boolean;
    onLine: boolean;
  };
  viewport: {
    window: {
      innerWidth: number;
      innerHeight: number;
      outerWidth: number;
      outerHeight: number;
      devicePixelRatio: number;
      scrollX: number;
      scrollY: number;
    };
    visualViewport: {
      width: number;
      height: number;
      offsetLeft: number;
      offsetTop: number;
      pageLeft: number;
      pageTop: number;
      scale: number;
    } | null;
    screen: {
      width: number;
      height: number;
      availWidth: number;
      availHeight: number;
      orientation: string | null;
    };
  };
  document: {
    title: string;
    readyState: DocumentReadyState;
    visibilityState: DocumentVisibilityState;
    activeElement: ElementSummary | null;
    selection: string | null;
    focusedInputs: ElementSummary[];
    root: SerializedDomNode;
    truncated: boolean;
    nodeCount: number;
  };
  devAnywhere: {
    ptyDebug: JsonValue | null;
    ptyInputDebugSnapshot: JsonValue | null;
    ptyInputDebugText: string | null;
    ptyInputDebugEvents: JsonValue | null;
    ptyScrollTraceTail: JsonValue | null;
    jsonScrollTraceTail: JsonValue | null;
  };
}

interface ElementSummary {
  path: string;
  tag: string;
  id: string | null;
  className: string | null;
  attrs: Record<string, string>;
  rect: SerializedRect;
  scroll: SerializedDomNode["scroll"];
  style: Record<string, string>;
  value?: SerializedDomNode["value"];
}

export type BrowserStateDumpPersistResult =
  | { status: "saved"; path: string; bytes: number; endpoint: string }
  | { status: "downloaded"; filename: string; bytes: number; endpointError?: string }
  | { status: "failed"; error: string; endpointError?: string };

export type BrowserStateDumpMode = "off" | "manual" | "auto";

declare global {
  interface Window {
    __devAnywhereLastBrowserStateDump?: BrowserStateDump;
  }
}

type DevAnywhereDebugWindow = Window & {
  __devAnywherePtyDebug?: () => unknown;
  __devAnywherePtyInputDebugSnapshot?: unknown;
  __devAnywherePtyInputDebugEvents?: unknown;
  __devAnywherePtyInputDebugText?: string;
  __devAnywherePtyScrollTrace?: unknown[];
  __devAnywhereJsonScrollTrace?: unknown[];
};

const DEBUG_DUMP_ENDPOINT = "/__dev_anywhere_debug/browser-state-dumps";
const MAX_DOM_NODES = 1500;
const MAX_DOM_DEPTH = 10;
const MAX_CHILDREN_PER_NODE = 80;
const MAX_TEXT_PREVIEW = 500;
const TRACE_TAIL_SIZE = 200;

const CAPTURED_ATTRS = [
  "id",
  "class",
  "data-slot",
  "data-state",
  "data-testid",
  "role",
  "aria-label",
  "aria-hidden",
  "name",
  "type",
  "autocomplete",
  "autocorrect",
  "autocapitalize",
  "inputmode",
  "enterkeyhint",
  "virtualkeyboardpolicy",
  "contenteditable",
  "placeholder",
  "href",
  "src",
] as const;

const STYLE_PROPS = [
  "display",
  "position",
  "visibility",
  "opacity",
  "pointer-events",
  "z-index",
  "overflow",
  "overflow-x",
  "overflow-y",
  "touch-action",
  "transform",
  "translate",
  "color-scheme",
  "background-color",
  "color",
  "font-size",
  "line-height",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
] as const;

export function isBrowserStateDumpEnabled(): boolean {
  return getBrowserStateDumpMode() !== "off";
}

export function getBrowserStateDumpMode(): BrowserStateDumpMode {
  if (typeof window === "undefined") return "off";
  const explicit = getDebugParam("debugDump");
  if (explicit === "auto") return "auto";
  if (explicit !== null) return "manual";
  if (hasDebugParam("debugInput")) return "manual";
  return "off";
}

export function captureBrowserStateDump(trigger: string = "manual"): BrowserStateDump {
  const rootState = { count: 0, truncated: false };
  const debugWindow = window as DevAnywhereDebugWindow;
  const dump: BrowserStateDump = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    trigger,
    url: {
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    },
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: Array.from(navigator.languages ?? []),
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
    },
    viewport: readViewport(),
    document: {
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      activeElement: summarizeElement(document.activeElement),
      selection: readSelection(),
      focusedInputs: Array.from(
        document.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable]"),
      )
        .filter((element) => element === document.activeElement || element.matches(":focus"))
        .map((element) => summarizeElement(element))
        .filter((element): element is ElementSummary => Boolean(element)),
      root: serializeNode(document.documentElement, 0, rootState),
      truncated: rootState.truncated,
      nodeCount: rootState.count,
    },
    devAnywhere: {
      ptyDebug: safeJson(() => debugWindow.__devAnywherePtyDebug?.() ?? null),
      ptyInputDebugSnapshot: safeJson(() => debugWindow.__devAnywherePtyInputDebugSnapshot ?? null),
      ptyInputDebugText: debugWindow.__devAnywherePtyInputDebugText ?? null,
      ptyInputDebugEvents: safeJson(() => debugWindow.__devAnywherePtyInputDebugEvents ?? null),
      ptyScrollTraceTail: safeJson(() => tail(debugWindow.__devAnywherePtyScrollTrace)),
      jsonScrollTraceTail: safeJson(() => tail(debugWindow.__devAnywhereJsonScrollTrace)),
    },
  };
  window.__devAnywhereLastBrowserStateDump = dump;
  return dump;
}

export async function captureAndPersistBrowserStateDump(
  trigger: string = "manual",
): Promise<BrowserStateDumpPersistResult> {
  const dump = captureBrowserStateDump(trigger);
  return persistBrowserStateDump(dump);
}

export async function persistBrowserStateDump(
  dump: BrowserStateDump,
): Promise<BrowserStateDumpPersistResult> {
  const payload = JSON.stringify(dump, null, 2);
  const bytes = new Blob([payload]).size;
  try {
    const saved = await saveBrowserStateDumpToEndpoint(payload);
    return {
      status: "saved",
      path: saved.path,
      bytes: saved.bytes,
      endpoint: DEBUG_DUMP_ENDPOINT,
    };
  } catch (error) {
    const endpointError = errorMessage(error);
    const filename = browserStateDumpFilename(dump.createdAt);
    const downloaded = downloadTextFile(filename, payload, "application/json");
    if (downloaded) {
      return { status: "downloaded", filename, bytes, endpointError };
    }
    return { status: "failed", error: "无法保存或下载诊断包", endpointError };
  }
}

async function saveBrowserStateDumpToEndpoint(
  payload: string,
): Promise<{ path: string; bytes: number }> {
  const response = await fetch(DEBUG_DUMP_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as { ok?: boolean; path?: string; bytes?: number };
  if (!parsed.ok || !parsed.path || typeof parsed.bytes !== "number") {
    throw new Error("debug endpoint returned an invalid response");
  }
  return { path: parsed.path, bytes: parsed.bytes };
}

function serializeNode(
  node: Node,
  depth: number,
  state: { count: number; truncated: boolean },
): SerializedDomNode {
  if (state.count >= MAX_DOM_NODES || depth > MAX_DOM_DEPTH) {
    state.truncated = true;
    return { kind: "truncated" };
  }
  state.count += 1;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = compactText(node.textContent ?? "");
    if (!text) return { kind: "text", text: "" };
    return { kind: "text", text: truncate(text, MAX_TEXT_PREVIEW) };
  }

  if (!(node instanceof HTMLElement)) {
    return { kind: "truncated" };
  }

  const children: SerializedDomNode[] = [];
  let omittedChildren = 0;
  const childNodes = Array.from(node.childNodes);
  for (const child of childNodes.slice(0, MAX_CHILDREN_PER_NODE)) {
    if (child.nodeType === Node.TEXT_NODE && !compactText(child.textContent ?? "")) continue;
    children.push(serializeNode(child, depth + 1, state));
  }
  if (childNodes.length > MAX_CHILDREN_PER_NODE) {
    omittedChildren = childNodes.length - MAX_CHILDREN_PER_NODE;
    state.truncated = true;
  }

  const result: SerializedDomNode = {
    kind: "element",
    tag: node.tagName.toLowerCase(),
    path: elementPath(node),
    attrs: readAttrs(node),
    rect: readRect(node),
    scroll: readScroll(node),
    style: readStyle(node),
  };
  const value = readValue(node);
  if (value) result.value = value;
  if (children.length > 0) result.children = children;
  if (omittedChildren > 0) result.omittedChildren = omittedChildren;
  return result;
}

function summarizeElement(element: Element | null): ElementSummary | null {
  if (!(element instanceof HTMLElement)) return null;
  const value = readValue(element);
  return {
    path: elementPath(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    className: element.className || null,
    attrs: readAttrs(element),
    rect: readRect(element),
    scroll: readScroll(element),
    style: readStyle(element),
    ...(value ? { value } : {}),
  };
}

function readViewport(): BrowserStateDump["viewport"] {
  const vv = window.visualViewport;
  const orientation = screen.orientation?.type ?? null;
  return {
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    visualViewport: vv
      ? {
          width: vv.width,
          height: vv.height,
          offsetLeft: vv.offsetLeft,
          offsetTop: vv.offsetTop,
          pageLeft: vv.pageLeft,
          pageTop: vv.pageTop,
          scale: vv.scale,
        }
      : null,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      orientation,
    },
  };
}

function readAttrs(element: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of CAPTURED_ATTRS) {
    const value = element.getAttribute(name);
    if (value !== null) attrs[name] = truncate(value, 500);
  }
  return attrs;
}

function readRect(element: HTMLElement): SerializedRect {
  const rect = element.getBoundingClientRect();
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    left: round(rect.left),
  };
}

function readScroll(element: HTMLElement): SerializedDomNode["scroll"] {
  return {
    top: round(element.scrollTop),
    left: round(element.scrollLeft),
    height: round(element.scrollHeight),
    width: round(element.scrollWidth),
    clientHeight: round(element.clientHeight),
    clientWidth: round(element.clientWidth),
  };
}

function readStyle(element: HTMLElement): Record<string, string> {
  const computed = window.getComputedStyle(element);
  const style: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    style[prop] = computed.getPropertyValue(prop);
  }
  return style;
}

function readValue(element: HTMLElement): SerializedDomNode["value"] | undefined {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return undefined;
  }
  return {
    length: element.value.length,
    preview: truncate(element.value, MAX_TEXT_PREVIEW),
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
  };
}

function readSelection(): string | null {
  try {
    return truncate(window.getSelection()?.toString() ?? "", MAX_TEXT_PREVIEW);
  } catch {
    return null;
  }
}

function elementPath(element: HTMLElement): string {
  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.documentElement) {
    let segment = current.tagName.toLowerCase();
    if (current.id) {
      segment += `#${current.id}`;
      segments.unshift(segment);
      break;
    }
    const slot = current.getAttribute("data-slot");
    if (slot) segment += `[data-slot="${slot}"]`;
    else if (current.classList.length > 0) {
      segment += `.${Array.from(current.classList).slice(0, 3).join(".")}`;
    }
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const tagName = current.tagName;
      const siblings = Array.from(parent.children).filter(
        (candidate): candidate is HTMLElement =>
          candidate instanceof HTMLElement && candidate.tagName === tagName,
      );
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    segments.unshift(segment);
    current = parent;
  }
  return `html>${segments.join(">")}`;
}

function browserStateDumpFilename(createdAt: string): string {
  return `dev-anywhere-browser-state-${createdAt.replace(/[:.]/g, "-")}.json`;
}

function downloadTextFile(filename: string, text: string, type: string): boolean {
  if (typeof document === "undefined") return false;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function hasDebugParam(name: string): boolean {
  return getDebugParam(name) !== null;
}

function getDebugParam(name: string): string | null {
  const search = new URLSearchParams(window.location.search);
  if (search.has(name)) return search.get(name) ?? "";
  const [, hashSearch = ""] = window.location.hash.split("?");
  const hashParams = new URLSearchParams(hashSearch);
  if (hashParams.has(name)) return hashParams.get(name) ?? "";
  return null;
}

function tail(value: unknown[] | undefined): JsonValue | null {
  return value ? toJsonValue(value.slice(-TRACE_TAIL_SIZE)) : null;
}

function safeJson(read: () => unknown): JsonValue | null {
  try {
    return toJsonValue(read());
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(entry);
    }
    return out;
  }
  return String(value);
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
