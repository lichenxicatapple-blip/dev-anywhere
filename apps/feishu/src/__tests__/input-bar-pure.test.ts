import { describe, it, expect } from "vitest";
import {
  hasValidAt,
  detectPickerMode,
  cleanupDeletedToken,
} from "@/components/input-bar";

describe("hasValidAt", () => {
  it("returns false for empty string", () => {
    expect(hasValidAt("")).toBe(false);
  });

  it("returns false when no @ present", () => {
    expect(hasValidAt("hello world")).toBe(false);
  });

  it("returns true for @ at start of string", () => {
    expect(hasValidAt("@src/file")).toBe(true);
  });

  it("returns true for @ after space", () => {
    expect(hasValidAt("read @src/file")).toBe(true);
  });

  it("returns false for @ in middle of word", () => {
    expect(hasValidAt("email@test")).toBe(false);
  });

  it("returns false when @ is followed by text with space (reference complete)", () => {
    expect(hasValidAt("@src/file.ts done")).toBe(false);
  });

  it("returns true for bare @ at end", () => {
    expect(hasValidAt("read @")).toBe(true);
  });

  it("uses last @ when multiple present", () => {
    expect(hasValidAt("@old done @new")).toBe(true);
  });

  it("returns false for multiple @ where last has space after", () => {
    expect(hasValidAt("@old @new file")).toBe(false);
  });
});

describe("detectPickerMode", () => {
  it("returns none for empty string", () => {
    expect(detectPickerMode("")).toBe("none");
  });

  it("returns slash for / at start", () => {
    expect(detectPickerMode("/")).toBe("slash");
  });

  it("returns slash for /compact", () => {
    expect(detectPickerMode("/compact")).toBe("slash");
  });

  it("returns none for / followed by text with space (command complete)", () => {
    expect(detectPickerMode("/help me")).toBe("none");
  });

  it("returns file for @ at start", () => {
    expect(detectPickerMode("@src")).toBe("file");
  });

  it("returns file for text followed by space and @", () => {
    expect(detectPickerMode("read @src")).toBe("file");
  });

  it("returns none for plain text", () => {
    expect(detectPickerMode("hello")).toBe("none");
  });

  it("returns none for text with / not at start", () => {
    expect(detectPickerMode("path/to/file")).toBe("none");
  });

  it("returns none for @ in middle of word", () => {
    expect(detectPickerMode("email@test.com")).toBe("none");
  });
});

describe("cleanupDeletedToken", () => {
  it("returns unchanged when text got longer (not a deletion)", () => {
    const result = cleanupDeletedToken("abc", "ab", ["/help"]);
    expect(result).toEqual({ cleaned: "abc", removedToken: null });
  });

  it("returns unchanged when no inserted tokens", () => {
    const result = cleanupDeletedToken("ab", "abc", []);
    expect(result).toEqual({ cleaned: "ab", removedToken: null });
  });

  it("returns unchanged when deleted text does not affect a token", () => {
    const result = cleanupDeletedToken("hello worl", "hello world", ["/help"]);
    expect(result).toEqual({ cleaned: "hello worl", removedToken: null });
  });

  it("cleans up partial token fragment after backspace", () => {
    // 用户插入了 "/compact "，然后退格删到 "/compac"
    const prev = "/compact ";
    const val = "/compac";
    const result = cleanupDeletedToken(val, prev, ["/compact"]);
    expect(result.removedToken).toBe("/compact");
    expect(result.cleaned).toBe("");
  });

  it("cleans up token with preceding text", () => {
    const prev = "hello /status ";
    const val = "hello /statu";
    const result = cleanupDeletedToken(val, prev, ["/status"]);
    expect(result.removedToken).toBe("/status");
    expect(result.cleaned).toBe("hello");
  });

  it("cleans up @ file token", () => {
    const prev = "read @src/file.ts ";
    const val = "read @src/file.t";
    const result = cleanupDeletedToken(val, prev, ["@src/file.ts"]);
    expect(result.removedToken).toBe("@src/file.ts");
    expect(result.cleaned).toBe("read");
  });

  it("only removes the affected token when multiple tokens exist", () => {
    const prev = "/help @src/a.ts ";
    const val = "/help @src/a.t";
    const result = cleanupDeletedToken(val, prev, ["/help", "@src/a.ts"]);
    expect(result.removedToken).toBe("@src/a.ts");
    expect(result.cleaned).toBe("/help");
  });
});
