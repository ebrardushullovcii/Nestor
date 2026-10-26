import { releaseApplicationRecordAfterDismissedUserAction } from "./workspace-application-user-action";
import { reconcileApplyRunAfterConfirmedSubmission } from "./workspace-apply-run-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplicationRecordSchema,
  UserActionRequestSchema,
  ApplicationPrivacyReceiptSchema,
} from "@nestor/contracts";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  releaseFinishedApplicationPages,
  isUnsentPreparedApplication,
  reuseApplicationPage,
  retireLostPreparedApplication,
} from "./application-page-lifecycle";

const now = "2026-10-03T10:00:00.000Z";
function seedPages(states: string[] = ["awaiting_review"]) {
  const seed = createSeed();
  seed.applicationRecords = [
    ApplicationRecordSchema.parse({
      id: "application_a",
      jobId: "job_ready",
      title: "Synthetic job",
      company: "Synthetic company",
      status: "ready_for_review",
      lastAttemptState: "paused",
      lastActionLabel: "Waiting",
      nextActionLabel: "Review",
      lastUpdatedAt: now,
    }),
  ];
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run_a",
      state: "paused_for_user_review",
      jobIds: ["job_ready"],
      createdAt: now,
      updatedAt: now,
      summary: "Waiting",
      detail: "Synthetic run",
      totalJobs: 1,
    }),
  ];
  seed.applyJobResults = states.map((state, index) =>
    ApplyJobResultSchema.parse({
      id: `result_${index}`,
      runId: "run_a",
      jobId: "job_ready",
      applicationRecordId: "application_a",
      state,
      summary: "Synthetic result",
      detail: "Synthetic result",
      startedAt: now,
      updatedAt: now,
    }),
  );
  return seed;
}

describe("application page ownership", () => {
  test("releases terminal results while retaining waiting and resumable forms", async () => {
    const releaseApplicationPageBinding = vi.fn<
      NonNullable<BrowserSessionRuntime["releaseApplicationPageBinding"]>
    >(() => Promise.resolve());
    const harness = createWorkspaceServiceHarness({
      seed: seedPages([
        "submitted",
        "skipped",
        "cancelled",
        "failed",
        "awaiting_review",
        "blocked",
      ]),
      browserRuntime: {
        ...createBrowserRuntime(),
        releaseApplicationPageBinding,
      },
    });
    await releaseFinishedApplicationPages({ ...harness, runId: "run_a" });
    expect(
      releaseApplicationPageBinding.mock.calls.map((call) => call[1]),
    ).toEqual(["result_0", "result_1", "result_2", "result_3"]);
  });

  test("a tab that will not close leaves the caller's result alone", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: seedPages(["submitted", "blocked"]),
      browserRuntime: {
        ...createBrowserRuntime(),
        releaseApplicationPageBinding: () =>
          Promise.reject(new Error("Target page has been closed")),
        transferApplicationPageBinding: () =>
          Promise.reject(new Error("Target page has been closed")),
      },
    });
    await expect(
      releaseFinishedApplicationPages({ ...harness, runId: "run_a" }),
    ).resolves.toBeUndefined();
    await expect(
      reuseApplicationPage({
        ...harness,
        source: "target_site",
        applicationRecordId: "application_a",
        resultId: "result_next",
      }),
    ).resolves.toBeUndefined();
  });

  test("transfers only a result of the exact application before its replacement starts", async () => {
    const seed = seedPages(["blocked"]);
    seed.applyJobResults.push(
      ApplyJobResultSchema.parse({
        ...seed.applyJobResults[0],
        id: "another_application_result",
        applicationRecordId: "application_b",
      }),
    );
    const transferApplicationPageBinding = vi.fn(() => Promise.resolve(true));
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...createBrowserRuntime(),
        transferApplicationPageBinding,
      },
    });
    await reuseApplicationPage({
      ...harness,
      source: "target_site",
      applicationRecordId: "application_a",
      resultId: "retry_result",
    });
    expect(transferApplicationPageBinding).toHaveBeenCalledExactlyOnceWith(
      "target_site",
      "result_0",
      "retry_result",
    );
  });


  test("a terminal run releases an unfinished form after a cancellation race", async () => {
    const seed = seedPages(["filling", "awaiting_review"]);
    seed.applyRuns = seed.applyRuns?.map((run) => ({
      ...run,
      state: "cancelled" as const,
    }));
    const releaseApplicationPageBinding = vi.fn<
      NonNullable<BrowserSessionRuntime["releaseApplicationPageBinding"]>
    >(() => Promise.resolve());
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...createBrowserRuntime(),
        releaseApplicationPageBinding,
      },
    });
    await releaseFinishedApplicationPages({ ...harness, runId: "run_a" });
    expect(releaseApplicationPageBinding).toHaveBeenCalledExactlyOnceWith(
      "target_site",
      "result_0",
    );
  });


  test.each(["cancel", "skip"] as const)(
    "%s closes a dismissed application's page",
    async (action) => {
      const seed = seedPages(["blocked"]);
      seed.userActionRequests = [
        UserActionRequestSchema.parse({
          id: "request_a",
          dedupeKey: "request_a",
          revision: 1,
          kind: "other",
          state: "pending",
          title: "Synthetic step",
          summary: "Synthetic step",
          instructions: ["Review this step"],
          verification: {
            type: "page_blocker_absent",
            blockerFingerprint: "synthetic_blocker",
            expectedPageFingerprint: null,
          },
          createdAt: now,
          updatedAt: now,
          scope: {
            type: "application",
            source: "target_site",
            runId: "run_a",
            resultId: "result_0",
            jobId: "job_ready",
            applicationRecordId: "application_a",
          },
        }),
      ];
      const releaseApplicationPageBinding = vi.fn<
        NonNullable<BrowserSessionRuntime["releaseApplicationPageBinding"]>
      >(() => Promise.resolve());
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: {
          ...createBrowserRuntime(),
          releaseApplicationPageBinding,
        },
      });
      await harness.workspaceService.performUserAction({
        requestId: "request_a",
        commandId: `command_${action}`,
        expectedRevision: 1,
        action,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      });
      expect(releaseApplicationPageBinding).toHaveBeenCalledWith(
        "target_site",
        "result_0",
      );
    },
  );
});

