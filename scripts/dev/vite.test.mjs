import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const requireRelay = createRequire(new URL("../../apps/relay/package.json", import.meta.url));
const viteUrl = pathToFileURL(
  join(dirname(requireWeb.resolve("vite/package.json")), "dist/node/index.js"),
).href;

function getPage(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/`, { timeout: 3000 }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("HTTP request timed out")));
  });
}

function closePing(port, statusCode) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = Buffer.alloc(0);
    let upgraded = false;
    socket.setTimeout(3000, () => socket.destroy(new Error("WebSocket ping timed out")));
    socket.on("error", (error) => {
      if (!upgraded || error.code !== "ECONNRESET") reject(error);
    });
    socket.on("close", () => {
      if (upgraded) resolve();
      else reject(new Error("WebSocket ping did not upgrade"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: vite-ping",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      if (upgraded) return;
      received = Buffer.concat([received, chunk]);
      if (!received.includes("\r\n\r\n")) return;
      if (!received.toString().startsWith("HTTP/1.1 101 ")) {
        socket.destroy(new Error(`WebSocket upgrade failed: ${received}`));
        return;
      }
      upgraded = true;
      // A masked close frame. 1006 is reserved and must never appear on the wire.
      socket.write(Buffer.from([0x88, 0x82, 0, 0, 0, 0, statusCode >> 8, statusCode & 0xff]));
    });
  });
}

test(
  "Vite survives a malformed reconnect ping and keeps serving HTTP and HMR",
  { timeout: 15000 },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "dev-anywhere-vite-"));
    await writeFile(join(fixture, "index.html"), "<h1>Preview still running</h1>");
    // Keep the crash regression isolated from both the test runner and the user's dev server.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createServer } from ${JSON.stringify(viteUrl)};
       const server = await createServer({ configFile: false, root: ${JSON.stringify(fixture)},
         logLevel: 'warn', server: { host: '127.0.0.1', port: 0 } });
       // Vite 6 treats port 0 as 5173; use its HTTP server for a truly ephemeral port.
       await new Promise((resolve, reject) => {
         server.httpServer.once('error', reject);
         server.httpServer.listen(0, '127.0.0.1', resolve);
       });
       process.send({ port: server.httpServer.address().port });`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      assert.equal(dirname(fixture), tmpdir());
      await rm(fixture, { recursive: true, force: true });
    });
    const { port } = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Vite exited (${code}): ${output}`)));
    });
    const initialPage = await getPage(port);
    assert.equal(initialPage.status, 200);
    assert.match(initialPage.body, /Preview still running/);
    await closePing(port, 1000);
    await closePing(port, 1006);
    try {
      const page = await getPage(port);
      assert.equal(page.status, 200);
      assert.match(page.body, /Preview still running/);
      assert.equal(child.exitCode, null);
    } catch (error) {
      assert.fail(`Vite stopped serving after a malformed ping: ${error.message}\n${output}`);
    }
    const WebSocket = requireRelay("ws");
    const client = new WebSocket(`ws://127.0.0.1:${port}/`, "vite-hmr");
    t.after(() => client.terminate());
    const [message] = await once(client, "message");
    assert.equal(JSON.parse(String(message)).type, "connected");
    client.close();
    await once(client, "close");
  },
);
