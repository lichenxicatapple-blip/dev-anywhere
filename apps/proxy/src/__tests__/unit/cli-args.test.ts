import { describe, expect, it } from "vitest";
import { extractAgentInvocation, normalizeCliArgs, stripProxyProfileArgs } from "#src/cli-args.js";

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

  it("extracts Cursor CLI from both agent and cursor aliases", () => {
    expect(extractAgentInvocation(["agent", "--yolo"])).toEqual({
      provider: "cursor",
      args: ["--yolo"],
    });
    expect(extractAgentInvocation(["cursor", "--mode=plan"])).toEqual({
      provider: "cursor",
      args: ["--mode=plan"],
    });
  });

  it("rejects missing agent command", () => {
    expect(() => extractAgentInvocation(["-c"])).toThrow(/Missing Agent CLI/);
  });

  it("strips dev-anywhere profile flags before provider selection", () => {
    expect(stripProxyProfileArgs(["--profile", "local", "claude", "--model", "sonnet"])).toEqual([
      "claude",
      "--model",
      "sonnet",
    ]);
    expect(stripProxyProfileArgs(["serve", "status", "--profile=local"])).toEqual([
      "serve",
      "status",
    ]);
    expect(stripProxyProfileArgs(["--profile", "local", "agent", "--yolo"])).toEqual([
      "agent",
      "--yolo",
    ]);
  });

  it("does not strip provider-owned profile flags", () => {
    expect(stripProxyProfileArgs(["claude", "--profile", "provider-profile"])).toEqual([
      "claude",
      "--profile",
      "provider-profile",
    ]);
  });
});
