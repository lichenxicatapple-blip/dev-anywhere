// 文件路径选择器：输入 @ 触发，浏览目录树，选择文件插入路径
import { useMemo, useCallback } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { DirEntry } from "@cc-anywhere/shared";
import { buildBreadcrumbSegments, joinPath } from "@/components/directory-picker/path-utils";
import "./index.css";

interface FilePathPickerProps {
  tree: Map<string, DirEntry[]>;
  currentPath: string;
  filter: string;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  visible: boolean;
}

export function FilePathPicker({
  tree,
  currentPath,
  filter,
  onSelect,
  onNavigate,
  visible,
}: FilePathPickerProps) {
  const allEntries = tree.get(currentPath) || [];

  const fileFilter = useMemo(() => {
    const afterAt = filter.split("@").pop() || "";
    const lastSlash = afterAt.lastIndexOf("/");
    return lastSlash >= 0
      ? afterAt.slice(lastSlash + 1).toLowerCase()
      : afterAt.toLowerCase();
  }, [filter]);

  const entries = useMemo(() => {
    if (!fileFilter) return allEntries;
    return allEntries.filter((e) =>
      e.name.toLowerCase().includes(fileFilter),
    );
  }, [allEntries, fileFilter]);

  const segments = useMemo(
    () => buildBreadcrumbSegments(currentPath),
    [currentPath],
  );

  const handleEntryClick = useCallback(
    (entry: DirEntry) => {
      const fullPath = joinPath(currentPath, entry.name);
      if (entry.isDir) {
        onNavigate(fullPath);
      } else {
        onSelect(fullPath);
      }
    },
    [currentPath, onNavigate, onSelect],
  );

  if (!visible) return null;

  return (
    <View className="file-picker-panel">
      <View className="file-picker-header">
        <Text className="file-picker-title">Files</Text>
      </View>
      <ScrollView className="file-picker-breadcrumb-scroll" scrollX>
        <View className="file-picker-breadcrumb-row">
          {segments.map((seg, i) => (
            <View
              key={seg.path}
              className="file-picker-breadcrumb-item"
              onClick={() => onNavigate(seg.path)}
            >
              {i > 1 && <Text className="file-picker-breadcrumb-sep">/</Text>}
              <Text
                className={`file-picker-breadcrumb-text ${i === segments.length - 1 ? "active" : ""}`}
              >
                {seg.label}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <ScrollView className="file-picker-scroll" scrollY>
        {entries.map((entry) => (
          <View
            key={entry.name}
            className="file-picker-item"
            onClick={() => handleEntryClick(entry)}
          >
            <Text className="file-picker-item-icon">
              {entry.isDir ? "[D]" : "[F]"}
            </Text>
            <Text
              className={`file-picker-item-name ${entry.isDir ? "dir" : "file"}`}
            >
              {entry.name}
            </Text>
            {entry.isDir && (
              <View className="file-picker-item-chevron" />
            )}
          </View>
        ))}
        {entries.length === 0 && (
          <View className="file-picker-empty">
            <Text className="file-picker-empty-text">No matching files</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
