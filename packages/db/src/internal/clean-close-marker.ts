import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

/**
 * A fingerprint of the closed database file: its size, its modification time
 * and the header page, which SQLite rewrites on every checkpointed commit.
 */
function fingerprint(filePath: string): string | null {
  try {
    const { size, mtimeMs } = statSync(filePath);
    const header = Buffer.alloc(4096);
    const descriptor = openSync(filePath, "r");
    try {
      readSync(descriptor, header, 0, header.length, 0);
    } finally {
      closeSync(descriptor);
    }
    return `${size}:${mtimeMs}:${createHash("sha1").update(header).digest("hex")}`;
  } catch {
    return null;
  }
}

function markerPath(filePath: string): string {
  return `${filePath}.clean-close`;
}

/**
 * Written after the database closed cleanly: its write-ahead log was folded
 * back and nothing can change the file until the next open.
 */
export function writeCleanCloseMarker(filePath: string): void {
  const print = fingerprint(filePath);
  if (!print || existsSync(`${filePath}-wal`)) return;
  try {
    writeFileSync(markerPath(filePath), print, "utf8");
  } catch {
    // Without the marker the next start runs the full integrity check.
  }
}

/**
 * The fingerprint a clean close recorded, when the database is still
 * byte-for-byte that file: no crash, no leftover write-ahead log and no
 * outside edit since. Null otherwise. Reading leaves the marker in place.
 */
export function readCleanCloseFingerprint(filePath: string): string | null {
  const path = markerPath(filePath);
  if (!existsSync(path) || existsSync(`${filePath}-wal`)) return null;
  let recorded: string;
  try {
    recorded = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return recorded !== "" && recorded === fingerprint(filePath)
    ? recorded
    : null;
}

/**
 * True when the database is exactly the file a clean close left. The marker
 * is removed either way, so it vouches for exactly one start.
 */
export function consumeCleanCloseMarker(filePath: string): boolean {
  const vouched = readCleanCloseFingerprint(filePath) !== null;
  rmSync(markerPath(filePath), { force: true });
  return vouched;
}
