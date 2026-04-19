// FilePathPicker: 订阅 useFileStore.tree + cache-miss 触发 dir_list_request
// 共享给 InputBar (mode="insert") 与 CreateSessionDialog (mode="select", dirsOnly)
// "insert" 从 "@query" 提取当前路径与过滤词; "select" 直接把 filter 视作绝对/相对路径
// 键盘: InputBar 通过 ref.handleKey 转发 ↑↓/Enter; 选中项用 scrollIntoView 跟随
// 滚动: Radix ScrollArea 在 max-h-only 父容器下 Viewport 拿不到高度约束, 这里用原生 overflow-y-auto
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFileStore } from "@/stores/file-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { cn } from "@/lib/utils";
import type { PickerHandle } from "./picker-handle";

interface FilePathPickerProps {
  filter: string;
  mode?: "insert" | "select";
  onSelect: (path: string) => void;
  dirsOnly?: boolean;
}

function extractQuery(filter: string, mode: "insert" | "select"): string {
  if (mode === "select") {
    const lastSlash = filter.lastIndexOf("/");
    return lastSlash >= 0
      ? filter.slice(lastSlash + 1).toLowerCase()
      : filter.toLowerCase();
  }
  const afterAt = filter.split("@").pop() ?? "";
  const lastSlash = afterAt.lastIndexOf("/");
  return lastSlash >= 0
    ? afterAt.slice(lastSlash + 1).toLowerCase()
    : afterAt.toLowerCase();
}

function extractPath(filter: string, mode: "insert" | "select"): string {
  if (mode === "select") {
    const lastSlash = filter.lastIndexOf("/");
    return lastSlash >= 0 ? filter.slice(0, lastSlash + 1) : "./";
  }
  const afterAt = filter.split("@").pop() ?? "";
  const lastSlash = afterAt.lastIndexOf("/");
  return lastSlash >= 0 ? afterAt.slice(0, lastSlash + 1) : "";
}

// 相对路径 (./, apps/, apps/feishu/) + cwd 拼成绝对路径
// 绝对路径 (/Users/...) 直接用, 避免 select 模式被错误拼到 cwd 下
// 空 / "./" → cwd; 末尾清斜杠避免 // 双斜杠; 前缀 "./" 清掉
function toAbsolutePath(cwd: string, relPath: string): string {
  if (relPath.startsWith("/")) {
    return relPath.replace(/\/+$/, "") || "/";
  }
  if (!cwd) return "";
  const cleaned = relPath.replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned ? `${cwd}/${cleaned}` : cwd;
}

export const FilePathPicker = forwardRef<PickerHandle, FilePathPickerProps>(
  function FilePathPicker(
    { filter, onSelect, mode = "insert", dirsOnly = false },
    ref,
  ) {
    const tree = useFileStore((s) => s.tree);
    const cwd = useFileStore((s) => s.cwd);
    const currentPath = useMemo(
      () => extractPath(filter, mode) || "./",
      [filter, mode],
    );
    const absolutePath = useMemo(
      () => toAbsolutePath(cwd, currentPath),
      [cwd, currentPath],
    );
    const query = useMemo(() => extractQuery(filter, mode), [filter, mode]);

    useEffect(() => {
      if (!absolutePath) return;
      if (!tree.get(absolutePath)) {
        const relay = relayClientRef;
        relay?.sendControl({ type: "dir_list_request", path: absolutePath });
      }
    }, [absolutePath, tree]);

    const filteredEntries = useMemo(() => {
      let entries = tree.get(absolutePath) ?? [];
      if (dirsOnly) entries = entries.filter((e) => e.isDir);
      if (query)
        entries = entries.filter((e) => e.name.toLowerCase().includes(query));
      return entries;
    }, [tree, absolutePath, query, dirsOnly]);

    const [index, setIndex] = useState(0);
    // filter 或所在目录变化时重置高亮到首项
    useEffect(() => setIndex(0), [currentPath, query]);
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
      const btn = listRef.current?.querySelector<HTMLElement>(
        `[data-entry-index="${index}"]`,
      );
      btn?.scrollIntoView({ block: "nearest" });
    }, [index]);

    // insert 模式下 "./" 只是 picker 内部的 cwd fallback 显示, 不该泄漏到插入文本;
    // select 模式保持原语义 (CreateSessionDialog 依赖 "./xxx" 表达相对路径)
    const emitPath = (entry: { name: string; isDir: boolean }): string => {
      const raw = currentPath + entry.name + (entry.isDir ? "/" : "");
      return mode === "insert" ? raw.replace(/^\.\//, "") : raw;
    };

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
      [filteredEntries, index, mode, currentPath, onSelect],
    );

    const containerClass =
      mode === "insert"
        ? "absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg z-10 overflow-hidden"
        : "bg-popover border border-border rounded-md shadow-sm overflow-hidden";

    return (
      <div className={containerClass} data-slot="file-path-picker" data-mode={mode}>
        <div className="text-xs text-muted-foreground px-3 py-1 border-b border-border font-mono">
          {currentPath}
        </div>
        <div className="max-h-60 overflow-y-auto overscroll-contain">
          {filteredEntries.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              没有匹配的路径
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
                      "w-full flex items-center gap-2 px-3 h-9 text-sm text-left transition-colors",
                      // --accent 和 --popover 同为 #2D2D2D, bg-accent 在 picker 里跟底色撞;
                      // 用 primary 15% 混透明色凑对比, 同时沿用品牌色语言
                      i === index &&
                        "bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]",
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
  },
);
