import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
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
/**
 * Calls `onLine(buffer, offset, lineNumber)` for every non-empty line, reading
 * the file in fixed chunks so a trace of any size is read with steady memory.
 * The buffer is only valid during the call.
 */
export function forEachLine(file, onLine, chunkSize = 8 << 20) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(chunkSize);
    let carry = [];
    let carryStart = 0;
    let lineNumber = 0;
    let position = 0;
    const emit = (line, offset) => {
      lineNumber++;
      if (line.length) onLine(line, offset, lineNumber);
    };
    while (position < size) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (!read) break;
      let start = 0;
      for (
        let newline = chunk.indexOf(10, 0);
        newline !== -1 && newline < read;
        newline = chunk.indexOf(10, start)
      ) {
        const part = chunk.subarray(start, newline);
        if (carry.length) {
          emit(Buffer.concat([...carry, part]), carryStart);
          carry = [];
        } else emit(part, position + start);
        start = newline + 1;
      }
      if (start < read) {
        if (!carry.length) carryStart = position + start;
        carry.push(Buffer.from(chunk.subarray(start, read)));
      }
      position += read;
    }
    if (carry.length) emit(Buffer.concat(carry), carryStart);
  } finally {
    closeSync(fd);
  }
}

/** Reads one recorded line back by its byte range. */
export function readLineAt(fd, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, offset + done);
    if (!read) break;
    done += read;
  }
  return buffer.subarray(0, done).toString("utf8");
}
