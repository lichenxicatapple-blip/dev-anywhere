import { describe, it, expect } from "vitest";
import { computeSendDisabled } from "@/components/input-bar/index";

describe("computeSendDisabled", () => {
  it("returns disabled when JSON mode and isWorking", () => {
    const result = computeSendDisabled("json", true, []);
    expect(result).toEqual({ disabled: true, reason: "Claude is working..." });
  });

  it("returns disabled when JSON mode and has pending approvals", () => {
    const result = computeSendDisabled("json", false, [{ status: "pending" }]);
    expect(result).toEqual({ disabled: true, reason: "Waiting for tool approval..." });
  });

  it("returns enabled when JSON mode and idle with no pending approvals", () => {
    const result = computeSendDisabled("json", false, []);
    expect(result).toEqual({ disabled: false, reason: undefined });
  });

  it("returns enabled when PTY mode and isWorking", () => {
    const result = computeSendDisabled("pty", true, []);
    expect(result).toEqual({ disabled: false, reason: undefined });
  });

  it("returns enabled when PTY mode and has pending approvals", () => {
    const result = computeSendDisabled("pty", false, [{ status: "pending" }]);
    expect(result).toEqual({ disabled: false, reason: undefined });
  });
});
