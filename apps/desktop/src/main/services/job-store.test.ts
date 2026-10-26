import type { FoundJob } from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingResetIntent } from "./job-finder/reset-intent-marker";

const { userData, pending } = vi.hoisted(() => ({
  userData: { dir: "" },
  pending: { value: { status: "none" } as PendingResetIntent },
}));

vi.mock("electron", () => ({ app: {} }));
vi.mock("../setup/user-data-directory", () => ({
  resolveDesktopUserDataDirectory: () => userData.dir,
}));
vi.mock("./job-finder/reset-intent-marker", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./job-finder/reset-intent-marker")
  >()),
  readPendingResetIntentSync: () => pending.value,
}));

import { closeJobStore, getJobStore } from "./job-store";
import { getJobFinderStartupResetRecoveryFact } from "./job-finder/reset-intent-marker";

function found(n: number): FoundJob {
  return {
    title: `Analyst ${n}`,
    company: `Company ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    postedAt: "2026-10-20T00:00:00.000Z",
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
  };
}

/** A store with one saved job, closed again so the next open reads the marker. */
function storeWithOneJob() {
  userData.dir = mkdtempSync(path.join(tmpdir(), "job-store-open-"));
  pending.value = { status: "none" };
  getJobStore().saveFoundJobs({ searchId: null, jobs: [found(1)] });
  closeJobStore();
}

afterEach(() => {
  closeJobStore();
  rmSync(userData.dir, { recursive: true, force: true });
});

describe("opening the job store after a reset stopped part way", () => {
  it("finishes a confirmed reset whose marker reads cleanly", () => {
    storeWithOneJob();
    pending.value = { status: "readable", intent: { token: "t", entries: [] } };

    expect(getJobStore().stageCounts().found).toBe(0);
  });

  it("keeps everything when the marker can't be read, and says the reset didn't finish", () => {
    storeWithOneJob();
    pending.value = { status: "unreadable" };

    expect(getJobStore().stageCounts().found).toBe(1);
    expect(getJobFinderStartupResetRecoveryFact()).toEqual({
      status: "degraded",
      reason: "marker_unreadable",
      quarantinedFileName: null,
    });
  });
});
