import { describe, it, expect } from "vitest";
import {
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "../tool.js";

describe("ToolUseRequestPayloadSchema", () => {
  it("accepts valid tool use request", () => {
    const result = ToolUseRequestPayloadSchema.parse({
      toolName: "read_file",
      toolId: "tool-1",
      parameters: { path: "/foo/bar.ts" },
    });
    expect(result).toEqual({
      toolName: "read_file",
      toolId: "tool-1",
      parameters: { path: "/foo/bar.ts" },
    });
  });

  it("accepts empty parameters", () => {
    const result = ToolUseRequestPayloadSchema.parse({
      toolName: "git_status",
      toolId: "tool-2",
      parameters: {},
    });
    expect(result.parameters).toEqual({});
  });

  it("rejects missing toolName", () => {
    expect(() =>
      ToolUseRequestPayloadSchema.parse({
        toolId: "tool-1",
        parameters: {},
      }),
    ).toThrow();
  });

  it("rejects missing toolId", () => {
    expect(() =>
      ToolUseRequestPayloadSchema.parse({
        toolName: "read_file",
        parameters: {},
      }),
    ).toThrow();
  });

  it("rejects missing parameters", () => {
    expect(() =>
      ToolUseRequestPayloadSchema.parse({
        toolName: "read_file",
        toolId: "tool-1",
      }),
    ).toThrow();
  });
});

describe("ToolApprovePayloadSchema", () => {
  it("accepts valid tool approve", () => {
    const result = ToolApprovePayloadSchema.parse({ toolId: "tool-1" });
    expect(result).toEqual({ toolId: "tool-1" });
  });

  it("rejects missing toolId", () => {
    expect(() => ToolApprovePayloadSchema.parse({})).toThrow();
  });
});

describe("ToolDenyPayloadSchema", () => {
  it("accepts tool deny with reason", () => {
    const result = ToolDenyPayloadSchema.parse({
      toolId: "tool-1",
      reason: "not safe",
    });
    expect(result).toEqual({ toolId: "tool-1", reason: "not safe" });
  });

  it("accepts tool deny without reason", () => {
    const result = ToolDenyPayloadSchema.parse({ toolId: "tool-1" });
    expect(result).toEqual({ toolId: "tool-1" });
  });

  it("rejects missing toolId", () => {
    expect(() => ToolDenyPayloadSchema.parse({ reason: "no" })).toThrow();
  });
});

describe("ToolResultPayloadSchema", () => {
  it("accepts valid tool result", () => {
    const result = ToolResultPayloadSchema.parse({
      toolId: "tool-1",
      result: "file content here",
      isError: false,
    });
    expect(result).toEqual({
      toolId: "tool-1",
      result: "file content here",
      isError: false,
    });
  });

  it("accepts null result", () => {
    const result = ToolResultPayloadSchema.parse({
      toolId: "tool-1",
      result: null,
      isError: false,
    });
    expect(result.result).toBeNull();
  });

  it("accepts complex object result", () => {
    const result = ToolResultPayloadSchema.parse({
      toolId: "tool-1",
      result: { files: ["a.ts", "b.ts"] },
      isError: false,
    });
    expect(result.result).toEqual({ files: ["a.ts", "b.ts"] });
  });

  it("rejects missing isError", () => {
    expect(() =>
      ToolResultPayloadSchema.parse({
        toolId: "tool-1",
        result: "ok",
      }),
    ).toThrow();
  });
});
