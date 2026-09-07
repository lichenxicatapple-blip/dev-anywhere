import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type {
  DevicePreviewCapability,
  DevicePreviewInput,
  DevicePreviewTarget,
} from "@dev-anywhere/shared";
import type { CloudflaredLocator } from "#src/serve/preview/cloudflared-locator.js";
import { PreviewRuntime } from "#src/serve/preview/preview-runtime.js";
import type { PreviewStore } from "#src/serve/preview/preview-store.js";
import type { PersistedPreviewDefinition } from "#src/serve/preview/types.js";
import type { DevicePreviewBackend, DevicePreviewFrame } from "#src/serve/device-preview/types.js";

// configure() must exercise transport lifecycle without creating a real WebSocket.
const stream = vi.hoisted(() => ({
  constructed: vi.fn(),
  register: vi.fn(),
  disconnectMain: vi.fn(),
  close: vi.fn(),
  sendFrame: vi.fn(async () => undefined),
  sendH264Packet: vi.fn(async () => undefined),
}));

vi.mock("#src/serve/device-preview/device-preview-stream-connection.js", () => ({
  DevicePreviewStreamConnection: class {
    constructor(options: unknown) {
      stream.constructed(options);
    }
    register = stream.register;
    disconnectMain = stream.disconnectMain;
    close = stream.close;
    sendFrame = stream.sendFrame;
    sendH264Packet = stream.sendH264Packet;
  },
}));

const TARGET: DevicePreviewTarget = {
  targetId: "ios:runtime-test-simulator",
  platform: "ios",
  name: "Test phone",
  model: "Test phone",
  osVersion: "test",
  width: 393,
  height: 852,
  interactive: true,
};
const RELAY = {
  relayUrl: "ws://relay.invalid",
  proxyId: "runtime-test-proxy",
  token: "test-token",
  connectionId: "serve-connection-1",
};
const SCOPE = { proxyId: RELAY.proxyId, bindingId: "binding-1" };
const DOWN: DevicePreviewInput = { kind: "touch", phase: "down", x: 0.5, y: 0.5 };

class MemoryStore {
  definitions: PersistedPreviewDefinition[] = [];
  load() {
    return structuredClone(this.definitions);
  }
  save(definitions: readonly PersistedPreviewDefinition[]) {
    this.definitions = definitions.map((definition) => structuredClone(definition));
  }
}

function backendFake() {
  const captureSignals: AbortSignal[] = [];
  const frameCallbacks: Array<(frame: DevicePreviewFrame) => void | Promise<void>> = [];
  const backend = {
    inspectCapabilities: vi.fn(
      async (): Promise<DevicePreviewCapability> => ({
        ios: { supported: true, available: true, interactive: true, command: "/unused/simctl" },
        android: {
          supported: false,
          available: false,
          interactive: false,
          error: "Not under test",
        },
      }),
    ),
    discoverTargets: vi.fn(async () => [TARGET]),
    capture: vi.fn(
      async (
        _targetId: string,
        signal: AbortSignal,
        onFrame: (frame: DevicePreviewFrame) => void | Promise<void>,
      ) => {
        captureSignals.push(signal);
        frameCallbacks.push(onFrame);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    ),
    requestKeyframe: vi.fn(async () => undefined),
    sendInput: vi.fn(
      async (_targetId: string, _input: DevicePreviewInput, _signal: AbortSignal) => undefined,
    ),
    releaseInput: vi.fn(async () => undefined),
    releaseTarget: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies DevicePreviewBackend;
  return { backend, captureSignals, frameCallbacks };
}

const fixtures: Array<{ runtime: PreviewRuntime; directory: string }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const { runtime, directory } of fixtures.splice(0)) {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(onState?: (message: Record<string, unknown>) => void) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "dev-anywhere-preview-runtime-test-")),
  );
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Dummy preview</title>");
  const device = backendFake();
  const gateway = {
    originUrl: "http://127.0.0.1:45678",
    deactivate: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, kill: vi.fn() });
  const tunnel = {
    child,
    publicUrl: Promise.resolve("https://preview-runtime.invalid"),
    connectionReady: Promise.resolve(),
    publicReady: Promise.resolve("https://preview-runtime.invalid"),
    getOutput: () => "",
    stop: vi.fn(async () => undefined),
  };
  const startGateway = vi.fn(async () => gateway);
  const startTunnel = vi.fn(() => tunnel);
  const messages: Record<string, unknown>[] = [];
  const runtime = new PreviewRuntime({
    web: {
      persistPath: join(directory, "previews.json"),
      runtimeRoot: join(directory, "run"),
      store: new MemoryStore() as unknown as PreviewStore,
      locator: {
        inspect: vi.fn(async () => ({
          capability: { available: true, command: "/unused/cloudflared", version: "test" },
          command: "/unused/cloudflared",
          env: {},
        })),
      } as unknown as CloudflaredLocator,
      startGateway,
      startTunnel,
    },
    backend: device.backend,
    send: (message) => {
      const parsed = JSON.parse(message);
      messages.push(parsed);
      onState?.(parsed);
    },
  });
  const binding = runtime.bindConnection(
    () => true,
    (message) => messages.push(JSON.parse(message)),
  );
  fixtures.push({ runtime, directory });
  return {
    runtime,
    binding,
    directory,
    ...device,
    gateway,
    tunnel,
    startGateway,
    startTunnel,
    messages,
  };
}

