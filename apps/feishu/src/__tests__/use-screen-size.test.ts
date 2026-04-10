import { describe, it, expect, vi } from "vitest";

// classifyScreen 和 getResponsiveClass 是纯函数，不依赖 Taro 和 React，
// 但模块顶层 import 了 Taro 和 React，必须 mock 才能加载模块
vi.mock("@tarojs/taro", () => ({
  default: {
    getSystemInfoSync: () => ({
      windowWidth: 375,
      windowHeight: 667,
      statusBarHeight: 20,
      safeArea: { top: 20, bottom: 667, left: 0, right: 375, width: 375, height: 647 },
    }),
    onWindowResize: vi.fn(),
    offWindowResize: vi.fn(),
  },
}));

vi.mock("react", () => ({
  useState: (init: unknown) => [init, vi.fn()],
  useEffect: vi.fn(),
}));

import { classifyScreen, getResponsiveClass } from "@/hooks/use-screen-size";

describe("classifyScreen", () => {
  it("returns phone-portrait for width 375", () => {
    expect(classifyScreen(375, 667, "_")).toBe("phone-portrait");
  });

  it("returns phone-portrait for width 430", () => {
    expect(classifyScreen(430, 740, "_")).toBe("phone-portrait");
  });

  it("returns phone-landscape for width 700", () => {
    expect(classifyScreen(700, 375, "_")).toBe("phone-landscape");
  });

  it("returns phone-landscape for width 850", () => {
    expect(classifyScreen(850, 400, "_")).toBe("phone-landscape");
  });

  it("returns desktop for width 900", () => {
    expect(classifyScreen(900, 600, "_")).toBe("desktop");
  });

  it("returns desktop for width 1200", () => {
    expect(classifyScreen(1200, 800, "_")).toBe("desktop");
  });

  it("returns phone-portrait for width 350 (narrow sidebar)", () => {
    expect(classifyScreen(350, 600, "_")).toBe("phone-portrait");
  });

  it("returns phone-landscape for width 768", () => {
    expect(classifyScreen(768, 1024, "_")).toBe("phone-landscape");
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
