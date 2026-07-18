import { describe, expect, it } from "vitest";
import { takeControlOfBrowserScrollRestoration } from "./browser-scroll-restoration";

describe("takeControlOfBrowserScrollRestoration", () => {
  it("prevents the browser from replaying stale scroll offsets after a reload", () => {
    const browserHistory = { scrollRestoration: "auto" as ScrollRestoration };

    takeControlOfBrowserScrollRestoration(browserHistory);

    expect(browserHistory.scrollRestoration).toBe("manual");
  });
});
