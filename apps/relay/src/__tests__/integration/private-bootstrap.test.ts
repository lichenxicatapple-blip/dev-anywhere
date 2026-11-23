import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { healthRouter } from "#src/health.js";
import { RelayRegistry } from "#src/registry.js";

vi.mock("#src/version.js", () => ({ RELAY_VERSION: "0.10.11-cursor-ide.20261123.1" }));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it("does not advertise a private build as a published Proxy upgrade", async () => {
  const app = express();
  app.use(healthRouter(new RelayRegistry()));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test address");
  const base = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${base}/api/proxy-upgrade-bootstrap`)).status).toBe(404);
  expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
    status: "ok",
    version: "0.10.11-cursor-ide.20261123.1",
  });
});
