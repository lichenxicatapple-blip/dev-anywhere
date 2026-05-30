import { describe, expect, it } from "vitest";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { mapCodexAppServerEvent } from "#src/serve/codex-app-server-event-mapper.js";

describe("mapCodexAppServerEvent", () => {
  it("maps agent message deltas to assistant message envelopes", () => {
    const mapped = mapCodexAppServerEvent("s1", 11, {
      type: "codex_app_server",
      method: "item/agentMessage/delta",
      params: { delta: "OK" },
    });

    expect(mapped).toEqual([
      {
        kind: "envelope",
        envelope: expect.objectContaining({
          type: "assistant_message",
          sessionId: "s1",
          seq: 11,
          payload: { text: "OK", isPartial: true },
        }),
      },
    ]);
  });

  it("maps completed turns to turn_result controls", () => {
    const mapped = mapCodexAppServerEvent("s1", 12, {
      type: "codex_app_server",
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "failed", error: "boom" } },
    });

    expect(mapped).toHaveLength(1);
    const first = mapped[0];
    expect(first.kind).toBe("control");
    if (first.kind !== "control") throw new Error("expected control mapping");
    expect(first.notifyTurnResult).toBe(true);
    expect(RelayControlSchema.parse(JSON.parse(first.raw))).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: false,
      isError: true,
      result: "boom",
    });
  });

  it("maps file changes to patch activity envelopes", () => {
    const mapped = mapCodexAppServerEvent("s1", 15, {
      type: "codex_app_server",
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: "patch-1",
          status: "completed",
          changes: [
            {
              path: "/tmp/project/a.txt",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
        },
      },
    });

    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      kind: "envelope",
      envelope: {
        type: "assistant_tool_use",
        sessionId: "s1",
        seq: 15,
        payload: {
          toolName: "Patch",
          toolId: "patch-1",
          parameters: {
            file_path: "/tmp/project/a.txt",
            content: "@@ -1 +1 @@\n-old\n+new\n",
            changes: [
              {
                path: "/tmp/project/a.txt",
                kind: "update",
                diff: "@@ -1 +1 @@\n-old\n+new\n",
              },
            ],
          },
        },
      },
    });
    expect(mapped[1]).toMatchObject({
      kind: "envelope",
      envelope: {
        type: "tool_result",
        sessionId: "s1",
        seq: 15,
        payload: { toolId: "patch-1", result: "completed", isError: false },
      },
    });
  });
});
