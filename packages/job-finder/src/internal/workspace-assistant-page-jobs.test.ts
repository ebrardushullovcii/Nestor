import { JobPostingSchema } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../workspace-service.test-support";

describe("saving jobs from a page", () => {
  it("leaves an already saved job's company, title and triage alone", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();
    const before = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_ready",
    )!;
    const posting = JobPostingSchema.parse({
      ...before,
      company: "Copper Kite",
      title: `${before.title} (page copy)`,
    });
    const saved = await workspaceService.saveJobsFromPage({
      postings: [posting],
      pageUrl: "http://127.0.0.1:47950/lever/",
    });
    expect(saved.mergedJobIds).toContain("job_ready");
    const after = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_ready",
    )!;
    expect(after.company).toBe(before.company);
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(after.provenance.length).toBeGreaterThanOrEqual(
      before.provenance.length,
    );
  });
});

describe("reporting what a page save touched", () => {
  it("does not report a saved job the merge kept apart as already saved", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();
    const template = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_ready",
    )!;
    const pageUrl = "http://127.0.0.1:47950/greenhouse/";
    const first = JobPostingSchema.parse({
      ...template,
      source: "target_site",
      sourceJobId: "2",
      title: "Backend Engineer, Lantern Services",
      company: "Moss Lantern",
      canonicalUrl: "http://127.0.0.1:47950/greenhouse/jobs/2",
      applicationUrl: "http://127.0.0.1:47950/greenhouse/jobs/2",
      employerWebsiteUrl: null,
      employerDomain: null,
    });
    const firstSave = await workspaceService.saveJobsFromPage({
      postings: [first],
      pageUrl,
    });
    const firstId = firstSave.newJobIds[0]!;
    const before = (await repository.listSavedJobs()).find(
      (job) => job.id === firstId,
    )!;
    // Same source id on another board, different employer and URL: the
    // merge keeps it apart as its own job.
    const second = JobPostingSchema.parse({
      ...first,
      title: "Gardener, Botanical Archive",
      company: "Unrelated Greenhouse Collective",
      canonicalUrl: "http://127.0.0.1:47950/lever/jobs/2",
      applicationUrl: "http://127.0.0.1:47950/lever/jobs/2",
    });
    const saved = await workspaceService.saveJobsFromPage({
      postings: [second],
      pageUrl: "http://127.0.0.1:47950/lever/",
    });
    const after = (await repository.listSavedJobs()).find(
      (job) => job.id === firstId,
    )!;
    expect(saved.newJobIds).toHaveLength(1);
    expect(saved.newJobIds[0]).not.toBe(firstId);
    expect(saved.mergedJobIds).not.toContain(firstId);
    expect(after.provenance).toHaveLength(before.provenance.length);
    expect(after.company).toBe("Moss Lantern");
  });
});
