import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { traceSafe } from "../../../core/src/trace-redaction.mjs";
export { traceSafe };
let seq = 0;
export function record(event, detail) {
  const dir = process.env.NESTOR_RUN_TRACE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      path.join(dir, `events-driver-${process.pid}.jsonl`),
      JSON.stringify(
        traceSafe({
          ...detail,
          event,
          at: new Date().toISOString(),
          pid: process.pid,
          seq: ++seq,
        }),
      ) + "\n",
      { mode: 0o600 },
    );
  } catch {
    console.warn("[run-trace] Driver event could not be written.");
  }
}
export function readEvents(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          event: "trace_read_error",
          file: path.basename(file),
          line: i + 1,
        };
      }
    });
}
