import { describe, expect, it } from "vitest";
import { MessageEnvelopeSchema, RelayControlSchema } from "@dev-anywhere/shared";
import { CursorAcpEventMapper } from "#src/serve/cursor-acp-event-mapper.js";

function update(sessionUpdate: string, fields: Record<string, unknown>) {
  return {
    type: "cursor_acp",
    method: "session/update",
    params: { sessionId: "cursor-session-1", update: { sessionUpdate, ...fields } },
  };
}

describe("CursorAcpEventMapper", () => {
  it("maps agent message chunks to assistant text snapshots", () => {
    const mapper = new CursorAcpEventMapper();
    expect(
      mapper.map(
        "s1",
        1,
        update("agent_message_chunk", { content: { type: "text", text: "你好" } }),
      ),
    ).toEqual([{ kind: "assistant_text", text: "你好" }]);
  });

  it("maps todos and generated images onto the existing chat protocol", () => {
    const mapper = new CursorAcpEventMapper();
    const todos = mapper.map("s1", 2, {
      type: "cursor_acp",
      method: "cursor/update_todos",
      params: {
        merge: true,
        todos: [{ id: "1", content: "Setup", status: "completed" }],
      },
    });
    expect(todos).toHaveLength(1);
    const todoControl = todos[0];
    expect(todoControl?.kind).toBe("control");
    if (todoControl?.kind !== "control") throw new Error("expected control");
    expect(RelayControlSchema.parse(JSON.parse(todoControl.raw))).toMatchObject({
      type: "cursor_session_ui",
      payload: {
        kind: "todos",
        merge: true,
        todos: [{ id: "1", content: "Setup", status: "completed" }],
      },
    });

    const image = mapper.map("s1", 3, {
      type: "cursor_acp",
      method: "cursor/generate_image",
      params: {
        toolCallId: "img-1",
        description: "App icon",
        filePath: "/tmp/icon.png",
      },
    });
    expect(image.map((item) => item.kind)).toEqual(["envelope", "envelope", "control"]);
    const toolUse = image[0];
    expect(toolUse?.kind).toBe("envelope");
    if (toolUse?.kind !== "envelope") throw new Error("expected envelope");
    expect(MessageEnvelopeSchema.parse(toolUse.envelope)).toMatchObject({
      type: "assistant_tool_use",
      payload: { toolName: "GenerateImage", toolId: "img-1" },
    });
  });

  it("surfaces a load-failed notice as an assistant message", () => {
    const mapper = new CursorAcpEventMapper();
    const mapped = mapper.map("s1", 4, {
      type: "cursor_acp",
      method: "cursor/session_load_failed",
      params: { message: "无法恢复 Cursor 会话 abc，已新建会话。" },
    });
    expect(mapped).toHaveLength(1);
    const first = mapped[0];
    expect(first?.kind).toBe("envelope");
    if (first?.kind !== "envelope") throw new Error("expected envelope");
    expect(MessageEnvelopeSchema.parse(first.envelope)).toMatchObject({
      type: "assistant_message",
      payload: { text: "无法恢复 Cursor 会话 abc，已新建会话。" },
    });
  });
});
