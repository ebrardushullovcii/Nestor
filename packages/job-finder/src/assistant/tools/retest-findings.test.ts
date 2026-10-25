import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildContextBlock,
  buildProfileDigest,
  plainFieldName,
} from "../prompt";
import type { AssistantTurnSession } from "../tool-kit";
import {
  applyToJobsTool,
  getApplicationRunTool,
} from "./application-tools";
import { listDocumentsTool } from "./profile-tools";
import { searchForJobsTool } from "./jobs-tools";
import { setResumeTemplateTool } from "./resume-tools";
import { resolveNeedsYouTool } from "./workspace-tools";

const session = {
  assertCurrent: () => undefined,
  assertPersonAnswerAuthority: () => Promise.resolve(),
  createId: () => "id_1",
  watchRun: () => Promise.resolve(),
  grants: { list: () => Promise.resolve([]) },
} as unknown as AssistantTurnSession;

async function rejection(work: Promise<unknown>): Promise<Error | null> {
  return work.then(
    () => null,
    (caught: unknown) => caught as Error,
  );
}

describe("the person's pause (R2)", () => {
  it("does not start a search or lift the pause; it tells the model to ask", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.setActivityControl({
      paused: true,
      reason: "Taking a break",
    });
    const startSearch = vi.fn();
    const error = await rejection(
      searchForJobsTool.execute(
        { goal: "frontend roles", freshness: "any" },
        {
          service: workspaceService,
          session,
          ports: { startSearch } as unknown as AssistantHostPorts,
        },
      ),
    );
    expect(error?.message).toContain("the person paused background work");
    expect(error?.message).toContain("ask whether to resume");
    expect(error?.message).toContain("Taking a break");
    expect(startSearch).not.toHaveBeenCalled();
    const after = await workspaceService.getWorkspaceSnapshot();
    expect(after.activityControl.paused).toBe(true);
  });

  it("does not start applications while paused either", async () => {
    const startApplications = vi.fn();
    const snapshot = {
      activityControl: { paused: true, pausedAt: null, reason: null },
      applyRuns: [],
      applyJobResults: [],
      applicationRecords: [],
      discoveryJobs: [],
      companyJobs: [],
      dismissedDiscoveryJobs: [],
      searchPreferences: { companyBlacklist: [] },
      settings: {},
      userActionRequests: [],
    } as unknown as JobFinderWorkspaceSnapshot;
    const error = await rejection(
      applyToJobsTool.execute(
        { jobIds: ["job_1"], evenIfExcludedOrApplied: false },
        {
          service: {
            getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          } as never,
          session,
          ports: { startApplications } as unknown as AssistantHostPorts,
        },
      ),
    );
    expect(error?.message).toContain("the person paused background work");
    expect(startApplications).not.toHaveBeenCalled();
  });
});

describe("a template change on an approved resume (R3)", () => {
  it("says in the same result that approval was cleared", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", artifact.id);
    const before = await workspaceService.getResumeWorkspace("job_ready");
    expect(before.draft.status).toBe("approved");
    const other =
      before.draft.templateId === "modern_split"
        ? "classic_ats"
        : "modern_split";

    const outcome = await setResumeTemplateTool.execute(
      { jobId: "job_ready", templateId: other },
      {
        service: workspaceService,
        session,
        ports: { publishWorkspaceUpdate: () => undefined } as never,
      },
    );
    expect(outcome.summary).toContain("cleared the resume's approval");
    expect(outcome.data).toMatchObject({ approvalCleared: true });
  });
});