test.each(["blocked", "awaiting_review"])(
  "restart retires a missing %s form and its stale question controls",
  async (state) => {
    const seed = seedPages([state]);
    if (state === "blocked")
      seed.applyJobResults[0]!.blockerReason = "required_human_input";
    const request = UserActionRequestSchema.parse({
      id: "missing_form_answer",
      dedupeKey: "missing_form_answer",
      revision: 1,
      kind: "manual_answer",
      state: "pending",
      title: "Answer dates",
      summary: "Answer dates",
      instructions: ["Answer"],
      createdAt: now,
      updatedAt: now,
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "dates",
      },
      scope: {
        type: "application",
        source: "target_site",
        runId: "run_a",
        resultId: "result_0",
        jobId: "job_ready",
        applicationRecordId: "application_a",
      },
    });
    seed.userActionRequests = [request];
    expect(isUnsentPreparedApplication(seed.applyJobResults[0]!)).toBe(true);
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...createBrowserRuntime(),
        hasApplicationPageBinding: () => Promise.resolve(false),
      },
    });
    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(
      snapshot.applicationRecords.find(
        (record) => record.id === "application_a",
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      nextActionLabel: "Prepare again",
    });
    expect(
      (await harness.repository.getUserActionRequest(request.id))?.state,
    ).toBe("cancelled");
  },
);

test("releasing one skipped job keeps another job's filling page", async () => {
  const seed = seedPages(["skipped"]);
  seed.applyJobResults.push(
    ApplyJobResultSchema.parse({
      ...seed.applyJobResults[0],
      id: "other_result",
      jobId: "job_other",
      applicationRecordId: "other_record",
      state: "filling",
    }),
  );
  const releaseApplicationPageBinding = vi.fn(() => Promise.resolve());
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: {
      ...createBrowserRuntime(),
      releaseApplicationPageBinding,
    },
  });
  await releaseFinishedApplicationPages({ ...harness, jobId: "job_ready" });
  expect(releaseApplicationPageBinding).toHaveBeenCalledExactlyOnceWith(
    "target_site",
    "result_0",
  );
  expect(
    (await harness.repository.listApplyJobResults()).find(
      (result) => result.id === "other_result",
    )?.state,
  ).toBe("filling");
});


test("restart does not call a missing-resume prerequisite a lost form", () => {
  const seed = seedPages(["blocked"]);
  seed.applyJobResults[0]!.blockerReason = "resume_missing";
  expect(isUnsentPreparedApplication(seed.applyJobResults[0]!)).toBe(false);
});

