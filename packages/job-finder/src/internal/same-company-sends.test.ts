import { describe, expect, it } from "vitest";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import {
  JobFinderIntelligenceStateSchema,
  ApplicationRecordSchema,
  SavedJobSchema,
  ApplyJobResultSchema,
  SafeguardMutationInputSchema,
} from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-support";
import {
  checkSameCompanySends,
  groupCompanyConflicts,
} from "./same-company-sends";

const at = "2026-10-05T10:00:00.000Z";
const jobs = ["London", "Manchester", "Bristol"].map((location, i) =>
  SavedJobSchema.parse({
    ...createSeed().savedJobs[0],
    id: `job_${i}`,
    title: "Engineer",
    company: "Synthetic",
    location,
    canonicalUrl: `https://example.test/${i}`,
  }),
);
const records = jobs.map((job, i) =>
  ApplicationRecordSchema.parse({
    id: `record_${i}`,
    jobId: job.id,
    title: job.title,
    company: job.company,
    status: "ready_for_review",
    lastUpdatedAt: at,
    lastActionLabel: "Prepared",
    nextActionLabel: "Send",
  }),
);

describe("same-company sending decisions", () => {
  it("checks single, batch and assistant callers with the same exact-pair choice", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: jobs,
    });
    expect(
      await checkSameCompanySends({
        repository,
        jobIds: jobs.slice(0, 2).map((job) => job.id),
        now: at,
      }),
    ).toContain("London");
    const state = await repository.getIntelligenceState();
    const group = state.safeguards.simultaneousApplicationConflicts[0]!;
    group.allowedPairs = [
      { jobIds: [jobs[0]!.id, jobs[1]!.id], decidedAt: at, revokedAt: null },
    ];
    await repository.saveIntelligenceState(state);
    expect(
      await checkSameCompanySends({
        repository,
        jobIds: jobs.slice(0, 2).map((job) => job.id),
        now: at,
      }),
    ).toBeNull();
    expect(
      await checkSameCompanySends({
        repository,
        jobIds: jobs.map((job) => job.id),
        now: at,
      }),
    ).toContain("Bristol");
    group.allowedPairs[0]!.revokedAt = at;
    await repository.saveIntelligenceState(state);
    expect(
      await checkSameCompanySends({
        repository,
        jobIds: jobs.slice(0, 2).map((job) => job.id),
        now: at,
      }),
    ).toContain("Send both anyway");
  });
  it("migrates old pairs into one company group without treating dismissal as send permission", () => {
    const state = JobFinderIntelligenceStateSchema.parse({
      safeguards: {
        simultaneousApplicationConflicts: [
          [0, 1],
          [0, 2],
        ].map(([a, b]) => ({
          id: `old_${a}_${b}`,
          applicationRecordId: records[a!]!.id,
          conflictingApplicationRecordId: records[b!]!.id,
          status: "resolved",
          explanation: "Old overlap",
          recoveryGuidance: "Review",
        })),
      },
    });
    const grouped = groupCompanyConflicts(state, records, jobs);
    expect(grouped.safeguards.simultaneousApplicationConflicts).toHaveLength(1);
    expect(
      grouped.safeguards.simultaneousApplicationConflicts[0]?.jobIds,
    ).toEqual(jobs.map((job) => job.id));
    expect(
      grouped.safeguards.simultaneousApplicationConflicts[0]?.allowedPairs,
    ).toEqual([]);
  });
  it("rejects a decision that is not a pair", () => {
    expect(
      SafeguardMutationInputSchema.safeParse({
        type: "decide_same_company_send_pair",
        conflictId: "group",
        jobIds: ["job_0", "job_0"],
        allow: true,
      }).success,
    ).toBe(false);
  });
});

it("stores and revokes the person's exact pair through the typed safeguard mutation", async () => {
  const { createWorkspaceServiceHarness } =
    await import("../workspace-service.test-support");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: { ...createSeed(), savedJobs: jobs },
  });
  await checkSameCompanySends({
    repository,
    jobIds: jobs.slice(0, 2).map((job) => job.id),
    now: at,
  });
  const group = (await repository.getIntelligenceState()).safeguards
    .simultaneousApplicationConflicts[0]!;
  const decision = {
    type: "decide_same_company_send_pair" as const,
    conflictId: group.id,
    jobIds: [jobs[0]!.id, jobs[1]!.id] as [string, string],
    allow: true,
  };
  await workspaceService.mutateSafeguards(decision);
  expect(
    await checkSameCompanySends({
      repository,
      jobIds: decision.jobIds,
      now: at,
    }),
  ).toBeNull();
  await workspaceService.mutateSafeguards({ ...decision, allow: false });
  expect(
    await checkSameCompanySends({
      repository,
      jobIds: decision.jobIds,
      now: at,
    }),
  ).toContain("Send both anyway");
  await expect(
    workspaceService.mutateSafeguards({
      ...decision,
      jobIds: [jobs[0]!.id, jobs[2]!.id],
    }),
  ).rejects.toThrow("no longer in the company group");
});

it("does not hold a send because an older peer preparation was already cancelled", async () => {
  const waiting = ApplyJobResultSchema.parse({
    id: "old",
    runId: "old_run",
    jobId: jobs[1]!.id,
    applicationRecordId: records[1]!.id,
    state: "awaiting_review",
    summary: "Prepared",
    detail: "Waiting",
    startedAt: at,
    updatedAt: at,
  });
  const cancelled = ApplyJobResultSchema.parse({
    ...waiting,
    id: "new",
    runId: "new_run",
    state: "cancelled",
    updatedAt: "2026-10-05T10:01:00.000Z",
  });
  const repository = createInMemoryJobFinderRepository({
    ...createSeed(),
    savedJobs: jobs,
    applyJobResults: [waiting, cancelled],
  });
  expect(
    await checkSameCompanySends({
      repository,
      jobIds: [jobs[0]!.id],
      now: "2026-10-05T10:02:00.000Z",
    }),
  ).toBeNull();
});
