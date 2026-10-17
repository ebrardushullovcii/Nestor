import type { ResumeResearchArtifact } from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

function createCountingResearchAdapter(
  fetchStatus: ResumeResearchArtifact["fetchStatus"] = "success",
) {
  let callCount = 0;

  return {
    get callCount() {
      return callCount;
    },
    fetchResearchPages(input: { job: { id: string } }) {
      callCount += 1;
      return Promise.resolve([
        {
          id: `research_${input.job.id}_company`,
          jobId: input.job.id,
          sourceUrl: "https://signalsystems.example/about",
          pageTitle: "About Signal Systems",
          fetchedAt: new Date().toISOString(),
          extractedText: "Signal Systems builds workflow automation software.",
          companyNotes: "Signal Systems builds workflow automation software.",
          domainVocabulary: ["workflow", "automation"],
          priorityThemes: ["workflow automation"],
          fetchStatus,
        } satisfies ResumeResearchArtifact,
      ]);
    },
  };
}

describe("resume research reuse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reuses recent research for immediate repeated generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const researchAdapter = createCountingResearchAdapter();
    const { workspaceService } = createWorkspaceServiceHarness({
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");
    await workspaceService.regenerateResumeDraft("job_ready");

    expect(researchAdapter.callCount).toBe(1);
  });

  test("refetches stale research", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const researchAdapter = createCountingResearchAdapter();
    const { workspaceService } = createWorkspaceServiceHarness({
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");
    vi.advanceTimersByTime(16 * 60 * 1_000);
    await workspaceService.generateResume("job_ready");

    expect(researchAdapter.callCount).toBe(2);
  });

  test("refetches when the saved job revision changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const researchAdapter = createCountingResearchAdapter();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");
    await repository.commitSavedJobDelta({
      update: (job) =>
        job.id === "job_ready"
          ? { ...job, description: `${job.description} Updated requirement.` }
          : job,
    });
    await workspaceService.generateResume("job_ready");

    expect(researchAdapter.callCount).toBe(2);
  });

  test("refetches persisted research when provenance is missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const seed = createSeed();
    seed.resumeResearchArtifacts = [
      {
        id: "research_job_ready_existing",
        jobId: "job_ready",
        sourceUrl: "https://signalsystems.example/about",
        pageTitle: "Existing research",
        fetchedAt: new Date().toISOString(),
        extractedText: "Existing evidence without revision provenance.",
        companyNotes: null,
        domainVocabulary: [],
        priorityThemes: [],
        fetchStatus: "success",
      },
    ];
    const researchAdapter = createCountingResearchAdapter();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");

    expect(researchAdapter.callCount).toBe(1);
  });

  test("refetches when proven research is no longer persisted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const seed = createSeed();
    const researchAdapter = createCountingResearchAdapter();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");
    await repository.reset({
      ...seed,
      resumeResearchArtifacts: [],
    });
    await workspaceService.generateResume("job_ready");

    expect(researchAdapter.callCount).toBe(2);
  });

  test("does not cache failed research as reusable evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const researchAdapter = createCountingResearchAdapter("failed");
    const { workspaceService } = createWorkspaceServiceHarness({
      researchAdapter,
    });

    await workspaceService.generateResume("job_ready");
    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(researchAdapter.callCount).toBe(2);
    expect(workspace.research).toEqual([
      expect.objectContaining({ fetchStatus: "failed" }),
    ]);
  });
});
