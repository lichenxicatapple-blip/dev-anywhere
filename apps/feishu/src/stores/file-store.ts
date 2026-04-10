// 文件树缓存：目录 -> 文件列表映射，重连时清空
import { createContext, useContext } from "react";
import type { DirEntry } from "@cc-anywhere/shared";

export type { DirEntry };

export interface FileStoreState {
  tree: Map<string, DirEntry[]>;
}

export type FileAction =
  | { type: "SET_DIR_ENTRIES"; path: string; entries: DirEntry[] }
  | { type: "CLEAR_TREE" };

export const initialFileState: FileStoreState = {
  tree: new Map(),
};

export function fileReducer(state: FileStoreState, action: FileAction): FileStoreState {
  switch (action.type) {
    case "SET_DIR_ENTRIES": {
      const next = new Map(state.tree);
      next.set(action.path, action.entries);
      return { tree: next };
    }
    case "CLEAR_TREE":
      return { tree: new Map() };
    default:
      return state;
  }
}

const FileStateContext = createContext<FileStoreState>(initialFileState);
const FileDispatchContext = createContext<React.Dispatch<FileAction>>(() => {
  throw new Error("FileDispatchContext used outside FileProvider");
});

export const FileProvider = FileStateContext.Provider;
export const FileDispatchProvider = FileDispatchContext.Provider;

export function useFileState(): FileStoreState {
  return useContext(FileStateContext);
}

export function useFileDispatch(): React.Dispatch<FileAction> {
  return useContext(FileDispatchContext);
}
