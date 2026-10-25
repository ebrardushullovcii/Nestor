import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeCleanCloseMarker,
  readCleanCloseFingerprint,
  writeCleanCloseMarker,
} from "./clean-close-marker";

const directories: string[] = [];

function databaseFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "clean-close-"));
  directories.push(directory);
  const file = path.join(directory, "workspace.sqlite");
  writeFileSync(file, Buffer.alloc(8192, 7));
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("clean close marker", () => {
  it("vouches for the file exactly as the clean close left it, once", () => {
    const file = databaseFile();
    writeCleanCloseMarker(file);

    expect(readCleanCloseFingerprint(file)).not.toBeNull();
    expect(consumeCleanCloseMarker(file)).toBe(true);
    // One start only.
    expect(consumeCleanCloseMarker(file)).toBe(false);
    expect(existsSync(`${file}.clean-close`)).toBe(false);
  });

  it("does not vouch for a file changed after the close", () => {
    const file = databaseFile();
    writeCleanCloseMarker(file);
    appendFileSync(file, Buffer.alloc(16, 1));

    expect(readCleanCloseFingerprint(file)).toBeNull();
    expect(consumeCleanCloseMarker(file)).toBe(false);
  });

  it("does not vouch while a write-ahead log is left over", () => {
    const file = databaseFile();
    writeCleanCloseMarker(file);
    writeFileSync(`${file}-wal`, "pending");

    expect(consumeCleanCloseMarker(file)).toBe(false);
  });

  it("writes nothing when the log was not folded back", () => {
    const file = databaseFile();
    writeFileSync(`${file}-wal`, "pending");
    writeCleanCloseMarker(file);

    expect(existsSync(`${file}.clean-close`)).toBe(false);
  });
});
