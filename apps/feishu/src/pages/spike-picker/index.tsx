import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { View, Text, ScrollView, Input } from "@tarojs/components";
import "./index.css";

// --- 数据类型 ---

interface CommandItem {
  name: string;
  description: string;
  argumentHint?: string;
  source: "repl" | "skill" | "plugin" | "command";
}

interface FileEntry {
  name: string;
  isDir: boolean;
}

// --- Mock 命令列表 ---

const MOCK_COMMANDS: CommandItem[] = [
  { name: "compact", description: "Compact conversation history", source: "repl" },
  { name: "status", description: "Show session status", source: "repl" },
  { name: "model", description: "Switch model", argumentHint: "<model-name>", source: "repl" },
  { name: "clear", description: "Clear conversation", source: "repl" },
  { name: "cost", description: "Show token usage", source: "repl" },
  { name: "help", description: "Show available commands", source: "repl" },
  { name: "gsd-plan-phase", description: "Create detailed phase plan (PLAN.md) with verification loop", argumentHint: "[phase] [--auto] [--research] [--skip-research] [--gaps]", source: "skill" },
  { name: "gsd-execute-phase", description: "Execute all plans in a phase with wave-based parallelization", argumentHint: "<phase-number> [--wave N] [--gaps-only] [--interactive]", source: "skill" },
  { name: "gsd-debug", description: "Systematic debugging with persistent state across context resets", argumentHint: "[--diagnose] [issue description]", source: "skill" },
  { name: "gsd-fast", description: "Execute a trivial task inline -- no subagents, no planning overhead", argumentHint: "[task description]", source: "skill" },
  { name: "gsd-discuss-phase", description: "Gather phase context through adaptive questioning before planning", argumentHint: "<phase> [--auto] [--chain] [--batch]", source: "skill" },
  { name: "gsd-quick", description: "Execute a quick task with GSD guarantees", argumentHint: "[--full] [--validate] [--discuss] [--research]", source: "skill" },
  { name: "gsd-progress", description: "Check project progress and route to next action", source: "skill" },
  { name: "gsd-resume-work", description: "Resume work from previous session with full context restoration", source: "skill" },
  { name: "gsd-help", description: "Show available GSD commands and usage guide", source: "skill" },
  { name: "gsd-note", description: "Zero-friction idea capture. Append, list, or promote notes to todos.", argumentHint: "<text> | list | promote <N> [--global]", source: "skill" },
  { name: "gsd-do", description: "Route freeform text to the right GSD command automatically", argumentHint: "<description of what you want to do>", source: "skill" },
  { name: "gsd-next", description: "Automatically advance to the next logical step in the GSD workflow", source: "skill" },
  { name: "gsd-stats", description: "Display project statistics -- phases, plans, requirements, git metrics", source: "skill" },
  { name: "gsd-code-review", description: "Review source files changed during a phase for bugs and security issues", argumentHint: "<phase-number> [--depth=quick|standard|deep]", source: "skill" },
  { name: "lark-im", description: "Feishu messaging: send, reply, search chat history, manage groups", source: "skill" },
  { name: "lark-calendar", description: "Feishu calendar: view/create events, manage attendees, check availability", source: "skill" },
  { name: "lark-doc", description: "Feishu docs: create, edit, search cloud documents", source: "skill" },
  { name: "lark-task", description: "Feishu tasks: create, update, track, assign tasks", source: "skill" },
  { name: "commit-commands:commit", description: "Create a git commit", source: "plugin" },
  { name: "commit-commands:commit-push-pr", description: "Commit, push, and open a PR", source: "plugin" },
  { name: "superpowers:brainstorming", description: "Explore intent, requirements and design before implementation", source: "plugin" },
  { name: "superpowers:systematic-debugging", description: "Use when encountering any bug, test failure, or unexpected behavior", source: "plugin" },
  { name: "feature-dev:feature-dev", description: "Guided feature development with codebase understanding", argumentHint: "Optional feature description", source: "plugin" },
  { name: "impeccable:frontend-design", description: "Create distinctive, production-grade frontend interfaces", source: "plugin" },
];

// --- Mock 文件树 ---

const MOCK_FILE_TREE: Record<string, FileEntry[]> = {
  "/": [
    { name: "apps", isDir: true },
    { name: "packages", isDir: true },
    { name: "reference", isDir: true },
    { name: ".planning", isDir: true },
    { name: "CLAUDE.md", isDir: false },
    { name: "package.json", isDir: false },
    { name: "pnpm-workspace.yaml", isDir: false },
    { name: "tsconfig.json", isDir: false },
  ],
  "/apps": [
    { name: "feishu", isDir: true },
    { name: "proxy", isDir: true },
    { name: "relay", isDir: true },
  ],
  "/apps/feishu": [
    { name: "src", isDir: true },
    { name: "package.json", isDir: false },
    { name: "tsconfig.json", isDir: false },
  ],
  "/apps/feishu/src": [
    { name: "pages", isDir: true },
    { name: "app.config.ts", isDir: false },
    { name: "app.css", isDir: false },
    { name: "app.ts", isDir: false },
  ],
  "/apps/feishu/src/pages": [
    { name: "spike-picker", isDir: true },
    { name: "spike-hub", isDir: true },
    { name: "spike-chat-json", isDir: true },
    { name: "spike-render", isDir: true },
    { name: "index", isDir: true },
  ],
  "/apps/proxy": [
    { name: "src", isDir: true },
    { name: "package.json", isDir: false },
  ],
  "/apps/relay": [
    { name: "src", isDir: true },
    { name: "Dockerfile", isDir: false },
    { name: "package.json", isDir: false },
  ],
};

