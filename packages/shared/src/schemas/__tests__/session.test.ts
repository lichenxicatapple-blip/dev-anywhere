import { describe, it, expect } from "vitest";
import { SessionListPayloadSchema, SessionStatusPayloadSchema } from "../session.js";

describe("SessionListPayloadSchema", () => {
  it.each([
    { kind: "agent", mode: "json", provider: "codex" },
    { kind: "agent", mode: "pty", provider: "kimi", ptyOwner: "local-terminal" },
    { kind: "terminal", mode: "pty", provider: "claude", ptyOwner: "proxy-hosted" },
  ])("strips list and $kind/$mode entry descriptions", (identity) => {
    const session = {
      ...identity,
      sessionId: "s1",
      state: "idle",
      cwd: "/project",
      lastActive: 1,
    };
    expect(
      SessionListPayloadSchema.parse({
        sessions: [{ ...session, displayGroup: "Project" }],
        displayOrder: "recent",
      }),
    ).toEqual({ sessions: [session] });
  });

  it("accepts valid session list", () => {
    const result = SessionListPayloadSchema.parse({
      sessions: [
        {
          sessionId: "s1",
          kind: "agent",
          name: "sess1",
          state: "idle",
          provider: "claude",
          mode: "pty",
          ptyOwner: "local-terminal",
          cwd: "/Users/dev/project",
          nameLocked: true,
          lastActive: 1,
        },
        {
          sessionId: "s2",
          kind: "agent",
          state: "working",
          mode: "json",
          provider: "codex",
          cwd: "/Users/dev/project",
          lastActive: 2,
        },
      ],
    });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].name).toBe("sess1");
    expect(result.sessions[0].cwd).toBe("/Users/dev/project");
    expect(result.sessions[0].nameLocked).toBe(true);
    expect(result.sessions[0].provider).toBe("claude");
    expect(result.sessions[0].kind).toBe("agent");
    expect(result.sessions[0].mode).toBe("pty");
    if (result.sessions[0].mode !== "pty") throw new Error("expected PTY session");
    expect(result.sessions[0].ptyOwner).toBe("local-terminal");
    expect(result.sessions[1].provider).toBe("codex");
    expect(result.sessions[1].name).toBeUndefined();
  });

  it("accepts empty session list", () => {
    const result = SessionListPayloadSchema.parse({ sessions: [] });
    expect(result.sessions).toEqual([]);
  });

  it("accepts terminal session kind", () => {
    const result = SessionListPayloadSchema.parse({
      sessions: [
        {
          sessionId: "terminal-1",
          kind: "terminal",
          name: "~/workspace",
          state: "idle",
          provider: "claude",
          mode: "pty",
          ptyOwner: "proxy-hosted",
          cwd: "/Users/dev/project",
          lastActive: 1,
        },
      ],
    });
    expect(result.sessions[0].kind).toBe("terminal");
  });

  it("rejects invalid session state", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "invalid_state",
            mode: "pty",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects missing provider", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "idle",
            mode: "pty",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects missing kind", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            state: "idle",
            mode: "pty",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects missing mode", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "idle",
            provider: "claude",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a PTY agent without an owner", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "idle",
            mode: "pty",
            provider: "claude",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a JSON agent with a PTY owner", () => {
    expect(() =>
      SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state: "idle",
            mode: "json",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    {
      sessionId: "terminal-json",
      kind: "terminal",
      state: "idle",
      mode: "json",
      provider: "claude",
      cwd: "/tmp/test",
      lastActive: 1,
    },
    {
      sessionId: "terminal-provider",
      kind: "terminal",
      state: "idle",
      mode: "pty",
      provider: "codex",
      ptyOwner: "local-terminal",
      cwd: "/tmp/test",
      lastActive: 1,
    },
    {
      sessionId: "terminal-owner",
      kind: "terminal",
      state: "idle",
      mode: "pty",
      provider: "claude",
      ptyOwner: "local-terminal",
      cwd: "/tmp/test",
      lastActive: 1,
    },
    {
      sessionId: "terminal-missing-owner",
      kind: "terminal",
      state: "idle",
      mode: "pty",
      provider: "claude",
      cwd: "/tmp/test",
      lastActive: 1,
    },
  ])("rejects an illegal terminal identity ($sessionId)", (session) => {
    expect(() => SessionListPayloadSchema.parse({ sessions: [session] })).toThrow();
  });

  it("accepts all valid session states", () => {
    const states = [
      "idle",
      "working",
      "compacting",
      "waiting_approval",
      "error",
      "terminated",
    ] as const;
    for (const state of states) {
      const result = SessionListPayloadSchema.parse({
        sessions: [
          {
            sessionId: "s1",
            kind: "agent",
            state,
            mode: "pty",
            provider: "claude",
            ptyOwner: "local-terminal",
            cwd: "/tmp/test",
            lastActive: 1,
          },
        ],
      });
      expect(result.sessions[0].state).toBe(state);
    }
  });

  it("rejects missing sessions field", () => {
    expect(() => SessionListPayloadSchema.parse({})).toThrow();
  });

  it.each(["cwd", "lastActive"] as const)("rejects a session missing %s", (field) => {
    const session: Record<string, unknown> = {
      sessionId: "s1",
      kind: "agent",
      state: "idle",
      mode: "json",
      provider: "claude",
      cwd: "/tmp/test",
      lastActive: 1,
    };
    delete session[field];
    expect(() => SessionListPayloadSchema.parse({ sessions: [session] })).toThrow();
  });
});

describe("SessionStatusPayloadSchema", () => {
  it("rejects invalid state", () => {
    expect(() =>
      SessionStatusPayloadSchema.parse({
        sessionId: "s1",
        state: "unknown",
        lastActive: 123,
      }),
    ).toThrow();
  });

  it("rejects missing state", () => {
    expect(() => SessionStatusPayloadSchema.parse({ sessionId: "s1" })).toThrow();
  });

  it("rejects missing lastActive", () => {
    expect(() =>
      SessionStatusPayloadSchema.parse({
        sessionId: "s1",
        state: "idle",
      }),
    ).toThrow();
  });
});
