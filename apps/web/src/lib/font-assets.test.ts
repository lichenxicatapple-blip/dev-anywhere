import { beforeEach, describe, expect, it } from "vitest";
import { loadFontCSS } from "./font-assets";

describe("loadFontCSS", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("preloads the provider bullet font shard before loading the split CSS", () => {
    loadFontCSS("http://localhost:3100");

    const preload = document.head.querySelector<HTMLLinkElement>('link[rel="preload"][as="font"]');
    const stylesheet = document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');

    expect(preload?.href).toBe(
      "http://localhost:3100/fonts/sarasa-fixed-sc/58e7c2324d8d292d58534d9f236f1552.woff2",
    );
    expect(preload?.type).toBe("font/woff2");
    expect(preload?.crossOrigin).toBe("anonymous");
    expect(stylesheet?.href).toBe("http://localhost:3100/fonts/sarasa-fixed-sc/result.css");
  });

  it("does not append duplicate font links", () => {
    loadFontCSS("http://localhost:3100");
    loadFontCSS("http://localhost:3100");

    expect(document.head.querySelectorAll("link")).toHaveLength(2);
  });
});
