import { createScrollTraceStore, round } from "./scroll-trace-store";

type PtyInputKind = "printable" | "enter" | "escape" | "control" | "paste" | "mixed";

interface PendingPtyInput {
  inputId: string;
  sessionId: string;
  data: string;
  kind: PtyInputKind;
  dataLength: number;
  startedAt: number;
  sentAt: number | null;
  firstOutputAt: number | null;
  echoMatchedAt: number | null;
  xtermWriteAt: number | null;
  paintAt: number | null;
}

export interface PtyInputLatencyTraceEntry {
  t: number;
  event: string;
  sessionId: string;
  inputId?: string;
  inputKind?: PtyInputKind;
  dataLength?: number;
  sent?: boolean;
  queueWhenDisconnected?: boolean;
  outputSeq?: number;
  bytes?: number;
  chunkCount?: number;
  pendingInputs?: number;
  deltaFromInputMs?: number | null;
  details?: string;
  repeat?: number;
}

interface StartedPtyInputTrace {
  inputId: string;
  sessionId: string;
}

declare global {
  interface Window {
    __devAnywherePtyInputLatencyTrace?: PtyInputLatencyTraceEntry[];
    __devAnywherePtyInputLatencyReport?: () => string;
  }
}

const TRACE_STORAGE_KEY = "dev_anywhere_pty_input_latency_trace";
const TRACE_URL_PARAM = "ptyInputTrace";
const MAX_PENDING_INPUTS_PER_SESSION = 80;
const PENDING_INPUT_TTL_MS = 10_000;
const decoder = new TextDecoder();

let inputSeq = 0;
const pendingBySession = new Map<string, PendingPtyInput[]>();

const store = createScrollTraceStore<PtyInputLatencyTraceEntry>({
  windowKey: "__devAnywherePtyInputLatencyTrace",
  urlParam: TRACE_URL_PARAM,
  storageKey: TRACE_STORAGE_KEY,
  dedupeKey: (entry) => {
    if (entry.event.startsWith("input")) return null;
    return `${entry.event}|${entry.sessionId}|${entry.outputSeq ?? ""}|${entry.pendingInputs ?? ""}`;
  },
});

export const isPtyInputLatencyTraceEnabled = store.isEnabled;

export function installPtyInputLatencyTrace(): void {
  if (typeof window === "undefined") return;
  window.__devAnywherePtyInputLatencyReport = formatPtyInputLatencyTraceReport;
}

export function beginPtyInputLatencyTrace(
  sessionId: string,
  data: string,
): StartedPtyInputTrace | null {
  if (!store.isEnabled()) return null;
  const inputId = `pty-in-${Date.now().toString(36)}-${++inputSeq}`;
  const now = performance.now();
  const pending: PendingPtyInput = {
    inputId,
    sessionId,
    data,
    kind: classifyPtyInput(data),
    dataLength: data.length,
    startedAt: now,
    sentAt: null,
    firstOutputAt: null,
    echoMatchedAt: null,
    xtermWriteAt: null,
    paintAt: null,
  };
  const sessionPending = pendingBySession.get(sessionId) ?? [];
  sessionPending.push(pending);
  prunePending(sessionPending, now);
  pendingBySession.set(sessionId, sessionPending);
  append({
    t: now,
    event: "input:start",
    sessionId,
    inputId,
    inputKind: pending.kind,
    dataLength: pending.dataLength,
    pendingInputs: sessionPending.length,
  });
  return { inputId, sessionId };
}

export function finishPtyInputLatencySend(
  trace: StartedPtyInputTrace | null,
  options: { sent: boolean; queueWhenDisconnected: boolean; details?: string },
): void {
  if (!trace || !store.isEnabled()) return;
  const now = performance.now();
  const pending = findPending(trace.sessionId, trace.inputId);
  if (pending) pending.sentAt = now;
  append({
    t: now,
    event: "input:ws-send",
    sessionId: trace.sessionId,
    inputId: trace.inputId,
    inputKind: pending?.kind,
    dataLength: pending?.dataLength,
    sent: options.sent,
    queueWhenDisconnected: options.queueWhenDisconnected,
    deltaFromInputMs: pending ? now - pending.startedAt : null,
    details: options.details,
  });
}

export function markPtyOutputReceived(
  sessionId: string,
  data: Uint8Array,
  outputSeq: number,
): void {
  if (!store.isEnabled()) return;
  const now = performance.now();
  const pending = pendingForSession(sessionId, now);
  const text = decodeUtf8(data);
  const firstOutputInputs: string[] = [];
  const echoMatchedInputs: string[] = [];
  for (const input of pending) {
    if (input.firstOutputAt === null) {
      input.firstOutputAt = now;
      firstOutputInputs.push(input.inputId);
    }
    if (input.echoMatchedAt === null && canMatchEcho(input) && text.includes(input.data)) {
      input.echoMatchedAt = now;
      echoMatchedInputs.push(input.inputId);
    }
  }
  append({
    t: now,
    event: "output:received",
    sessionId,
    outputSeq,
    bytes: data.byteLength,
    pendingInputs: pending.length,
    deltaFromInputMs: firstDelta(pending, now),
    details: detailList([
      firstOutputInputs.length > 0 ? `first=${firstOutputInputs.length}` : "",
      echoMatchedInputs.length > 0 ? `echo=${echoMatchedInputs.length}` : "",
    ]),
  });
}

