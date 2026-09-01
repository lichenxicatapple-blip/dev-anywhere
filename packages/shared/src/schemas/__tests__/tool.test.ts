import { describe, it, expect } from "vitest";
import {
  ApprovalOptionSchema,
  ToolUseRequestPayloadSchema,
  ToolApprovePayloadSchema,
  ToolDenyPayloadSchema,
  ToolResultPayloadSchema,
} from "../tool.js";

describe("ApprovalOptionSchema", () => {
  it("parses each provider approval option kind", () => {
    for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"] as const) {
      expect(ApprovalOptionSchema.parse({ optionId: `option-${kind}`, name: kind, kind })).toEqual({
        optionId: `option-${kind}`,
        name: kind,
        kind,
      });
    }
  });

  it("rejects unknown option kinds", () => {
    expect(() =>
      ApprovalOptionSchema.parse({ optionId: "option-1", name: "Maybe", kind: "maybe" }),
    ).toThrow();
  });
});

describe("ToolUseRequestPayloadSchema", () => {
  it("preserves provider-defined approval options", () => {
    expect(
      ToolUseRequestPayloadSchema.parse({
        toolName: "AskUserQuestion",
        toolId: "tool-1",
        parameters: { question: "Continue?" },
        options: [
          { optionId: "yes", name: "Continue once", kind: "allow_once" },
          { optionId: "no", name: "Stop", kind: "reject_once" },
        ],
      }),
    ).toMatchObject({
      options: [
        { optionId: "yes", name: "Continue once", kind: "allow_once" },
        { optionId: "no", name: "Stop", kind: "reject_once" },
      ],
    });
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
  it("preserves an exact provider option id", () => {
    expect(
      ToolApprovePayloadSchema.parse({
        toolId: "tool-1",
        optionId: "allow-session",
        whitelistTool: true,
      }),
    ).toEqual({ toolId: "tool-1", optionId: "allow-session", whitelistTool: true });
  });

  it("rejects missing toolId", () => {
    expect(() => ToolApprovePayloadSchema.parse({})).toThrow();
  });
});

describe("ToolDenyPayloadSchema", () => {
  it("preserves an exact provider option id", () => {
    expect(ToolDenyPayloadSchema.parse({ toolId: "tool-1", optionId: "reject-once" })).toEqual({
      toolId: "tool-1",
      optionId: "reject-once",
    });
  });

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
