// FilePathPicker: 订阅 useFileStore.tree + cache miss 时通过 RelayClient 请求目录
// 共享给 InputBar (mode="insert") 与 CreateSessionDialog (mode="select", dirsOnly)
// "insert" 从 "@query" 提取当前路径与过滤词; "select" 直接把 filter 视作绝对/相对路径
// 键盘: InputBar 通过 ref.handleKey 转发 ↑↓/Enter; 选中项用 scrollIntoView 跟随
// 滚动: Radix ScrollArea 在 max-h-only 父容器下 Viewport 拿不到高度约束, 这里用原生 overflow-y-auto
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFileStore } from "@/stores/file-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { cn } from "@/lib/utils";
import {
  resolvePickerTarget,
  withTrailingSlash,
  type PickerMode,
} from "@/lib/file-path-picker-target";
import type { PickerHandle } from "./picker-handle";

interface FilePathPickerProps {
  filter: string;
  mode?: PickerMode;
  placement?: "floating" | "inline";
  onSelect: (path: string) => void;
  onCreateDirectory?: (path: string) => Promise<string | null>;
  dirsOnly?: boolean;
  title?: string;
}

// 相对路径 (./, apps/, apps/web/) + cwd 拼成绝对路径
// 绝对路径 (/home/dev/...) 直接用, 避免 select 模式被错误拼到 cwd 下
// 空 / "./" → cwd; 末尾清斜杠避免 // 双斜杠; 前缀 "./" 清掉
function toAbsolutePath(cwd: string, relPath: string): string {
  if (relPath.startsWith("/")) {
    return relPath.replace(/\/+$/, "") || "/";
  }
  if (!cwd) return "";
  const cleaned = relPath.replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned ? `${cwd}/${cleaned}` : cwd;
}

function joinPickerPath(currentPath: string, entry: { name: string; isDir: boolean }): string {
  return `${withTrailingSlash(currentPath)}${entry.name}${entry.isDir ? "/" : ""}`;
}

