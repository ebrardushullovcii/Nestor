import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeExportFile } from "./write-export-file";

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("tracker export from chat", () => {
  it("writes to the folder and never replaces an earlier export", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tracker-export-"));
    const first = await writeExportFile({
      directory,
      fileName: "tracker.csv",
      content: "a",
    });
    const second = await writeExportFile({
      directory,
      fileName: "tracker.csv",
      content: "b",
    });
    expect(path.basename(first)).toBe("tracker.csv");
    expect(path.basename(second)).toBe("tracker (2).csv");
    expect(await readFile(first, "utf8")).toBe("a");
    expect(await readFile(second, "utf8")).toBe("b");
  });
});
