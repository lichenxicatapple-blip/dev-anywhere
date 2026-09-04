// FilePathPicker: 订阅 useFileStore.tree + cache miss 时通过 RelayClient 请求目录
// 共享给 InputBar (mode="insert") 与各类远程路径选择器 (mode="select")
// "insert" 从 "@query" 提取当前路径与过滤词; "select" 将 filter 锚到 $HOME 并只输出绝对路径
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
import type { RelayClient } from "@/services/relay-client";
import { cn } from "@/lib/utils";
import { resolvePickerTarget, withTrailingSlash } from "@/lib/file-path-picker-target";
import type { PickerHandle } from "./picker-handle";

interface FilePathPickerBaseProps {
  filter: string;
  placement?: "floating" | "inline";
  onSelect: (path: string) => void;
  onSelectCurrentDirectory?: (path: string) => void;
  onCreateDirectory?: (path: string) => Promise<string | null>;
  dirsOnly?: boolean;
  fileExtensions?: readonly string[];
  includeHidden?: boolean;
  autoHighlightFirst?: boolean;
  title?: string;
}

type FilePathPickerProps = FilePathPickerBaseProps &
  (
    | {
        mode: "select";
        onNavigate: (absoluteDirectory: string) => void;
      }
    | {
        mode?: "insert";
        onNavigate?: never;
      }
  );

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
    onNavigate,
    onSelectCurrentDirectory,
    onCreateDirectory,
    mode = "insert",
    placement = "floating",
    dirsOnly = false,
    fileExtensions,
    includeHidden = false,
    autoHighlightFirst = true,
    title,
  },
  ref,
) {
  const tree = useFileStore((s) => (includeHidden ? s.treeWithHidden : s.tree));
  const sessionCwd = useFileStore((s) => s.cwd);
  const homePath = useFileStore((s) => s.homePath);
  // insert 模式在 Chat 页, 锚到 session cwd (@ 后的相对路径拼在 session cwd 下)
  // select 模式不依赖会话 cwd，统一从开发机的 $HOME 开始
  const baseCwd = mode === "insert" ? sessionCwd : homePath || sessionCwd;
  const knownDirs = useMemo(() => new Set(tree.keys()), [tree]);
  const target = useMemo(
    () => resolvePickerTarget(filter, mode, { baseCwd, knownDirs }),
    [filter, mode, baseCwd, knownDirs],
  );
  const currentPath = target.currentPath;
  const absolutePath = useMemo(() => toAbsolutePath(baseCwd, currentPath), [baseCwd, currentPath]);
  const query = target.query;
  const pendingDirRequestsRef = useRef(
    new Map<string, ReturnType<RelayClient["requestDirectoryList"]>>(),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);
  const [loadFailure, setLoadFailure] = useState<{ path: string; message: string } | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (!absolutePath) return;
    const requestKey = `${includeHidden ? "hidden" : "default"}\0${absolutePath}`;
    if (tree.has(absolutePath)) return;
    const relay = relayClientRef;
    if (!relay) return;
    let cancelled = false;
    setLoadFailure((failure) => (failure?.path === absolutePath ? null : failure));

    let request = pendingDirRequestsRef.current.get(requestKey);
    if (!request) {
      request = relay.requestDirectoryList(absolutePath, { includeHidden });
      pendingDirRequestsRef.current.set(requestKey, request);
      const clearPendingRequest = () => {
        if (pendingDirRequestsRef.current.get(requestKey) === request) {
          pendingDirRequestsRef.current.delete(requestKey);
        }
      };
      void request.then(clearPendingRequest, clearPendingRequest);
    }

    void request.then(
      (result) => {
        if (cancelled) return;
        if (result.error !== undefined || result.errorCode !== undefined) {
          setLoadFailure({ path: absolutePath, message: result.error || "读取失败" });
          return;
        }
        useFileStore.getState().setDirEntries(result.path, result.entries, result.includeHidden);
      },
      (error: unknown) => {
        if (cancelled) return;
        setLoadFailure({
          path: absolutePath,
          message: error instanceof Error ? error.message : "读取失败",
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [absolutePath, includeHidden, tree, retryGeneration]);

  // tree.has vs tree.get 分两档:
  // - 没 key: 目录请求飞行中, 显示 "加载中" 别误导成 "没有匹配"
  // - 有 key 但过滤后空: 才是 "没有匹配的路径"
  const activeLoadFailure = loadFailure?.path === absolutePath ? loadFailure : null;
  const isLoading = !tree.has(absolutePath) && !activeLoadFailure;
  const normalizedFileExtensions = useMemo(
    () =>
      fileExtensions?.map((extension) =>
        extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`,
      ),
    [fileExtensions],
  );
  const filteredEntries = useMemo(() => {
    let entries = tree.get(absolutePath) ?? [];
    if (dirsOnly) entries = entries.filter((e) => e.isDir);
    else if (normalizedFileExtensions?.length) {
      entries = entries.filter(
        (entry) =>
          entry.isDir ||
          normalizedFileExtensions.some((extension) =>
            entry.name.toLowerCase().endsWith(extension),
          ),
      );
    }
    if (query) entries = entries.filter((e) => e.name.toLowerCase().includes(query));
    return entries;
  }, [tree, absolutePath, query, dirsOnly, normalizedFileExtensions]);

  const [index, setIndex] = useState(autoHighlightFirst ? 0 : -1);
  // filter 或所在目录变化时重置高亮到首项
  useEffect(() => setIndex(autoHighlightFirst ? 0 : -1), [autoHighlightFirst, currentPath, query]);
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

  // insert 模式下 "./" 只是 picker 内部的 cwd fallback 显示，不该泄漏到插入文本；
  // select 模式始终向业务层返回绝对路径。
  const emitPath = useCallback(
    (entry: { name: string; isDir: boolean }): string => {
      const raw = joinPickerPath(currentPath, entry);
      if (mode === "insert") return raw.replace(/^\.\//, "");
      const absolute = toAbsolutePath(baseCwd, raw);
      return entry.isDir ? withTrailingSlash(absolute) : absolute;
    },
    [baseCwd, currentPath, mode],
  );

  const navigate = useCallback(
    (path: string): void => {
      const absolute = toAbsolutePath(baseCwd, path);
      if (!absolute) return;
      const directory = withTrailingSlash(absolute);
      if (mode === "select") {
        onNavigate!(directory);
        return;
      }
      onSelect(directory);
    },
    [baseCwd, mode, onNavigate, onSelect],
  );

  const selectEntry = useCallback(
    (entry: { name: string; isDir: boolean }): void => {
      const path = emitPath(entry);
      if (entry.isDir) {
        navigate(path);
        return;
      }
      onSelect(path);
    },
    [emitPath, navigate, onSelect],
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
      if (onSelectCurrentDirectory) {
        onSelectCurrentDirectory(withTrailingSlash(createdPath));
        return;
      }
      navigate(createdPath);
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
        if (e.key === "Enter" && index >= 0 && !e.nativeEvent.isComposing) {
          selectEntry(filteredEntries[index]);
          return true;
        }
        return false;
      },
    }),
    [filteredEntries, index, selectEntry],
  );

  const parentPath = useMemo(() => {
    if (!absolutePath || absolutePath === "/") return "/";
    const lastSlash = absolutePath.lastIndexOf("/");
    return lastSlash <= 0 ? "/" : absolutePath.slice(0, lastSlash);
  }, [absolutePath]);

  const containerClass =
    placement === "inline"
      ? "relative w-full bg-popover border border-border rounded-md overflow-hidden"
      : mode === "insert"
        ? "absolute bottom-full left-0 right-0 z-50 mb-2 bg-popover border border-border rounded-md shadow-lg overflow-hidden"
        : "absolute left-0 right-0 top-full z-50 mt-2 bg-popover border border-border rounded-md shadow-lg overflow-hidden";
  const listClass =
    placement === "inline"
      ? "max-h-[min(11rem,30dvh)] overflow-y-auto overscroll-contain"
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
      {mode === "select" ? (
        <div className="border-b border-border/70 px-3 py-2">
          <div className="min-w-0">
            {title ? (
              <p
                className="mb-2 truncate text-xs text-muted-foreground"
                data-slot="file-path-picker-title"
              >
                {title}
              </p>
            ) : null}
            <p
              className="truncate font-mono text-xs text-foreground"
              data-slot="file-path-picker-current-directory"
              title={absolutePath}
            >
              {absolutePath || "正在读取路径"}
            </p>
          </div>
          <div
            className="mt-1 flex items-center justify-between gap-2"
            role="toolbar"
            aria-label="路径操作"
            data-slot="file-path-picker-actions"
          >
            <button
              type="button"
              data-slot="file-path-picker-parent"
              className="inline-flex min-h-11 min-w-11 items-center justify-start px-0 text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline md:min-h-8 md:min-w-0"
              disabled={!absolutePath || absolutePath === "/"}
              onClick={() => navigate(parentPath)}
            >
              上一级
            </button>
            {onSelectCurrentDirectory || onCreateDirectory ? (
              <span className="flex shrink-0 items-center gap-4">
                {onCreateDirectory ? (
                  <button
                    type="button"
                    data-slot="file-path-picker-create-directory-toggle"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center px-0 text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline md:min-h-8 md:min-w-0"
                    disabled={!absolutePath || creatingDir}
                    onClick={() => setCreateOpen((value) => !value)}
                  >
                    新建目录
                  </button>
                ) : null}
                {onSelectCurrentDirectory ? (
                  <button
                    type="button"
                    data-slot="select-current-directory"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center px-0 text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline md:min-h-8 md:min-w-0"
                    disabled={!absolutePath}
                    onClick={() => onSelectCurrentDirectory(withTrailingSlash(absolutePath))}
                  >
                    选定
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          {createOpen ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                data-slot="file-path-picker-create-directory-name"
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
                data-slot="file-path-picker-create-directory-submit"
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
      <div className={listClass} data-slot="file-path-picker-entries">
        {activeLoadFailure ? (
          <div
            data-slot="file-path-picker-error"
            className="flex items-center justify-between gap-3 px-3 py-2"
            role="alert"
          >
            <span className="min-w-0 text-xs text-destructive" title={activeLoadFailure.message}>
              无法读取这个文件夹
            </span>
            <button
              type="button"
              data-slot="file-path-picker-retry"
              className="shrink-0 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setRetryGeneration((generation) => generation + 1)}
            >
              重试
            </button>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {isLoading ? "加载中..." : "没有匹配的路径"}
          </div>
        ) : (
          <ul ref={listRef} role="list" className="flex flex-col">
            {filteredEntries.map((e, i) => (
              <li key={e.name}>
                <button
                  type="button"
                  onClick={() => selectEntry(e)}
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
                  data-entry-name={e.name}
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
