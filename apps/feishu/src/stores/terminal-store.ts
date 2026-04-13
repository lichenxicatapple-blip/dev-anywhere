// 终端状态管理：PTY 栅格数据、字体大小、PTY 语义状态
import { createContext, useContext } from "react";
import Taro from "@tarojs/taro";
import type { TermLine } from "@cc-anywhere/shared";

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
  frameCache: Map<number, TermLine[]>;
  anchorLineId: number | null;
  newestLineId: number | null;
}

export type TerminalAction =
  | { type: "SET_TERMINAL_LINES"; lines: TermLine[] }
  | { type: "SET_FONT_SIZE_INDEX"; index: number }
  | { type: "SET_PTY_STATE"; state: TerminalStoreState["ptyState"]; title?: string }
  | { type: "SET_PTY_TITLE"; title: string }
  | { type: "SET_APPROVAL_TOOL"; tool: string | null }
  | { type: "CACHE_FRAME"; anchorLineId: number; lines: TermLine[] }
  | { type: "SET_SCROLL_STATE"; anchorLineId: number | null; newestLineId: number | null; lines?: TermLine[] }
  | { type: "CLEAR_ANCHOR" };

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
  frameCache: new Map(),
  anchorLineId: null,
  newestLineId: null,
};

export function terminalReducer(
  state: TerminalStoreState,
  action: TerminalAction,
): TerminalStoreState {
  switch (action.type) {
    case "SET_TERMINAL_LINES":
      // 锚定状态下不更新 lines，防止 live 帧覆盖滚动视图
      if (state.anchorLineId !== null) return state;
      return { ...state, lines: action.lines };
    case "SET_FONT_SIZE_INDEX": {
      const idx = Math.max(0, Math.min(action.index, FONT_SIZES.length - 1));
      return { ...state, fontSizeIndex: idx, fontSize: FONT_SIZES[idx] };
    }
    case "SET_PTY_STATE":
      return { ...state, ptyState: action.state, ptyTitle: action.title ?? state.ptyTitle };
    case "SET_PTY_TITLE":
      return { ...state, ptyTitle: action.title };
    case "SET_APPROVAL_TOOL":
      return { ...state, approvalTool: action.tool };
    case "CACHE_FRAME": {
      const newCache = new Map(state.frameCache);
      newCache.set(action.anchorLineId, action.lines);
      return { ...state, frameCache: newCache };
    }
    case "SET_SCROLL_STATE": {
      const next = { ...state, anchorLineId: action.anchorLineId, newestLineId: action.newestLineId };
      if (action.lines) next.lines = action.lines;
      return next;
    }
    case "CLEAR_ANCHOR":
      return { ...state, anchorLineId: null };
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