async function createPair(test: Awaited<ReturnType<typeof fixture>>) {
  const { runtime, binding, directory } = test;
  await binding.handle({
    type: "preview_create_request",
    requestId: "web-create",
    operationId: "web-create-op",
    scope: SCOPE,
    source: { kind: "static", path: directory, entryPath: "index.html" },
    tunnelProvider: "cloudflare",
  });
  await vi.waitFor(() => expect(runtime.web.list().previews[0]?.state).toBe("ready"));
  await binding.handle({
    type: "device_preview_targets_request",
    requestId: "targets",
    scope: SCOPE,
    refresh: false,
  });
  await binding.handle({
    type: "device_preview_create_request",
    requestId: "device-create",
    operationId: "device-create-op",
    scope: SCOPE,
    targetId: TARGET.targetId,
  });
  const webId = runtime.web.list().previews[0]!.previewId;
  const deviceId = runtime.device.list().previews[0]!.previewId;
  await binding.handle({
    type: "preview_rename_request",
    requestId: "web-rename",
    operationId: "web-rename-op",
    scope: SCOPE,
    previewId: webId,
    name: "Renamed web",
  });
  await binding.handle({
    type: "device_preview_rename_request",
    requestId: "device-rename",
    operationId: "device-rename-op",
    scope: SCOPE,
    previewId: deviceId,
    name: "Renamed phone",
  });
  expect(runtime.web.list().previews[0]).toMatchObject({ name: "Renamed web", state: "ready" });
  expect(runtime.device.list().previews[0]).toMatchObject({
    name: "Renamed phone",
    state: "ready",
  });
  expect(runtime.empty).toBe(false);
  return { webId, deviceId };
}

async function startViewer(runtime: PreviewRuntime, previewId: string, leaseId: string) {
  await runtime.device.startStream({
    streamId: `stream-${leaseId}`,
    leaseId,
    previewId,
    format: "jpeg",
  });
  await runtime.device.sendInput(leaseId, 1, DOWN);
}

