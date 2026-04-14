// 目录选择器：用于新建会话时选择工作目录
import { useState, useCallback, useMemo, useEffect } from "react";
import { View, Text, ScrollView, Input } from "@tarojs/components";
import type { DirEntry } from "@cc-anywhere/shared";
import { buildBreadcrumbSegments, joinPath } from "./path-utils";
import "./index.css";

export { buildBreadcrumbSegments, buildParentPath, joinPath } from "./path-utils";

interface DirectoryPickerProps {
  visible: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onRequestDir: (path: string) => void;
  onCreateDir?: (path: string) => void;
  dirEntries: Map<string, DirEntry[]>;
  initialPath?: string;
}

export function DirectoryPicker({
  visible,
  onSelect,
  onCancel,
  onRequestDir,
  onCreateDir,
  dirEntries,
  initialPath = "/",
}: DirectoryPickerProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");

  useEffect(() => {
    if (visible) {
      setCurrentPath(initialPath);
      setCreatingDir(false);
      setNewDirName("");
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
      setCreatingDir(false);
      setNewDirName("");
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

  const handleCreateDir = useCallback(() => {
    const name = newDirName.trim();
    if (!name || !onCreateDir) return;
    const fullPath = joinPath(currentPath, name);
    onCreateDir(fullPath);
    setCreatingDir(false);
    setNewDirName("");
    // 创建后刷新当前目录
    setTimeout(() => onRequestDir(currentPath), 300);
  }, [currentPath, newDirName, onCreateDir, onRequestDir]);

  if (!visible) return null;

  return (
    <View className="dir-picker-overlay" onClick={onCancel}>
      <View
        className="dir-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <View className="dir-picker-header">
          <Text className="dir-picker-title">&gt;_ Select Dir</Text>
        </View>

        <ScrollView className="dir-picker-breadcrumb-scroll" scrollX>
          <View className="dir-picker-breadcrumb-row">
            {segments.map((seg, i) => (
              <View
                key={seg.path}
                className="dir-picker-breadcrumb-item"
                onClick={() => handleNavigate(seg.path)}
              >
                {i > 1 && <Text className="dir-picker-breadcrumb-sep">/</Text>}
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
              <View className="dir-picker-item-chevron" />
            </View>
          ))}
          {dirs.length === 0 && !creatingDir && (
            <View className="dir-picker-empty">
              <Text className="dir-picker-empty-text">-- empty --</Text>
            </View>
          )}
        </ScrollView>

        {creatingDir && (
          <View className="dir-picker-create-row">
            <Input
              className="dir-picker-create-input"
              value={newDirName}
              onInput={(e) => setNewDirName(e.detail.value)}
              onConfirm={handleCreateDir}
              placeholder="dir_name"
              focus
            />
            <View className="dir-picker-create-confirm" onClick={handleCreateDir}>
              <Text className="dir-picker-create-confirm-text">OK</Text>
            </View>
            <View className="dir-picker-create-cancel" onClick={() => { setCreatingDir(false); setNewDirName(""); }}>
              <Text className="dir-picker-create-cancel-text">X</Text>
            </View>
          </View>
        )}

        <View className="dir-picker-actions">
          <View className="dir-picker-select-btn" onClick={() => onSelect(currentPath)}>
            <Text className="dir-picker-select-btn-text">[ OK ] {currentPath}</Text>
          </View>
          <View className="dir-picker-bottom-row">
            {onCreateDir && (
              <View className="dir-picker-mkdir-btn" onClick={() => setCreatingDir(true)}>
                <Text className="dir-picker-mkdir-btn-text">+ mkdir</Text>
              </View>
            )}
            <View className="dir-picker-cancel-btn" onClick={onCancel}>
              <Text className="dir-picker-cancel-btn-text">ESC</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
