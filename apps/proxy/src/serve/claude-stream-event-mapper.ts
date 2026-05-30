import { buildMessage, serializeControl, type MessageEnvelope } from "@dev-anywhere/shared";
import {
  ContentBlockDeltaSchema,
  KnownContentBlockSchema,
  type StreamJsonEvent,
} from "../common/stream-json-schema.js";

type MappedClaudeStreamEvent =
  | { kind: "envelope"; envelope: MessageEnvelope }
  | { kind: "control"; raw: string; notifyTurnResult: boolean }
  | { kind: "unknown_assistant_block"; blockType: string };

interface MapClaudeStreamEventOptions {
  event: StreamJsonEvent;
  isStreamDeltaSession: boolean;
  isCompactingSession: boolean;
}

export function mapClaudeStreamEvent(
  sessionId: string,
  seq: number,
  options: MapClaudeStreamEventOptions,
): MappedClaudeStreamEvent[] {
  const { event, isStreamDeltaSession, isCompactingSession } = options;

  if (event.type === "stream_event") {
    const delta = ContentBlockDeltaSchema.safeParse(event.event);
    if (!delta.success) return [];
    const d = delta.data.delta;
    if (d.type === "text_delta" && d.text) {
      return [
        {
          kind: "envelope",
          envelope: buildMessage(
            "assistant_message",
            sessionId,
            seq,
            { text: d.text, isPartial: true },
            "proxy",
          ),
        },
      ];
    }
    if (d.type === "thinking_delta" && d.thinking) {
      return [
        {
          kind: "envelope",
          envelope: buildMessage("thinking", sessionId, seq, { text: d.thinking }, "proxy"),
        },
      ];
    }
    return [];
  }

  if (event.type === "assistant") {
    const mapped: MappedClaudeStreamEvent[] = [];
    let forwardedContent = false;
    for (const raw of event.message.content) {
      const blockParse = KnownContentBlockSchema.safeParse(raw);
      if (!blockParse.success) {
        const blockType =
          raw && typeof raw === "object"
            ? ((raw as Record<string, unknown>).type as string | undefined)
            : undefined;
        mapped.push({ kind: "unknown_assistant_block", blockType: blockType ?? "<missing>" });
        continue;
      }
      const block = blockParse.data;
      if (block.type === "text") {
        if (!isStreamDeltaSession && block.text) {
          forwardedContent = true;
          mapped.push({
            kind: "envelope",
            envelope: buildMessage(
              "assistant_message",
              sessionId,
              seq,
              { text: block.text, isPartial: true },
              "proxy",
            ),
          });
        }
      } else if (block.type === "thinking") {
        if (!isStreamDeltaSession && block.thinking) {
          forwardedContent = true;
          mapped.push({
            kind: "envelope",
            envelope: buildMessage("thinking", sessionId, seq, { text: block.thinking }, "proxy"),
          });
        }
      } else if (block.type === "tool_use") {
        forwardedContent = true;
        mapped.push({
          kind: "envelope",
          envelope: buildMessage(
            "assistant_tool_use",
            sessionId,
            seq,
            { toolName: block.name, toolId: block.id, parameters: block.input },
            "proxy",
          ),
        });
      }
    }
    if (forwardedContent && isCompactingSession) {
      mapped.push({
        kind: "control",
        raw: serializeControl({
          type: "turn_result",
          sessionId,
          success: true,
          isError: false,
        }),
        notifyTurnResult: true,
      });
    }
    return mapped;
  }

  if (event.type === "user") {
    if (typeof event.message.content === "string") return [];
    return event.message.content.flatMap((raw): MappedClaudeStreamEvent[] => {
      const blockParse = KnownContentBlockSchema.safeParse(raw);
      if (!blockParse.success) return [];
      const block = blockParse.data;
      if (block.type !== "tool_result") return [];
      return [
        {
          kind: "envelope",
          envelope: buildMessage(
            "tool_result",
            sessionId,
            seq,
            { toolId: block.tool_use_id, result: block.content, isError: block.is_error ?? false },
            "proxy",
          ),
        },
      ];
    });
  }

  if (event.type === "result") {
    const resultText = typeof event.result === "string" ? event.result : undefined;
    return [
      {
        kind: "control",
        raw: serializeControl({
          type: "turn_result",
          sessionId,
          success: event.subtype === "success",
          isError: event.is_error ?? false,
          ...(resultText ? { result: resultText } : {}),
        }),
        notifyTurnResult: true,
      },
    ];
  }

  return [];
}
