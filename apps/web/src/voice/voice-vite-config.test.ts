import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Voice Pilot Vite configuration", () => {
  const configSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../vite.config.ts"),
    "utf8",
  );

  it("proxies voice WebSocket endpoints to the relay in local dev", () => {
    expect(configSource).toMatch(/["']\/voice["']:\s*\{[\s\S]*?target:\s*relayTarget\.ws/);
    expect(configSource).toMatch(/["']\/voice["']:\s*\{[\s\S]*?ws:\s*true/);
  });

  it("keeps voice endpoints out of the PWA SPA fallback", () => {
    expect(configSource).toContain(/^\/voice(\/|$|\?)/.source);
  });
});
