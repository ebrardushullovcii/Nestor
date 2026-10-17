import {
  ApplicationAttemptBlockerSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { persistApplicationUserAction } from "./internal/workspace-application-user-action";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-09-24T00:20:00.000Z";

function seedPrepared(state: "awaiting_review" | "blocked") {
  const seed = createSeed();
  seed.applicationRecords = [
    ApplicationRecordSchema.parse({
      id: "application_a",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Ready to send",
      nextActionLabel: "Open the application and finish it",
      lastUpdatedAt: now,
    }),
  ];
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run_prepared",
      campaignId: null,
      state: "paused_for_user_review",
      jobIds: ["job_ready"],
      currentJobId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      summary: "Filled in and waiting.",
      detail: "Nothing was sent.",
      totalJobs: 1,
      pendingJobs: 0,
    }),
  ];
  seed.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "result_a",
      runId: "run_prepared",
      jobId: "job_ready",
      applicationRecordId: "application_a",
      state,
      summary: "Filled in.",
      detail: "Nothing was sent.",
      startedAt: now,
      updatedAt: now,
    }),
  ];
  return seed;
}

describe("opening a prepared application to finish it", () => {
  test("lets the person's own send through on that exact page", async () => {
    const handApplicationPageToPerson = vi.fn(() => Promise.resolve());
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: seedPrepared("awaiting_review"),
      browserRuntime: {
        ...createBrowserRuntime(),
        focusApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
        handApplicationPageToPerson,
      },
    });

    await workspaceService.focusPreparedApplicationPage({
      runId: "run_prepared",
      jobId: "job_ready",
      resultId: "result_a",
      applicationRecordId: "application_a",
    });

    expect(handApplicationPageToPerson).toHaveBeenCalledTimes(1);
    expect(handApplicationPageToPerson).toHaveBeenCalledWith(
      expect.anything(),
      "result_a",
    );
  });

  test("keeps the page locked when the application is not filled in yet", async () => {
    const handApplicationPageToPerson = vi.fn(() => Promise.resolve());
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: seedPrepared("blocked"),
      browserRuntime: {
        ...createBrowserRuntime(),
        focusApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
        handApplicationPageToPerson,
      },
    });

    await workspaceService.focusPreparedApplicationPage({
      runId: "run_prepared",
      jobId: "job_ready",
      resultId: "result_a",
      applicationRecordId: "application_a",
    });

    expect(handApplicationPageToPerson).not.toHaveBeenCalled();
  });

  test("a later workspace read does not take the page back from the person", async () => {
    const seed = seedPrepared("awaiting_review");
    // The question this application stopped on was answered earlier: a
    // resolved step every snapshot re-checks for a continuation.
    seed.userActionRequests = [
      UserActionRequestSchema.parse({
        id: "request_answered",
        dedupeKey: "dedupe_request_answered",
        revision: 3,
        kind: "manual_answer",
        state: "resolved",
        requirement: "required",
        scope: {
          type: "application",
          runId: "run_prepared",
          jobId: "job_ready",
          applicationRecordId: "application_a",
          resultId: "result_a",
          replayCheckpointId: "checkpoint_a",
          source: "target_site",
        },
        verification: {
          type: "page_blocker_absent",
          blockerFingerprint: "blocker_a",
          expectedPageFingerprint: null,
        },
        title: "Answer the required question",
        summary: "A question needed you.",
        instructions: [],
        actionUrl: null,
        displayOrigin: null,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        openedAt: null,
        resolvedAt: now,
        expiresAt: null,
      }),
    ];
    const handApplicationPageToPerson = vi.fn(() => Promise.resolve());
    const closeApplicationFormAction = vi.fn(() => Promise.resolve());
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...createBrowserRuntime(),
        focusApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
        handApplicationPageToPerson,
        closeApplicationFormAction,
      },
    });

    await workspaceService.focusPreparedApplicationPage({
      runId: "run_prepared",
      jobId: "job_ready",
      resultId: "result_a",
      applicationRecordId: "application_a",
    });
    await workspaceService.getWorkspaceSnapshot();
    await workspaceService.getWorkspaceSnapshot();

    expect(handApplicationPageToPerson).toHaveBeenCalledTimes(1);
    expect(closeApplicationFormAction).not.toHaveBeenCalled();
  });

  test("a form the person sent on that page is recorded as sent by them, and nothing else is", async () => {
    const page = (bodyText: string) => ({
      url: "https://jobs.example.com/apply",
      title: "Apply",
      bodyText,
      headings: [],
      controls: [],
      actions: [],
      links: [],
      clickables: [],
      openedTabs: [],
      validationErrors: [],
      stepLabel: null,
      loading: false,
    });
    let shown = page("Apply: Senior Product Designer. Submit application");
    const readApplicationPageWithPerson = vi.fn(() => Promise.resolve(shown));
    const releaseApplicationPageBinding = vi.fn(() => Promise.resolve());
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: seedPrepared("awaiting_review"),
      browserRuntime: {
        ...createBrowserRuntime(),
        readApplicationPageWithPerson,
        releaseApplicationPageBinding,
      },
    });

    // Still the form: nothing recorded.
    expect(await workspaceService.recordApplicationsSentByPerson()).toBe(0);

    shown = page("Thank you! Your application has been received.");
    expect(await workspaceService.recordApplicationsSentByPerson()).toBe(1);
    const [result] = await repository.listApplyJobResults({
      runId: "run_prepared",
    });
    expect(result).toMatchObject({
      state: "submitted",
      summary: "You sent this application yourself on the site.",
    });
    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.id === "application_a",
    );
    expect(record).toMatchObject({
      status: "submitted",
      lastAttemptState: "submitted",
    });
    expect(releaseApplicationPageBinding).toHaveBeenCalledWith(
      expect.anything(),
      "result_a",
    );
    // Recorded once.
    expect(await workspaceService.recordApplicationsSentByPerson()).toBe(0);
  });

  test.each([true, false])(
    "the person's send keeps its site reference, with an older privacy receipt: %s",
    async (withReceipt) => {
      const seed = seedPrepared("awaiting_review");
      if (withReceipt)
        seed.applyJobResults = seed.applyJobResults.map((result) =>
          ApplyJobResultSchema.parse({
            ...result,
            privacyReceipt: {
              generatedAt: now,
              lineage: {
                runId: "run_prepared",
                jobId: "job_ready",
                resultId: "result_a",
                applicationRecordId: "application_a",
              },
              destination: {
                origin: "https://jobs.example.com",
                safePath: "/jobs/1",
              },
              resume: {
                source: "tailored_export",
                sourceDocumentId: null,
                exportArtifactId: "resume_export_a",
                fileName: "resume.pdf",
                sha256: "a".repeat(64),
              },
            },
          }),
        );
      const { repository, workspaceService } = createWorkspaceServiceHarness({
        seed,
        browserRuntime: {
          ...createBrowserRuntime(),
          readApplicationPageWithPerson: vi.fn(() =>
            Promise.resolve({
              url: "https://jobs.example.com/apply/1?ref=x",
              title: "Thanks",
              bodyText:
                "Thank you! Your application has been received. Reference: SYN-42.",
              headings: [],
              controls: [],
              actions: [],
              links: [],
              clickables: [],
              openedTabs: [],
              validationErrors: [],
              stepLabel: null,
              loading: false,
            }),
          ),
          releaseApplicationPageBinding: vi.fn(() => Promise.resolve()),
        },
      });

      expect(await workspaceService.recordApplicationsSentByPerson()).toBe(1);
      const [result] = await repository.listApplyJobResults({
        runId: "run_prepared",
      });
      const [record] = await repository.listApplicationRecords();
      expect(record?.personSendReceipt).toMatchObject({
        origin: "https://jobs.example.com",
        safePath: "/apply/1",
        summary: "The site confirmed receipt. Reference: SYN-42.",
      });
      if (!withReceipt) {
        expect(result?.privacyReceipt).toBeNull();
        expect(record?.lastAttemptState).toBe("submitted");
        return;
      }
      expect(result?.privacyReceipt).toMatchObject({
        finalSubmitOccurred: true,
        submissionOutcome: {
          outcome: "submitted",
          resultId: "result_a",
          retry: { eligible: false, blockReason: "submission_confirmed" },
          evidence: [
            {
              kind: "employer_site_state",
              summary: "The site confirmed receipt. Reference: SYN-42.",
              destination: {
                origin: "https://jobs.example.com",
                safePath: "/apply/1",
              },
            },
          ],
        },
      });
    },
  );

  test("a page not handed to the person is never read as their send", async () => {
    const readApplicationPageWithPerson = vi.fn(() => Promise.resolve(null));
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: seedPrepared("awaiting_review"),
      browserRuntime: {
        ...createBrowserRuntime(),
        readApplicationPageWithPerson,
      },
    });
    expect(await workspaceService.recordApplicationsSentByPerson()).toBe(0);
    const [result] = await repository.listApplyJobResults({
      runId: "run_prepared",
    });
    expect(result?.state).toBe("awaiting_review");
  });

  test("a finished step's snapshot recovery does not lock the page handed to the person", async () => {
    const closeApplicationFormAction = vi.fn(() => Promise.resolve());
    const drafting = createWorkspaceServiceHarness({ seed: createSeed() });
    const harness = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime: {
        ...createBrowserRuntime(),
        closeApplicationFormAction,
      },
    });
    const job = (await harness.repository.listSavedJobs())[0];
    if (!job) throw new Error("Expected a saved job fixture.");
    await persistApplicationUserAction({
      repository: drafting.repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: "run_answered",
      resultId: "result_answered",
      replayCheckpointId: "checkpoint_answered",
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        url: job.applicationUrl ?? job.canonicalUrl,
      }),
      occurredAt: now,
    });
    const request = (await drafting.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected a request.");

    // Settled long ago: every snapshot re-reads it, and each read used to
    // close the send window of the filled-in form the person had opened.
    await harness.repository.createUserActionRequest({
      ...request,
      state: "resolved",
      resolvedAt: now,
    });
    expect((await harness.repository.listUserActionRequests())[0]?.state).toBe(
      "resolved",
    );
    await harness.workspaceService.getWorkspaceSnapshot();
    await harness.workspaceService.getWorkspaceSnapshot();
    expect(closeApplicationFormAction).not.toHaveBeenCalled();
  });
});
