import { useState, useRef, useCallback } from "react";
import { View, Text, ScrollView, Input } from "@tarojs/components";
import "./index.css";

interface TermSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

type TermLine = TermSpan[];

const FONT_SIZES = [8, 10, 12, 14, 16, 20];

type PtyState = "working" | "idle" | "waiting_approval";

const STATUS_CONFIG: Record<PtyState, { bg: string; color: string; text: string }> = {
  working: { bg: "#E6F7FF", color: "#1890FF", text: "Working..." },
  idle: { bg: "#F6FFED", color: "#52C41A", text: "Idle" },
  waiting_approval: { bg: "#FFFBE6", color: "#FAAD14", text: "Waiting for approval" },
};

function buildTerminalGrid(): TermLine[] {
  return [
    [
      { text: " \u258C", fg: "#d77757" },
      { text: "\u2599\u2588\u2588\u2588\u259C", fg: "#fff", bg: "#000" },
      { text: "\u258C", fg: "#d77757" },
      { text: "   " },
      { text: "Claude Code", bold: true },
      { text: " v2.1.92", fg: "#999" },
    ],
    [{ text: "" }],
    [
      { text: "\u276F ", fg: "#555", bg: "#373737" },
      { text: "Analyze the relay server code", fg: "#fff", bg: "#373737" },
    ],
    [{ text: "" }],
    [
      { text: "\u23FA", fg: "#fff" },
      { text: " Let me examine the relay server architecture and key modules." },
    ],
    [{ text: "" }],
    [
      { text: "\u23FA", fg: "#4eba65" },
      { text: " " },
      { text: "Read", bold: true },
      { text: " (apps/relay/src/server.ts)" },
    ],
    [
      { text: "  \u23BF  ", fg: "#999" },
      { text: "import { WebSocketServer } from 'ws';" },
    ],
    [{ text: "     import { Router } from './router';" }],
    [{ text: "     import { SessionStore } from './session-store';" }],
    [{ text: "     ..." }],
    [{ text: "" }],
    [
      { text: "\u23FA", fg: "#4eba65" },
      { text: " " },
      { text: "Read", bold: true },
      { text: " (apps/relay/src/handlers/client.ts)" },
    ],
    [
      { text: "  \u23BF  ", fg: "#999" },
      { text: "export class ClientHandler {" },
    ],
    [{ text: "       private seq = 0;" }],
    [{ text: "       private sessionId: string;" }],
    [{ text: "       ..." }],
    [{ text: "" }],
    [
      { text: "\u23FA", fg: "#fff" },
      { text: " The relay server uses a WebSocket bridge pattern with:" },
    ],
    [{ text: "  - Router for message dispatching" }],
    [{ text: "  - SessionStore for persistence" }],
    [{ text: "  - Separate handlers for proxy and client connections" }],
    [{ text: "" }],
    [
      { text: "\u23FA", fg: "#faad14" },
      { text: " " },
      { text: "Edit", bold: true },
      { text: " (apps/relay/src/handlers/client.ts)" },
    ],
    [{ text: "  Claude wants to edit this file. Allow? (y/n)", fg: "#faad14" }],
  ];
}

