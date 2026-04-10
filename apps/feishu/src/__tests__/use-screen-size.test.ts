import { describe, it, expect } from "vitest";
import { classifyScreen, getResponsiveClass } from "@/hooks/use-screen-size";

describe("classifyScreen", () => {
  it("returns phone-portrait for 375x667 phone", () => {
    expect(classifyScreen(375, 667, "phone")).toBe("phone-portrait");
  });

  it("returns phone-portrait for 430x740 phone", () => {
    expect(classifyScreen(430, 740, "phone")).toBe("phone-portrait");
  });

  it("returns phone-landscape for 700x375 phone", () => {
    expect(classifyScreen(700, 375, "phone")).toBe("phone-landscape");
  });

  it("returns phone-landscape for 850x400 phone", () => {
    expect(classifyScreen(850, 400, "phone")).toBe("phone-landscape");
  });

  it("returns desktop for 900x600 pc", () => {
    expect(classifyScreen(900, 600, "pc")).toBe("desktop");
  });

  it("returns desktop for 1200x800 pc", () => {
    expect(classifyScreen(1200, 800, "pc")).toBe("desktop");
  });

  it("returns phone-portrait for 350x600 pc (narrow sidebar)", () => {
    expect(classifyScreen(350, 600, "pc")).toBe("phone-portrait");
  });

  it("returns phone-landscape for 768x1024 tablet", () => {
    expect(classifyScreen(768, 1024, "tablet")).toBe("phone-landscape");
  });
});

describe("getResponsiveClass", () => {
  it("returns screen-portrait for phone-portrait", () => {
    expect(getResponsiveClass("phone-portrait")).toBe("screen-portrait");
  });

  it("returns screen-landscape for phone-landscape", () => {
    expect(getResponsiveClass("phone-landscape")).toBe("screen-landscape");
  });

  it("returns screen-desktop for desktop", () => {
    expect(getResponsiveClass("desktop")).toBe("screen-desktop");
  });
});
