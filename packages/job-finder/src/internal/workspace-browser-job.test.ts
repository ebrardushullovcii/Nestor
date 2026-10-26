import { describe, expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-harness";
import { createAiClient } from "../workspace-service.test-runtimes";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  AiBehaviorPreferenceSchema,
  JobSearchCampaignSchema,
  getDefaultCampaignConfiguration,
} from "@nestor/contracts";
import type { JobFinderAiClient } from "@nestor/ai-providers";

describe("Add this job", () => {
  it("judges browser jobs with Settings and Profile goals, without filing under a retired plan", async () => {
    const base = createSeed();
    const now = "2026-10-26T00:00:00.000Z";
    const plan = JobSearchCampaignSchema.parse({
      id: "retired",
      name: "Retired plan",
      mode: "precision",
      status: "active",
      createdAt: now,
      updatedAt: now,
      searchPreferences: {
        ...base.searchPreferences,
        targetRoles: ["Retired plan role"],
      },
      ...getDefaultCampaignConfiguration("precision"),
      progress: { lastUpdatedAt: now },
    });
    const posting = {
      ...base.savedJobs[0]!,
      canonicalUrl: "https://board.example.test/jobs/policy",
      sourceJobId: "policy",
    };
    const assessJobFit = vi.fn<JobFinderAiClient["assessJobFit"]>(() =>
      Promise.resolve({
        score: 82,
        reasons: ["Synthetic fit"],
        gaps: ["Outside preferred places"],
        recommendation: "review_before_applying",
        role: "exact",
        preferences: "conflict",
        requirements: [
          {
            id: "role",
            label: "Role",
            status: "supported",
            category: "skill",
            importance: "required",
            jobEvidence: "Role",
            resumeEvidence: [],
            explanation: "Synthetic evidence",
          },
        ],
      }),
    );
    const finished = vi.fn();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed: {
        ...base,
        searchPreferences: {
          ...base.searchPreferences,
          targetRoles: ["Current Profile role"],
        },
        settings: {
          ...base.settings,
          aiBehavior: AiBehaviorPreferenceSchema.parse({
            jobSearch: { remoteCountsAsAnyLocation: false },
          }),
        },
        campaigns: [plan],
        activeCampaignId: plan.id,
      },
      aiClient: {
        ...createAiClient(),
        extractJobsFromPage: () => Promise.resolve([posting]),
        assessJobFit,
      },
      onListingAssessmentFinished: finished,
    });
    const saved = await workspaceService.addJobFromBrowserPage({
      html: "<main>Synthetic job</main>",
      pageUrl: posting.canonicalUrl,
    });
    await vi.waitFor(() => expect(finished).toHaveBeenCalled());
    expect(assessJobFit.mock.calls[0]?.[0].searchPreferences).toMatchObject({
      targetRoles: ["Current Profile role"],
      discovery: { remoteCountsAsAnyLocation: false },
    });
    const job = (await repository.listSavedJobs()).find(
      (row) => row.id === saved.jobId,
    )!;
    expect(job.matchAssessment.score).toBe(82);
    expect(job.planAssessments ?? {}).toEqual({});
    expect(saved.planName).toBeNull();
  });
  it("returns the saved record before fit judging finishes", async () => {
    let finish!: () => void;
    let judged = false;
    const assessJobFit = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      judged = true;
      return null;
    });
    const posting = {
      ...createSeed().savedJobs[0]!,
      canonicalUrl: "https://board.example.test/jobs/new",
      sourceJobId: "new",
    };
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      aiClient: {
        ...createAiClient(),
        extractJobsFromPage: vi.fn().mockResolvedValue([posting]),
        assessJobFit,
      },
    });
    const saved = await workspaceService.addJobFromBrowserPage({
      html: "<main>Job</main>",
      pageUrl: posting.canonicalUrl,
    });
    expect(assessJobFit).toHaveBeenCalledOnce();
    expect(judged).toBe(false);
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === saved.jobId)
        ?.personSupplied,
    ).toBe(true);
    expect(saved.company).toBe(posting.company);
    finish();
    await vi.waitFor(() => expect(judged).toBe(true));
  });
  it("reads the page with the model and saves its listing source without shortlisting automatically", async () => {
    const posting = {
      ...createSeed().savedJobs[0]!,
      canonicalUrl: "https://board.example.test/jobs/browsed",
      sourceJobId: "browsed",
      title: "Browsed designer",
    };
    const extractJobsFromPage = vi.fn().mockResolvedValue([posting]);
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      aiClient: { ...createAiClient(), extractJobsFromPage },
    });
    const saved = await workspaceService.addJobFromBrowserPage({
      html: '<main>Browsed designer</main><a href="/apply/browsed">Apply</a>',
      pageUrl: posting.canonicalUrl,
    });
    expect(extractJobsFromPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageType: "job_detail",
        maxJobs: 1,
        pageText: expect.stringContaining("Browsed designer") as unknown,
      }),
    );
    const job = (await repository.listSavedJobs()).find(
      (job) => job.id === saved.jobId,
    )!;
    expect(job.canonicalUrl).toBe(posting.canonicalUrl);
    expect(job.provenance.at(-1)?.startingUrl).toBe(posting.canonicalUrl);
    expect(job.status).toBe("discovered");
    expect(job.personSupplied).toBe(true);
    expect(saved.title).toBe(posting.title);
  });
  it("reports a non-listing and does not save anything", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      aiClient: {
        ...createAiClient(),
        extractJobsFromPage: vi.fn().mockResolvedValue([]),
      },
    });
    const before = await repository.listSavedJobs();
    await expect(
      workspaceService.addJobFromBrowserPage({
        html: "Sign in",
        pageUrl: "https://board.example.test/login",
      }),
    ).rejects.toThrow("No job listing");
    expect(await repository.listSavedJobs()).toEqual(before);
    await expect(
      workspaceService.addJobFromBrowserPage({
        html: "",
        pageUrl: "file:///tmp/a",
      }),
    ).rejects.toThrow("website");
  });
});
