// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ methods: [] as string[] }));
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
      fake.methods.push(request.method);
      let result: unknown;
      let exceptionDetails: { text: string } | undefined;
      try {
        if (request.method === "Runtime.evaluate")
          result = (0, eval)(request.params.expression ?? "");
      } catch (error) {
        exceptionDetails = { text: String(error) };
      }
      queueMicrotask(() => {
        callback();
        this.emit(
          "message",
          JSON.stringify({
            id: request.id,
            result: {
              result: { value: result },
              ...(exceptionDetails ? { exceptionDetails } : {}),
            },
          }),
        );
      });
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { default: FakeSocket };
});

import { CursorIdeSession } from "#src/worker/cursor-ide-session.js";
import { readCursorIdeEditorTabs, readCursorIdeSidebar } from "#src/common/cursor-ide-sidebar.js";
const id = "c3bc842d-97dc-4cec-9cde-00f07cac3f02";

beforeEach(() => {
  fake.methods.length = 0;
  document.body.innerHTML = `<div class="composer-bar" data-composer-id="${id}"><div contenteditable="true" role="textbox"></div><button aria-label="Send message" class="ui-prompt-input-submit-button">Send</button></div>`;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100 } as DOMRect);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn((_command: string, _ui: boolean, text: string) => {
      const input = document.activeElement;
      if (!input) return false;
      input.textContent = text;
      return true;
    }),
  });
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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function makeSession(
  onPromptError: (error: Error) => void,
  onPromptComplete: () => void,
  onUpdate = (_value: Record<string, unknown>) => {},
) {
  return new CursorIdeSession({
    cwd: "/project",
    resumeSessionId: `cursor_ide_${id}`,
    onUpdate,
    onPromptStart: () => {},
    onPromptComplete,
    onPromptError,
    onApproval: async () => "cancel",
    onExit: () => {},
  });
}

