// 将 CCAE events.bin 转为浏览器可消费的 JSON fixture
// 用法: tsx apps/web/scripts/convert-fixture.ts <input.bin> <output.json>
import { EventStore, EventType } from "../../proxy/src/event-store.js";
import { writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: tsx convert-fixture.ts <input.bin> <output.json>");
  process.exit(1);
}

const events = EventStore.readEventsFromFile(input);

type Chunk =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "meta"; cols: number; rows: number }
  | { type: "snapshot"; cols: number; rows: number; data: string };

const chunks: Chunk[] = [];

for (const event of events) {
  if (event.type === EventType.METADATA) {
    const meta = JSON.parse(event.payload.toString("utf-8"));
    chunks.push({ type: "meta", cols: meta.cols, rows: meta.rows });
  } else if (event.type === EventType.PTY_DATA) {
    chunks.push({ type: "data", data: event.payload.toString("base64") });
  } else if (event.type === EventType.RESIZE) {
    chunks.push({
      type: "resize",
      cols: event.payload.readUInt16LE(0),
      rows: event.payload.readUInt16LE(2),
    });
  } else if (event.type === EventType.SNAPSHOT) {
    const cols = event.payload.readUInt16LE(0);
    const rows = event.payload.readUInt16LE(2);
    const data = event.payload.subarray(4).toString("utf-8");
    chunks.push({ type: "snapshot", cols, rows, data });
  }
}

writeFileSync(output, JSON.stringify(chunks));
console.log(`Converted ${events.length} events → ${chunks.length} chunks → ${output}`);
