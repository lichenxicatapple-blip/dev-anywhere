#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessionId = `json-chaos-${Date.now()}`;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assistantText(text) {
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

function result(text) {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
  });
}

emit({ type: "system", session_id: sessionId });

for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }

  if (msg.type === "control_response") {
    const response = msg.response?.response;
    const behavior = response?.behavior === "allow" ? "allow" : "deny";
    assistantText(`JSON chaos approval: ${behavior}`);
    result(`approval ${behavior}`);
    continue;
  }

  if (msg.type !== "user") continue;
  const content = String(msg.message?.content ?? "");
  if (/approval/i.test(content)) {
    emit({
      type: "control_request",
      request_id: `json-chaos-request-${Date.now()}`,
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "json-chaos.txt", content: "chaos" },
      },
    });
    continue;
  }

  assistantText(`JSON chaos reply: ${content}`);
  result("ok");
}
