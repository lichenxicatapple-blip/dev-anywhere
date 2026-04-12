// 终端状态管理：PTY 栅格数据、字体大小、PTY 语义状态、scrollback 缓存
import { createContext, useContext } from "react";
import Taro from "@tarojs/taro";
import type { TermLine } from "@cc-anywhere/shared";
import { ScrollbackCache } from "@/services/scrollback-cache";

export type { TermLine };

export const FONT_SIZES = [8, 10, 12, 14, 16, 20] as const;
const DEFAULT_FONT_SIZE_INDEX = 2; // 12px

export interface TerminalStoreState {
  lines: TermLine[];
  fontSize: number;
  fontSizeIndex: number;
  ptyState: "working" | "turn_complete" | "approval_wait" | "idle";
  ptyTitle: string | null;
  approvalTool: string | null;
  scrollbackCache: ScrollbackCache;
  scrollbackLines: TermLine[];
  isLoadingScrollback: boolean;
  isAtOldest: boolean;
  userScrolledUp: boolean;
}

export type TerminalAction =
  | { type: "SET_TERMINAL_LINES"; lines: TermLine[] }
  | { type: "SET_FONT_SIZE_INDEX"; index: number }
  | { type: "SET_PTY_STATE"; state: TerminalStoreState["ptyState"]; title?: string }
  | { type: "SET_APPROVAL_TOOL"; tool: string | null }
  | { type: "APPLY_LINES_RESPONSE"; response: { fromLineId: number; oldestLineId: number; newestLineId: number; lines: TermLine[] } }
  | { type: "REQUEST_SCROLLBACK" }
  | { type: "SET_USER_SCROLLED_UP"; value: boolean };

function loadFontSizeIndex(): number {
  const stored = Taro.getStorageSync("cc_fontSizeIndex") as number | "";
  if (typeof stored === "number" && stored >= 0 && stored < FONT_SIZES.length) return stored;
  return DEFAULT_FONT_SIZE_INDEX;
}

const savedIndex = loadFontSizeIndex();

export const initialTerminalState: TerminalStoreState = {
  lines: [],
  fontSize: FONT_SIZES[savedIndex],
  fontSizeIndex: savedIndex,
  ptyState: "idle",
  ptyTitle: null,
  approvalTool: null,
  scrollbackCache: new ScrollbackCache(),
  scrollbackLines: [],
  isLoadingScrollback: false,
  isAtOldest: false,
  userScrolledUp: false,
};

// 从 scrollback 缓存中重建渲染用的历史行数组
function buildScrollbackLines(cache: ScrollbackCache): TermLine[] {
  if (cache.cacheSize === 0) return [];
  const lines: TermLine[] = [];
  const cached = cache.getCachedLines(cache.oldestLineId, cache.newestLineId - cache.oldestLineId + 1);
  for (const line of cached) {
    if (line) lines.push(line);
  }
  return lines;
}

export function terminalReducer(
  state: TerminalStoreState,
  action: TerminalAction,
): TerminalStoreState {
  switch (action.type) {
    case "SET_TERMINAL_LINES":
      return { ...state, lines: action.lines };
    case "SET_FONT_SIZE_INDEX": {
      const idx = Math.max(0, Math.min(action.index, FONT_SIZES.length - 1));
      return { ...state, fontSizeIndex: idx, fontSize: FONT_SIZES[idx] };
    }
    case "SET_PTY_STATE":
      return { ...state, ptyState: action.state, ptyTitle: action.title ?? state.ptyTitle };
    case "SET_APPROVAL_TOOL":
      return { ...state, approvalTool: action.tool };
    case "APPLY_LINES_RESPONSE": {
      const cache = state.scrollbackCache;
      cache.applyLinesResponse(action.response);
      return {
        ...state,
        scrollbackLines: buildScrollbackLines(cache),
        isLoadingScrollback: false,
        isAtOldest: cache.isAtOldest(cache.oldestLineId),
      };
    }
    case "REQUEST_SCROLLBACK":
      return { ...state, isLoadingScrollback: true };
    case "SET_USER_SCROLLED_UP":
      return { ...state, userScrolledUp: action.value };
    default:
      return state;
  }
}

const TerminalStateContext = createContext<TerminalStoreState>(initialTerminalState);
const TerminalDispatchContext = createContext<React.Dispatch<TerminalAction>>(() => {
  throw new Error("TerminalDispatchContext used outside TerminalProvider");
});

export const TerminalProvider = TerminalStateContext.Provider;
export const TerminalDispatchProvider = TerminalDispatchContext.Provider;

export function useTerminalState(): TerminalStoreState {
  return useContext(TerminalStateContext);
}

export function useTerminalDispatch(): React.Dispatch<TerminalAction> {
  return useContext(TerminalDispatchContext);
}
