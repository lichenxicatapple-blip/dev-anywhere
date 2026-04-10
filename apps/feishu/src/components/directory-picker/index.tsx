// 目录选择器：用于新建会话时选择工作目录
import { useState, useCallback, useMemo, useEffect } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { DirEntry } from "@cc-anywhere/shared";
import { buildBreadcrumbSegments, joinPath } from "./path-utils";
import "./index.css";

export { buildBreadcrumbSegments, buildParentPath, joinPath } from "./path-utils";

interface DirectoryPickerProps {
  visible: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onRequestDir: (path: string) => void;
  dirEntries: Map<string, DirEntry[]>;
  initialPath?: string;
}

export function DirectoryPicker({
  visible,
  onSelect,
  onCancel,
  onRequestDir,
  dirEntries,
  initialPath = "/",
}: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);

  useEffect(() => {
    if (visible) {
      setCurrentPath(initialPath);
      onRequestDir(initialPath);
    }
  }, [visible, initialPath, onRequestDir]);

  const segments = useMemo(
    () => buildBreadcrumbSegments(currentPath),
    [currentPath],
  );

  const entries = dirEntries.get(currentPath) || [];
  const dirs = entries.filter((e) => e.isDir);

  const handleNavigate = useCallback(
    (path: string) => {
      setCurrentPath(path);
      if (!dirEntries.has(path)) {
        onRequestDir(path);
      }
    },
    [dirEntries, onRequestDir],
  );

  const handleEntryClick = useCallback(
    (entry: DirEntry) => {
      const fullPath = joinPath(currentPath, entry.name);
      handleNavigate(fullPath);
    },
    [currentPath, handleNavigate],
  );

  if (!visible) return null;

  return (
    <View className="dir-picker-overlay" onClick={onCancel}>
      <View
        className="dir-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <Text className="dir-picker-title">Select Working Directory</Text>

        <ScrollView className="dir-picker-breadcrumb-scroll" scrollX>
          <View className="dir-picker-breadcrumb-row">
            {segments.map((seg, i) => (
              <View
                key={seg.path}
                className="dir-picker-breadcrumb-item"
                onClick={() => handleNavigate(seg.path)}
              >
                {i > 0 && <Text className="dir-picker-breadcrumb-sep">/</Text>}
                <Text
                  className={`dir-picker-breadcrumb-text ${i === segments.length - 1 ? "active" : ""}`}
                >
                  {seg.label}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>

        <ScrollView className="dir-picker-list" scrollY>
          {dirs.map((entry) => (
            <View
              key={entry.name}
              className="dir-picker-item"
              onClick={() => handleEntryClick(entry)}
            >
              <Text className="dir-picker-item-icon">[D]</Text>
              <Text className="dir-picker-item-name">{entry.name}</Text>
              <Text className="dir-picker-item-arrow">{">"}</Text>
            </View>
          ))}
          {dirs.length === 0 && (
            <View className="dir-picker-empty">
              <Text className="dir-picker-empty-text">No subdirectories</Text>
            </View>
          )}
        </ScrollView>

        <View className="dir-picker-actions">
          <View className="dir-picker-select-btn" onClick={() => onSelect(currentPath)}>
            <Text className="dir-picker-select-btn-text">Select</Text>
          </View>
          <View className="dir-picker-cancel-btn" onClick={onCancel}>
            <Text className="dir-picker-cancel-btn-text">Return</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
