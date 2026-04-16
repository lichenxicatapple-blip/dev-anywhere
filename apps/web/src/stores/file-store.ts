// 文件树缓存：目录 -> 文件列表映射，重连时清空
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { DirEntry } from "@cc-anywhere/shared";

interface FileStoreState {
  tree: Map<string, DirEntry[]>;

  setDirEntries: (path: string, entries: DirEntry[]) => void;
  clearTree: () => void;
}

export const useFileStore = create<FileStoreState>()(
  devtools(
    (set, get) => ({
      tree: new Map(),

      setDirEntries: (path, entries) => {
        const next = new Map(get().tree);
        next.set(path, entries);
        set({ tree: next });
      },
      clearTree: () => set({ tree: new Map() }),
    }),
    { name: "file-store" },
  ),
);
