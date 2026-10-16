import { describe, expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-harness";
import { createAiClient } from "../workspace-service.test-runtimes";
import { createSeed } from "../workspace-service.test-fixtures";

describe("Add this job", () => {
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