describe("answers the person gives through Needs you (R7)", () => {
  it("keeps a lasting answer for later applications when asked to", async () => {
    const performUserAction = vi.fn().mockResolvedValue(undefined);
    const request = {
      id: "step_1",
      revision: 1,
      state: "pending",
      title: "Answer the required question",
      scope: {
        type: "application",
        jobId: "job_1",
        runId: "run_1",
        resultId: "result_1",
        applicationRecordId: "application_job_1",
      },
    };
    const snapshot = {
      applyRuns: [],
      applyJobResults: [],
      userActionRequests: [request],
    } as unknown as JobFinderWorkspaceSnapshot;
    await resolveNeedsYouTool.execute(
      resolveNeedsYouTool.input.parse({
        requestId: "step_1",
        action: "answer",
        answer: "Yes",
        saveForLater: true,
      }),
      {
        service: {
          getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          performUserAction,
          getApplyRunDetails: () => Promise.resolve({ questionRecords: [] }),
        } as never,
        session,
        ports: {} as AssistantHostPorts,
      },
    );
    expect(performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "submit_manual_answer",
        answer: "Yes",
        saveForFuture: true,
      }),
    );
  });

  it("says an answer being put on the form is not waiting on the person", async () => {
    const snapshot = {
      applyRuns: [{ id: "run_1", state: "paused_for_user_review" }],
      applyJobResults: [
        {
          id: "result_1",
          runId: "run_1",
          jobId: "job_1",
          state: "awaiting_review",
          updatedAt: "2026-09-27T10:00:00.000Z",
        },
      ],
      applicationRecords: [],
      userActionRequests: [
        {
          id: "step_1",
          state: "verifying",
          title: "Answer the required question",
          scope: { type: "application", jobId: "job_1" },
        },
      ],
    } as unknown as JobFinderWorkspaceSnapshot;
    const outcome = await getApplicationRunTool.execute(
      { jobId: "job_1" },
      {
        service: {
          getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          getApplyRunDetails: () => Promise.resolve(null),
        } as never,
        session,
        ports: {} as AssistantHostPorts,
      },
    );
    expect(outcome.summary).toContain("It is not waiting on the person");
  });
});

describe("what the model is told (R1, R4, R5)", () => {
  it("knows attached files are used for applications", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const block = buildContextBlock({
      context: {
        screen: "settings",
        route: "/job-finder/settings",
        sectionLabel: null,
        focus: null,
        list: null,
        editor: null,
        browser: null,
        selectedText: null,
        mentions: [],
        attachments: [
          {
            documentId: "asset_1",
            fileName: "portfolio.pdf",
            mimeType: "application/pdf",
            byteSize: 10,
          },
        ],
        capturedAt: "2026-09-28T00:00:00.000Z",
      } as never,
      resultSets: [],
      snapshot,
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(block).toContain(
      "uploads the matching one to that form's file field",
    );
    expect(listDocumentsTool.description).toContain("no extra step is needed");
  });

  it("does not ask for an extra proposal on every reply by default", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const digest = buildProfileDigest(
      await workspaceService.getWorkspaceSnapshot(),
    );
    expect(digest).not.toContain("add exactly one closely related improvement");
    expect(digest).toContain("Never add one during profile setup");
    expect(digest).toContain("acknowledge the saved result and stop");
  });

  it("keeps unrelated shortlist resumes out of page context while retaining focused saved truth", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const focused = snapshot.reviewQueue[0]!;
    snapshot.reviewQueue = [
      focused,
      ...Array.from({ length: 200 }, (_, index) => ({
        ...focused,
        jobId: `unrelated_${index}`,
        title: `Unrelated resume ${index}`,
      })),
    ];
    const block = buildContextBlock({
      context: {
        screen: "resume_studio",
        route: "/",
        focus: { kind: "job", id: focused.jobId, label: null },
        sectionLabel: null,
        list: null,
        editor: null,
        browser: null,
        selectedText: null,
        mentions: [],
        attachments: [],
        capturedAt: "2026-09-28T00:00:00.000Z",
      },
      snapshot,
      resultSets: [],
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(block).toContain(`"jobId":"${focused.jobId}"`);
    expect(block).toContain("201 jobs shortlisted in total");
    expect(block).not.toContain("Unrelated resume");
    expect(block).not.toContain("unrelated_199");
  });

  it("names screens as the app shows them", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const block = buildContextBlock({
      context: {
        screen: "review_queue",
        route: "/job-finder/review-queue",
        sectionLabel: null,
        focus: null,
        list: null,
        editor: null,
        browser: null,
        selectedText: null,
        mentions: [],
        attachments: [],
        capturedAt: "2026-09-28T00:00:00.000Z",
      } as never,
      resultSets: [],
      snapshot: await workspaceService.getWorkspaceSnapshot(),
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(block).toContain("Screen: Shortlisted (id review_queue)");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Find jobs, Shortlisted");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never by routes or ids");
    // The resume screen sits under Shortlisted; "on Resume" named no place.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Shortlisted › Resume");
  });

  it("names fields as the app labels them", () => {
    expect(plainFieldName("jobFamilies")).toBe("Related role areas");
    expect(plainFieldName("preferences.seniorityLevels")).toBe(
      "Seniority levels",
    );
    expect(plainFieldName("noticePeriodDays")).toBe("Notice period days");
  });
});
