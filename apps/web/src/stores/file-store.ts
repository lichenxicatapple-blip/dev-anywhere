// 两套文件树缓存: 普通目录与包含隐藏项的目录互不覆盖 (key 一律是绝对路径)
// cwd 由 file_tree_push 带来, FilePathPicker 的相对路径在发请求前拼成绝对路径
// proxy 的 isPathSafe 只接受绝对路径, 相对路径会被直接拒绝
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { AgentCliStatus, DirEntry } from "@dev-anywhere/shared";

interface FileStoreState {
  tree: Map<string, DirEntry[]>;
  treeWithHidden: Map<string, DirEntry[]>;
  cwd: string;
  // proxy 启动时回传的 process.env.HOME, 新建会话 picker 的默认起点
  homePath: string;
  agentCli: AgentCliStatus | null;

  setDirEntries: (path: string, entries: DirEntry[], includeHidden?: boolean) => void;
  setCwd: (cwd: string) => void;
  setHomePath: (homePath: string) => void;
  setAgentCli: (agentCli: AgentCliStatus) => void;
  clearTree: () => void;
  prepareForProxySwitch: () => void;
}

export const useFileStore = create<FileStoreState>()(
  devtools(
    (set, get) => ({
      tree: new Map(),
      treeWithHidden: new Map(),
      cwd: "",
      homePath: "",
      agentCli: null,

      setDirEntries: (path, entries, includeHidden = false) => {
        if (includeHidden) {
          const next = new Map(get().treeWithHidden);
          next.set(path, entries);
          set({ treeWithHidden: next });
          return;
        }
        const next = new Map(get().tree);
        next.set(path, entries);
        set({ tree: next });
      },
      setCwd: (cwd) => set({ cwd }),
      setHomePath: (homePath) => set({ homePath }),
      setAgentCli: (agentCli) => set({ agentCli }),
      clearTree: () => set({ tree: new Map(), treeWithHidden: new Map(), cwd: "" }),
      prepareForProxySwitch: () =>
        set({ tree: new Map(), treeWithHidden: new Map(), cwd: "", homePath: "", agentCli: null }),
    }),
    { name: "file-store" },
  ),
);
