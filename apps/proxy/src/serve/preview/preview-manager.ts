import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defineFSM,
  ControlErrorCode,
  type TunnelProvider,
  type WebPreviewCapability,
} from "@dev-anywhere/shared";
import { nanoid } from "nanoid";
import type { CloudflaredQuickTunnel } from "../../common/cloudflared-quick-tunnel.js";
import { startCloudflaredQuickTunnel } from "../../common/cloudflared-quick-tunnel.js";
import type { CpolarQuickTunnel } from "../../common/cpolar-quick-tunnel.js";
import { cpolarFailureMessage, startCpolarQuickTunnel } from "../../common/cpolar-quick-tunnel.js";
import { serviceLogger } from "../../common/logger.js";
import { CloudflaredLocator, type CloudflaredCapability } from "./cloudflared-locator.js";
import { CpolarLocator, type CpolarCapability } from "./cpolar-locator.js";
import { normalizeLocalPreviewUrl, probeLocalPreviewTarget } from "./local-preview-url.js";
import { startPreviewGateway, type PreviewGateway } from "./preview-gateway.js";
import { normalizeOptionalPreviewName, normalizeRequiredPreviewName } from "./preview-name.js";
import {
  fingerprintPreviewOperationParameters,
  PreviewOperationJournalError,
} from "./preview-operation-journal.js";
import { MAX_PERSISTED_PREVIEWS, PreviewStore } from "./preview-store.js";
import { inspectStaticPreviewPath, resolveStaticPreviewSource } from "./static-preview.js";
import {
  captureCpolarRuntimeProcessIdentity,
  serializePreviewRuntimeMarker,
} from "./stale-preview-runtime.js";
import type {
  PreviewCreateInput,
  PreviewDefinition,
  PersistedPreviewDefinition,
  PreviewSnapshot,
  PreviewState,
  PreviewSummary,
  StaticPreviewInspection,
} from "./types.js";

const MAX_ACTIVE_PREVIEWS = 8;

const previewFsm = defineFSM<PreviewState>({
  disconnected: ["starting", "stopping"],
  starting: ["ready", "failed", "disconnected", "stopping"],
  ready: ["failed", "disconnected", "stopping"],
  failed: ["starting", "disconnected", "stopping"],
  stopping: ["disconnected", "failed"],
});

export class PreviewOperationError extends Error {
  constructor(
    message: string,
    readonly errorCode: (typeof ControlErrorCode)[keyof typeof ControlErrorCode] = ControlErrorCode.UNKNOWN,
  ) {
    super(message);
  }
}

interface PreviewRuntime {
  generation: number;
  provider: TunnelProvider;
  localHost?: "127.0.0.1" | "::1";
  gateway?: PreviewGateway;
  tunnel?: CloudflaredQuickTunnel | CpolarQuickTunnel;
  runtimeDir?: string;
  expectedTunnelStop: boolean;
}

interface PreviewRecord {
  summary: PreviewSummary;
  operationId: string;
  operationFingerprint: string;
  generation: number;
  runtime?: PreviewRuntime;
}

type PreviewManagerEvent =
  | { type: "state"; epoch: string; revision: number; preview: PreviewSummary }
  | { type: "removed"; epoch: string; revision: number; previewId: string };

interface PreviewManagerOptions {
  persistPath: string;
  runtimeRoot: string;
  locator?: CloudflaredLocator;
  cpolarLocator?: CpolarLocator;
  store?: PreviewStore;
  onEvent?: (event: PreviewManagerEvent) => void;
  startGateway?: typeof startPreviewGateway;
  startTunnel?: typeof startCloudflaredQuickTunnel;
  startCpolarTunnel?: typeof startCpolarQuickTunnel;
  now?: () => number;
}

function cloneSummary(summary: PreviewSummary): PreviewSummary {
  return {
    ...summary,
    source: { ...summary.source },
  };
}

