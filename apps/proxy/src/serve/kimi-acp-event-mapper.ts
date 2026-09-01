import {
  buildMessage,
  serializeControl,
  type CommandEntry,
  type MessageEnvelope,
} from "@dev-anywhere/shared";

type MappedKimiAcpEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "envelope"; envelope: MessageEnvelope }
  | {
      kind: "control";
      raw: string;
      notifyTurnResult: boolean;
      completeAssistant?: boolean;
      providerCommands?: CommandEntry[];
    }
  | { kind: "unknown_update"; updateType: string };

interface KimiToolState {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: unknown[];
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

const KNOWN_IGNORED_UPDATES = new Set([
  "config_option_update",
  "current_mode_update",
  "plan",
  "plan_removed",
  "plan_update",
  "session_info_update",
  "usage_update",
  // Live prompt input is already echoed by RelayInputHandlers. ACP may echo it back too.
  "user_message_chunk",
]);
const COMPLETED_TOOL_ID_LIMIT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function contentText(content: unknown): string {
  if (!isRecord(content) || content.type !== "text") return "";
  return typeof content.text === "string" ? content.text : "";
}

function toolName(tool: KimiToolState): string {
  if (tool.name) return tool.name;
  switch (tool.kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Search";
    case "execute":
      return "Bash";
    case "think":
      return "Think";
    case "fetch":
      return "Fetch";
    case "switch_mode":
      return "SwitchMode";
    default:
      return tool.title || "Kimi Tool";
  }
}

function toolParameters(tool: KimiToolState): Record<string, unknown> {
  const parameters: Record<string, unknown> = isRecord(tool.rawInput)
    ? { ...tool.rawInput }
    : tool.rawInput === undefined
      ? {}
      : { input: tool.rawInput };
  if (tool.title && !hasOwn(parameters, "title")) parameters.title = tool.title;
  if (tool.kind && !hasOwn(parameters, "kind")) parameters.kind = tool.kind;
  if (tool.locations?.length && !hasOwn(parameters, "locations")) {
    parameters.locations = tool.locations;
  }
  return parameters;
}

function toolResult(tool: KimiToolState): unknown {
  if (tool.rawOutput !== undefined) return tool.rawOutput;
  if (tool.content !== undefined) return tool.content;
  return tool.status ?? "completed";
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function mergeToolState(
  previous: KimiToolState | undefined,
  update: Record<string, unknown>,
): KimiToolState | null {
  const toolCallId =
    typeof update.toolCallId === "string" ? update.toolCallId : previous?.toolCallId;
  if (!toolCallId) return null;
  const next: KimiToolState = previous ? { ...previous } : { toolCallId };
  const stringFields = ["name", "title", "kind", "status"] as const;
  for (const field of stringFields) {
    if (!hasOwn(update, field)) continue;
    const value = update[field];
    if (typeof value === "string" && value) next[field] = value;
    else delete next[field];
  }
  const arrayFields = ["content", "locations"] as const;
  for (const field of arrayFields) {
    if (!hasOwn(update, field)) continue;
    const value = update[field];
    if (Array.isArray(value)) next[field] = value;
    else delete next[field];
  }
  for (const field of ["rawInput", "rawOutput"] as const) {
    if (!hasOwn(update, field)) continue;
    const value = update[field];
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  return next;
}

function eventParams(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.params) ? event.params : {};
}

function promptErrorMessage(params: Record<string, unknown>): string {
  if (typeof params.message === "string" && params.message.trim()) return params.message;
  if (isRecord(params.error) && typeof params.error.message === "string") {
    return params.error.message;
  }
  return "Kimi ACP prompt failed";
}

function availableCommands(update: Record<string, unknown>): CommandEntry[] {
  if (!Array.isArray(update.availableCommands)) return [];
  return update.availableCommands.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== "string") return [];
    const rawName = candidate.name.trim();
    if (!rawName) return [];
    const input = isRecord(candidate.input) ? candidate.input : null;
    const argumentHint = input && typeof input.hint === "string" ? input.hint : undefined;
    return [
      {
        name: rawName.startsWith("/") ? rawName : `/${rawName}`,
        description: typeof candidate.description === "string" ? candidate.description : "",
        ...(argumentHint ? { argumentHint } : {}),
        source: "kimi",
      },
    ];
  });
}

/** Maps Kimi's ACP notifications into the existing JSON-chat wire protocol. */
export class KimiAcpEventMapper {
  private readonly toolsBySession = new Map<string, Map<string, KimiToolState>>();
  private readonly completedToolIdsBySession = new Map<string, Set<string>>();

  clearSession(sessionId: string): void {
    this.toolsBySession.delete(sessionId);
    this.completedToolIdsBySession.delete(sessionId);
  }

  clear(): void {
    this.toolsBySession.clear();
    this.completedToolIdsBySession.clear();
  }