describe("PreviewRuntime command binding", () => {
  it.each(["configure", "takeover", "disconnect"] as const)(
    "drops a queued stream start invalidated by %s before it can create an old lease",
    async (change) => {
      const { runtime } = await fixture();
      let current = true;
      const reply = vi.fn();
      const binding = runtime.bindConnection(() => current, reply);
      binding.configure(RELAY);
      const startStream = vi.spyOn(runtime.device, "startStream");
      const queued = binding.handle({
        type: "device_preview_stream_start",
        previewId: "preview-1",
        streamId: "old-stream",
        leaseId: "old-lease",
        format: "jpeg",
      });

      if (change === "configure") {
        binding.configure({ ...RELAY, connectionId: "replacement-connection" });
      } else {
        current = false;
        runtime.disconnect();
        if (change === "takeover") {
          runtime
            .bindConnection(() => true, vi.fn())
            .configure({ ...RELAY, connectionId: "replacement-connection" });
        }
      }
      await queued;

      expect(startStream).not.toHaveBeenCalled();
      expect(runtime.device.hasLease("old-lease")).toBe(false);
      expect(reply).not.toHaveBeenCalled();
    },
  );

  it.each(["configure", "takeover", "disconnect"] as const)(
    "drops an in-flight inspection reply after %s without delivering it to a new attachment",
    async (change) => {
      const { runtime, directory } = await fixture();
      let current = true;
      const oldReply = vi.fn();
      const newReply = vi.fn();
      const binding = runtime.bindConnection(() => current, oldReply);
      binding.configure(RELAY);
      const inspection = deferred<Awaited<ReturnType<typeof runtime.web.inspectStatic>>>();
      const inspect = vi
        .spyOn(runtime.web, "inspectStatic")
        .mockReturnValueOnce(inspection.promise);
      const pending = binding.handle({
        type: "preview_static_inspect_request",
        requestId: "old-inspection",
        scope: SCOPE,
        path: directory,
      });
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());

      if (change === "configure") {
        binding.configure({ ...RELAY, connectionId: "replacement-connection" });
      } else {
        current = false;
        runtime.disconnect();
        if (change === "takeover") {
          runtime
            .bindConnection(() => true, newReply)
            .configure({ ...RELAY, connectionId: "replacement-connection" });
        }
      }
      inspection.resolve({ rootPath: directory, htmlEntries: ["index.html"] });
      await pending;

      expect(oldReply).not.toHaveBeenCalled();
      expect(newReply).not.toHaveBeenCalled();
    },
  );

  it("finishes an admitted create after takeover, broadcasts its state to the new owner, and deduplicates its retry", async () => {
    let current = "old";
    const events: Array<{ owner: string; message: Record<string, unknown> }> = [];
    const { runtime, backend } = await fixture((message) =>
      events.push({ owner: current, message }),
    );
    const oldReply = vi.fn();
    const newReply = vi.fn();
    const old = runtime.bindConnection(() => current === "old", oldReply);
    old.configure(RELAY);
    const discovery = deferred<DevicePreviewTarget[]>();
    backend.discoverTargets.mockReturnValueOnce(discovery.promise);
    const create = vi.spyOn(runtime.device, "create");
    const request = {
      type: "device_preview_create_request" as const,
      requestId: "old-create",
      scope: SCOPE,
      operationId: "create-across-takeover",
      targetId: TARGET.targetId,
      name: "Retained phone",
    };
    const pending = old.handle(request);
    await vi.waitFor(() => expect(backend.discoverTargets).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();

    current = "new";
    runtime.disconnect();
    const replacement = runtime.bindConnection(() => current === "new", newReply);
    replacement.configure({ ...RELAY, connectionId: "replacement-connection" });
    discovery.resolve([TARGET]);
    await pending;

    const preview = runtime.device.list().previews[0]!;
    expect(runtime.device.list().previews).toHaveLength(1);
    expect(preview).toMatchObject({ name: "Retained phone", state: "ready" });
    expect(events).toContainEqual({
      owner: "new",
      message: {
        type: "device_preview_state_event",
        epoch: expect.any(String),
        revision: expect.any(Number),
        preview,
      },
    });
    expect(oldReply).not.toHaveBeenCalled();
    expect(newReply).not.toHaveBeenCalled();

    await replacement.handle({
      ...request,
      requestId: "retry-create",
      scope: { ...SCOPE, bindingId: "new-binding" },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(runtime.device.list().previews).toHaveLength(1);
    expect(JSON.parse(newReply.mock.calls[0]![0])).toMatchObject({
      type: "device_preview_create_response",
      requestId: "retry-create",
      operationId: request.operationId,
      accepted: true,
      previewId: preview.previewId,
    });

    await replacement.handle({
      type: "preview_rename_request",
      requestId: "cross-kind-conflict",
      scope: SCOPE,
      operationId: request.operationId,
      previewId: "web-preview",
      name: "Conflicting operation",
    });
    expect(JSON.parse(newReply.mock.calls[1]![0])).toMatchObject({
      type: "preview_rename_response",
      success: false,
      errorCode: ControlErrorCode.OPERATION_CONFLICT,
    });
  });
});

describe("PreviewRuntime resource ownership", () => {
  it("keeps renamed resources, epochs and public URL across Serve disconnect/reconfigure while revoking old viewers", async () => {
    const test = await fixture();
    const { runtime, binding, backend, captureSignals, frameCallbacks, messages, gateway, tunnel } =
      test;
    expect(runtime.empty).toBe(true);
    binding.configure(RELAY);
    const { deviceId } = await createPair(test);
    await startViewer(runtime, deviceId, "old-lease");
    const webBefore = runtime.web.list();
    const deviceBefore = runtime.device.list();
    expect(webBefore.previews[0]?.publicUrl).toBe("https://preview-runtime.invalid/index.html");
    const oldInputSignal = backend.sendInput.mock.calls[0]![2];

    runtime.disconnect();
    expect(stream.disconnectMain).toHaveBeenCalledOnce();
    expect(runtime.device.hasLease("old-lease")).toBe(false);
    expect(oldInputSignal.aborted).toBe(true);
    await expect(runtime.device.sendInput("old-lease", 2, DOWN)).rejects.toMatchObject({
      errorCode: ControlErrorCode.CONTROL_LEASE_INVALID,
    });
    await vi.waitFor(() => expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId));
    await vi.waitFor(() => expect(captureSignals[0]?.aborted).toBe(true));
    // releaseTarget only frees idle adapters; neither the resource nor simulator is closed.
    expect(runtime.device.list()).toEqual(deviceBefore);
    expect(backend.dispose).not.toHaveBeenCalled();
    await frameCallbacks[0]!({ format: "jpeg", jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    expect(stream.sendFrame).not.toHaveBeenCalled();

    binding.configure({ ...RELAY, connectionId: "serve-connection-2" });
    expect(stream.constructed).toHaveBeenCalledOnce();
    expect(stream.register.mock.calls).toEqual([["serve-connection-1"], ["serve-connection-2"]]);
    expect(stream.close).not.toHaveBeenCalled();
    expect(runtime.web.list()).toEqual(webBefore);
    expect(runtime.device.list()).toEqual(deviceBefore);
    expect(test.startGateway).toHaveBeenCalledOnce();
    expect(test.startTunnel).toHaveBeenCalledOnce();
    expect(gateway.deactivate).not.toHaveBeenCalled();
    expect(gateway.close).not.toHaveBeenCalled();
    expect(tunnel.stop).not.toHaveBeenCalled();

    const newScope = { ...SCOPE, bindingId: "binding-2" };
    await binding.handle({
      type: "preview_list_request",
      requestId: "web-list-2",
      scope: newScope,
    });
    await binding.handle({
      type: "device_preview_list_request",
      requestId: "device-list-2",
      scope: newScope,
    });
    expect(messages.find((message) => message.requestId === "web-list-2")).toEqual({
      type: "preview_list_response",
      requestId: "web-list-2",
      scope: newScope,
      ...webBefore,
    });
    expect(messages.find((message) => message.requestId === "device-list-2")).toEqual({
      type: "device_preview_list_response",
      requestId: "device-list-2",
      scope: newScope,
      ...deviceBefore,
    });
    await startViewer(runtime, deviceId, "new-lease");
    expect(runtime.device.hasLease("new-lease")).toBe(true);
    expect(backend.capture).toHaveBeenCalledTimes(2);
    expect(backend.sendInput).toHaveBeenCalledTimes(2);
    expect(runtime.device.list()).toEqual(deviceBefore);
  });

  it("explicit close stops only its corresponding resources and leaves the runtime usable", async () => {
    const test = await fixture();
    const { runtime, binding, backend, captureSignals, gateway, tunnel } = test;
    binding.configure(RELAY);
    const { webId, deviceId } = await createPair(test);
    await startViewer(runtime, deviceId, "close-lease");
    const deviceBefore = runtime.device.list();

    await binding.handle({
      type: "preview_close_request",
      requestId: "web-close",
      operationId: "web-close-op",
      scope: SCOPE,
      previewId: webId,
    });
    expect(runtime.web.list().previews).toEqual([]);
    expect(tunnel.stop).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(runtime.device.list()).toEqual(deviceBefore);
    expect(runtime.device.hasLease("close-lease")).toBe(true);
    expect(captureSignals[0]?.aborted).toBe(false);
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(runtime.empty).toBe(false);

    await binding.handle({
      type: "device_preview_close_request",
      requestId: "device-close",
      operationId: "device-close-op",
      scope: SCOPE,
      previewId: deviceId,
    });
    await vi.waitFor(() => expect(captureSignals[0]?.aborted).toBe(true));
    expect(runtime.device.hasLease("close-lease")).toBe(false);
    expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId);
    expect(backend.releaseTarget).toHaveBeenCalledWith(TARGET.targetId);
    expect(runtime.device.list().previews).toEqual([]);
    expect(runtime.empty).toBe(true);
    expect(stream.close).not.toHaveBeenCalled();
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(tunnel.stop).toHaveBeenCalledOnce();
    const replacement = await runtime.device.create(TARGET.targetId);
    expect(replacement.previewId).not.toBe(deviceId);
    expect(replacement.state).toBe("ready");
  });

  it("shutdown closes every live web resource and device transport/backend, releasing input first", async () => {
    const test = await fixture();
    const { runtime, binding, backend, captureSignals, gateway, tunnel } = test;
    binding.configure(RELAY);
    const { deviceId } = await createPair(test);
    await startViewer(runtime, deviceId, "shutdown-lease");

    await runtime.shutdown();

    expect(stream.close).toHaveBeenCalledOnce();
    expect(gateway.close).toHaveBeenCalledOnce();
    expect(tunnel.stop).toHaveBeenCalledOnce();
    expect(captureSignals[0]?.aborted).toBe(true);
    expect(runtime.device.hasLease("shutdown-lease")).toBe(false);
    expect(backend.releaseInput).toHaveBeenCalledWith(TARGET.targetId);
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(backend.releaseInput.mock.invocationCallOrder[0]!).toBeLessThan(
      backend.dispose.mock.invocationCallOrder[0]!,
    );
    expect(runtime.web.list().previews[0]?.state).toBe("disconnected");
    await expect(
      runtime.device.startStream({
        streamId: "after-shutdown",
        leaseId: "after-shutdown",
        previewId: deviceId,
        format: "jpeg",
      }),
    ).rejects.toThrow("Proxy 正在停止");
  });
});