test("startup leaves stale prepared histories alone for a verified sent job", async () => {
  // The record's own day, so the 14-day no-response follow-up cannot fire as
  // the calendar moves on.
  vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const seed = seedPages(["submitted", "awaiting_review"]);
  const sent = seed.applyJobResults[0]!;
  sent.privacyReceipt = ApplicationPrivacyReceiptSchema.parse({
    generatedAt: now,
    lineage: {
      runId: sent.runId,
      jobId: sent.jobId,
      resultId: sent.id,
      applicationRecordId: "application_a",
    },
    destination: { origin: "http://127.0.0.1:47950", safePath: "/apply" },
    resume: {
      source: "original_upload",
      sourceDocumentId: "synthetic",
      exportArtifactId: null,
      fileName: "synthetic.pdf",
      sha256: "a".repeat(64),
    },
    finalSubmitOccurred: true,
  });
  seed.applicationRecords[0]!.status = "submitted";
  seed.applicationRecords[0]!.lastAttemptState = "submitted";
  seed.applicationRecords[0]!.nextActionLabel = "View application";
  const expected = structuredClone(seed.applicationRecords[0]);
  const hasApplicationPageBinding = vi.fn(() => Promise.resolve(false));
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: { ...createBrowserRuntime(), hasApplicationPageBinding },
  });
  await harness.workspaceService.getWorkspaceSnapshot();
  await harness.workspaceService.getWorkspaceSnapshot();
  await retireLostPreparedApplication({
    repository: harness.repository,
    applicationRecordId: "application_a",
    resultId: "result_1",
    occurredAt: now,
  });
  expect(await harness.repository.listApplicationRecords()).toEqual([expected]);
  expect(hasApplicationPageBinding).not.toHaveBeenCalled();
  expect(
    (await harness.repository.listApplyJobResults()).find(
      (result) => result.id === "result_1",
    )?.state,
  ).toBe("awaiting_review");
});

test("skipping a waiting job preserves its filling sibling and the sibling can finish the run", async () => {
  const seed = seedPages(["awaiting_review"]);
  seed.applyRuns[0]!.state = "running";
  seed.applyRuns[0]!.jobIds = ["job_ready", "job_other"];
  seed.applyRuns[0]!.totalJobs = 2;
  seed.applyRuns[0]!.currentJobId = "job_other";
  seed.applyJobResults.push(
    ApplyJobResultSchema.parse({
      ...seed.applyJobResults[0],
      id: "other_result",
      jobId: "job_other",
      applicationRecordId: "other_record",
      state: "filling",
    }),
  );
  const request = UserActionRequestSchema.parse({
    id: "skip_request",
    revision: 1,
    dedupeKey: "skip_request",
    kind: "manual_answer",
    state: "cancelled",
    title: "Answer",
    summary: "Answer",
    createdAt: now,
    updatedAt: now,
    verification: { type: "page_blocker_absent", blockerFingerprint: "answer" },
    scope: {
      type: "application",
      source: "target_site",
      runId: "run_a",
      resultId: "result_0",
      jobId: "job_ready",
      applicationRecordId: "application_a",
    },
  });
  const harness = createWorkspaceServiceHarness({ seed });
  await releaseApplicationRecordAfterDismissedUserAction({
    repository: harness.repository,
    request,
    occurredAt: now,
    eventId: "skip",
    dismissal: "skipped",
  });
  const run = (await harness.repository.listApplyRuns())[0]!;
  expect(run).toMatchObject({
    state: "running",
    currentJobId: "job_other",
    pendingJobs: 1,
    completedAt: null,
  });
  const results = await harness.repository.listApplyJobResults();
  expect(results.find((result) => result.id === "other_result")).toMatchObject({
    state: "filling",
    summary: "Synthetic result",
  });
  const finished = reconcileApplyRunAfterConfirmedSubmission({
    run,
    results: results.map((result) =>
      result.id === "other_result" ? { ...result, state: "submitted" } : result,
    ),
    submittedAt: now,
    submittedSummary: "Sent",
    submittedDetail: "The site confirmed receipt.",
  });
  expect(finished).toMatchObject({
    state: "completed",
    pendingJobs: 0,
    submittedJobs: 1,
    skippedJobs: 1,
  });
});

test("Prepare again opens a fresh form when the earlier page cannot accept the approved letter", async () => {
  const seed = seedPages();
  seed.applyJobResults[0] = ApplyJobResultSchema.parse({
    ...seed.applyJobResults[0],
    reviewCard: {
      siteLabel: "Synthetic careers",
      preparedAt: now,
      letter: { text: "Earlier letter", needsRefresh: true },
    },
  });
  const transferApplicationPageBinding = vi.fn(() => Promise.resolve(true));
  const releaseApplicationPageBinding = vi.fn(() => Promise.resolve());
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: {
      ...createBrowserRuntime(),
      transferApplicationPageBinding,
      releaseApplicationPageBinding,
    },
  });
  await reuseApplicationPage({
    ...harness,
    source: "target_site",
    applicationRecordId: "application_a",
    resultId: "new_result",
  });
  expect(releaseApplicationPageBinding).toHaveBeenCalledWith(
    "target_site",
    "result_0",
  );
  expect(transferApplicationPageBinding).not.toHaveBeenCalled();
});