export function markPtyOutputWritten(sessionId: string, bytes: number, chunkCount = 1): void {
  if (!store.isEnabled()) return;
  const now = performance.now();
  const pending = pendingForSession(sessionId, now);
  const newlyWritten: string[] = [];
  for (const input of pending) {
    if (input.xtermWriteAt === null) {
      input.xtermWriteAt = now;
      newlyWritten.push(input.inputId);
    }
  }
  append({
    t: now,
    event: "output:xterm-write",
    sessionId,
    bytes,
    chunkCount,
    pendingInputs: pending.length,
    deltaFromInputMs: firstDelta(pending, now),
    details: newlyWritten.length > 0 ? `firstWrite=${newlyWritten.length}` : "",
  });

  if (typeof requestAnimationFrame === "function" && newlyWritten.length > 0) {
    requestAnimationFrame(() => markPaintAfterWrite(sessionId, newlyWritten));
  }
}

export function formatPtyInputLatencyTraceReport(): string {
  const trace = store.getAll();
  const rows = trace.slice(-200);
  const pending = [...pendingBySession.values()].flat();
  const pendingLines = pending
    .slice(-80)
    .map((input) =>
      [
        input.inputId,
        input.sessionId,
        input.kind,
        input.dataLength,
        input.sentAt === null ? "" : round(input.sentAt - input.startedAt),
        input.firstOutputAt === null ? "" : round(input.firstOutputAt - input.startedAt),
        input.echoMatchedAt === null ? "" : round(input.echoMatchedAt - input.startedAt),
        input.xtermWriteAt === null ? "" : round(input.xtermWriteAt - input.startedAt),
        input.paintAt === null ? "" : round(input.paintAt - input.startedAt),
      ].join("\t"),
    );
  const eventLines = rows.map((entry) =>
    [
      round(entry.t),
      entry.repeat && entry.repeat > 0 ? `${entry.event} +${entry.repeat}` : entry.event,
      entry.sessionId,
      entry.inputId ?? "",
      entry.inputKind ?? "",
      entry.dataLength ?? "",
      entry.sent === undefined ? "" : entry.sent ? "sent" : "not-sent",
      entry.queueWhenDisconnected ? "queue-ok" : "",
      entry.outputSeq ?? "",
      entry.bytes ?? "",
      entry.chunkCount ?? "",
      entry.pendingInputs ?? "",
      entry.deltaFromInputMs === undefined || entry.deltaFromInputMs === null
        ? ""
        : round(entry.deltaFromInputMs),
      entry.details ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere PTY input latency trace",
    `events=${trace.length}, included=${rows.length}, pendingInputs=${pending.length}`,
    "pending input summary:",
    "inputId\tsessionId\tkind\tlen\twsSendMs\tfirstOutputMs\techoMatchMs\txtermWriteMs\tpaintMs",
    ...pendingLines,
    "events:",
    "t\tevent\tsessionId\tinputId\tkind\tlen\tsent\tqueue\toutputSeq\tbytes\tchunks\tpending\tdeltaMs\tdetails",
    ...eventLines,
  ].join("\n");
}

function append(entry: PtyInputLatencyTraceEntry): void {
  store.append(entry);
}

function pendingForSession(sessionId: string, now: number): PendingPtyInput[] {
  const pending = pendingBySession.get(sessionId) ?? [];
  prunePending(pending, now);
  pendingBySession.set(sessionId, pending);
  return pending;
}

function prunePending(pending: PendingPtyInput[], now: number): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const input = pending[i];
    const complete = input.paintAt !== null;
    const expired = now - input.startedAt > PENDING_INPUT_TTL_MS;
    if (complete || expired) pending.splice(i, 1);
  }
  if (pending.length > MAX_PENDING_INPUTS_PER_SESSION) {
    pending.splice(0, pending.length - MAX_PENDING_INPUTS_PER_SESSION);
  }
}

function findPending(sessionId: string, inputId: string): PendingPtyInput | null {
  return (pendingBySession.get(sessionId) ?? []).find((input) => input.inputId === inputId) ?? null;
}

function markPaintAfterWrite(sessionId: string, inputIds: string[]): void {
  if (!store.isEnabled()) return;
  const now = performance.now();
  const pending = pendingForSession(sessionId, now);
  let marked = 0;
  for (const inputId of inputIds) {
    const input = pending.find((item) => item.inputId === inputId);
    if (!input || input.paintAt !== null) continue;
    input.paintAt = now;
    marked += 1;
  }
  append({
    t: now,
    event: "output:paint",
    sessionId,
    pendingInputs: pending.length,
    deltaFromInputMs: firstDelta(pending, now),
    details: marked > 0 ? `paint=${marked}` : "",
  });
  prunePending(pending, now);
}

function firstDelta(pending: PendingPtyInput[], now: number): number | null {
  const first = pending[0];
  return first ? now - first.startedAt : null;
}

function classifyPtyInput(data: string): PtyInputKind {
  if (data === "\r" || data === "\n") return "enter";
  if (data.startsWith("\x1b")) return "escape";
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(data)) return "control";
  if (data.length > 16) return "paste";
  if (/[\r\n]/.test(data)) return "mixed";
  return "printable";
}

function canMatchEcho(input: PendingPtyInput): boolean {
  return input.kind === "printable" && input.data.length > 0 && input.data.length <= 16;
}

function decodeUtf8(data: Uint8Array): string {
  try {
    return decoder.decode(data);
  } catch {
    return "";
  }
}

function detailList(values: string[]): string {
  return values.filter(Boolean).join(" ");
}
