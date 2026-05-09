import { describe, it, expect } from "vitest";
import {
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "../tool.js";

describe("ToolUseRequestPayloadSchema", () => {
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
  it("rejects missing toolId", () => {
    expect(() => ToolApprovePayloadSchema.parse({})).toThrow();
  });
});

describe("ToolDenyPayloadSchema", () => {
  it("rejects missing toolId", () => {
    expect(() => ToolDenyPayloadSchema.parse({ reason: "no" })).toThrow();
  });
});

describe("ToolResultPayloadSchema", () => {
  it("rejects missing isError", () => {
    expect(() =>
      ToolResultPayloadSchema.parse({
        toolId: "tool-1",
        result: "ok",
      }),
    ).toThrow();
  });
});