// --- SlashCommandPicker ---

function SlashCommandPicker({
  filterText,
  onSelect,
}: {
  filterText: string;
  onSelect: (cmd: CommandItem) => void;
}) {
  const filtered = useMemo(() => {
    const q = filterText.toLowerCase().replace(/^\//, "");
    if (!q) return MOCK_COMMANDS;
    return MOCK_COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
  }, [filterText]);

  return (
    <View className="picker-panel">
      <View className="picker-header">
        <Text className="picker-title">Commands</Text>
        <Text className="picker-count">{filtered.length}</Text>
      </View>
      <ScrollView className="picker-scroll" scrollY>
        {filtered.length === 0 && (
          <View className="picker-empty">
            <Text className="picker-empty-text">No matching commands</Text>
          </View>
        )}
        {filtered.map((cmd) => (
          <View key={cmd.name} className="cmd-item" onClick={() => onSelect(cmd)}>
            <View className="cmd-row-top">
              <Text className="cmd-name">/{cmd.name}</Text>
              <Text className="cmd-source-tag">{cmd.source}</Text>
            </View>
            <Text className="cmd-desc">{cmd.description}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// --- FilePathPicker ---

function FilePathPicker({
  filterText,
  onSelect,
}: {
  filterText: string;
  onSelect: (path: string) => void;
}) {
  const [currentPath, setCurrentPath] = useState("/");
  const allEntries = MOCK_FILE_TREE[currentPath] || [];

  const fileFilter = useMemo(() => {
    const afterAt = filterText.split("@").pop() || "";
    const lastSlash = afterAt.lastIndexOf("/");
    return lastSlash >= 0 ? afterAt.slice(lastSlash + 1).toLowerCase() : afterAt.toLowerCase();
  }, [filterText]);

  const entries = useMemo(() => {
    if (!fileFilter) return allEntries;
    return allEntries.filter((e) => e.name.toLowerCase().includes(fileFilter));
  }, [allEntries, fileFilter]);

  const breadcrumbs = useMemo(() => {
    if (currentPath === "/") return [{ label: "root", path: "/" }];
    const parts = currentPath.split("/").filter(Boolean);
    const result = [{ label: "root", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      result.push({ label: p, path: acc });
    }
    return result;
  }, [currentPath]);

  const handleEntry = useCallback(
    (entry: FileEntry) => {
      const fullPath =
        currentPath === "/" ? "/" + entry.name : currentPath + "/" + entry.name;
      if (entry.isDir) {
        if (MOCK_FILE_TREE[fullPath]) {
          setCurrentPath(fullPath);
        }
      } else {
        onSelect(fullPath);
        setCurrentPath("/");
      }
    },
    [currentPath, onSelect],
  );

  return (
    <View className="picker-panel">
      <View className="picker-header">
        <Text className="picker-title">Files</Text>
      </View>
      <ScrollView className="breadcrumb-scroll" scrollX>
        <View className="breadcrumb-row">
          {breadcrumbs.map((b, i) => (
            <View
              key={b.path}
              className="breadcrumb-item"
              onClick={() => setCurrentPath(b.path)}
            >
              {i > 0 && <Text className="breadcrumb-sep">/</Text>}
              <Text
                className={`breadcrumb-text ${i === breadcrumbs.length - 1 ? "active" : ""}`}
              >
                {b.label}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <ScrollView className="picker-scroll" scrollY>
        {entries.map((entry) => (
          <View
            key={entry.name}
            className="file-item"
            onClick={() => handleEntry(entry)}
          >
            <Text className="file-icon">{entry.isDir ? "[D]" : "[F]"}</Text>
            <Text className={`file-name ${entry.isDir ? "dir" : "file"}`}>
              {entry.name}
            </Text>
            {entry.isDir && <Text className="file-arrow">{">"}</Text>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// @ 在句首或前面有空格时才算有效触发
// @ 后面如果已经有空格说明文件引用已完成，不再触发
function hasValidAt(val: string): boolean {
  const idx = val.lastIndexOf("@");
  if (idx < 0) return false;
  if (idx > 0 && val[idx - 1] !== " ") return false;
  const afterAt = val.slice(idx + 1);
  return !afterAt.includes(" ");
}

// --- 主页面 ---

export default function SpikePicker() {
  const [inputText, setInputText] = useState("");
  // 追踪已插入的 token（命令和文件路径），用于整体删除
  const [insertedTokens, setInsertedTokens] = useState<string[]>([]);
  const [pickerMode, setPickerMode] = useState<"none" | "slash" | "file">("none");
  const [argumentHint, setArgumentHint] = useState("");
  const [sentMessages, setSentMessages] = useState<string[]>([]);
  const [inputFocus, setInputFocus] = useState(false);
  const prevTextRef = useRef("");

  const handleInput = useCallback((e) => {
    const val: string = e.detail.value;
    const prev = prevTextRef.current;

    // 检测退格：文本变短且某个已知路径被部分删除
    if (val.length < prev.length && insertedTokens.length > 0) {
      for (const p of insertedTokens) {
        // 之前包含完整路径，现在不包含了，说明正在删这个路径
        if (prev.includes(p) && !val.includes(p)) {
          // 找到残留部分并整体移除
          // p 的某个前缀可能还残留在 val 里
          let cleaned = val;
          for (let len = p.length - 1; len > 0; len--) {
            const fragment = p.slice(0, len);
            if (cleaned.endsWith(fragment)) {
              cleaned = cleaned.slice(0, -fragment.length);
              // 如果前面有空格也清掉
              if (cleaned.endsWith(" ")) cleaned = cleaned.slice(0, -1);
              break;
            }
          }
          setInsertedTokens((tokens) => tokens.filter((x) => x !== p));
          setInputText(cleaned);
          prevTextRef.current = cleaned;

          if (!cleaned) {
            setPickerMode("none");
          } else if (hasValidAt(cleaned)) {
            setPickerMode("file");
          } else if (cleaned.startsWith("/")) {
            setPickerMode("slash");
          } else {
            setPickerMode("none");
          }
          return;
        }
      }
    }

    setInputText(val);
    prevTextRef.current = val;

    if (!val) {
      setPickerMode("none");
    } else if (hasValidAt(val)) {
      setPickerMode("file");
    } else if (val.startsWith("/") && !val.slice(1).includes(" ")) {
      setPickerMode("slash");
    } else {
      setPickerMode("none");
    }
  }, [insertedTokens]);

  const refocus = useCallback(() => {
    setInputFocus(false);
    setTimeout(() => setInputFocus(true), 50);
  }, []);

  const handleSelectCommand = useCallback((cmd: CommandItem) => {
    const token = "/" + cmd.name;
    const val = token + " ";
    setInputText(val);
    prevTextRef.current = val;
    setInsertedTokens((prev) => [...prev, token]);
    setPickerMode("none");
    setArgumentHint(cmd.argumentHint || "");
    refocus();
  }, [refocus]);

  const handleSelectFile = useCallback((path: string) => {
    const token = "@" + path;
    setInputText((prev) => {
      const idx = prev.lastIndexOf("@");
      const before = idx > 0 ? prev.slice(0, idx) : "";
      const val = before + token + " ";
      prevTextRef.current = val;
      return val;
    });
    setInsertedTokens((prev) => [...prev, token]);
    setPickerMode("none");
    setArgumentHint("");
    refocus();
  }, [refocus]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setSentMessages((prev) => [...prev, text]);
    setInputText("");
    setInsertedTokens([]);
    prevTextRef.current = "";
    setArgumentHint("");
    setPickerMode("none");
  }, [inputText]);

  useEffect(() => {
    if (!inputText) {
      setArgumentHint("");
    }
  }, [inputText]);

  return (
    <View className="page">
      <View className="page-header">
        <Text className="page-title">Picker Spike</Text>
        <Text className="page-subtitle">Type "/" for commands, "@" for files</Text>
      </View>

      <ScrollView className="message-list" scrollY>
        {sentMessages.map((msg, i) => (
          <View key={i} className="sent-msg">
            <Text className="sent-msg-text">{msg}</Text>
          </View>
        ))}
        {sentMessages.length === 0 && (
          <View className="hint-area">
            <Text className="hint-text">Try typing: / or @</Text>
          </View>
        )}
      </ScrollView>

      {/* picker 面板：输入栏上方 */}
      {pickerMode === "slash" && (
        <SlashCommandPicker
          filterText={inputText}
          onSelect={handleSelectCommand}
        />
      )}
      {pickerMode === "file" && (
        <FilePathPicker filterText={inputText} onSelect={handleSelectFile} />
      )}

      {/* 参数提示行 */}
      {argumentHint && (
        <View className="hint-bar">
          <Text className="hint-bar-text">{argumentHint}</Text>
        </View>
      )}

      {/* 输入栏 */}
      <View className="input-bar">
        <Input
          className="input-field"
          value={inputText}
          focus={inputFocus}
          onInput={handleInput}
          onConfirm={handleSend}
          onBlur={() => setInputFocus(false)}
          placeholder="输入消息..."
          confirmType="send"
        />
        <View
          className={`send-btn ${inputText.trim() ? "active" : "disabled"}`}
          onClick={handleSend}
        >
          <Text className="send-btn-icon">{"\u2191"}</Text>
        </View>
      </View>
    </View>
  );
}
