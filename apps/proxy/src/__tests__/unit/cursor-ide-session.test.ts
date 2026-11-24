import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  id: "c3bc842d-97dc-4cec-9cde-00f07cac3f02",
  draft: "",
  sent: false,
  snapshots: 0,
  inserted: false,
  methods: [] as string[],
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    send(raw: string, callback: (error?: Error) => void) {
      const request = JSON.parse(raw) as {
        id: number;
        method: string;
        params: { expression?: string };
      };
      state.methods.push(request.method);
      let value: unknown;
      if (request.method === "Runtime.evaluate") {
        const expression = request.params.expression ?? "";
        if (expression.includes("document.execCommand")) {
          state.inserted = true;
          state.draft = "hello";
          value = true;
        } else if (expression.includes("return 'sent'")) {
          state.sent = true;
          state.draft = "";
          value = "sent";
        } else if (expression.includes("return { sidebar: rows.length")) {
          value = { sidebar: false, active: true, tab: false };
        } else if (expression.includes("return 'clicked'")) {
          value = "active";
        } else if (expression.includes("const bars =")) {
          state.snapshots++;
          value = {
            id: state.id,
            draft: state.draft,
            approval: null,
            busy: state.sent && state.snapshots < 5,
            messages: state.sent ? ["answer"] : [],
          };
        } else if (expression.includes("!!document.querySelector")) value = true;
        else value = true;
      }
      queueMicrotask(() => {
        callback();
        this.emit("message", JSON.stringify({ id: request.id, result: { result: { value } } }));
      });
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { default: FakeSocket };
});

import {
  CursorIdeSession,
  diffCursorIdeTranscript,
  diffUnkeyedTranscript,
} from "#src/worker/cursor-ide-session.js";

function session(
  callbacks: {
    onUpdate?: (value: Record<string, unknown>) => void;
    onPromptError?: (error: Error) => void;
    onPromptComplete?: () => void;
  } = {},
) {
  return new CursorIdeSession({
    cwd: "/project",
    resumeSessionId: `cursor_ide_${state.id}`,
    onUpdate: callbacks.onUpdate ?? (() => {}),
    onPromptStart: () => {},
    onPromptComplete: callbacks.onPromptComplete ?? (() => {}),
    onPromptError: callbacks.onPromptError ?? (() => {}),
    onApproval: async () => "cancel",
    onExit: () => {},
  });
}

function stubTargets() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: "target",
          title: "project",
          type: "page",
          url: "vscode-file://workbench",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/test",
        },
      ],
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.draft = "";
  state.sent = false;
  state.inserted = false;
  state.snapshots = 0;
  state.methods = [];
});

describe("Cursor IDE session", () => {
  it("resumes the verified ID and forwards an assistant reply", async () => {
    stubTargets();
    const updates: Record<string, unknown>[] = [];
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const current = session({
      onUpdate: (value) => updates.push(value),
      onPromptComplete: complete,
    });
    current.start();
    await expect(current.waitUntilReady()).resolves.toBe(`cursor_ide_${state.id}`);
    current.sendMessage("hello");
    await finished;
    expect(state.inserted).toBe(true);
    expect(updates).toEqual([
      {
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      },
    ]);
    await current.stop();
  });

  it("does not type or submit when the IDE has an existing draft", async () => {
    stubTargets();
    state.draft = "unsent local draft";
    let failed!: (error: Error) => void;
    const failure = new Promise<Error>((resolve) => {
      failed = resolve;
    });
    const current = session({ onPromptError: failed });
    current.start();
    await current.waitUntilReady();
    current.sendMessage("new message");
    expect((await failure).message).toContain("草稿");
    expect(state.inserted).toBe(false);
    await current.stop();
  });

  it("follows a virtualized window by row id instead of aborting", () => {
    const sync = {
      sent: new Map([
        ["u1", "question"],
        ["a1", "Hello"],
      ]),
      highWater: 1,
    };
    expect(
      diffCursorIdeTranscript(sync, [
        { id: "a1", role: "assistant", text: "Hello", index: 1 },
        { id: "a2", role: "assistant", text: " world", index: 2 },
      ]),
    ).toEqual([{ role: "assistant", messageId: "", text: " world" }]);
    expect(
      diffCursorIdeTranscript(
        { sent: new Map([["a1", "Hello"]]), highWater: 5 },
        [
          { id: "old", role: "user", text: "earlier", index: 2 },
          { id: "a1", role: "assistant", text: "Hello", index: 5 },
        ],
      ),
    ).toEqual([]);
  });

  it("does not resend a reply that Cursor split into bubbles, then sends later growth", () => {
    const sync = { sent: new Map([["a1", "Hello world"]]), highWater: 1 };
    expect(
      diffCursorIdeTranscript(sync, [
        { id: "a1", role: "assistant", text: "Hello", index: 1 },
        { id: "a2", role: "assistant", text: " world", index: 2 },
      ]),
    ).toEqual([]);
    expect(sync.sent.get("a1")).toBe("Hello");
    expect(
      diffCursorIdeTranscript(sync, [
        { id: "a1", role: "assistant", text: "Hello", index: 1 },
        { id: "a2", role: "assistant", text: " world!", index: 2 },
      ]),
    ).toEqual([{ role: "assistant", messageId: "", text: "!" }]);
  });

  it("keeps index alignment when the transcript has no row ids", () => {
    expect(
      diffCursorIdeTranscript(
        { sent: new Map(), highWater: -1 },
        [{ role: "assistant", text: "answer" }],
      ),
    ).toBeNull();
  });

  it("realigns an unkeyed transcript after the view scrolls or a bubble splits", () => {
    expect(
      diffUnkeyedTranscript(
        { user: "question", assistant: "Hello" },
        [
          { role: "assistant", text: "Hello" },
          { role: "assistant", text: " world" },
        ],
      ),
    ).toEqual([{ role: "assistant", messageId: "", text: " world" }]);
    expect(
      diffUnkeyedTranscript(
        { user: "", assistant: "Hello world" },
        [
          { role: "assistant", text: "Hello" },
          { role: "assistant", text: " world" },
        ],
      ),
    ).toEqual([]);
    expect(
      diffUnkeyedTranscript(
        { user: "", assistant: "Hello world" },
        [
          { role: "assistant", text: "Hello" },
          { role: "assistant", text: " world!" },
        ],
      ),
    ).toEqual([{ role: "assistant", messageId: "", text: "!" }]);
    expect(
      diffUnkeyedTranscript(
        { user: "", assistant: "Hello world" },
        [{ role: "assistant", text: "Hello  world" }],
      ),
    ).toEqual([]);
  });

  it("rejects a target whose debug socket is not loopback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: "target",
            title: "project",
            type: "page",
            url: "vscode-file://workbench",
            webSocketDebuggerUrl: "ws://other-host:9222/devtools/page/test",
          },
        ],
      })),
    );
    const current = session();
    current.start();
    await expect(current.waitUntilReady()).rejects.toThrow("非本机");
    await current.stop();
  });
});