  finishTurn(sessionId: string): void {
    this.toolsBySession.delete(sessionId);
  }

  map(sessionId: string, seq: number, event: Record<string, unknown>): MappedKimiAcpEvent[] {
    const method = typeof event.method === "string" ? event.method : "";
    const params = eventParams(event);

    if (method === "session/prompt/result") {
      this.finishTurn(sessionId);
      const response = isRecord(params.response) ? params.response : params;
      const stopReason = typeof response.stopReason === "string" ? response.stopReason : "unknown";
      const success = stopReason === "end_turn";
      return [
        {
          kind: "control",
          raw: serializeControl({
            type: "turn_result",
            sessionId,
            success,
            isError: !success,
            ...(!success ? { result: `Kimi ACP stopped: ${stopReason}` } : {}),
          }),
          notifyTurnResult: true,
        },
      ];
    }

    if (method === "session/prompt/error") {
      this.finishTurn(sessionId);
      const message = promptErrorMessage(params);
      return [
        {
          kind: "control",
          raw: serializeControl({
            type: "turn_result",
            sessionId,
            success: false,
            isError: true,
            result: message,
          }),
          notifyTurnResult: true,
        },
      ];
    }

    if (method !== "session/update") return [];
    const update = isRecord(params.update) ? params.update : null;
    if (!update) return [];
    const updateType = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (updateType === "agent_message_chunk") {
      const text = contentText(update.content);
      return text ? [{ kind: "assistant_text", text }] : [];
    }

    if (updateType === "agent_thought_chunk") {
      const text = contentText(update.content);
      return text
        ? [
            {
              kind: "envelope",
              envelope: buildMessage("thinking", sessionId, seq, { text }, "proxy"),
            },
          ]
        : [];
    }

    if (updateType === "tool_call" || updateType === "tool_call_update") {
      return this.mapToolUpdate(sessionId, seq, update, updateType === "tool_call");
    }

    if (updateType === "available_commands_update") {
      const commands = availableCommands(update);
      return [
        {
          kind: "control",
          raw: serializeControl({
            type: "command_list_push",
            sessionId,
            commands,
          }),
          notifyTurnResult: false,
          completeAssistant: false,
          providerCommands: commands,
        },
      ];
    }

    if (KNOWN_IGNORED_UPDATES.has(updateType)) return [];
    return [{ kind: "unknown_update", updateType: updateType || "<missing>" }];
  }

  private mapToolUpdate(
    sessionId: string,
    seq: number,
    update: Record<string, unknown>,
    isInitial: boolean,
  ): MappedKimiAcpEvent[] {
    const sessionTools = this.toolsBySession.get(sessionId) ?? new Map<string, KimiToolState>();
    this.toolsBySession.set(sessionId, sessionTools);
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!toolCallId) return [];
    const completedToolIds = this.completedToolIdsBySession.get(sessionId) ?? new Set<string>();
    this.completedToolIdsBySession.set(sessionId, completedToolIds);
    if (completedToolIds.has(toolCallId)) return [];
    const previous = sessionTools.get(toolCallId);
    const tool = mergeToolState(previous, update);
    if (!tool) return [];
    sessionTools.set(toolCallId, tool);

    const mapped: MappedKimiAcpEvent[] = [];
    const hasPresentationUpdate = ["name", "title", "kind", "rawInput", "locations"].some((field) =>
      hasOwn(update, field),
    );
    if (isInitial || !previous || hasPresentationUpdate) {
      mapped.push({
        kind: "envelope",
        envelope: buildMessage(
          "assistant_tool_use",
          sessionId,
          seq,
          {
            toolName: toolName(tool),
            toolId: tool.toolCallId,
            parameters: toolParameters(tool),
          },
          "proxy",
        ),
      });
    }

    const terminal = tool.status === "completed" || tool.status === "failed";
    const previousTerminal = previous?.status === "completed" || previous?.status === "failed";
    const terminalResultChanged =
      previousTerminal &&
      (hasOwn(update, "rawOutput") || hasOwn(update, "content")) &&
      !sameJsonValue(toolResult(previous), toolResult(tool));
    if (
      terminal &&
      (!previousTerminal || previous?.status !== tool.status || terminalResultChanged)
    ) {
      mapped.push({
        kind: "envelope",
        envelope: buildMessage(
          "tool_result",
          sessionId,
          seq,
          {
            toolId: tool.toolCallId,
            result: toolResult(tool),
            isError: tool.status === "failed",
          },
          "proxy",
        ),
      });
      // Terminal payloads can be large. Retain only a bounded id tombstone for deduplication.
      sessionTools.delete(toolCallId);
      completedToolIds.add(toolCallId);
      if (completedToolIds.size > COMPLETED_TOOL_ID_LIMIT) {
        const oldest = completedToolIds.values().next().value;
        if (oldest !== undefined) completedToolIds.delete(oldest);
      }
    }
    return mapped;
  }
}