export function buildPreviewPublicUrl(publicBase: string, summary: PreviewSummary): string {
  const url = new URL(publicBase);
  if (summary.source.kind === "local") {
    const source = new URL(summary.source.url);
    url.pathname = source.pathname;
    url.search = source.search;
    url.hash = source.hash;
  } else {
    url.pathname = `/${summary.source.entryPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }
  return url.toString();
}

function publicFailureMessage(error: unknown, provider: TunnelProvider, output = ""): string {
  const message = error instanceof Error ? error.message : String(error);
  if (provider === "cpolar") {
    const actionable = cpolarFailureMessage(output);
    if (actionable) return actionable;
    if (/not found|未找到/i.test(message)) return "未找到 Cpolar";
  } else if (/not found|未找到/i.test(message)) {
    return "未找到 Cloudflare Tunnel";
  }
  if (/cancelled/i.test(message)) return "预览创建已取消";
  return "无法创建临时预览链接";
}

interface LocatedTunnelProvider {
  capability: CloudflaredCapability | CpolarCapability;
  command?: string;
  env: NodeJS.ProcessEnv;
}

export class PreviewManager {
  readonly epoch = nanoid();
  private revision = 0;
  private readonly records = new Map<string, PreviewRecord>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly activeCreateReservations = new Set<symbol>();
  private readonly reconnectOperations = new Map<string, Promise<void>>();
  private readonly activeReconnectReservations = new Set<string>();
  private readonly locator: CloudflaredLocator;
  private readonly cpolarLocator: CpolarLocator;
  private readonly store: PreviewStore;
  private readonly onEvent?: (event: PreviewManagerEvent) => void;
  private readonly startGateway: typeof startPreviewGateway;
  private readonly startTunnel: typeof startCloudflaredQuickTunnel;
  private readonly startCpolarTunnel: typeof startCpolarQuickTunnel;
  private readonly now: () => number;
  private shuttingDown = false;

  constructor(private readonly options: PreviewManagerOptions) {
    this.locator = options.locator ?? new CloudflaredLocator();
    this.cpolarLocator = options.cpolarLocator ?? new CpolarLocator();
    this.store = options.store ?? new PreviewStore(options.persistPath);
    this.onEvent = options.onEvent;
    this.startGateway = options.startGateway ?? startPreviewGateway;
    this.startTunnel = options.startTunnel ?? startCloudflaredQuickTunnel;
    this.startCpolarTunnel = options.startCpolarTunnel ?? startCpolarQuickTunnel;
    this.now = options.now ?? Date.now;

    for (const definition of this.store.load()) {
      if (this.records.has(definition.previewId)) continue;
      this.records.set(definition.previewId, {
        summary: {
          previewId: definition.previewId,
          name: definition.name,
          source: { ...definition.source },
          tunnelProvider: definition.tunnelProvider,
          createdAt: definition.createdAt,
          updatedAt: definition.updatedAt,
          state: "disconnected",
        },
        operationId: definition.operationId,
        operationFingerprint: definition.operationFingerprint,
        generation: 0,
      });
    }
  }

  async inspectCapabilities(refreshPath = false): Promise<WebPreviewCapability> {
    const [cloudflared, cpolar] = await Promise.all([
      this.locator.inspect({ refreshPath }),
      this.cpolarLocator.inspect({ refreshPath }),
    ]);
    return {
      cloudflared: cloudflared.capability,
      cpolar: cpolar.capability,
    };
  }

  private locateProvider(
    provider: TunnelProvider,
    refreshPath = false,
  ): Promise<LocatedTunnelProvider> {
    return provider === "cloudflare"
      ? this.locator.inspect({ refreshPath })
      : this.cpolarLocator.inspect({ refreshPath });
  }

  inspectStatic(path: string): Promise<StaticPreviewInspection> {
    return inspectStaticPreviewPath(path);
  }

  list(): PreviewSnapshot {
    return {
      epoch: this.epoch,
      revision: this.revision,
      previews: Array.from(this.records.values())
        .map((record) => cloneSummary(record.summary))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  create(
    operationId: string,
    input: PreviewCreateInput,
    tunnelProvider: TunnelProvider,
    name?: string,
  ): Promise<PreviewSummary> {
    if (this.shuttingDown) return Promise.reject(new PreviewOperationError("Proxy 正在停止"));
    const customName = this.normalizeOptionalName(name);
    const operationFingerprint = fingerprintPreviewOperationParameters({
      source: input,
      tunnelProvider,
      name: customName ?? null,
    });
    const existing = Array.from(this.records.values()).find(
      (record) => record.operationId === operationId,
    );
    if (existing) {
      if (existing.operationFingerprint !== operationFingerprint) {
        throw new PreviewOperationJournalError(
          "operationId 已用于不同的预览操作",
          ControlErrorCode.OPERATION_CONFLICT,
        );
      }
      return Promise.resolve(cloneSummary(existing.summary));
    }
    this.assertCreateCapacity();
    const reservation = Symbol("preview-create");
    this.activeCreateReservations.add(reservation);
    return this.createOnce(operationId, operationFingerprint, input, tunnelProvider, customName)
      .finally(() => this.activeCreateReservations.delete(reservation))
      .then(cloneSummary);
  }

  private async createOnce(
    operationId: string,
    operationFingerprint: string,
    input: PreviewCreateInput,
    tunnelProvider: TunnelProvider,
    customName: string | undefined,
  ): Promise<PreviewSummary> {
    if (this.shuttingDown) throw new PreviewOperationError("Proxy 正在停止");
    const located = await this.locateProvider(tunnelProvider);
    if (!located.capability.available || !located.command) {
      throw new PreviewOperationError(
        located.capability.error ??
          (tunnelProvider === "cloudflare" ? "未找到 Cloudflare Tunnel" : "未找到 Cpolar"),
        ControlErrorCode.PROCESS_START_FAILED,
      );
    }

    let definition: PreviewDefinition;
    let localHost: "127.0.0.1" | "::1" | undefined;
    const now = this.now();
    const previewId = nanoid();
    if (input.kind === "local") {
      let normalized;
      try {
        normalized = normalizeLocalPreviewUrl(input.url);
        localHost = await probeLocalPreviewTarget(normalized);
      } catch (error) {
        throw new PreviewOperationError(
          error instanceof Error ? error.message : String(error),
          ControlErrorCode.PROCESS_START_FAILED,
        );
      }
      const url = new URL(normalized.sourceUrl);
      definition = {
        previewId,
        name: customName ?? `${url.hostname}${url.port ? `:${url.port}` : ""}`,
        source: { kind: "local", url: normalized.sourceUrl },
        tunnelProvider,
        createdAt: now,
        updatedAt: now,
      };
    } else {
      try {
        const resolved = await resolveStaticPreviewSource(input.path, input.entryPath);
        definition = {
          previewId,
          name: customName ?? resolved.name,
          source: resolved.source,
          tunnelProvider,
          createdAt: now,
          updatedAt: now,
        };
      } catch (error) {
        throw new PreviewOperationError(
          error instanceof Error ? error.message : String(error),
          ControlErrorCode.INVALID_PATH,
        );
      }
    }

    const record: PreviewRecord = {
      summary: { ...definition, state: "starting" },
      operationId,
      operationFingerprint,
      generation: 0,
    };
    if (this.shuttingDown) throw new PreviewOperationError("Proxy 正在停止");
    this.records.set(previewId, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(previewId);
      serviceLogger.error(
        { previewId, error: error instanceof Error ? error.message : String(error) },
        "Failed to persist a new web preview",
      );
      throw new PreviewOperationError("无法保存网页预览，请重试");
    }
    this.emitState(record.summary);
    this.scheduleStart(record, { localHost, command: located.command, env: located.env });
    return record.summary;
  }

  rename(previewId: string, name: string): PreviewSummary {
    if (this.shuttingDown) throw new PreviewOperationError("Proxy 正在停止");
    const record = this.records.get(previewId);
    if (!record) throw new PreviewOperationError("网页预览不存在");
    const normalized = this.normalizeRequiredName(name);
    if (record.summary.name === normalized) return cloneSummary(record.summary);

    const previous = record.summary;
    record.summary = { ...previous, name: normalized, updatedAt: this.now() };
    try {
      this.persist();
    } catch (error) {
      record.summary = previous;
      serviceLogger.error(
        { previewId, error: error instanceof Error ? error.message : String(error) },
        "Failed to persist web preview rename",
      );
      throw new PreviewOperationError("无法保存预览名称，请重试");
    }
    this.emitState(record.summary);
    return cloneSummary(record.summary);
  }

  async reconnect(previewId: string): Promise<void> {
    const inFlight = this.reconnectOperations.get(previewId);
    if (inFlight) return inFlight;
    if (this.shuttingDown) throw new PreviewOperationError("Proxy 正在停止");
    const record = this.records.get(previewId);
    if (!record) throw new PreviewOperationError("网页预览不存在");
    if (record.summary.state === "starting" || record.summary.state === "ready") return;
    if (record.summary.state === "stopping") {
      throw new PreviewOperationError("网页预览正在关闭");
    }
    if (record.runtime) {
      throw new PreviewOperationError("上一次连接尚未停止，请先关闭预览");
    }
    this.assertActiveCapacity();
    this.activeReconnectReservations.add(previewId);
    const operation = this.reconnectOnce(record).finally(() => {
      this.reconnectOperations.delete(previewId);
      this.activeReconnectReservations.delete(previewId);
    });
    this.reconnectOperations.set(previewId, operation);
    return operation;
  }

  private async reconnectOnce(record: PreviewRecord): Promise<void> {
    const tunnelProvider = record.summary.tunnelProvider;
    const located = await this.locateProvider(tunnelProvider);
    if (!located.capability.available || !located.command) {
      throw new PreviewOperationError(
        located.capability.error ??
          (tunnelProvider === "cloudflare" ? "未找到 Cloudflare Tunnel" : "未找到 Cpolar"),
        ControlErrorCode.PROCESS_START_FAILED,
      );
    }

    let localHost: "127.0.0.1" | "::1" | undefined;
    if (record.summary.source.kind === "local") {
      try {
        localHost = await probeLocalPreviewTarget(
          normalizeLocalPreviewUrl(record.summary.source.url),
        );
      } catch (error) {
        throw new PreviewOperationError(
          error instanceof Error ? error.message : String(error),
          ControlErrorCode.PROCESS_START_FAILED,
        );
      }
    }

    if (this.shuttingDown) throw new PreviewOperationError("Proxy 正在停止");
    const current = this.records.get(record.summary.previewId);
    if (current !== record || record.summary.state === "stopping") {
      throw new PreviewOperationError("网页预览正在关闭");
    }
    if (record.summary.state === "starting" || record.summary.state === "ready") return;
    this.transition(record, "starting");
    this.startInBackground(record, { localHost, command: located.command, env: located.env });
  }

  close(previewId: string): Promise<void> {
    const existingClose = this.closing.get(previewId);
    if (existingClose) return existingClose;
    const record = this.records.get(previewId);
    if (!record) return Promise.resolve();

    if (record.summary.state !== "stopping") {
      this.transition(record, "stopping");
    }
    const closing = this.finishClose(record).finally(() => this.closing.delete(previewId));
    this.closing.set(previewId, closing);
    return closing;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const stops: Promise<void>[] = [...this.closing.values()];
    for (const record of this.records.values()) {
      if (this.closing.has(record.summary.previewId)) continue;
      stops.push(this.shutdownRecord(record));
    }
    await Promise.allSettled(stops);
    this.persistBestEffort("shutdown");
  }

  private async shutdownRecord(record: PreviewRecord): Promise<void> {
    const runtime = record.runtime;
    if (runtime) {
      try {
        await this.stopRuntime(runtime);
        if (record.runtime === runtime) record.runtime = undefined;
      } catch (error) {
        if (this.records.get(record.summary.previewId) === record) {
          this.transition(record, "failed", { error: "无法关闭预览，请重试" });
        }
        serviceLogger.error(
          {
            previewId: record.summary.previewId,
            tunnelProvider: runtime.provider,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to stop a web preview runtime during shutdown",
        );
        return;
      }
    }
    if (
      this.records.get(record.summary.previewId) === record &&
      record.summary.state !== "disconnected"
    ) {
      this.transition(record, "disconnected");
    }
  }

  private startInBackground(
    record: PreviewRecord,
    located: {
      localHost?: "127.0.0.1" | "::1";
      command: string;
      env: NodeJS.ProcessEnv;
    },
  ): void {
    record.generation += 1;
    const runtime: PreviewRuntime = {
      generation: record.generation,
      provider: record.summary.tunnelProvider,
      localHost: located.localHost,
      expectedTunnelStop: false,
    };
    record.runtime = runtime;
    void this.runStart(record, runtime, located.command, located.env);
  }

  private scheduleStart(
    record: PreviewRecord,
    located: {
      localHost?: "127.0.0.1" | "::1";
      command: string;
      env: NodeJS.ProcessEnv;
    },
  ): void {
    setImmediate(() => {
      if (
        this.shuttingDown ||
        this.records.get(record.summary.previewId) !== record ||
        record.summary.state !== "starting"
      ) {
        return;
      }
      this.startInBackground(record, located);
    });
  }

  private async runStart(
    record: PreviewRecord,
    runtime: PreviewRuntime,
    tunnelCommand: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    try {
      const gateway = await this.startGateway({
        source: record.summary.source,
        localHost: runtime.localHost,
      });
      runtime.gateway = gateway;
      if (!this.isCurrentRuntime(record, runtime)) {
        await gateway.close();
        return;
      }

      const runtimeDir = join(
        this.options.runtimeRoot,
        `${record.summary.previewId}-${this.epoch}-${runtime.generation}`,
      );
      runtime.runtimeDir = runtimeDir;
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      if (!this.isStartingRuntime(record, runtime)) {
        await this.removeRuntimeDir(runtimeDir);
        return;
      }
      let tunnel: CloudflaredQuickTunnel | CpolarQuickTunnel;
      if (runtime.provider === "cloudflare") {
        const { configPath, pidFilePath } = await this.prepareCloudflareRuntime(runtimeDir);
        if (!this.isStartingRuntime(record, runtime)) {
          await this.removeRuntimeDir(runtimeDir);
          return;
        }
        tunnel = this.startTunnel({
          cloudflaredBin: tunnelCommand,
          originUrl: gateway.originUrl,
          configPath,
          pidFilePath,
          env,
        });
      } else {
        tunnel = this.startCpolarRuntimeTunnel(record, runtime, tunnelCommand, gateway, env);
      }
      runtime.tunnel = tunnel;
      tunnel.child.once("exit", (code, signal) => {
        if (runtime.expectedTunnelStop || !this.isCurrentRuntime(record, runtime)) return;
        void this.onUnexpectedTunnelExit(record, runtime, code, signal);
      });
      if (Number.isSafeInteger(tunnel.child.pid) && (tunnel.child.pid ?? 0) > 1) {
        const processIdentity =
          runtime.provider === "cpolar"
            ? await captureCpolarRuntimeProcessIdentity(tunnel.child.pid!)
            : null;
        if (runtime.provider === "cpolar" && !processIdentity) {
          throw new Error("Unable to verify the cpolar process identity");
        }
        await writeFile(
          join(runtimeDir, "runtime.json"),
          serializePreviewRuntimeMarker(
            tunnel.child.pid!,
            runtime.provider === "cpolar"
              ? { provider: "cpolar", ...processIdentity! }
              : { provider: "cloudflare" },
          ),
          { mode: 0o600 },
        );
      }

      if (!this.isStartingRuntime(record, runtime)) return;

      const publicBase = await tunnel.publicReady;
      const publicUrl = buildPreviewPublicUrl(publicBase, record.summary);
      if (!this.isCurrentRuntime(record, runtime) || record.summary.state !== "starting") return;
      this.transition(record, "ready", { publicUrl });
      serviceLogger.info(
        {
          previewId: record.summary.previewId,
          kind: record.summary.source.kind,
          tunnelProvider: runtime.provider,
        },
        "Web preview is ready",
      );
    } catch (error) {
      if (!this.isCurrentRuntime(record, runtime)) return;
      let stopFailed = false;
      try {
        await this.stopRuntime(runtime);
        record.runtime = undefined;
      } catch (stopError) {
        stopFailed = true;
        serviceLogger.error(
          {
            previewId: record.summary.previewId,
            tunnelProvider: runtime.provider,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          },
          "Failed to stop a web preview runtime after startup failure",
        );
      }
      if (record.summary.state === "starting") {
        this.transition(record, "failed", {
          error: stopFailed
            ? "内网穿透进程未能停止，请关闭预览后重试"
            : publicFailureMessage(error, runtime.provider, runtime.tunnel?.getOutput()),
        });
      }
      serviceLogger.warn(
        {
          previewId: record.summary.previewId,
          tunnelProvider: runtime.provider,
          error: error instanceof Error ? error.message : String(error),
        },
        "Web preview startup failed",
      );
    }
  }

  private async prepareCloudflareRuntime(
    runtimeDir: string,
  ): Promise<{ configPath: string; pidFilePath: string }> {
    const configPath = join(runtimeDir, "cloudflared.yml");
    const pidFilePath = join(runtimeDir, "cloudflared.pid");
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    return { configPath, pidFilePath };
  }

  private startCpolarRuntimeTunnel(
    record: PreviewRecord,
    runtime: PreviewRuntime,
    command: string,
    gateway: PreviewGateway,
    env: NodeJS.ProcessEnv,
  ): CpolarQuickTunnel {
    const tunnelName = `dev_anywhere_${record.summary.previewId}_${this.epoch}_${runtime.generation}`;
    return this.startCpolarTunnel({
      cpolarBin: command,
      originUrl: gateway.originUrl,
      tunnelName,
      env,
    });
  }

  private async onUnexpectedTunnelExit(
    record: PreviewRecord,
    runtime: PreviewRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    await runtime.gateway?.close().catch(() => undefined);
    await this.removeRuntimeDir(runtime.runtimeDir);
    if (!this.isCurrentRuntime(record, runtime)) return;
    record.runtime = undefined;
    if (record.summary.state === "starting" || record.summary.state === "ready") {
      this.transition(record, "failed", {
        error:
          runtime.provider === "cloudflare" ? "Cloudflare Tunnel 连接已停止" : "Cpolar 连接已停止",
      });
    }
    serviceLogger.warn(
      { previewId: record.summary.previewId, tunnelProvider: runtime.provider, code, signal },
      "Web preview tunnel exited unexpectedly",
    );
  }

  private async finishClose(record: PreviewRecord): Promise<void> {
    const runtime = record.runtime;
    if (runtime) {
      try {
        await this.stopRuntime(runtime);
        if (record.runtime === runtime) record.runtime = undefined;
      } catch {
        if (this.records.get(record.summary.previewId) === record) {
          this.transition(record, "failed", { error: "无法关闭预览，请重试" });
        }
        throw new PreviewOperationError("无法关闭预览，请重试");
      }
    }
    try {
      this.store.save(this.definitions(record.summary.previewId));
    } catch (error) {
      this.transition(record, "failed", { error: "关闭预览未完成，请重试" });
      serviceLogger.error(
        {
          previewId: record.summary.previewId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist web preview removal",
      );
      throw new PreviewOperationError("关闭预览未完成，请重试");
    }
    this.records.delete(record.summary.previewId);
    this.revision += 1;
    this.emitEvent({
      type: "removed",
      epoch: this.epoch,
      revision: this.revision,
      previewId: record.summary.previewId,
    });
    serviceLogger.info({ previewId: record.summary.previewId }, "Web preview closed");
  }

  private async stopRuntime(runtime: PreviewRuntime): Promise<void> {
    runtime.expectedTunnelStop = true;
    runtime.gateway?.deactivate();
    await runtime.tunnel?.stop();
    await runtime.gateway?.close();
    await this.removeRuntimeDir(runtime.runtimeDir);
  }

  private async removeRuntimeDir(runtimeDir: string | undefined): Promise<void> {
    if (!runtimeDir) return;
    try {
      await rm(runtimeDir, { recursive: true, force: true });
    } catch (error) {
      serviceLogger.warn(
        { runtimeDir, error: error instanceof Error ? error.message : String(error) },
        "Failed to remove web preview runtime directory",
      );
    }
  }

  private isCurrentRuntime(record: PreviewRecord, runtime: PreviewRuntime): boolean {
    return record.runtime === runtime && record.generation === runtime.generation;
  }

  private isStartingRuntime(record: PreviewRecord, runtime: PreviewRuntime): boolean {
    return this.isCurrentRuntime(record, runtime) && record.summary.state === "starting";
  }

  private assertActiveCapacity(): void {
    const activeCount = Array.from(this.records.values()).filter(
      (record) =>
        record.runtime !== undefined ||
        record.summary.state === "starting" ||
        record.summary.state === "ready" ||
        record.summary.state === "stopping",
    ).length;
    if (
      activeCount + this.activeCreateReservations.size + this.activeReconnectReservations.size >=
      MAX_ACTIVE_PREVIEWS
    ) {
      throw new PreviewOperationError(
        `最多同时开启 ${MAX_ACTIVE_PREVIEWS} 个网页预览，请先关闭一个`,
        ControlErrorCode.PROCESS_START_FAILED,
      );
    }
  }

  private assertCreateCapacity(): void {
    this.assertActiveCapacity();
    if (this.records.size + this.activeCreateReservations.size >= MAX_PERSISTED_PREVIEWS) {
      throw new PreviewOperationError(
        `最多保留 ${MAX_PERSISTED_PREVIEWS} 个网页预览，请先关闭一个`,
        ControlErrorCode.PROCESS_START_FAILED,
      );
    }
  }

  private normalizeOptionalName(name: string | undefined): string | undefined {
    try {
      return normalizeOptionalPreviewName(name);
    } catch (error) {
      throw new PreviewOperationError(error instanceof Error ? error.message : String(error));
    }
  }

  private normalizeRequiredName(name: string): string {
    try {
      return normalizeRequiredPreviewName(name);
    } catch (error) {
      throw new PreviewOperationError(error instanceof Error ? error.message : String(error));
    }
  }

  private transition(record: PreviewRecord, state: "starting" | "disconnected" | "stopping"): void;
  private transition(record: PreviewRecord, state: "ready", details: { publicUrl: string }): void;
  private transition(record: PreviewRecord, state: "failed", details: { error: string }): void;
  private transition(
    record: PreviewRecord,
    state: PreviewState,
    details?: { publicUrl: string } | { error: string },
  ): void {
    const from = record.summary.state;
    if (from !== state && !previewFsm.canTransition(from, state)) {
      throw new Error(`Invalid preview state transition: ${from} -> ${state}`);
    }
    const base = {
      previewId: record.summary.previewId,
      name: record.summary.name,
      source: record.summary.source,
      tunnelProvider: record.summary.tunnelProvider,
      createdAt: record.summary.createdAt,
    };
    if (state === "ready") {
      if (!details || !("publicUrl" in details)) {
        throw new Error("A ready web preview requires a public URL");
      }
      record.summary = { ...base, state, publicUrl: details.publicUrl, updatedAt: this.now() };
    } else if (state === "failed") {
      if (!details || !("error" in details)) {
        throw new Error("A failed web preview requires an error");
      }
      record.summary = { ...base, state, error: details.error, updatedAt: this.now() };
    } else {
      record.summary = { ...base, state, updatedAt: this.now() };
    }
    this.persistBestEffort(`transition:${from}->${state}`);
    this.emitState(record.summary);
  }

  private definitions(excludePreviewId?: string): PersistedPreviewDefinition[] {
    return Array.from(this.records.values())
      .filter((record) => record.summary.previewId !== excludePreviewId)
      .map((record) => ({
        previewId: record.summary.previewId,
        name: record.summary.name,
        source: { ...record.summary.source },
        tunnelProvider: record.summary.tunnelProvider,
        createdAt: record.summary.createdAt,
        updatedAt: record.summary.updatedAt,
        operationId: record.operationId,
        operationFingerprint: record.operationFingerprint,
      }));
  }

  private persist(): void {
    this.store.save(this.definitions());
  }

  private persistBestEffort(context: string): void {
    try {
      this.persist();
    } catch (error) {
      serviceLogger.error(
        { context, error: error instanceof Error ? error.message : String(error) },
        "Failed to persist web preview definitions",
      );
    }
  }

  private emitState(summary: PreviewSummary): void {
    this.revision += 1;
    this.emitEvent({
      type: "state",
      epoch: this.epoch,
      revision: this.revision,
      preview: cloneSummary(summary),
    });
  }

  private emitEvent(event: PreviewManagerEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      serviceLogger.error(
        { type: event.type, error: error instanceof Error ? error.message : String(error) },
        "Failed to publish web preview state",
      );
    }
  }
}
