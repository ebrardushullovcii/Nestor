import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { rememberRowChanges } from "@nestor/core";
import { createJobFinderWorkspaceDeltaTracker } from "./workspace-delta";

function createWorkspace(input: {
  generatedAt: string;
  jobIds: readonly string[];
  selectedJobId: string | null;
  profileSummary?: string;
  discoveryJobs?: readonly Record<string, unknown>[];
  companyJobs?: readonly Record<string, unknown>[];
  applicationRecords?: readonly Record<string, unknown>[];
}): JobFinderRendererWorkspaceSnapshot {
  return {
    generatedAt: input.generatedAt,
    profile: { summary: input.profileSummary ?? "Original summary" },
    discoveryRunState: "idle",
    activeDiscoveryRun: null,
    discoverySessions: [],
    sourceAccessPrompts: [],
    latestResumeImportRun: null,
    discoveryJobs: input.discoveryJobs ?? input.jobIds.map((id) => ({ id })),
    dismissedDiscoveryJobs: [],
    companyJobs: input.companyJobs ?? [],
    recentDiscoveryRuns: [],
    reviewQueue: [],
    applyRuns: [],
    applyJobResults: [],
    applicationRecords: input.applicationRecords ?? [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
    selectedDiscoveryJobId: input.selectedJobId,
    selectedReviewJobId: null,
    selectedApplyRunId: null,
    selectedApplicationRecordId: null,
    dashboard: {},
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("Job Finder workspace delta tracker", () => {
  it("diffs only nominated rows on an exact immutable lineage, even from a held baseline", () => {
    const a = { id: "job-1", title: "Original" };
    const b = { id: "job-2", title: "Added" };
    const changed = { ...a, title: "Updated" };
    const guarded = (rows: readonly Record<string, unknown>[]) =>
      new Proxy(Object.freeze([...rows]), {
        get(target, key, receiver) {
          if (
            key === Symbol.iterator ||
            (typeof key === "string" && /^\d+$/.test(key))
          )
            throw new Error("Unchanged collection was walked");
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const first = guarded([a]);
    const second = guarded([changed, b]);
    const third = guarded([a]);
    rememberRowChanges(first, second, [
      { id: a.id, before: a, after: changed },
      { id: b.id, before: undefined, after: b },
    ]);
    rememberRowChanges(second, third, [
      { id: a.id, before: changed, after: a },
      { id: b.id, before: b, after: undefined },
    ]);
    const workspace = (jobs: readonly Record<string, unknown>[]) =>
      createWorkspace({
        generatedAt: "2026-08-09T10:00:00.000Z",
        jobIds: [],
        selectedJobId: null,
        discoveryJobs: jobs,
      });
    const tracker = createJobFinderWorkspaceDeltaTracker();
    tracker.synchronize(null, workspace(first));
    expect(tracker.synchronize(1, workspace(second))).toMatchObject({
      kind: "delta",
      delta: { discoveryJobs: { upserts: [changed, b], removedIds: [] } },
    });
    expect(tracker.synchronize(1, workspace(third))).toMatchObject({
      kind: "delta",
      delta: { discoveryJobs: { upserts: [], removedIds: [] } },
    });
    expect(tracker.synchronize(2, workspace(third))).toMatchObject({
      kind: "delta",
      delta: { discoveryJobs: { upserts: [a], removedIds: [b.id] } },
    });
  });
  it("returns a bounded entity delta with the current selection", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: "job-1",
    });
    const current = createWorkspace({
      generatedAt: "2026-08-09T10:01:00.000Z",
      jobIds: ["job-2"],
      selectedJobId: "job-2",
    });

    expect(tracker.synchronize(null, initial)).toMatchObject({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
    });
    const result = tracker.synchronize(1, current);

    expect(result).toMatchObject({
      kind: "delta",
      delta: {
        baseRevision: 1,
        currentRevision: 2,
        selectedDiscoveryJobId: "job-2",
        discoveryJobs: {
          upserts: [{ id: "job-2" }],
          removedIds: ["job-1"],
        },
      },
    });
  });

  it("emits an upsert when only derived listing activity changes", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initialJob = {
      id: "job-1",
      listingActivity: { status: "unknown" },
    };
    const currentJob = {
      id: "job-1",
      listingActivity: {
        status: "closed",
        observedAt: "2026-08-23T10:00:00.000Z",
        signalId: "signal-1",
        provenance: "provider",
        explanation: "The provider explicitly reported the listing closed.",
        detail: null,
        confidence: 1,
      },
    };
    const initial = createWorkspace({
      generatedAt: "2026-08-23T10:00:00.000Z",
      jobIds: [],
      selectedJobId: "job-1",
      discoveryJobs: [initialJob],
    });
    const current = createWorkspace({
      generatedAt: "2026-08-23T10:01:00.000Z",
      jobIds: [],
      selectedJobId: "job-1",
      discoveryJobs: [currentJob],
    });

    tracker.synchronize(null, initial);

    expect(tracker.synchronize(1, current)).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: { upserts: [currentJob], removedIds: [] },
      },
    });
  });

  it("propagates Companies activity and workflow changes independently of Discovery", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initialCompanyJob = {
      id: "job-company",
      status: "submitted",
      listingActivity: { status: "active" },
    };
    const currentCompanyJob = {
      id: "job-company",
      status: "rejected",
      listingActivity: { status: "closed" },
    };
    const initial = createWorkspace({
      generatedAt: "2026-08-23T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [],
      companyJobs: [initialCompanyJob],
    });
    const current = createWorkspace({
      generatedAt: "2026-08-23T10:01:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [],
      companyJobs: [currentCompanyJob],
    });

    tracker.synchronize(null, initial);

    expect(tracker.synchronize(1, current)).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: { upserts: [], removedIds: [] },
        companyJobs: { upserts: [currentCompanyJob], removedIds: [] },
      },
    });
  });

  it("sends nothing for unchanged plan state on an idle refresh", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const workspace = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: "job-1",
    });
    tracker.synchronize(null, workspace);
    const result = tracker.synchronize(1, {
      ...workspace,
      generatedAt: "2026-08-09T10:00:05.000Z",
    });
    if (result.kind !== "delta") throw new Error("expected a delta");
    expect(result.delta).not.toHaveProperty("campaigns");
    expect(result.delta).not.toHaveProperty("replaced");
    expect(result.delta.discoveryJobs).toEqual({ upserts: [], removedIds: [] });
  });

  it("recovers stale mutation revisions with one full snapshot", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const workspace = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
    });

    tracker.synchronize(null, workspace);

    expect(tracker.synchronize(0, workspace)).toMatchObject({
      kind: "snapshot",
      currentRevision: 2,
      reason: "stale_base",
    });
  });

  it("keeps concurrent mutation replies as deltas and omits unchanged intelligence", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = createWorkspace({
      generatedAt: "2026-10-13T10:00:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: "job-1",
    });
    const first = {
      ...initial,
      generatedAt: "2026-10-13T10:00:01.000Z",
      selectedDiscoveryJobId: null,
    };
    const second = {
      ...first,
      generatedAt: "2026-10-13T10:00:02.000Z",
      discoveryJobs: [],
    };
    tracker.synchronize(null, initial);
    expect(tracker.synchronize(1, first).kind).toBe("delta");
    const concurrent = tracker.synchronize(1, second);
    expect(concurrent).toMatchObject({
      kind: "delta",
      delta: {
        baseRevision: 1,
        currentRevision: 3,
        discoveryJobs: { removedIds: ["job-1"] },
      },
    });
    if (concurrent.kind === "delta")
      expect(concurrent.delta).not.toHaveProperty("intelligence");
    // Old baselines expire, bounding retained snapshot arrays and scalar state.
    for (let revision = 3; revision <= 6; revision++)
      tracker.synchronize(revision, second);
    expect(tracker.synchronize(1, second)).toMatchObject({
      kind: "snapshot",
      reason: "stale_base",
    });
  });

  it("ignores nested object key order when comparing entities", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [
        {
          id: "job-1",
          metadata: {
            title: "Engineer",
            location: { country: "Kosovo", city: "Pristina" },
          },
        },
      ],
    });
    const sameValuesWithDifferentKeyOrder = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [
        {
          id: "job-1",
          metadata: {
            location: { city: "Pristina", country: "Kosovo" },
            title: "Engineer",
          },
        },
      ],
    });

    tracker.synchronize(null, initial);

    expect(
      tracker.synchronize(1, sameValuesWithDifferentKeyOrder),
    ).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: { upserts: [], removedIds: [] },
      },
    });
  });

  it("detects a removed nested object key", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initialJob = {
      id: "job-1",
      metadata: { title: "Engineer", location: "Pristina" },
    };
    const currentJob = {
      id: "job-1",
      metadata: { title: "Engineer" },
    };
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [initialJob],
    });
    const current = createWorkspace({
      generatedAt: "2026-08-09T10:01:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [currentJob],
    });

    tracker.synchronize(null, initial);

    expect(tracker.synchronize(1, current)).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: { upserts: [currentJob], removedIds: [] },
      },
    });
  });

  it.each([
    {
      label: "order",
      currentTags: ["backend", "typescript"],
    },
    {
      label: "value",
      currentTags: ["backend", "rust"],
    },
  ])("detects nested array $label changes", ({ currentTags }) => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [
        { id: "job-1", metadata: { tags: ["typescript", "backend"] } },
      ],
    });
    const currentJob = {
      id: "job-1",
      metadata: { tags: currentTags },
    };
    const current = createWorkspace({
      generatedAt: "2026-08-09T10:01:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [currentJob],
    });

    tracker.synchronize(null, initial);

    expect(tracker.synchronize(1, current)).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: { upserts: [currentJob], removedIds: [] },
      },
    });
  });

  it("sends only the running search's new activity", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const withRun = (runId: string, eventIds: readonly string[]) =>
      ({
        ...createWorkspace({
          generatedAt: "2026-08-09T10:00:00.000Z",
          jobIds: [],
          selectedJobId: null,
        }),
        activeDiscoveryRun: {
          id: runId,
          activity: eventIds.map((id) => ({ id })),
        },
      }) as unknown as JobFinderRendererWorkspaceSnapshot;

    tracker.synchronize(null, withRun("run-1", ["a", "b"]));
    expect(
      tracker.synchronize(1, withRun("run-1", ["a", "b", "c"])),
    ).toMatchObject({
      kind: "delta",
      delta: {
        activeDiscoveryRunActivityFrom: 2,
        activeDiscoveryRun: { id: "run-1", activity: [{ id: "c" }] },
      },
    });
    // Another run, or a history that does not continue the held one, goes whole.
    expect(tracker.synchronize(2, withRun("run-2", ["x"]))).toMatchObject({
      kind: "delta",
      delta: {
        activeDiscoveryRunActivityFrom: null,
        activeDiscoveryRun: { id: "run-2", activity: [{ id: "x" }] },
      },
    });
    expect(tracker.synchronize(3, withRun("run-2", ["y", "z"]))).toMatchObject({
      kind: "delta",
      delta: {
        activeDiscoveryRunActivityFrom: null,
        activeDiscoveryRun: { activity: [{ id: "y" }, { id: "z" }] },
      },
    });
  });

  it("keeps generatedAt-only changes as a delta", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: "job-1",
    });
    const current = createWorkspace({
      generatedAt: "2026-08-09T10:01:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: "job-1",
    });

    tracker.synchronize(null, initial);

    expect(tracker.synchronize(1, current)).toMatchObject({
      kind: "delta",
      delta: {
        generatedAt: current.generatedAt,
        discoveryJobs: { upserts: [], removedIds: [] },
      },
    });
  });

  it("sends changed jobs and applications and falls back for a stale baseline", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const createJobs = () =>
      Array.from({ length: 4 }, (_, index) => ({
        id: `job-${index}`,
        title: `Platform Engineer ${index}`,
        company: {
          id: `company-${index % 250}`,
          name: `Company ${index % 250}`,
        },
        metadata: {
          locations: [`City ${index % 50}`, "Remote"],
          compensation: { currency: "USD", minimum: 90_000 + index },
          skills: ["typescript", "sql", `specialty-${index % 20}`],
        },
      }));
    const createApplications = () =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `application-${index}`,
        jobId: `job-${index}`,
        status: "prepared",
        answers: [
          { id: `answer-${index}-1`, value: `Candidate response ${index}` },
          { id: `answer-${index}-2`, value: "Authorized local-only evidence" },
        ],
      }));

    const initialJobs = createJobs();
    const currentJobs = createJobs().slice(1);
    const originalChangedJob = currentJobs[1]!;
    const changedJob = {
      ...originalChangedJob,
      metadata: {
        ...originalChangedJob.metadata,
        skills: [...originalChangedJob.metadata.skills, "electron"],
      },
    };
    currentJobs[1] = changedJob;
    const addedJob = {
      ...initialJobs[0]!,
      id: "job-4",
      title: "Platform Engineer 4",
    };
    currentJobs.push(addedJob);

    const initialApplications = createApplications();
    const currentApplications = createApplications().slice(0, -1);
    const changedApplication = {
      ...currentApplications[1]!,
      status: "interviewing",
    };
    currentApplications[1] = changedApplication;

    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: "job-0",
      discoveryJobs: initialJobs,
      applicationRecords: initialApplications,
    });
    const current = createWorkspace({
      generatedAt: "2026-08-09T10:01:00.000Z",
      jobIds: [],
      selectedJobId: "job-4",
      discoveryJobs: currentJobs,
      applicationRecords: currentApplications,
    });

    tracker.synchronize(null, initial);
    const deltaResult = tracker.synchronize(1, current);

    expect(deltaResult).toMatchObject({
      kind: "delta",
      delta: {
        baseRevision: 1,
        currentRevision: 2,
        selectedDiscoveryJobId: "job-4",
        discoveryJobs: {
          upserts: [changedJob, addedJob],
          removedIds: ["job-0"],
        },
        applicationRecords: {
          upserts: [changedApplication],
          removedIds: ["application-2"],
        },
      },
    });
    const fallbackResult = tracker.synchronize(0, current);

    expect(fallbackResult).toMatchObject({
      kind: "snapshot",
      currentRevision: 3,
      reason: "stale_base",
    });
    expect(fallbackResult.kind).toBe("snapshot");
    if (fallbackResult.kind === "snapshot") {
      expect(fallbackResult.snapshot).toBe(current);
    }
  });

  it("sends only real changes after a view saved by an earlier run of the app", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const saved = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [
        { id: "job-1", title: "Engineer", detailRevision: "old-1" },
        { id: "job-2", title: "Designer", detailRevision: "old-2" },
      ],
    });
    const loaded = createWorkspace({
      generatedAt: "2026-08-09T10:00:05.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [
        { id: "job-1", title: "Engineer", detailRevision: "new-7" },
        { id: "job-2", title: "Senior designer", detailRevision: "new-8" },
      ],
    });

    tracker.synchronize(null, saved, { earlierProcess: true });
    const result = tracker.synchronize(1, loaded);

    // Only the job whose content changed travels; a new detail revision on
    // an unchanged row does not make it a change.
    expect(result).toMatchObject({
      kind: "delta",
      delta: {
        discoveryJobs: {
          upserts: [{ id: "job-2", title: "Senior designer" }],
          removedIds: [],
        },
      },
    });
  });

  it("still treats a new detail revision as a change within one run", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const first = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [{ id: "job-1", detailRevision: "r1" }],
    });
    const second = createWorkspace({
      generatedAt: "2026-08-09T10:00:01.000Z",
      jobIds: [],
      selectedJobId: null,
      discoveryJobs: [{ id: "job-1", detailRevision: "r2" }],
    });

    tracker.synchronize(null, first);

    expect(tracker.synchronize(1, second)).toMatchObject({
      kind: "delta",
      delta: { discoveryJobs: { upserts: [{ id: "job-1" }] } },
    });
  });

  it("answers a window's change with a delta from the revision it holds", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const window = {};
    const jobIds = Array.from({ length: 50 }, (_, index) => `job-${index}`);
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds,
      selectedJobId: null,
    });
    const changed = {
      ...initial,
      generatedAt: "2026-08-09T10:00:01.000Z",
      profile: { summary: "Edited summary" },
    } as JobFinderRendererWorkspaceSnapshot;

    tracker.synchronize(null, initial);
    tracker.noteHeldRevision(window, 1);
    const answer = tracker.respond(window, changed);

    expect(answer).toMatchObject({
      kind: "delta",
      delta: {
        baseRevision: 1,
        currentRevision: 2,
        replaced: { profile: { summary: "Edited summary" } },
        discoveryJobs: { upserts: [], removedIds: [] },
      },
    });
  });

  it("sends the whole view to a window holding nothing main still has, keeping other baselines", () => {
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const held = {};
    const fresh = {};
    const initial = createWorkspace({
      generatedAt: "2026-08-09T10:00:00.000Z",
      jobIds: ["job-1"],
      selectedJobId: null,
    });
    const next = createWorkspace({
      generatedAt: "2026-08-09T10:00:01.000Z",
      jobIds: ["job-1", "job-2"],
      selectedJobId: null,
    });

    tracker.synchronize(null, initial);
    tracker.noteHeldRevision(held, 1);

    expect(tracker.respond(fresh, next)).toMatchObject({
      kind: "snapshot",
      currentRevision: 2,
      snapshot: next,
    });
    expect(tracker.respond(undefined, next)).toMatchObject({
      kind: "snapshot",
    });
    // The other window's revision 1 is still a usable baseline.
    expect(tracker.respond(held, next)).toMatchObject({
      kind: "delta",
      delta: { baseRevision: 1 },
    });

    tracker.noteHeldRevision(held, 0);
    expect(tracker.respond(held, next)).toMatchObject({ kind: "snapshot" });
  });
});
