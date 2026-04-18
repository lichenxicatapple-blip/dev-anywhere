// FilePathPicker: 订阅 useFileStore.tree + cache-miss 触发 dir_list_request
// 共享给 InputBar (mode="insert") 与 CreateSessionDialog (mode="select", dirsOnly)
// "insert" 从 "@query" 提取当前路径与过滤词
// "select" 直接把 filter 视作绝对/相对路径输入
import { useEffect, useMemo } from "react";
import { useFileStore } from "@/stores/file-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

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

export function FilePathPicker({
  filter,
  onSelect,
  mode = "insert",
  dirsOnly = false,
}: FilePathPickerProps) {
  const tree = useFileStore((s) => s.tree);
  const currentPath = useMemo(
    () => extractPath(filter, mode) || "./",
    [filter, mode],
  );
  const query = useMemo(() => extractQuery(filter, mode), [filter, mode]);

  useEffect(() => {
    if (!tree.get(currentPath)) {
      const relay = relayClientRef;
      relay?.sendControl({ type: "dir_list_request", path: currentPath });
    }
  }, [currentPath, tree]);

  const allEntries = tree.get(currentPath) ?? [];
  const filteredEntries = useMemo(() => {
    let entries = allEntries;
    if (dirsOnly) entries = entries.filter((e) => e.isDir);
    if (query) entries = entries.filter((e) => e.name.toLowerCase().includes(query));
    return entries;
  }, [allEntries, query, dirsOnly]);

  const containerClass =
    mode === "insert"
      ? "absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg max-h-60 z-10 overflow-hidden"
      : "bg-popover border border-border rounded-md shadow-sm max-h-48 overflow-hidden";

  return (
    <div className={containerClass} data-slot="file-path-picker" data-mode={mode}>
      <div className="text-xs text-muted-foreground px-3 py-1 border-b border-border font-mono">
        {currentPath}
      </div>
      <ScrollArea className="max-h-48">
        {filteredEntries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            没有匹配的路径
          </div>
        ) : (
          <ul role="list" className="flex flex-col">
            {filteredEntries.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  onClick={() =>
                    onSelect(currentPath + e.name + (e.isDir ? "/" : ""))
                  }
                  className={cn(
                    "w-full flex items-center gap-2 px-3 h-9 text-sm hover:bg-accent text-left",
                    e.isDir && "font-semibold",
                  )}
                  data-slot="file-entry"
                  data-entry-type={e.isDir ? "dir" : "file"}
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
      </ScrollArea>
    </div>
  );
}
