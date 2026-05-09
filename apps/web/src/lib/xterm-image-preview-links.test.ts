import { describe, expect, it, vi } from "vitest";
import {
  findImagePreviewPathMatches,
  registerImagePreviewLinkProvider,
} from "./xterm-image-preview-links";

describe("xterm image preview links", () => {
  it("finds image path ranges with 1-based terminal columns", () => {
    expect(findImagePreviewPathMatches("open @.dev-anywhere/clipboard/s1/shot.png now")).toEqual([
      {
        path: ".dev-anywhere/clipboard/s1/shot.png",
        startColumn: 6,
        endColumn: 41,
      },
    ]);
  });

  it("registers a link provider that activates image preview", () => {
    const onPreview = vi.fn();
    const providerRef: {
      current?: { provideLinks: (line: number, cb: (links: unknown) => void) => void };
    } = {};
    const term = {
      buffer: {
        active: {
          getLine: () => ({
            translateToString: () => "artifact /tmp/shot.png",
          }),
        },
      },
      registerLinkProvider: vi.fn((provider) => {
        providerRef.current = provider;
        return { dispose: vi.fn() };
      }),
    };

    registerImagePreviewLinkProvider(term as never, onPreview);

    providerRef.current?.provideLinks(1, (links) => {
      const [link] = links as Array<{ text: string; activate: () => void }>;
      expect(link.text).toBe("/tmp/shot.png");
      link.activate();
    });

    expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
  });
});