function joinChildDirectory(parent: string, child: string): string | null {
  const base = parent.trim().replace(/\/+$/, "") || "/";
  const name = child.trim().replace(/^\/+|\/+$/g, "");
  if (!base.startsWith("/") || !name || child.trim().startsWith("/")) return null;
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

export const FilePathPicker = forwardRef<PickerHandle, FilePathPickerProps>(function FilePathPicker(
  {
    filter,
    onSelect,
    onCreateDirectory,
    mode = "insert",
    placement = "floating",
    dirsOnly = false,
    title,
  },
  ref,
) {
  const tree = useFileStore((s) => s.tree);
  const sessionCwd = useFileStore((s) => s.cwd);
  const homePath = useFileStore((s) => s.homePath);
  // insert 模式在 Chat 页, 锚到 session cwd (@ 后的相对路径拼在 session cwd 下)
  // select 模式给新建会话用, 那会儿还没有 session, 锚到 $HOME
  const baseCwd = mode === "insert" ? sessionCwd : homePath || sessionCwd;
  const knownDirs = useMemo(() => new Set(tree.keys()), [tree]);
  const target = useMemo(
    () => resolvePickerTarget(filter, mode, { baseCwd, knownDirs }),
    [filter, mode, baseCwd, knownDirs],
  );
  const currentPath = target.currentPath;
  const absolutePath = useMemo(() => toAbsolutePath(baseCwd, currentPath), [baseCwd, currentPath]);
  const query = target.query;
  const pendingDirRequestsRef = useRef(new Set<string>());
  const [createOpen, setCreateOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);

  useEffect(() => {
    if (!absolutePath) return;
    if (tree.has(absolutePath) || pendingDirRequestsRef.current.has(absolutePath)) return;
    const relay = relayClientRef;
    if (!relay) return;
    let cancelled = false;
    pendingDirRequestsRef.current.add(absolutePath);
    void relay
      .requestDirectoryList(absolutePath)
      .then((result) => {
        if (cancelled) return;
        useFileStore.getState().setDirEntries(result.path, result.entries);
      })
      .catch(() => {
        if (cancelled) return;
        useFileStore.getState().setDirEntries(absolutePath, []);
      })
      .finally(() => {
        pendingDirRequestsRef.current.delete(absolutePath);
      });
    return () => {
      cancelled = true;
    };
  }, [absolutePath, tree]);

  // tree.has vs tree.get 分两档:
  // - 没 key: 目录请求飞行中, 显示 "加载中" 别误导成 "没有匹配"
  // - 有 key 但过滤后空: 才是 "没有匹配的路径"
  const isLoading = !tree.has(absolutePath);
  const filteredEntries = useMemo(() => {
    let entries = tree.get(absolutePath) ?? [];
    if (dirsOnly) entries = entries.filter((e) => e.isDir);
    if (query) entries = entries.filter((e) => e.name.toLowerCase().includes(query));
    return entries;
  }, [tree, absolutePath, query, dirsOnly]);

  const [index, setIndex] = useState(0);
  // filter 或所在目录变化时重置高亮到首项
  useEffect(() => setIndex(0), [currentPath, query]);
  useEffect(() => {
    setCreateOpen(false);
    setNewDirName("");
  }, [absolutePath]);
  useEffect(() => {
    if (index >= filteredEntries.length && filteredEntries.length > 0) {
      setIndex(filteredEntries.length - 1);
    }
  }, [filteredEntries.length, index]);

  const listRef = useRef<HTMLUListElement>(null);
  // 只有键盘 ↑↓ 改 index 时才滚动; 鼠标 hover 改 index 不滚,
  // 否则贴边 item 被 hover 时会触发 scrollIntoView("nearest") 抖一下
  const shouldScrollOnIndexChange = useRef(false);
  useEffect(() => {
    if (!shouldScrollOnIndexChange.current) return;
    shouldScrollOnIndexChange.current = false;
    const btn = listRef.current?.querySelector<HTMLElement>(`[data-entry-index="${index}"]`);
    btn?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // insert 模式下 "./" 只是 picker 内部的 cwd fallback 显示, 不该泄漏到插入文本;
  // select 模式保持原语义 (CreateSessionDialog 依赖 "./xxx" 表达相对路径)
  const emitPath = useCallback(
    (entry: { name: string; isDir: boolean }): string => {
      const raw = joinPickerPath(currentPath, entry);
      return mode === "insert" ? raw.replace(/^\.\//, "") : raw;
    },
    [currentPath, mode],
  );

  async function handleCreateDirectory() {
    const targetPath = joinChildDirectory(absolutePath, newDirName);
    if (!targetPath || !onCreateDirectory) return;
    setCreatingDir(true);
    try {
      const createdPath = await onCreateDirectory(targetPath);
      if (!createdPath) return;
      setNewDirName("");
      setCreateOpen(false);
      onSelect(withTrailingSlash(createdPath));
    } finally {
      setCreatingDir(false);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      handleKey(e) {
        if (filteredEntries.length === 0) return false;
        if (e.key === "ArrowDown") {
          shouldScrollOnIndexChange.current = true;
          setIndex((i) => Math.min(filteredEntries.length - 1, i + 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          shouldScrollOnIndexChange.current = true;
          setIndex((i) => Math.max(0, i - 1));
          return true;
        }
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          onSelect(emitPath(filteredEntries[index]));
          return true;
        }
        return false;
      },
    }),
    [filteredEntries, index, emitPath, onSelect],
  );

  const containerClass =
    placement === "inline"
      ? "relative w-full bg-popover border border-border rounded-md overflow-hidden"
      : mode === "insert"
        ? "absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg z-10 overflow-hidden"
        : "absolute left-0 right-0 top-full z-50 mt-2 bg-popover border border-border rounded-md shadow-lg overflow-hidden";
  const listClass =
    placement === "inline"
      ? "h-44 overflow-y-auto overscroll-contain"
      : mode === "select"
        ? "max-h-44 overflow-y-auto overscroll-contain"
        : "max-h-60 overflow-y-auto overscroll-contain";

  return (
    <div
      className={containerClass}
      data-slot="file-path-picker"
      data-mode={mode}
      data-placement={placement}
    >
      {mode === "select" && title ? (
        <div className="border-b border-border/70 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{title}</span>
            {onCreateDirectory ? (
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!absolutePath || creatingDir}
                onClick={() => setCreateOpen((value) => !value)}
              >
                新建目录
              </button>
            ) : null}
          </div>
          {createOpen ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleCreateDirectory();
                  }
                  if (e.key === "Escape") {
                    setCreateOpen(false);
                    setNewDirName("");
                  }
                }}
                placeholder="目录名称"
                className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-input px-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:min-h-0 md:text-sm"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="min-h-11 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:min-h-0"
                disabled={!joinChildDirectory(absolutePath, newDirName) || creatingDir}
                onClick={() => void handleCreateDirectory()}
              >
                {creatingDir ? "创建中..." : "创建目录"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={listClass}>
        {filteredEntries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {isLoading ? "加载中..." : "没有匹配的路径"}
          </div>
        ) : (
          <ul ref={listRef} role="list" className="flex flex-col">
            {filteredEntries.map((e, i) => (
              <li key={e.name}>
                <button
                  type="button"
                  onClick={() => onSelect(emitPath(e))}
                  onMouseEnter={() => setIndex(i)}
                  className={cn(
                    "w-full flex min-h-11 items-center gap-2 px-3 py-2 text-sm text-left transition-colors md:h-9 md:min-h-0 md:py-0",
                    // --accent 和 --popover 同为 #2D2D2D, bg-accent 在 picker 里跟底色撞;
                    // 用 primary 15% 混透明色凑对比, 同时沿用品牌色语言
                    i === index && "bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]",
                    e.isDir && "font-semibold",
                  )}
                  data-slot="file-entry"
                  data-entry-type={e.isDir ? "dir" : "file"}
                  data-entry-index={i}
                >
                  <span className="font-mono text-[13px]">
                    {e.name}
                    {e.isDir ? "/" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
