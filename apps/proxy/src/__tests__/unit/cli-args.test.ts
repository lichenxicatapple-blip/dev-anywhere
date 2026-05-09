import { describe, expect, it } from "vitest";
import { extractAgentInvocation, normalizeCliArgs } from "#src/cli-args.js";

describe("CLI args", () => {
  it("strips repeated leading pnpm separators", () => {
    expect(normalizeCliArgs(["--", "--", "claude", "-c"])).toEqual(["claude", "-c"]);
  });

  it("extracts agent command without passing it to the provider CLI", () => {
    expect(extractAgentInvocation(["codex", "--model", "gpt-5.5"])).toEqual({
      provider: "codex",
      args: ["--model", "gpt-5.5"],
    });
  });

  it("passes all arguments after agent name through to provider CLI", () => {
    expect(extractAgentInvocation(["claude", "--", "hello"])).toEqual({
      provider: "claude",
      args: ["--", "hello"],
    });
  });

  it("rejects missing agent command", () => {
    expect(() => extractAgentInvocation(["-c"])).toThrow(/Missing Agent CLI/);
  });
});
