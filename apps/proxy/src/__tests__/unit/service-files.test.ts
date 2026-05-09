import { describe, expect, it } from "vitest";
import { formatProxyNameForProfile } from "#src/serve/service-files.js";

describe("service files", () => {
  it("keeps the default proxy profile display name unchanged", () => {
    expect(formatProxyNameForProfile("DEV Mac", "default")).toBe("DEV Mac");
  });

  it("adds the profile name for isolated non-default proxy profiles", () => {
    expect(formatProxyNameForProfile("DEV Mac", "local")).toBe("DEV Mac (local)");
  });
});
