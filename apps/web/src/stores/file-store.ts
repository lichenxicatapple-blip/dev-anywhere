// 文件树缓存: 目录 -> 文件列表 (key 一律是绝对路径)
// cwd 由 file_tree_push 带来, FilePathPicker 的相对路径在发请求前拼成绝对路径
// proxy 的 isPathSafe 只接受绝对路径, 相对路径会被直接拒绝
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { DirEntry } from "@dev-anywhere/shared";

interface FileStoreState {
  tree: Map<string, DirEntry[]>;
  cwd: string;
  // proxy 启动时回传的 process.env.HOME, 新建会话 picker 的默认起点
  homePath: string;

  setDirEntries: (path: string, entries: DirEntry[]) => void;
  setCwd: (cwd: string) => void;
  setHomePath: (homePath: string) => void;
  clearTree: () => void;
}

export const useFileStore = create<FileStoreState>()(
  devtools(
    (set, get) => ({
      tree: new Map(),
      cwd: "",
      homePath: "",

      setDirEntries: (path, entries) => {
        const next = new Map(get().tree);
        next.set(path, entries);
        set({ tree: next });
      },
      setCwd: (cwd) => set({ cwd }),
      setHomePath: (homePath) => set({ homePath }),
      clearTree: () => set({ tree: new Map(), cwd: "" }),
    }),
    { name: "file-store" },
  ),
);
