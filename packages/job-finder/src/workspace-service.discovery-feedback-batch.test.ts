import { expect, test, vi } from "vitest";
import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  CompanyEntitySchema,
  DiscoveryLedgerEntrySchema,
  SavedJobSchema,
  type SavedJob,
} from "@nordri/contracts";
import type { JobFinderRepository } from "@nordri/db";
import type { AssistantTurnSession } from "./assistant/tool-kit";
import type { AssistantHostPorts } from "./assistant/ports";
import {
  dismissJobsTool,
  excludeEmployerTool,
  restoreJobsTool,
} from "./assistant/tools/jobs-tools";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import { createCampaign } from "./internal/campaign-dashboard";

function batchSeed(count = 100) {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: count }, (_, index) =>
    SavedJobSchema.parse({
      ...base,
      id: `feedback_${index}`,
      canonicalUrl: `https://jobs.example.test/feedback/${index}`,
      applicationUrl: `https://jobs.example.test/feedback/${index}/apply`,
      sourceJobId: String(index),
      company: "Scale Company",
      status: "discovered",
    }),
  );
  seed.tailoredAssets = [];
  seed.searchPreferences.companyWhitelist = [];
  const now = "2026-10-13T10:00:00.000Z";
  const jobIds = seed.savedJobs.map((job) => job.id);
  seed.campaigns = [
    {
      ...createCampaign({
        id: "feedback_plan",
        name: "Synthetic plan",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now,
      }),
      jobIds,
    },
  ];
  seed.activeCampaignId = "feedback_plan";
  seed.intelligence.companies = [
    CompanyEntitySchema.parse({
      id: "scale_company",
      canonicalName: "Scale Company",
      jobIds,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  return seed;
}

function world(count = 100) {
  const harness = createWorkspaceServiceHarness({ seed: batchSeed(count) });
  const controller = new AbortController();
  const session = {
    signal: controller.signal,
    assertCurrent: vi.fn(() => {
      if (controller.signal.aborted) throw new Error("Assistant stopped.");
    }),
  } as unknown as AssistantTurnSession;
  const publishWorkspaceUpdate = vi.fn();
  const ports = { publishWorkspaceUpdate } as unknown as AssistantHostPorts;
  return {
    ...harness,
    service: harness.workspaceService,
    session,
    ports,
    controller,
    publishWorkspaceUpdate,
  };
}

function assertDisplayReads(repository: JobFinderRepository) {
  return {
    display: vi.spyOn(repository, "readSavedJobsProjection"),
    canonicalJobs: vi.spyOn(repository, "listSavedJobs"),
    canonicalDiscovery: vi.spyOn(repository, "getDiscoveryState"),
  };
}

async function upsertJob(repository: JobFinderRepository, job: SavedJob) {
  await repository.commitSavedJobDelta({ upserts: [job] });
}

test("100 assistant hides and restores use one terminal display each, no canonical reads, and one publication", async () => {
  const context = world();
  const ids = batchSeed().savedJobs.map((job) => job.id);
  const reads = assertDisplayReads(context.repository);
  const singles = vi.spyOn(context.service, "dismissDiscoveryJob");
  const canonicalWorkspace = vi.spyOn(context.service, "getWorkspaceSnapshot");
  const before = vi.spyOn(context.service, "getWorkspaceProjection");
  const commits = vi.spyOn(context.repository, "commitDiscoveryFeedbackUpdate");
  const hidden = await dismissJobsTool.execute(
    { jobIds: ids, reasons: ["location"] },
    context,
  );
  expect(hidden.summary).toBe("Hid 100 jobs.");
  expect(hidden.data).toHaveLength(100);
  expect(singles).not.toHaveBeenCalled();
  expect(before).toHaveBeenCalledOnce();
  expect(reads.display).toHaveBeenCalledTimes(2); // Before and the batch's terminal display.
  expect(commits.mock.calls.map(([id]) => id)).toEqual(ids);
  expect(context.publishWorkspaceUpdate).toHaveBeenCalledOnce();
  reads.display.mockClear();
  context.publishWorkspaceUpdate.mockClear();
  const restoreSingle = vi.spyOn(
    context.service,
    "restoreDismissedDiscoveryJob",
  );
  const restored = await restoreJobsTool.execute({ jobIds: ids }, context);
  expect(restored.summary).toBe("Restored 100 jobs.");
  expect(restored.data).toHaveLength(100);
  expect(restoreSingle).not.toHaveBeenCalled();
  expect(reads.display).toHaveBeenCalledOnce();
  expect(context.publishWorkspaceUpdate).toHaveBeenCalledOnce();
  expect(canonicalWorkspace).not.toHaveBeenCalled();
  expect(reads.canonicalJobs).not.toHaveBeenCalled();
  expect(reads.canonicalDiscovery).not.toHaveBeenCalled();
  expect(
    (await context.repository.listSavedJobsByIds(ids)).every(
      (job) => job.status === "discovered" && job.discoveryFeedback === null,
    ),
  ).toBe(true);
});

test("hiding accepts the complete selection beyond the old 100-job ceiling and deduplicates IDs", async () => {
  const context = world(105);
  const jobIds = batchSeed(105).savedJobs.map((job) => job.id);
  const input = dismissJobsTool.input.parse({
    jobIds: [...jobIds, jobIds[0]],
    reasons: ["company"],
  });
  const result = await dismissJobsTool.execute(input, context);
  expect(result.summary).toBe("Hid 105 jobs.");
  expect(result.data).toHaveLength(105);
});

test("100 employer hides preserve shortlisted/applied jobs with constant projection reads", async () => {
  const context = world(103);
  for (const [id, status] of [
    ["feedback_100", "shortlisted"],
    ["feedback_101", "submitted"],
  ] as const) {
    const [job] = await context.repository.listSavedJobsByIds([id]);
    await upsertJob(
      context.repository,
      SavedJobSchema.parse({ ...job, status }),
    );
  }
  const [other] = await context.repository.listSavedJobsByIds(["feedback_102"]);
  await upsertJob(
    context.repository,
    SavedJobSchema.parse({ ...other, company: "Other Company" }),
  );
  const reads = assertDisplayReads(context.repository);
  const single = vi.spyOn(context.service, "dismissDiscoveryJob");
  const commits = vi.spyOn(context.repository, "commitDiscoveryFeedbackUpdate");
  const result = await excludeEmployerTool.execute(
    { jobId: "feedback_0" },
    context,
  );
  expect(result.summary).toContain("Hidden now: 100 found jobs.");
  expect(result.summary).toContain(
    "Left as they are (shortlisted or applied): 2 jobs.",
  );
  expect(commits).toHaveBeenCalledTimes(100);
  expect(reads.display).toHaveBeenCalledTimes(2);
  expect(reads.canonicalJobs).not.toHaveBeenCalled();
  expect(reads.canonicalDiscovery).not.toHaveBeenCalled();
  expect(single).not.toHaveBeenCalled();
  expect(context.publishWorkspaceUpdate).toHaveBeenCalledOnce();
  expect(
    (
      await context.repository.listSavedJobsByIds([
        "feedback_100",
        "feedback_101",
        "feedback_102",
      ])
    ).map((job) => job.status),
  ).toEqual(["shortlisted", "submitted", "discovered"]);
  expect(
    (await context.repository.getSearchPreferences()).companyBlacklist,
  ).toEqual(["Scale Company"]);
});

test.each(["hide", "restore"] as const)(
  "%s batch keeps ordered partial failures and attempts the remaining jobs",
  async (action) => {
    const context = world(3);
    const ids = ["feedback_0", "missing", "feedback_1", "feedback_2"];
    if (action === "restore") {
      await context.service.dismissDiscoveryJobs!(
        ids
          .filter((id) => id !== "missing")
          .map((jobId) => ({ jobId, reasons: ["company"] })),
      );
    }
    const commit = context.repository.commitDiscoveryFeedbackUpdate.bind(
      context.repository,
    );
    vi.spyOn(
      context.repository,
      "commitDiscoveryFeedbackUpdate",
    ).mockImplementation((jobId, update) =>
      jobId === "feedback_1"
        ? Promise.reject(new Error("Synthetic write failure"))
        : commit(jobId, update),
    );
    const result =
      action === "hide"
        ? await context.service.dismissDiscoveryJobs!(
            ids.map((jobId) => ({ jobId, reasons: ["company"] })),
          )
        : await context.service.restoreDismissedDiscoveryJobs!(ids);
    expect(result.outcomes.map((entry) => entry.jobId)).toEqual(ids);
    expect(result.outcomes.map((entry) => entry.status)).toEqual([
      action === "hide" ? "hidden" : "restored",
      "failed",
      "failed",
      action === "hide" ? "hidden" : "restored",
    ]);
    expect(result.outcomes[2]).toMatchObject({
      message: "Synthetic write failure",
    });
    expect(result.workspace).not.toBeNull();
  },
);

test("employer exclusion rechecks current status and normalized identity for every peer", async () => {
  const context = world(4);
  const commit = context.repository.commitDiscoveryFeedbackUpdate.bind(
    context.repository,
  );
  vi.spyOn(
    context.repository,
    "commitDiscoveryFeedbackUpdate",
  ).mockImplementation(async (jobId, update) => {
    if (jobId === "feedback_1" || jobId === "feedback_2") {
      const [job] = await context.repository.listSavedJobsByIds([jobId]);
      await upsertJob(
        context.repository,
        SavedJobSchema.parse({
          ...job,
          ...(jobId === "feedback_1"
            ? { status: "shortlisted" }
            : { company: "Changed Company" }),
        }),
      );
    }
    return commit(jobId, update);
  });
  const result = await context.service.excludeEmployerDiscoveryJobs!({
    jobId: "feedback_0",
    jobIds: ["feedback_1", "feedback_2", "feedback_3"],
    expectedNormalizedCompanyName: "scale company",
  });
  expect(result.outcomes.map((entry) => entry.status)).toEqual([
    "hidden",
    "held",
    "held",
    "hidden",
  ]);
  expect(
    (
      await context.repository.listSavedJobsByIds(["feedback_1", "feedback_2"])
    ).map((job) => job.status),
  ).toEqual(["shortlisted", "discovered"]);
});

test.each(["identity", "whitelist"] as const)(
  "a changed exclusion %s prevents the anchor and every peer write",
  async (change) => {
    const context = world(3);
    const preview =
      await context.service.previewEmployerExclusion("feedback_0");
    expect(preview.status).toBe("available");
    if (change === "identity") {
      const [job] = await context.repository.listSavedJobsByIds(["feedback_0"]);
      await upsertJob(
        context.repository,
        SavedJobSchema.parse({ ...job, company: "Changed Company" }),
      );
    } else {
      const preferences = await context.repository.getSearchPreferences();
      await context.repository.saveSearchPreferences({
        ...preferences,
        companyWhitelist: ["Scale Company"],
      });
    }
    const commits = vi.spyOn(
      context.repository,
      "commitDiscoveryFeedbackUpdate",
    );
    const result = await context.service.excludeEmployerDiscoveryJobs!({
      jobId: "feedback_0",
      jobIds: ["feedback_1", "feedback_2"],
      expectedNormalizedCompanyName: "scale company",
    });
    expect(result.outcomes.map((entry) => entry.status)).toEqual([
      change === "identity" ? "held" : "failed",
      "held",
      "held",
    ]);
    expect(commits).toHaveBeenCalledOnce();
    expect(
      (await context.repository.getSearchPreferences()).companyBlacklist,
    ).toEqual([]);
    expect(
      (
        await context.repository.listSavedJobsByIds([
          "feedback_0",
          "feedback_1",
          "feedback_2",
        ])
      ).every((job) => job.status === "discovered"),
    ).toBe(true);
  },
);

test("an assistant stop inside a queued transaction fences that write and every remaining job", async () => {
  const context = world(3);
  const commit = context.repository.commitDiscoveryFeedbackUpdate.bind(
    context.repository,
  );
  vi.spyOn(
    context.repository,
    "commitDiscoveryFeedbackUpdate",
  ).mockImplementation((jobId, update) => {
    if (jobId === "feedback_1") context.controller.abort();
    return commit(jobId, update);
  });
  const result = await context.service.dismissDiscoveryJobs!(
    ["feedback_0", "feedback_1", "feedback_2"].map((jobId) => ({
      jobId,
      reasons: ["company"],
    })),
    {
      signal: context.controller.signal,
      assertCurrent: () => context.session.assertCurrent(),
    },
  );
  expect(result.outcomes.map((entry) => entry.status)).toEqual([
    "hidden",
    "stopped",
    "stopped",
  ]);
  expect(
    (
      await context.repository.listSavedJobsByIds([
        "feedback_0",
        "feedback_1",
        "feedback_2",
      ])
    ).map((job) => job.status),
  ).toEqual(["archived", "discovered", "discovered"]);
});

test("superseding the assistant generation fences the transaction even without aborting its signal", async () => {
  const context = world(2);
  let current = true;
  const commit = context.repository.commitDiscoveryFeedbackUpdate.bind(
    context.repository,
  );
  vi.spyOn(
    context.repository,
    "commitDiscoveryFeedbackUpdate",
  ).mockImplementation((jobId, update) => {
    current = false;
    return commit(jobId, update);
  });
  const result = await context.service.dismissDiscoveryJobs!(
    [
      { jobId: "feedback_0", reasons: [] },
      { jobId: "feedback_1", reasons: [] },
    ],
    {
      signal: context.controller.signal,
      assertCurrent: () => {
        if (!current) throw new Error("Superseded generation");
      },
    },
  );
  expect(context.controller.signal.aborted).toBe(false);
  expect(result.outcomes.map((entry) => entry.status)).toEqual([
    "stopped",
    "stopped",
  ]);
  expect(
    (
      await context.repository.listSavedJobsByIds(["feedback_0", "feedback_1"])
    ).every((job) => job.status === "discovered"),
  ).toBe(true);
});

test("an exclusion anchor that left the found list is held and leaves every peer unchanged", async () => {
  const context = world(2);
  const [anchor] = await context.repository.listSavedJobsByIds(["feedback_0"]);
  await upsertJob(
    context.repository,
    SavedJobSchema.parse({ ...anchor, status: "shortlisted" }),
  );
  await expect(
    excludeEmployerTool.execute({ jobId: "feedback_0" }, context),
  ).rejects.toThrow("no longer in the found list");
  expect(context.publishWorkspaceUpdate).not.toHaveBeenCalled();
  expect(
    (await context.repository.getSearchPreferences()).companyBlacklist,
  ).toEqual([]);
  expect(
    (
      await context.repository.listSavedJobsByIds(["feedback_0", "feedback_1"])
    ).map((job) => job.status),
  ).toEqual(["shortlisted", "discovered"]);
});

test("a pending discovery job is promoted when hidden and restored as discovered", async () => {
  const seed = batchSeed(2);
  const pending = seed.savedJobs.pop()!;
  seed.discovery.pendingDiscoveryJobs = [pending];
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const hidden = await workspaceService.dismissDiscoveryJobs!([
    { jobId: pending.id, reasons: ["company"] },
  ]);
  expect(hidden.outcomes).toEqual([{ jobId: pending.id, status: "hidden" }]);
  expect((await repository.getDiscoveryState()).pendingDiscoveryJobs).toEqual(
    [],
  );
  expect((await repository.listSavedJobsByIds([pending.id]))[0]).toMatchObject({
    status: "archived",
    discoveryFeedback: { priorStatus: null },
  });
  await workspaceService.restoreDismissedDiscoveryJobs!([pending.id]);
  expect((await repository.listSavedJobsByIds([pending.id]))[0]).toMatchObject({
    status: "discovered",
    discoveryFeedback: null,
  });
});

function pauseCommit(context: ReturnType<typeof world>) {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = context.repository.commitDiscoveryFeedbackUpdate.bind(
    context.repository,
  );
  const spy = vi
    .spyOn(context.repository, "commitDiscoveryFeedbackUpdate")
    .mockImplementationOnce(async (jobId, update) => {
      await blocked;
      return commit(jobId, update);
    });
  return { release, spy };
}

test.each(["hide", "restore"] as const)(
  "shutdown fences an in-flight %s transaction and builds no terminal display",
  async (action) => {
    const context = world(2);
    if (action === "restore")
      await context.service.dismissDiscoveryJobs!([
        { jobId: "feedback_0", reasons: [] },
      ]);
    const paused = pauseCommit(context);
    const reads = assertDisplayReads(context.repository);
    const pending =
      action === "hide"
        ? context.service.dismissDiscoveryJobs!([
            { jobId: "feedback_0", reasons: [] },
            { jobId: "feedback_1", reasons: [] },
          ])
        : context.service.restoreDismissedDiscoveryJobs!([
            "feedback_0",
            "feedback_1",
          ]);
    await context.service.shutdown();
    paused.release();
    const result = await pending;
    expect(result.workspace).toBeNull();
    expect(result.outcomes.map((entry) => entry.status)).toEqual([
      "stopped",
      "stopped",
    ]);
    expect(reads.display).not.toHaveBeenCalled();
    expect(
      (await context.repository.listSavedJobsByIds(["feedback_0"]))[0]?.status,
    ).toBe(action === "hide" ? "discovered" : "archived");
    await expect(
      context.service.dismissDiscoveryJobs!([
        { jobId: "feedback_1", reasons: [] },
      ]),
    ).rejects.toThrow("closing");
  },
);

test("reset waits for the batch and replacing reused IDs leaves no old mutation able to resurrect them", async () => {
  const context = world(2);
  const paused = pauseCommit(context);
  const pending = context.service.dismissDiscoveryJobs!([
    { jobId: "feedback_0", reasons: [] },
  ]);
  await expect(context.service.resetWorkspace(batchSeed(1))).rejects.toThrow(
    "hiding jobs",
  );
  paused.release();
  await pending;
  const replacement = batchSeed(1);
  replacement.savedJobs[0]!.description = "Replacement after reset";
  await context.service.resetWorkspace(replacement);
  expect(
    (await context.repository.listSavedJobsByIds(["feedback_0"]))[0],
  ).toMatchObject({
    status: "discovered",
    description: "Replacement after reset",
    discoveryFeedback: null,
  });
});

test("batch feedback preserves ledger, prior status, assessment facts and application-page release", async () => {
  const seed = batchSeed(2);
  seed.savedJobs[0]!.status = "shortlisted";
  const job = seed.savedJobs[0]!;
  seed.discovery.discoveryLedger = [
    DiscoveryLedgerEntrySchema.parse({
      id: "ledger_feedback",
      canonicalUrl: job.canonicalUrl,
      source: job.source,
      sourceJobId: job.sourceJobId,
      title: job.title,
      company: job.company,
      location: job.location,
      targetId: "synthetic",
      collectionMethod: "careers_page",
      detailQuality: "detail_enriched",
      firstSeenAt: job.firstSeenAt,
      lastSeenAt: job.lastSeenAt,
      latestStatus: "seen",
    }),
  ];
  const now = "2026-10-13T10:00:00.000Z";
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run_feedback",
      state: "paused_for_user_review",
      jobIds: [job.id],
      createdAt: now,
      updatedAt: now,
      summary: "Review",
      detail: "Synthetic",
      totalJobs: 1,
    }),
  ];
  seed.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "result_feedback",
      runId: "run_feedback",
      jobId: job.id,
      state: "awaiting_review",
      summary: "Review",
      detail: "Synthetic",
      startedAt: now,
      updatedAt: now,
    }),
  ];
  const releaseApplicationPageBinding = vi.fn(() => Promise.resolve());
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    browserRuntime: {
      ...createBrowserRuntime(),
      releaseApplicationPageBinding,
    },
  });
  await workspaceService.dismissDiscoveryJobs!([
    { jobId: job.id, reasons: ["location", "location", "duplicate"] },
  ]);
  expect(releaseApplicationPageBinding).toHaveBeenCalledWith(
    job.source,
    "result_feedback",
  );
  expect((await repository.listSavedJobsByIds([job.id]))[0]).toMatchObject({
    status: "archived",
    matchAssessment: job.matchAssessment,
    discoveryFeedback: {
      priorStatus: "shortlisted",
      reasons: ["location", "duplicate"],
      revision: 1,
    },
  });
  expect(
    (await repository.getDiscoveryState()).discoveryLedger[0],
  ).toMatchObject({
    latestStatus: "skipped",
    skipReason: "Not interested: location, duplicate.",
  });
  await workspaceService.restoreDismissedDiscoveryJobs!([job.id]);
  expect((await repository.listSavedJobsByIds([job.id]))[0]).toMatchObject({
    status: "shortlisted",
    discoveryFeedback: null,
    matchAssessment: job.matchAssessment,
  });
  expect(
    (await repository.getDiscoveryState()).discoveryLedger[0],
  ).toMatchObject({ latestStatus: "seen", skipReason: null });
});
