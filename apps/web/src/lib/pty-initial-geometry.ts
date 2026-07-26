import {
  PTY_INITIAL_MAX_COLS,
  PTY_INITIAL_MAX_ROWS,
  PTY_INITIAL_MIN_COLS,
  PTY_INITIAL_MIN_ROWS,
} from "@dev-anywhere/shared";
import { DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY } from "./chat-font-size";

interface InitialPtyGeometryInput {
  viewportWidth: number;
  viewportHeight: number;
  sidebarWidth?: number;
  safeAreaTop?: number;
  safeAreaBottom?: number;
  cellWidth: number;
  cellHeight: number;
}

interface InitialPtyGeometry {
  cols: number;
  rows: number;
}

const PTY_HORIZONTAL_PADDING_PX = 24;
const CHAT_HEADER_RAIL_HEIGHT_PX = 48;
const CHAT_HEADER_BORDER_PX = 1;
const STATUS_LINE_HEIGHT_PX = 4;
const PTY_PADDING_TOP_PX = 8;
const PTY_PADDING_BOTTOM_PX = 8;
const PTY_HORIZONTAL_SCROLL_PADDING_BOTTOM_PX = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeInitialPtyGeometry({
  viewportWidth,
  viewportHeight,
  sidebarWidth = 0,
  safeAreaTop = 0,
  safeAreaBottom = 0,
  cellWidth,
  cellHeight,
}: InitialPtyGeometryInput): InitialPtyGeometry {
  if (viewportWidth <= 0 || viewportHeight <= 0 || cellWidth <= 0 || cellHeight <= 0) {
    return { cols: PTY_INITIAL_MIN_COLS, rows: PTY_INITIAL_MIN_ROWS };
  }

  const contentWidth = Math.max(
    0,
    viewportWidth - Math.max(0, sidebarWidth) - PTY_HORIZONTAL_PADDING_PX,
  );
  const naturalCols = Math.floor(contentWidth / cellWidth);
  const needsHorizontalScroll = naturalCols < PTY_INITIAL_MIN_COLS;
  const bottomPadding = needsHorizontalScroll
    ? PTY_HORIZONTAL_SCROLL_PADDING_BOTTOM_PX
    : PTY_PADDING_BOTTOM_PX;
  const verticalChrome =
    CHAT_HEADER_RAIL_HEIGHT_PX +
    CHAT_HEADER_BORDER_PX +
    STATUS_LINE_HEIGHT_PX +
    PTY_PADDING_TOP_PX +
    bottomPadding +
    Math.max(0, safeAreaTop) +
    Math.max(0, safeAreaBottom);
  const contentHeight = Math.max(0, viewportHeight - verticalChrome);
  const naturalRows = Math.floor(contentHeight / cellHeight);

  return {
    cols: clamp(naturalCols, PTY_INITIAL_MIN_COLS, PTY_INITIAL_MAX_COLS),
    rows: clamp(naturalRows, PTY_INITIAL_MIN_ROWS, PTY_INITIAL_MAX_ROWS),
  };
}

function measureSafeAreaInsets(): { top: number; bottom: number } {
  if (typeof document === "undefined" || !document.body) return { top: 0, bottom: 0 };
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
  });
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const result = {
    top: Number.parseFloat(style.paddingTop) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
  };
  probe.remove();
  return result;
}

function measureTerminalCell(fontSize: number): { width: number; height: number } {
  const fallback = { width: fontSize * 0.5, height: fontSize * 1.25 };
  if (typeof document === "undefined" || !document.body) return fallback;

  const probe = document.createElement("span");
  probe.textContent = "W";
  Object.assign(probe.style, {
    position: "fixed",
    left: "-9999px",
    top: "0",
    visibility: "hidden",
    whiteSpace: "pre",
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: `${fontSize}px`,
    fontWeight: "normal",
    fontStyle: "normal",
    fontVariant: "normal",
    letterSpacing: "0",
    lineHeight: "normal",
  });
  document.body.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return {
    width: rect.width > 0 ? rect.width : fallback.width,
    height: rect.height > 0 ? rect.height : fallback.height,
  };
}

function visibleSidebarWidth(): number {
  if (typeof document === "undefined") return 0;
  const sidebar = document.querySelector<HTMLElement>(
    '[data-slot="sidebar"], [data-slot="sidebar-rail"]',
  );
  if (!sidebar) return 0;
  const rect = sidebar.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect.width : 0;
}

function fullApplicationViewport(): { width: number; height: number } {
  const visualViewport = window.visualViewport;
  const appShell = document.querySelector<HTMLElement>('[data-slot="app-shell"]');
  const shellRect = appShell?.getBoundingClientRect();
  return {
    width: Math.max(window.innerWidth, visualViewport?.width ?? 0, shellRect?.width ?? 0),
    // 创建 Agent PTY 时软键盘可能仍开着。visualViewport 此时只是临时可视高度，
    // app-shell / layout viewport 才是键盘收起后终端实际可用的完整画布。
    height: Math.max(window.innerHeight, visualViewport?.height ?? 0, shellRect?.height ?? 0),
  };
}

export function measureInitialPtyGeometry(
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
): InitialPtyGeometry {
  if (typeof window === "undefined") {
    return { cols: PTY_INITIAL_MIN_COLS, rows: PTY_INITIAL_MIN_ROWS };
  }
  const viewport = fullApplicationViewport();
  const safeArea = measureSafeAreaInsets();
  const cell = measureTerminalCell(fontSize);
  return computeInitialPtyGeometry({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    sidebarWidth: visibleSidebarWidth(),
    safeAreaTop: safeArea.top,
    safeAreaBottom: safeArea.bottom,
    cellWidth: cell.width,
    cellHeight: cell.height,
  });
}
