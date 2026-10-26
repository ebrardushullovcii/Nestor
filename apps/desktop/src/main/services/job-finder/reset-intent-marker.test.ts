import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { root } = vi.hoisted(() => ({ root: { dir: "" } }));

vi.mock("./paths", () => ({
  getJobFinderUserDataDirectory: () => root.dir,
  getJobFinderResetIntentFilePath: () =>
    path.join(root.dir, "job-finder-reset-intent.json"),
  getJobFinderDocumentsDirectory: () => path.join(root.dir, "documents"),
  getCandidateAssetsDirectory: () =>
    path.join(root.dir, "documents", "candidate-assets"),
  getApplicationDocumentsDirectory: () =>
    path.join(root.dir, "documents", "application-documents"),
  getBrowserAgentProfileDirectory: () => path.join(root.dir, "browser-agent"),
  resolveJobFinderWorkspaceRelativePath: (relative: string) =>
    path.join(root.dir, ...relative.split("/")),
}));

import {
  listResetSourceRelativePaths,
  readPendingResetIntentSync,
} from "./reset-intent-marker";

const marker = () => path.join(root.dir, "job-finder-reset-intent.json");

beforeEach(() => {
  root.dir = mkdtempSync(path.join(tmpdir(), "reset-intent-marker-"));
});
afterEach(() => {
  rmSync(root.dir, { recursive: true, force: true });
});

describe("readPendingResetIntentSync", () => {
  it("finds nothing when no reset is pending", () => {
    expect(readPendingResetIntentSync()).toEqual({ status: "none" });
  });

  it("reads the marker a confirmed reset writes", () => {
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const entries = listResetSourceRelativePaths().map((sourcePath) => ({
      sourcePath,
      trashPath: `trash/job-finder-reset-${token}/${sourcePath}`,
    }));
    writeFileSync(
      marker(),
      JSON.stringify({
        version: 1,
        token,
        createdAt: "2026-10-26T06:00:00.000Z",
        entries,
      }),
    );
    expect(readPendingResetIntentSync()).toEqual({
      status: "readable",
      intent: { token, entries },
    });
  });

  it.each([
    ["cut short", '{"version":1,"token":"aaaaaaaa-bb'],
    [
      "missing its entries",
      '{"version":1,"token":"aaaaaaaa-bbbb","entries":[]}',
    ],
    ["too large to be one", " ".repeat(64 * 1024 + 1)],
  ])("treats a marker %s as unreadable", (_name, text) => {
    writeFileSync(marker(), text);
    expect(readPendingResetIntentSync()).toEqual({ status: "unreadable" });
  });
});
