import { closeSync, openSync, readSync } from "node:fs";
import { endianness } from "node:os";

/** Read-only scheduling hint; SQLite still owns every lock and checkpoint. */
export function readWalCheckpointProgress(filePath: string): {
  generation: string;
  frames: number;
  backfilled: number;
  frameBytes: number;
} | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(`${filePath}-shm`, "r");
    const header = Buffer.allocUnsafe(100);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length)
      return null;
    // SQLite publishes two matching headers. A racing writer can leave them
    // different: defer the hint rather than guessing from an incomplete one.
    if (!header.subarray(0, 48).equals(header.subarray(48, 96))) return null;
    const little = endianness() === "LE";
    const integer = (offset: number) =>
      little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
    if (integer(0) !== 3007000 || header[12] !== 1) return null;
    const page = little ? header.readUInt16LE(14) : header.readUInt16BE(14);
    const frames = integer(16),
      backfilled = integer(96);
    if (backfilled > frames || !page) return null;
    // https://sqlite.org/walformat.html: mxFrame, nBackfill and aSalt.
    return {
      generation: header.subarray(32, 40).toString("hex"),
      frames,
      backfilled,
      frameBytes: (page === 1 ? 65536 : page) + 24,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        /* A scheduling hint cannot fail a committed write. */
      }
    }
  }
}