describe("Cursor IDE DOM interaction", () => {
  it("reads only the current sidebar rows using their actual IDs and sections", () => {
    document.body.innerHTML = `
      <div class="ui-sidebar-section-head"><span class="ui-sidebar-label-row-title">team/project</span></div>
      <li data-sidebar-item-key="row:${id}"><div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}"><span class="ui-sidebar-menu-button-label">Current chat</span></div></li>
      <div class="ui-sidebar-section-head"><span class="ui-sidebar-label-row-title">other/project</span></div>
      <li><div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="d6bc842d-97dc-4cec-9cde-00f07cac3f02"><span class="ui-sidebar-menu-button-label">Another chat</span></div></li>`;
    expect(readCursorIdeSidebar()).toEqual([
      { id, title: "Current chat", section: "team/project" },
      {
        id: "d6bc842d-97dc-4cec-9cde-00f07cac3f02",
        title: "Another chat",
        section: "other/project",
      },
    ]);
  });

  it("uses editor chat tabs when the separate Agents window is absent", () => {
    document.body.innerHTML = `<div id="workbench.parts.auxiliarybar"><div role="tab" data-resource-name="${id}"><span class="label-name">Editor chat</span></div></div>`;
    expect(readCursorIdeEditorTabs()).toEqual([{ id, title: "Editor chat", section: "" }]);
  });

  it("opens a sidebar chat by UUID and verifies the newly active input", async () => {
    const previous = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    document.body.innerHTML = `
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${previous}" data-active="true"></div>
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}"><div data-sidebar-row-trigger>Open</div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" data-sidebar-file-drop-editor-agent-id="${previous}"></div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" data-sidebar-file-drop-editor-agent-id="${id}"></div></div>`;
    const rows = document.querySelectorAll('[data-perf-id="glass-sidebar-agent-row"]');
    const click = vi.fn(() => {
      rows[0].removeAttribute("data-active");
      rows[1].setAttribute("data-active", "true");
    });
    document.querySelector("[data-sidebar-row-trigger]")!.addEventListener("click", click);
    const current = makeSession(
      () => {},
      () => {},
    );
    current.start();
    await expect(current.waitUntilReady()).resolves.toBe(`cursor_ide_${id}`);
    expect(click).toHaveBeenCalledOnce();
    await current.stop();
  });

  it("does not switch chats when the current Cursor input has a draft", async () => {
    const previous = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    document.body.innerHTML = `
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}"><div data-sidebar-row-trigger>Open</div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" data-sidebar-file-drop-editor-agent-id="${previous}">unsent draft</div></div>`;
    const click = vi.fn();
    document.querySelector("[data-sidebar-row-trigger]")!.addEventListener("click", click);
    const current = makeSession(
      () => {},
      () => {},
    );
    current.start();
    await expect(current.waitUntilReady()).rejects.toThrow("草稿");
    expect(click).not.toHaveBeenCalled();
    await current.stop();
  });

  it("sends and streams a reply in the selected Agents panel even when other panels are cached", async () => {
    const other = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    document.body.innerHTML = `
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}" data-active="true"></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" data-sidebar-file-drop-editor-agent-id="${other}"></div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" data-sidebar-file-drop-editor-agent-id="${id}"></div><button aria-label="Send message" class="ui-prompt-input-submit-button">Send</button></div>`;
    const input = document.querySelector(`[data-sidebar-file-drop-editor-agent-id="${id}"]`)!;
    const panel = input.closest(".agent-panel-conversation-shell")!;
    const send = panel.querySelector("button")!;
    send.addEventListener("click", () => {
      expect(input.textContent).toBe("hello");
      send.setAttribute("data-state", "stop");
      const reply = document.createElement("div");
      reply.className = "agent-transcript-row-markdown";
      reply.innerHTML = '<div class="markdown-root">agent reply</div>';
      panel.appendChild(reply);
      setTimeout(() => send.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const updates: Record<string, unknown>[] = [];
    const current = makeSession(
      (error) => {
        throw error;
      },
      complete,
      (value) => updates.push(value),
    );
    current.start();
    await current.waitUntilReady();
    current.sendMessage("hello");
    await finished;
    expect(updates).toMatchObject([{ update: { content: { text: "agent reply" } } }]);
    expect(
      document.querySelector(`[data-sidebar-file-drop-editor-agent-id="${other}"]`)?.textContent,
    ).toBe("");
    await current.stop();
  });

  it("selects a background agent before typing when Cursor is showing another chat", async () => {
    const other = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    document.body.innerHTML = `
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}" data-active="true"><div data-sidebar-row-trigger></div></div>
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${other}"><div data-sidebar-row-trigger></div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" role="textbox" data-sidebar-file-drop-editor-agent-id="${id}"></div><button aria-label="Send message" class="ui-prompt-input-submit-button">Send</button></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" role="textbox" data-sidebar-file-drop-editor-agent-id="${other}"></div><button aria-label="Send message" class="ui-prompt-input-submit-button">Send</button></div>`;
    const targetRow = document.querySelector(
      `[data-sidebar-file-drop-agent-id="${id}"]`,
    ) as HTMLElement;
    targetRow.querySelector("[data-sidebar-row-trigger]")!.addEventListener("click", () => {
      document
        .querySelectorAll("[data-perf-id='glass-sidebar-agent-row']")
        .forEach((row) => row.removeAttribute("data-active"));
      targetRow.setAttribute("data-active", "true");
    });
    const input = document.querySelector(
      `[data-sidebar-file-drop-editor-agent-id="${id}"]`,
    ) as HTMLElement;
    const send = input.parentElement!.querySelector("button")!;
    send.addEventListener("click", () => {
      expect(input.textContent).toBe("hello");
      send.setAttribute("data-state", "stop");
      setTimeout(() => send.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const current = makeSession((error) => {
      throw error;
    }, complete);
    current.start();
    await current.waitUntilReady();
    targetRow.removeAttribute("data-active");
    document
      .querySelector(`[data-sidebar-file-drop-agent-id="${other}"]`)!
      .setAttribute("data-active", "true");
    current.sendMessage("hello");
    await finished;
    expect(
      document.querySelector(`[data-sidebar-file-drop-editor-agent-id="${other}"]`)?.textContent,
    ).toBe("");
    await current.stop();
  });

  it("sends to the target chat while the chat Cursor is showing is still generating", async () => {
    const other = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
    document.body.innerHTML = `
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${id}" data-active="true"><div data-sidebar-row-trigger></div></div>
      <div data-perf-id="glass-sidebar-agent-row" data-sidebar-file-drop-agent-id="${other}"><div data-sidebar-row-trigger></div></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" role="textbox" data-sidebar-file-drop-editor-agent-id="${id}"></div><button aria-label="Send message" class="ui-prompt-input-submit-button">Send</button></div>
      <div class="agent-panel-conversation-shell"><div contenteditable="true" role="textbox" data-sidebar-file-drop-editor-agent-id="${other}"></div><button aria-label="Stop generation" class="ui-prompt-input-submit-button" data-state="stop">Stop</button></div>`;
    const targetRow = document.querySelector(
      `[data-sidebar-file-drop-agent-id="${id}"]`,
    ) as HTMLElement;
    targetRow.querySelector("[data-sidebar-row-trigger]")!.addEventListener("click", () => {
      document
        .querySelectorAll("[data-perf-id='glass-sidebar-agent-row']")
        .forEach((row) => row.removeAttribute("data-active"));
      targetRow.setAttribute("data-active", "true");
    });
    const input = document.querySelector(
      `[data-sidebar-file-drop-editor-agent-id="${id}"]`,
    ) as HTMLElement;
    const send = input.parentElement!.querySelector("button")!;
    send.addEventListener("click", () => {
      expect(input.textContent).toBe("hello");
      send.setAttribute("data-state", "stop");
      setTimeout(() => send.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const current = makeSession((error) => {
      throw error;
    }, complete);
    current.start();
    await current.waitUntilReady();
    targetRow.removeAttribute("data-active");
    document
      .querySelector(`[data-sidebar-file-drop-agent-id="${other}"]`)!
      .setAttribute("data-active", "true");
    current.sendMessage("hello");
    await finished;
    expect(
      document.querySelector(`[data-sidebar-file-drop-editor-agent-id="${other}"]`)?.textContent,
    ).toBe("");
    await current.stop();
  });

  it("does not sync Cursor's injected task-result prompt as a user message", async () => {
    const prompt =
      "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.";
    const updates: Record<string, unknown>[] = [];
    const current = makeSession(
      (error) => {
        throw error;
      },
      () => {},
      (value) => updates.push(value),
    );
    current.start();
    await current.waitUntilReady();
    document.querySelector(".composer-bar")!.insertAdjacentHTML(
      "beforeend",
      `<div data-message-id="sys" data-message-kind="human"><div class="ui-agent-transcript-human-bubble">${prompt}</div></div>
       <div data-message-id="real" data-message-kind="human"><div class="ui-agent-transcript-human-bubble">real question</div></div>`,
    );
    const texts = () =>
      updates.map((value) => (value.update as { content?: { text?: string } }).content?.text);
    await vi.waitFor(() => expect(texts()).toContain("real question"), { timeout: 3_000 });
    expect(texts()).not.toContain(prompt);
    await current.stop();
  });

  it("creates a new IDE chat only after its identity changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-ide-workspace-"));
    const original = process.env.CURSOR_IDE_USER_DIR;
    try {
      const workspace = join(root, "workspaceStorage", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(workspace, "workspace.json"),
        JSON.stringify({ folder: "file:///home/example/project" }),
      );
      process.env.CURSOR_IDE_USER_DIR = root;
      const button = document.createElement("a");
      button.setAttribute("aria-label", "New Agent (⌘N)");
      const newId = "d6bc842d-97dc-4cec-9cde-00f07cac3f02";
      button.addEventListener("click", () =>
        document.querySelector(".composer-bar")!.setAttribute("data-composer-id", newId),
      );
      document.body.appendChild(button);
      const current = new CursorIdeSession({
        cwd: "/home/example/project",
        onUpdate: () => {},
        onPromptStart: () => {},
        onPromptComplete: () => {},
        onPromptError: () => {},
        onApproval: async () => "cancel",
        onExit: () => {},
      });
      current.start();
      await expect(current.waitUntilReady()).resolves.toBe(`cursor_ide_${newId}`);
      await current.stop();
    } finally {
      if (original === undefined) delete process.env.CURSOR_IDE_USER_DIR;
      else process.env.CURSOR_IDE_USER_DIR = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the requested tab and verifies its composer ID", async () => {
    document.querySelector(".composer-bar")!.setAttribute("data-composer-id", "another");
    const tab = document.createElement("div");
    tab.setAttribute("role", "tab");
    tab.setAttribute("data-resource-name", id);
    tab.addEventListener("click", () =>
      document.querySelector(".composer-bar")!.setAttribute("data-composer-id", id),
    );
    document.body.appendChild(tab);
    const current = makeSession(
      () => {},
      () => {},
    );
    current.start();
    await expect(current.waitUntilReady()).resolves.toBe(`cursor_ide_${id}`);
    await current.stop();
  });

  it("observes a reply started in Cursor itself", async () => {
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const updates: Record<string, unknown>[] = [];
    const start = vi.fn();
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: (value) => updates.push(value),
      onPromptStart: start,
      onPromptComplete: complete,
      onPromptError: (error) => {
        throw error;
      },
      onApproval: async () => "cancel",
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    const button = document.querySelector("button")!;
    button.setAttribute("data-state", "stop");
    const row = document.createElement("div");
    row.className = "agent-transcript-row-markdown";
    row.innerHTML = '<div class="markdown-root">local response</div>';
    document.querySelector(".composer-bar")!.appendChild(row);
    setTimeout(() => button.removeAttribute("data-state"), 600);
    await finished;
    expect(start).toHaveBeenCalledOnce();
    expect(updates).toMatchObject([{ update: { content: { text: "local response" } } }]);
    await current.stop();
  });

  it("keeps a switched-away composer working and shows the user prompt and plan", async () => {
    const updates: Record<string, unknown>[] = [];
    const complete = vi.fn();
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: (value) => updates.push(value),
      onPromptStart: () => {},
      onPromptComplete: complete,
      onPromptError: (error) => {
        throw error;
      },
      onApproval: async () => "cancel",
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    const other = document.createElement("div");
    other.setAttribute("data-perf-id", "glass-sidebar-agent-row");
    other.setAttribute("data-active", "true");
    other.setAttribute("data-sidebar-file-drop-agent-id", "d6bc842d-97dc-4cec-9cde-00f07cac3f02");
    document.body.appendChild(other);
    document.querySelector(".composer-bar")!.insertAdjacentHTML(
      "beforeend",
      `<div data-message-kind="human"><div data-agent-transcript-human-bubble>plan this feature</div></div>
       <div class="plan-body">1. Inspect the switch</div>`,
    );
    document.querySelector("button")!.setAttribute("data-state", "stop");
    await vi.waitFor(() => {
      expect(updates.map((value) => (value.update as { content?: { text?: string } }).content?.text)).toEqual(
        expect.arrayContaining(["plan this feature", "1. Inspect the switch"]),
      );
    });
    expect(complete).not.toHaveBeenCalled();
    other.remove();
    document.querySelector("button")!.removeAttribute("data-state");
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 3_000 });
    await current.stop();
  });

  it("keeps syncing after the virtualized transcript scrolls and splits", async () => {
    const updates: Record<string, unknown>[] = [];
    const errors: Error[] = [];
    const complete = vi.fn();
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: (value) => updates.push(value),
      onPromptStart: () => {},
      onPromptComplete: complete,
      onPromptError: (error) => errors.push(error),
      onApproval: async () => "cancel",
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    const bar = document.querySelector(".composer-bar")!;
    bar.insertAdjacentHTML(
      "beforeend",
      `<div class="virtualized-composer-messages-row" data-index="0">
         <div data-message-id="u1" data-message-kind="human"><div class="ui-agent-transcript-human-bubble">question</div></div>
       </div>
       <div class="virtualized-composer-messages-row" data-index="1">
         <div data-message-id="a1" data-message-kind="assistant"><div class="markdown-root">Hello</div></div>
       </div>`,
    );
    document.querySelector("button")!.setAttribute("data-state", "stop");
    const texts = () =>
      updates.map((value) => (value.update as { content?: { text?: string } }).content?.text);
    await vi.waitFor(() => expect(texts()).toEqual(expect.arrayContaining(["question", "Hello"])), {
      timeout: 3_000,
    });
    bar.querySelector('[data-index="0"]')!.remove();
    bar.insertAdjacentHTML(
      "beforeend",
      `<div class="virtualized-composer-messages-row" data-index="2">
         <div data-message-id="a2" data-message-kind="assistant"><div class="markdown-root">world</div></div>
       </div>`,
    );
    await vi.waitFor(() => expect(texts()).toContain("world"), { timeout: 3_000 });
    document.querySelector('[data-message-id="a1"] .markdown-root')!.textContent = "Hel";
    bar.insertAdjacentHTML(
      "beforeend",
      `<div class="virtualized-composer-messages-row" data-index="3">
         <div data-message-id="a3" data-message-kind="assistant"><div class="markdown-root">lo</div></div>
       </div>`,
    );
    document.querySelector('[data-message-id="a2"] .markdown-root')!.textContent = "world!";
    await vi.waitFor(() => expect(texts()).toContain("!"), { timeout: 3_000 });
    expect(texts()).not.toContain("lo");
    expect(errors).toEqual([]);
    document.querySelector("button")!.removeAttribute("data-state");
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 3_000 });
    await current.stop();
  });

  it("keeps syncing when an unkeyed transcript scrolls instead of aborting", async () => {
    const updates: Record<string, unknown>[] = [];
    const errors: Error[] = [];
    const complete = vi.fn();
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: (value) => updates.push(value),
      onPromptStart: () => {},
      onPromptComplete: complete,
      onPromptError: (error) => errors.push(error),
      onApproval: async () => "cancel",
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    const bar = document.querySelector(".composer-bar")!;
    bar.insertAdjacentHTML(
      "beforeend",
      `<div data-message-kind="human"><div data-agent-transcript-human-bubble>question</div></div>
       <div class="agent-transcript-row-markdown"><div class="markdown-root">Hello</div></div>`,
    );
    document.querySelector("button")!.setAttribute("data-state", "stop");
    const texts = () =>
      updates.map((value) => (value.update as { content?: { text?: string } }).content?.text);
    await vi.waitFor(() => expect(texts()).toEqual(expect.arrayContaining(["question", "Hello"])), {
      timeout: 3_000,
    });
    bar.querySelector('[data-message-kind="human"]')!.remove();
    bar.insertAdjacentHTML(
      "beforeend",
      `<div class="agent-transcript-row-markdown"><div class="markdown-root">world</div></div>`,
    );
    await vi.waitFor(() => expect(texts()).toContain("world"), { timeout: 3_000 });
    expect(errors.map((error) => error.message)).not.toContain(
      "Cursor IDE 消息视图已变化，无法可靠同步回复",
    );
    document.querySelector("button")!.removeAttribute("data-state");
    await vi.waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 3_000 });
    await current.stop();
  });

  it("inserts into the verified composer, submits and streams its response", async () => {
    const button = document.querySelector("button")!;
    button.addEventListener("click", () => {
      expect(document.querySelector('[role="textbox"]')?.textContent).toBe("hello");
      button.setAttribute("data-state", "stop");
      const row = document.createElement("div");
      row.className = "agent-transcript-row-markdown";
      row.innerHTML = '<div class="markdown-root">answer</div>';
      document.querySelector(".composer-bar")!.appendChild(row);
      setTimeout(() => button.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const updates: Record<string, unknown>[] = [];
    const current = makeSession(
      (error) => {
        throw error;
      },
      complete,
      (value) => updates.push(value),
    );
    current.start();
    await current.waitUntilReady();
    current.sendMessage("hello");
    await finished;
    expect(updates).toMatchObject([
      { update: { sessionUpdate: "agent_message_chunk", content: { text: "answer" } } },
    ]);
    await current.stop();
  });

  it("writes through the Lexical editor when execCommand refuses the input", async () => {
    const input = document.querySelector("[contenteditable='true']") as HTMLElement & {
      __lexicalEditor?: {
        parseEditorState: (serialized: string) => string;
        setEditorState: (state: string) => void;
      };
    };
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    input.__lexicalEditor = {
      parseEditorState: (serialized) => serialized,
      setEditorState: (state) => {
        const parsed = JSON.parse(state) as {
          root: { children: Array<{ children: Array<{ text?: string }> }> };
        };
        input.textContent = parsed.root.children[0]?.children[0]?.text ?? "";
      },
    };
    const button = document.querySelector("button")!;
    button.addEventListener("click", () => {
      expect(input.textContent).toBe("hello");
      button.setAttribute("data-state", "stop");
      const row = document.createElement("div");
      row.className = "agent-transcript-row-markdown";
      row.innerHTML = '<div class="markdown-root">answer</div>';
      document.querySelector(".composer-bar")!.appendChild(row);
      setTimeout(() => button.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const current = makeSession(
      (error) => {
        throw error;
      },
      complete,
    );
    current.start();
    await current.waitUntilReady();
    current.sendMessage("hello");
    await finished;
    await current.stop();
  });

  it("waits for editor text that lands after execCommand accepts", async () => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((_command: string, _ui: boolean, text: string) => {
        const input = document.querySelector("[contenteditable='true']");
        setTimeout(() => {
          if (input) input.textContent = text;
        }, 150);
        return true;
      }),
    });
    const button = document.querySelector("button")!;
    button.addEventListener("click", () => {
      expect(document.querySelector("[contenteditable='true']")?.textContent).toBe("hello");
      button.setAttribute("data-state", "stop");
      const row = document.createElement("div");
      row.className = "agent-transcript-row-markdown";
      row.innerHTML = '<div class="markdown-root">answer</div>';
      document.querySelector(".composer-bar")!.appendChild(row);
      setTimeout(() => button.removeAttribute("data-state"), 500);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const current = makeSession(
      (error) => {
        throw error;
      },
      complete,
    );
    current.start();
    await current.waitUntilReady();
    current.sendMessage("hello");
    await finished;
    await current.stop();
  });

  it("forwards a command approval and clicks the matching IDE action", async () => {
    const send = document.querySelector("button")!;
    let approved = false;
    send.addEventListener("click", () => {
      send.setAttribute("data-state", "stop");
      const tool = document.createElement("div");
      tool.className = "ui-shell-tool-call";
      tool.innerHTML =
        '<div class="ui-shell-tool-call__approval-row">run tests <button class="ui-shell-tool-call__run-btn">Allow</button><button class="ui-shell-tool-call__skip-btn">Skip</button></div>';
      tool.querySelector(".ui-shell-tool-call__run-btn")!.addEventListener("click", () => {
        approved = true;
        tool.remove();
        send.removeAttribute("data-state");
      });
      document.querySelector(".composer-bar")!.appendChild(tool);
    });
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const onApproval = vi.fn(async () => "allow" as const);
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: () => {},
      onPromptStart: () => {},
      onPromptComplete: complete,
      onPromptError: (error) => {
        throw error;
      },
      onApproval,
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    current.sendMessage("run tests");
    await finished;
    expect(onApproval).toHaveBeenCalledWith(expect.stringContaining("run tests"));
    expect(approved).toBe(true);
    await current.stop();
  });

  it("does not approve after the user switches to another chat", async () => {
    const send = document.querySelector("button")!;
    let approved = false;
    send.addEventListener("click", () => {
      send.setAttribute("data-state", "stop");
      const tool = document.createElement("div");
      tool.className = "ui-shell-tool-call";
      tool.innerHTML =
        '<div class="ui-shell-tool-call__approval-row">run tests <button class="ui-shell-tool-call__run-btn">Allow</button></div>';
      tool.querySelector("button")!.addEventListener("click", () => {
        approved = true;
      });
      document.querySelector(".composer-bar")!.appendChild(tool);
    });
    let resolveApproval!: (value: "allow") => void;
    let notifyApproval!: () => void;
    const requested = new Promise<void>((resolve) => {
      notifyApproval = resolve;
    });
    const decision = new Promise<"allow">((resolve) => {
      resolveApproval = resolve;
    });
    let fail!: (error: Error) => void;
    const failed = new Promise<Error>((resolve) => {
      fail = resolve;
    });
    const current = new CursorIdeSession({
      cwd: "/project",
      resumeSessionId: `cursor_ide_${id}`,
      onUpdate: () => {},
      onPromptStart: () => {},
      onPromptComplete: () => {},
      onPromptError: fail,
      onApproval: () => {
        notifyApproval();
        return decision;
      },
      onExit: () => {},
    });
    current.start();
    await current.waitUntilReady();
    current.sendMessage("run tests");
    await requested;
    document.querySelector(".composer-bar")!.setAttribute("data-composer-id", "other");
    resolveApproval("allow");
    expect((await failed).message).toContain("审批状态已变化");
    expect(approved).toBe(false);
    await current.stop();
  });

  it("does not insert after the active composer changes", async () => {
    let fail!: (error: Error) => void;
    const failed = new Promise<Error>((resolve) => {
      fail = resolve;
    });
    const current = makeSession(fail, () => {});
    current.start();
    await current.waitUntilReady();
    document.querySelector(".composer-bar")!.setAttribute("data-composer-id", "other");
    current.sendMessage("do not send");
    expect((await failed).message).toContain("找不到此会话");
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(document.querySelector('[role="textbox"]')?.textContent).toBe("");
    await current.stop();
  });
});
