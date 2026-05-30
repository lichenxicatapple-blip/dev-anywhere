import { buildMessage, serializeControl, type MessageEnvelope } from "@dev-anywhere/shared";

interface CodexFileChange {
  path: string;
  kind: string;
  diff: string;
  move_path?: string;
}

type MappedCodexAppServerEvent =
  | { kind: "envelope"; envelope: MessageEnvelope }
  | { kind: "control"; raw: string; notifyTurnResult: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function codexPatchKind(kind: unknown): { kind: string; movePath?: string } {
  if (typeof kind === "string") return { kind };
  if (!kind || typeof kind !== "object") return { kind: "unknown" };
  const record = kind as Record<string, unknown>;
  const kindType = typeof record.type === "string" ? record.type : "unknown";
  const movePath = typeof record.move_path === "string" ? record.move_path : undefined;
  return { kind: kindType, movePath };
}

function codexPatchParameters(item: Record<string, unknown>): Record<string, unknown> {
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const changes: CodexFileChange[] = rawChanges.flatMap((rawChange) => {
    if (!rawChange || typeof rawChange !== "object") return [];
    const change = rawChange as Record<string, unknown>;
    const path = typeof change.path === "string" ? change.path : "";
    const diff = typeof change.diff === "string" ? change.diff : "";
    if (!path && !diff) return [];
    const { kind, movePath } = codexPatchKind(change.kind);
    return [
      {
        path,
        kind,
        diff,
        ...(movePath ? { move_path: movePath } : {}),
      },
    ];
  });
  const paths = changes.map((change) => change.path).filter(Boolean);
  return {
    file_path: paths[0] ?? "",
    paths,
    changes,
    content: changes
      .map((change) => change.diff)
      .filter(Boolean)
      .join("\n"),
    status: typeof item.status === "string" ? item.status : undefined,
  };
}

export function mapCodexAppServerEvent(
  sessionId: string,
  seq: number,
  event: Record<string, unknown>,
): MappedCodexAppServerEvent[] {
  const method = typeof event.method === "string" ? event.method : "";
  const params = isRecord(event.params) ? event.params : {};

  if (method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!delta) return [];
    return [
      {
        kind: "envelope",
        envelope: buildMessage(
          "assistant_message",
          sessionId,
          seq,
          { text: delta, isPartial: true },
          "proxy",
        ),
      },
    ];
  }

  const item = isRecord(params.item) ? params.item : null;

  if ((method === "item/started" || method === "item/completed") && item?.type === "fileChange") {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return [];
    const status = typeof item.status === "string" ? item.status : "";
    const mapped: MappedCodexAppServerEvent[] = [
      {
        kind: "envelope",
        envelope: buildMessage(
          "assistant_tool_use",
          sessionId,
          seq,
          { toolName: "Patch", toolId: id, parameters: codexPatchParameters(item) },
          "proxy",
        ),
      },
    ];
    if (method === "item/completed") {
      mapped.push({
        kind: "envelope",
        envelope: buildMessage(
          "tool_result",
          sessionId,
          seq,
          { toolId: id, result: status || "completed", isError: status === "failed" },
          "proxy",
        ),
      });
    }
    return mapped;
  }

  if (method === "item/started" && item?.type === "commandExecution") {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return [];
    const command = typeof item.command === "string" ? item.command : "";
    const cwd = typeof item.cwd === "string" ? item.cwd : "";
    return [
      {
        kind: "envelope",
        envelope: buildMessage(
          "assistant_tool_use",
          sessionId,
          seq,
          { toolName: "Bash", toolId: id, parameters: { command, cwd } },
          "proxy",
        ),
      },
    ];
  }

  if (method === "item/completed" && item?.type === "commandExecution") {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return [];
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    return [
      {
        kind: "envelope",
        envelope: buildMessage(
          "tool_result",
          sessionId,
          seq,
          { toolId: id, result: output, isError: exitCode !== null && exitCode !== 0 },
          "proxy",
        ),
      },
    ];
  }

  if (method === "turn/completed") {
    const turn = isRecord(params.turn) ? params.turn : {};
    const status = turn.status;
    const error = turn.error;
    const success = status === "completed";
    return [
      {
        kind: "control",
        raw: serializeControl({
          type: "turn_result",
          sessionId,
          success,
          isError: !success,
          ...(error ? { result: String(error) } : {}),
        }),
        notifyTurnResult: true,
      },
    ];
  }

  return [];
}
