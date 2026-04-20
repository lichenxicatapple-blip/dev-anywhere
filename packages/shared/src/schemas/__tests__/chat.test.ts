import { describe, it, expect } from "vitest";
import {
  UserInputPayloadSchema,
  AssistantMessagePayloadSchema,
  ThinkingPayloadSchema,
} from "../chat.js";

describe("UserInputPayloadSchema", () => {
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
  it("rejects missing isPartial", () => {
    expect(() => AssistantMessagePayloadSchema.parse({ text: "hello" })).toThrow();
  });

  it("rejects missing text", () => {
    expect(() => AssistantMessagePayloadSchema.parse({ isPartial: false })).toThrow();
  });
});

describe("ThinkingPayloadSchema", () => {
  it("rejects missing text", () => {
    expect(() => ThinkingPayloadSchema.parse({})).toThrow();
  });
});
