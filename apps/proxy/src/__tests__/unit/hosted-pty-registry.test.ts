import { describe, expect, it } from "vitest";
import { buildHostedPtyArgs, normalizeHostedPtyEnv } from "#src/serve/hosted-pty-registry.js";

describe("Hosted PTY registry", () => {
  it("builds provider-specific resume args", () => {
    expect(buildHostedPtyArgs("claude", "claude-session")).toEqual(["--resume", "claude-session"]);
    expect(buildHostedPtyArgs("codex", "codex-session")).toEqual(["resume", "codex-session"]);
    expect(buildHostedPtyArgs("claude")).toEqual([]);
  });

  it("normalizes hosted PTY env as a truecolor terminal", () => {
    const env = normalizeHostedPtyEnv({
      TERM: "dumb",
      NO_COLOR: "1",
      CLICOLOR: "0",
      COLORTERM: "ignored",
      KEEP_ME: "yes",
      UNDEFINED_VALUE: undefined,
    });

    expect(env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      KEEP_ME: "yes",
    });
    expect(env).not.toHaveProperty("NO_COLOR");
    expect(env).not.toHaveProperty("UNDEFINED_VALUE");
  });
});
