import { beforeEach, describe, expect, it } from "vitest";
import { loadFontCSS } from "./font-assets";

describe("loadFontCSS", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("preloads provider and terminal metric shards before loading the split CSS", () => {
    loadFontCSS("http://localhost:3100");

    const preloads = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"]'),
    );
    const stylesheet = document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');

    expect(preloads.map((link) => link.href)).toEqual([
      "http://localhost:3100/fonts/sarasa-fixed-sc/58e7c2324d8d292d58534d9f236f1552.woff2",
      "http://localhost:3100/fonts/sarasa-fixed-sc/c8e0baa6e08346d410255ea827a8be27.woff2",
      "http://localhost:3100/fonts/sarasa-fixed-sc/ac9e1d7b7d0e738c0965e0c37a171594.woff2",
      "http://localhost:3100/fonts/sarasa-fixed-sc/911993a058e817f1a231fbac27b3781c.woff2",
    ]);
    expect(preloads.every((link) => link.type === "font/woff2")).toBe(true);
    expect(preloads.every((link) => link.crossOrigin === "anonymous")).toBe(true);
    expect(stylesheet?.href).toBe("http://localhost:3100/fonts/sarasa-fixed-sc/result.css");
  });

  it("does not append duplicate font links", () => {
    loadFontCSS("http://localhost:3100");
    loadFontCSS("http://localhost:3100");

    expect(document.head.querySelectorAll("link")).toHaveLength(5);
  });
});
