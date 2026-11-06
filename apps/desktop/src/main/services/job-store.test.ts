import type { FoundJob } from "@nestor/contracts";
import {
  CandidateProfileSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";
import { createProfileStore } from "@nestor/db/job-store";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as JobStoreModule from "@nestor/db/job-store";
import type * as ResetIntentMarker from "./job-finder/reset-intent-marker";
import type { PendingResetIntent } from "./job-finder/reset-intent-marker";

const { userData, pending, failReset } = vi.hoisted(() => ({
  userData: { dir: "" },
  pending: { value: { status: "none" } as PendingResetIntent },
  failReset: { next: false },
}));

vi.mock("electron", () => ({ app: {} }));
vi.mock("@nestor/db/job-store", async (importOriginal) => {
  const actual = await importOriginal<typeof JobStoreModule>();
  return {
    ...actual,
    resetJobStore: (store: Parameters<typeof actual.resetJobStore>[0]) => {
      if (failReset.next) {
        failReset.next = false;
        throw new Error("database is locked");
      }
      actual.resetJobStore(store);
    },
  };
});
vi.mock("../setup/user-data-directory", () => ({
  resolveDesktopUserDataDirectory: () => userData.dir,
}));
vi.mock("./job-finder/reset-intent-marker", async (importOriginal) => ({
  ...(await importOriginal<typeof ResetIntentMarker>()),
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

  it("keeps nothing open when finishing the reset fails, and tries again next time", () => {
    storeWithOneJob();
    pending.value = { status: "readable", intent: { token: "t", entries: [] } };
    failReset.next = true;

    expect(() => getJobStore()).toThrow("database is locked");
    expect(getJobStore().stageCounts().found).toBe(0);
  });
});

it("imports the retained workspace beside the selected store before the first screen reads Profile", () => {
  userData.dir = mkdtempSync(path.join(tmpdir(), "job-store-import-"));
  pending.value = { status: "none" };
  const legacy = new DatabaseSync(
    path.join(userData.dir, "job-finder-workspace.sqlite"),
  );
  legacy.exec(
    "CREATE TABLE singleton_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  legacy.prepare("INSERT INTO singleton_state VALUES('profile',?)").run(
    JSON.stringify(
      CandidateProfileSchema.parse({
        ...createFreshStartCandidateProfile(),
        fullName: "Synthetic Candidate",
      }),
    ),
  );
  legacy.close();
  expect(createProfileStore(getJobStore()).read().fullName).toBe(
    "Synthetic Candidate",
  );
  closeJobStore();
  expect(createProfileStore(getJobStore()).read().fullName).toBe(
    "Synthetic Candidate",
  );
});

it("does not import retained data while a confirmed reset is recovering", () => {
  userData.dir = mkdtempSync(path.join(tmpdir(), "job-store-import-reset-"));
  pending.value = { status: "readable", intent: { token: "t", entries: [] } };
  // A malformed retired file is still ignored, rather than blocking reset.
  const legacy = new DatabaseSync(
    path.join(userData.dir, "job-finder-workspace.sqlite"),
  );
  legacy.exec("CREATE TABLE obsolete(value TEXT)");
  legacy.close();
  expect(createProfileStore(getJobStore()).read().fullName).toBeNull();
  closeJobStore();
  pending.value = { status: "none" };
  expect(createProfileStore(getJobStore()).read().fullName).toBeNull();
});