function getDistance(touches: { clientX: number; clientY: number }[]): number {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function SpikeChatPty() {
  const [fontIdx, setFontIdx] = useState(2);
  const [pinchFontIdx, setPinchFontIdx] = useState(-1);
  const [ptyState, setPtyState] = useState<PtyState>("waiting_approval");
  const [inputText, setInputText] = useState("");
  const [approvalResolved, setApprovalResolved] = useState<"allow" | "deny" | null>(null);
  const pinchRef = useRef({ startDistance: 0, startFontIdx: 2 });

  const fontSize = FONT_SIZES[pinchFontIdx >= 0 ? pinchFontIdx : fontIdx];
  const terminalGrid = buildTerminalGrid();
  const statusCfg = STATUS_CONFIG[ptyState];

  const handleTouchStart = useCallback(
    (e) => {
      if (e.touches.length === 2) {
        const touches = e.touches.map((t) => ({ clientX: t.clientX, clientY: t.clientY }));
        pinchRef.current.startDistance = getDistance(touches);
        pinchRef.current.startFontIdx = fontIdx;
      }
    },
    [fontIdx],
  );

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2) {
      e.stopPropagation();
      const touches = e.touches.map((t) => ({ clientX: t.clientX, clientY: t.clientY }));
      const currentDistance = getDistance(touches);
      const { startDistance, startFontIdx } = pinchRef.current;
      if (startDistance > 0) {
        const ratio = currentDistance / startDistance;
        const offset = Math.round((ratio - 1) * 3);
        const newIdx = Math.min(FONT_SIZES.length - 1, Math.max(0, startFontIdx + offset));
        setPinchFontIdx(newIdx);
      }
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (pinchFontIdx >= 0) {
      setFontIdx(pinchFontIdx);
      setPinchFontIdx(-1);
    }
  }, [pinchFontIdx]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText("");
  }, [inputText]);

  return (
    <View className="page">
      {/* Status line (4px colored bar) */}
      <View className={`status-line ${ptyState}`}>
        {ptyState === "working" && <View className="status-line-glow" />}
      </View>

      {/* State toggle (spike only) */}
      <View className="state-toggles">
        {(["idle", "working", "waiting_approval"] as const).map((s) => (
          <Text
            key={s}
            className={`state-toggle ${ptyState === s ? "active" : ""}`}
            onClick={() => { setPtyState(s); setApprovalResolved(null); }}
          >
            {s === "waiting_approval" ? "wait" : s}
          </Text>
        ))}
      </View>

      {/* Terminal viewport */}
      <ScrollView
        className="terminal-viewport"
        scrollX
        scrollY
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <View className="term-content">
          {terminalGrid.map((line, i) => (
            <View
              key={i}
              className="term-line"
              style={{
                fontSize: `${fontSize}PX`,
                lineHeight: `${fontSize * 1.4}PX`,
                minHeight: `${fontSize * 1.4}PX`,
              }}
            >
              {line.map((span, j) => (
                <Text
                  key={j}
                  selectable
                  style={{
                    color: span.fg || "#e0e0e0",
                    backgroundColor: span.bg || "transparent",
                    fontWeight: span.bold ? "bold" : "normal",
                  }}
                >
                  {span.text || " "}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Approval overlay */}
      {ptyState === "waiting_approval" && approvalResolved === null && (
        <View className="approval-overlay">
          <View className="approval-card">
            <Text className="approval-label">Tool Approval Required</Text>
            <Text className="approval-tool">Edit</Text>
            <View className="approval-diff">
              <Text className="approval-file">apps/relay/src/handlers/client.ts</Text>
              <Text className="diff-del">- this.seq = 0</Text>
              <Text className="diff-add">+ this.seq = lastAckedSeq</Text>
            </View>
            <View className="approval-buttons">
              <View className="approval-btn allow" onClick={() => { setApprovalResolved("allow"); setPtyState("working"); }}>
                <Text className="approval-btn-text">Allow</Text>
              </View>
              <View className="approval-btn allow-all" onClick={() => { setApprovalResolved("allow"); setPtyState("working"); }}>
                <Text className="approval-btn-text">Allow All</Text>
              </View>
              <View className="approval-btn deny" onClick={() => { setApprovalResolved("deny"); setPtyState("idle"); }}>
                <Text className="approval-btn-text-deny">Deny</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* Font size controls */}
      <View className="font-controls">
        <View className="font-btn" onClick={() => setFontIdx((i) => Math.max(0, i - 1))}>
          <Text className="font-btn-text">A-</Text>
        </View>
        <Text className="font-label">{fontSize}PX</Text>
        <View className="font-btn" onClick={() => setFontIdx((i) => Math.min(FONT_SIZES.length - 1, i + 1))}>
          <Text className="font-btn-text">A+</Text>
        </View>
      </View>

      {/* Input bar */}
      <View className="input-bar">
        <Input
          className="input-field"
          value={inputText}
          onInput={(e) => setInputText(e.detail.value)}
          onConfirm={handleSend}
          placeholder="Send to stdin..."
          confirmType="send"
        />
        <View className="send-btn" onClick={handleSend}>
          <Text className="send-btn-text">Send</Text>
        </View>
      </View>
    </View>
  );
}
