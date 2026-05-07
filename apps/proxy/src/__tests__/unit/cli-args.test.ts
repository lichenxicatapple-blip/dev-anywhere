import { describe, expect, it } from "vitest";
import { extractProviderArgs, normalizeCliArgs } from "#src/cli-args.js";

describe("CLI args", () => {
  it("strips repeated leading pnpm separators", () => {
    expect(normalizeCliArgs(["--", "--", "--provider", "claude"])).toEqual([
      "--provider",
      "claude",
    ]);
  });

  it("extracts provider without passing it to the provider CLI", () => {
    expect(extractProviderArgs(["--provider", "codex", "--model", "gpt-5.5"])).toEqual({
      provider: "codex",
      args: ["--model", "gpt-5.5"],
    });
  });

  it("keeps non-leading separator as provider CLI args", () => {
    expect(extractProviderArgs(["--provider=claude", "--", "hello"])).toEqual({
      provider: "claude",
      args: ["--", "hello"],
    });
  });
});
