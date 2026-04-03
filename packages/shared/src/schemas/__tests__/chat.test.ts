import { describe, it, expect } from "vitest";
import {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "../chat.js";

describe("UserInputPayloadSchema", () => {
  it("accepts valid user input", () => {
    const result = UserInputPayloadSchema.parse({ text: "hello" });
    expect(result).toEqual({ text: "hello" });
  });

  it("rejects empty text", () => {
    expect(() => UserInputPayloadSchema.parse({ text: "" })).toThrow();
  });

  it("rejects missing text field", () => {
    expect(() => UserInputPayloadSchema.parse({})).toThrow();
  });

  it("rejects non-string text", () => {
    expect(() => UserInputPayloadSchema.parse({ text: 123 })).toThrow();
  });
});

describe("AssistantMessagePayloadSchema", () => {
  it("accepts valid assistant message", () => {
    const result = AssistantMessagePayloadSchema.parse({
      text: "response",
      isPartial: false,
    });
    expect(result).toEqual({ text: "response", isPartial: false });
  });

  it("accepts partial message", () => {
    const result = AssistantMessagePayloadSchema.parse({
      text: "partial...",
      isPartial: true,
    });
    expect(result).toEqual({ text: "partial...", isPartial: true });
  });

  it("accepts empty text for assistant messages", () => {
    const result = AssistantMessagePayloadSchema.parse({
      text: "",
      isPartial: true,
    });
    expect(result).toEqual({ text: "", isPartial: true });
  });

  it("rejects missing isPartial", () => {
    expect(() =>
      AssistantMessagePayloadSchema.parse({ text: "hello" }),
    ).toThrow();
  });

  it("rejects missing text", () => {
    expect(() =>
      AssistantMessagePayloadSchema.parse({ isPartial: false }),
    ).toThrow();
  });
});

describe("ThinkingPayloadSchema", () => {
  it("accepts valid thinking payload", () => {
    const result = ThinkingPayloadSchema.parse({ text: "thinking..." });
    expect(result).toEqual({ text: "thinking..." });
  });

  it("accepts empty thinking text", () => {
    const result = ThinkingPayloadSchema.parse({ text: "" });
    expect(result).toEqual({ text: "" });
  });

  it("rejects missing text", () => {
    expect(() => ThinkingPayloadSchema.parse({})).toThrow();
  });
});
