import { describe, it, expect } from "vitest";
import { parseAssistantMessage, routeStreamEvent } from "../services/message-parser.js";

describe("parseAssistantMessage", () => {
  it("parses valid StreamJsonEvent JSON", () => {
    const input = JSON.stringify({ type: "assistant", text: "hello" });
    const result = parseAssistantMessage(input);
    expect(result).toEqual({ type: "assistant", text: "hello" });
  });

  it("returns null for invalid JSON", () => {
    const result = parseAssistantMessage("not json");
    expect(result).toBeNull();
  });
});

describe("routeStreamEvent", () => {
  it("returns APPEND_ASSISTANT_TEXT for assistant event with subtype content_block_delta", () => {
    const result = routeStreamEvent({
      type: "assistant",
      subtype: "content_block_delta",
      text: "hello world",
    });
    expect(result).toEqual({ type: "APPEND_ASSISTANT_TEXT", text: "hello world" });
  });

  it("returns MARK_TURN_COMPLETE for result event", () => {
    const result = routeStreamEvent({ type: "result" });
    expect(result).toEqual({ type: "MARK_TURN_COMPLETE" });
  });

  it("returns SET_CLAUDE_SESSION_ID for system event with session_id", () => {
    const result = routeStreamEvent({
      type: "system",
      session_id: "abc-123",
    });
    expect(result).toEqual({ type: "SET_CLAUDE_SESSION_ID", id: "abc-123" });
  });

  it("returns null for unknown event types", () => {
    const result = routeStreamEvent({ type: "stream_event" as "system" });
    expect(result).toBeNull();
  });
});
