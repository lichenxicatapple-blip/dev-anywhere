import { describe, it, expect } from "vitest";
import { parseAssistantMessage, routeStreamEvent } from "@/services/message-parser";

describe("parseAssistantMessage", () => {
  it("parses valid StreamJsonEvent JSON", () => {
    const input = JSON.stringify({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    const result = parseAssistantMessage(input);
    expect(result).toEqual({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseAssistantMessage("not json")).toBeNull();
  });

  it("returns null for JSON without type field", () => {
    expect(parseAssistantMessage(JSON.stringify({ data: 42 }))).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseAssistantMessage(null as unknown as string)).toBeNull();
  });
});

describe("routeStreamEvent", () => {
  it("returns APPEND_ASSISTANT_TEXT for assistant event", () => {
    const result = routeStreamEvent({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
      },
    });
    expect(result).toEqual({ type: "APPEND_ASSISTANT_TEXT", text: "hello world" });
  });

  it("returns null for assistant event with empty content", () => {
    const result = routeStreamEvent({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [] },
    });
    expect(result).toBeNull();
  });

  it("concatenates multiple text blocks", () => {
    const result = routeStreamEvent({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(result).toEqual({ type: "APPEND_ASSISTANT_TEXT", text: "hello world" });
  });

  it("returns MARK_TURN_COMPLETE for result event", () => {
    const result = routeStreamEvent({ type: "result", subtype: "success", is_error: false });
    expect(result).toEqual({ type: "MARK_TURN_COMPLETE" });
  });

  it("returns SET_CLAUDE_SESSION_ID for system event with session_id", () => {
    const result = routeStreamEvent({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    });
    expect(result).toEqual({ type: "SET_CLAUDE_SESSION_ID", id: "abc-123" });
  });

  it("returns null for system event without session_id", () => {
    const result = routeStreamEvent({ type: "system", subtype: "hook_started" });
    expect(result).toBeNull();
  });

  it("returns null for rate_limit_event", () => {
    const result = routeStreamEvent({ type: "rate_limit_event" });
    expect(result).toBeNull();
  });
});
