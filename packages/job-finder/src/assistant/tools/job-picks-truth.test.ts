import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { createJobCaveats } from "./format";
import { applyHereTool, readPageTextWithLinks } from "./browser-tools";
import {
  excludeEmployerTool,
  queryJobsTool,
  shortlistJobsTool,
} from "./jobs-tools";

function world() {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  const found = (id: string, company: string, title: string) => ({
    ...base,
    id,
    sourceJobId: `${id}_source`,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applicationUrl: `https://jobs.example.test/${id}/apply`,
    company,
    title,
    status: "discovered" as const,
  });
  seed.savedJobs = [
    ...seed.savedJobs,
    found("job_pebble_1", "Pebble Orbit", "Frontend Engineer"),
    found("job_pebble_2", "Pebble Orbit", "Backend Engineer"),
    found("job_pebble_3", "Pebble Orbit", "Data Engineer"),
    found("job_other", "Harbor Mutual", "UX Designer"),
  ];
  const { workspaceService } = createWorkspaceServiceHarness({ seed });
  let sets = 0;
  const session = {
    assertCurrent: () => undefined,
    now: () => new Date().toISOString(),
    createId: (prefix: string) => `${prefix}_1`,
    createResultSet: (input: { itemIds: readonly string[] }) =>
      Promise.resolve({ id: `rs_${(sets += 1)}`, itemIds: input.itemIds }),
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate: () => undefined,
  } as unknown as AssistantHostPorts;
  return { service: workspaceService, session, ports };
}

describe("job picks tell the truth and respect exclusions", () => {
  it("hides every found job from an excluded employer and says what is still listed", async () => {
    const context = world();
    const result = await excludeEmployerTool.execute(
      { jobId: "job_pebble_1" },
      context,
    );
    const snapshot = await context.service.getWorkspaceSnapshot();
    const stillFound = snapshot.discoveryJobs.filter(
      (job) => job.company === "Pebble Orbit" && job.status === "discovered",
    );
    expect(stillFound).toEqual([]);
    expect(result.summary).toContain("Hidden now: 3 found jobs");
    expect(result.summary).toContain("No found jobs from them are listed");
  });

  it("leaves excluded employers out of picks and holds them back from the shortlist", async () => {
    const context = world();
    await context.service.saveSearchPreferences({
      ...(await context.service.getWorkspaceSnapshot()).searchPreferences,
      companyBlacklist: ["Pebble Orbit"],
    });
    const query = await queryJobsTool.execute(
      {
        scope: "found",
        sort: "score",
        limit: 10,
        includeExcludedEmployers: false,
        show: true,
      },
      context,
    );
    const ids = (query.data as { jobs: { id: string }[] }).jobs.map(
      (job) => job.id,
    );
    expect(ids).toEqual(["job_other"]);
    const shortlist = await shortlistJobsTool.execute(
      { jobIds: ["job_pebble_2", "job_other"], evenIfExcludedOrApplied: false },
      context,
    );
    expect(shortlist.data).toEqual([
      {
        jobId: "job_pebble_2",
        outcome: "held back: the person excluded Pebble Orbit",
      },
      { jobId: "job_other", outcome: "shortlisted" },
    ]);
  });

  it("marks the same posting on another site as already applied (one job across sources)", () => {
    const applied = {
      id: "job_greenhouse",
      title: "Frontend Engineer, Cedar Components",
      company: "Cedar Compass Studio",
      description:
        "Build the component library used by every Cedar product team across web and mobile.",
      status: "submitted",
    };
    const copy = {
      ...applied,
      id: "job_gatekeeper",
      company: "Pebble Orbit",
      status: "discovered",
    };
    const snapshot = {
      discoveryJobs: [applied, copy],
      companyJobs: [],
      dismissedDiscoveryJobs: [],
      applicationRecords: [{ jobId: "job_greenhouse", status: "submitted" }],
      searchPreferences: { companyBlacklist: [] },
    } as unknown as JobFinderWorkspaceSnapshot;
    const caveats = createJobCaveats(snapshot)(
      copy as unknown as JobFinderWorkspaceSnapshot["discoveryJobs"][number],
    );
    expect(caveats.alreadyAppliedAs).toEqual({
      jobId: "job_greenhouse",
      status: "submitted",
    });
  });

  it("says when 'apply on this link' will run on another site's saved job", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const existing = snapshot.discoveryJobs.find(
      (job) => job.id === "job_ready",
    )!;
    const service = Object.create(workspaceService) as typeof workspaceService;
    service.extractJobsFromPageText = () =>
      Promise.resolve([
        { title: existing.title, company: existing.company } as never,
      ]);
    service.saveJobsFromPage = () =>
      Promise.resolve({
        savedJobIds: ["job_ready"],
        newJobIds: [],
        mergedJobIds: ["job_ready"],
      });
    const session = {
      assertCurrent: () => undefined,
      signal: new AbortController().signal,
      createResultSet: () => Promise.resolve({ id: "rs_1" }),
      browserLease: () =>
        Promise.resolve({
          revoked: new AbortController().signal,
          currentUrl: () => "http://127.0.0.1:47950/gatekeeper/jobs/9",
          hands: { readText: () => Promise.resolve("Job page") },
        }),
    } as unknown as AssistantTurnSession;
    const ports = {
      browser: {},
      publishWorkspaceUpdate: () => undefined,
    } as unknown as AssistantHostPorts;
    const result = await applyHereTool.execute({}, { service, session, ports });
    expect(result.summary).toContain("same job as saved job job_ready");
    expect(result.summary).toContain("not on this page");
    expect(result.data).toMatchObject({
      mergedIntoExistingJob: true,
      applicationRunsOnThisPage: false,
    });
  });

  it("reads a job list page with its links, so each posting has an address", async () => {
    const text = await readPageTextWithLinks({
      hands: {
        readText: () => Promise.resolve("Open roles\nPlatform Engineer"),
        readPage: () =>
          Promise.resolve({
            links: [
              {
                index: 0,
                label: "Platform Engineer",
                href: "http://127.0.0.1:47950/greenhouse/jobs/3",
                target: "",
              },
              {
                index: 1,
                label: "Email us",
                href: "mailto:jobs@example.test",
                target: "",
              },
            ],
          }),
      },
    } as never);
    expect(text).toContain(
      "Platform Engineer -> http://127.0.0.1:47950/greenhouse/jobs/3",
    );
    expect(text).not.toContain("mailto:");
  });
});
