import {
  DiscoveryJobViewSchema,
  TailoredAssetSchema,
  ApplyJobResultSchema,
  ApplicationAttemptSchema,
  JobListRowSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  toRendererJob,
  toRendererWorkspaceSnapshot,
} from "./renderer-workspace-view";
import { createJobFinderWorkspaceDeltaTracker } from "./workspace-delta";

const body = "Full synthetic listing evidence. ".repeat(400).trim();
function job() {
  return DiscoveryJobViewSchema.parse({
    id: "job-1",
    source: "target_site",
    sourceJobId: "source-1",
    canonicalUrl: "https://example.test/1",
    title: "Engineer",
    company: "Example",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    salaryText: null,
    description: body,
    summary: body,
    responsibilities: [body],
    minimumQualifications: [body],
    discoveredAt: "2026-10-13T00:00:00.000Z",
    status: "discovered",
    matchAssessment: { score: 80 },
    planAssessments: { plan_a: { score: 80 }, plan_b: { score: 20 } },
    provenance: [
      {
        targetId: "board",
        adapterKind: "auto",
        startingUrl: "https://example.test",
        discoveredAt: "2026-10-13T00:00:00.000Z",
        listingFacts: {
          title: "Engineer",
          company: "Example",
          location: "Remote",
          salaryText: null,
          seniority: null,
          description: body,
          summary: body,
        },
      },
    ],
  });
}
function workspaceWith(discoveryJobs = [job()]): JobFinderWorkspaceSnapshot {
  return {
    discoveryJobs,
    dismissedDiscoveryJobs: discoveryJobs,
    companyJobs: discoveryJobs,
    activeDiscoveryRun: null,
    recentDiscoveryRuns: [],
    reviewQueue: [],
    tailoredAssets: [],
    applyRuns: [],
    applyJobResults: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
  } as unknown as JobFinderWorkspaceSnapshot;
}

describe("renderer workspace list projection", () => {
  it("omits queried inventories per response without changing another window's legacy projection", () => {
    const workspace = workspaceWith();
    workspace.companyJobs = workspace.discoveryJobs;
    workspace.dismissedDiscoveryJobs = workspace.discoveryJobs;
    const queried = toRendererWorkspaceSnapshot(workspace, true);
    expect(queried.discoveryJobs).toEqual([]);
    expect(queried.companyJobs).toEqual([]);
    expect(queried.dismissedDiscoveryJobs).toEqual([]);
    const legacy = toRendererWorkspaceSnapshot(workspace, false);
    expect(legacy.discoveryJobs).toHaveLength(1);
    expect(legacy.companyJobs).toHaveLength(1);
    expect(legacy.dismissedDiscoveryJobs).toHaveLength(1);
    expect(workspace.discoveryJobs).toHaveLength(1);
  });
  it("does not open lazy listing or provenance bodies when sending list rows", () => {
    const full = job();
    const lazy = Object.freeze({
      ...full,
      get description(): string {
        throw new Error("listing detail opened");
      },
      provenance: full.provenance.map((entry) =>
        Object.freeze({
          ...entry,
          get listingFacts(): typeof entry.listingFacts {
            throw new Error("sighting detail opened");
          },
        }),
      ),
    });
    expect(toRendererJob(lazy).id).toBe(full.id);
  });
  it("omits complete resume bodies and unused attempt/result evidence while selected/canonical data stays complete", () => {
    const at = "2026-10-13T10:00:00.000Z";
    const body = "Synthetic full document and historical capture".repeat(200);
    const asset = TailoredAssetSchema.parse({
      id: "asset",
      jobId: "job",
      kind: "resume",
      status: "ready",
      label: "Resume",
      version: "1",
      templateName: "Classic",
      compatibilityScore: 90,
      progressPercent: 100,
      updatedAt: at,
      contentText: body,
      previewSections: [{ heading: "Summary", lines: [body] }],
    });
    const result = ApplyJobResultSchema.parse({
      id: "result",
      runId: "run",
      jobId: "job",
      state: "skipped",
      summary: "Skipped",
      detail: "Synthetic",
      startedAt: at,
      updatedAt: at,
      visualObservationSets: [
        {
          id: "observation",
          snapshotId: "snapshot",
          observedAt: at,
          purpose: "apply_checkpoint",
          providerKind: "deterministic",
          providerLabel: "Synthetic",
          summary: body,
        },
      ],
    });
    const attempt = ApplicationAttemptSchema.parse({
      id: "attempt",
      jobId: "job",
      state: "cancelled",
      summary: "Cancelled",
      detail: "Synthetic",
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      outcome: "archived",
      nextActionLabel: null,
      checkpoints: [
        {
          id: "checkpoint",
          at,
          label: "Captured",
          detail: body,
          state: "cancelled",
        },
      ],
      visualObservationSets: result.visualObservationSets,
    });
    const workspace = {
      ...workspaceWith(),
      tailoredAssets: [asset],
      applyJobResults: [result],
      applicationAttempts: [attempt],
    };
    const sent = toRendererWorkspaceSnapshot(workspace);
    expect(sent.tailoredAssets[0]).not.toHaveProperty("contentText");
    expect(sent.tailoredAssets[0]).not.toHaveProperty("previewSections");
    expect(sent.applyJobResults[0]).not.toHaveProperty("visualObservationSets");
    expect(sent.applicationAttempts[0]).not.toHaveProperty("checkpoints");
    expect(JSON.stringify(sent)).not.toContain(body);
    expect(asset.previewSections[0]?.lines[0]).toBe(body);
    expect(result.visualObservationSets[0]?.summary).toBe(body);
    expect(attempt.checkpoints[0]?.detail).toBe(body);
    Object.freeze(asset);
    Object.freeze(result);
    Object.freeze(attempt);
    Object.freeze(workspace.tailoredAssets);
    Object.freeze(workspace.applyJobResults);
    Object.freeze(workspace.applicationAttempts);
    const warm = toRendererWorkspaceSnapshot(workspace);
    const again = toRendererWorkspaceSnapshot(workspace);
    expect(again.tailoredAssets).toBe(warm.tailoredAssets);
    expect(again.applyJobResults).toBe(warm.applyJobResults);
    expect(again.applicationAttempts).toBe(warm.applicationAttempts);
  });
  it("keeps full evidence in main and sends only list fields in every collection", () => {
    const workspace = workspaceWith();
    const sent = toRendererWorkspaceSnapshot(workspace);
    for (const rows of [
      sent.discoveryJobs,
      sent.dismissedDiscoveryJobs,
      sent.companyJobs,
    ]) {
      expect(JobListRowSchema.safeParse(rows[0]).success).toBe(true);
      expect(rows[0]).toMatchObject({
        id: "job-1",
        title: "Engineer",
        matchAssessment: { score: 80 },
      });
      for (const field of [
        "description",
        "summary",
        "responsibilities",
        "minimumQualifications",
        "preferredQualifications",
        "keySkills",
        "screeningHints",
        "sourceIntelligence",
        "keywordSignals",
        "benefits",
        "planAssessments",
        "latestMatchAssessmentAudit",
      ])
        expect(rows[0]).not.toHaveProperty(field);
      expect(rows[0]?.provenance[0]).not.toHaveProperty("listingFacts");
      expect(JSON.stringify(rows)).not.toContain(body);
    }
    expect(workspace.discoveryJobs[0]?.description).toBe(body);
    expect(
      workspace.discoveryJobs[0]?.provenance[0]?.listingFacts?.description,
    ).toBe(body);
    expect(workspace.discoveryJobs[0]?.planAssessments?.plan_b?.score).toBe(20);
    expect(JSON.stringify(sent.discoveryJobs).length).toBeLessThan(
      JSON.stringify(workspace.discoveryJobs).length / 5,
    );
  });

  it("retains unchanged row references and invalidates detail on body-only changes", () => {
    const workspace = workspaceWith();
    Object.freeze(workspace.discoveryJobs[0]);
    Object.freeze(workspace.discoveryJobs);
    const first = toRendererWorkspaceSnapshot(workspace);
    expect(toRendererWorkspaceSnapshot(workspace).discoveryJobs).toBe(
      first.discoveryJobs,
    );
    const changed = toRendererWorkspaceSnapshot({
      ...workspace,
      discoveryJobs: [
        { ...workspace.discoveryJobs[0]!, description: `${body} Changed.` },
      ],
    });
    expect(changed.discoveryJobs[0]?.detailRevision).not.toBe(
      first.discoveryJobs[0]?.detailRevision,
    );
    const tracker = createJobFinderWorkspaceDeltaTracker();
    const initial = tracker.synchronize(null, first);
    const revision =
      initial.kind === "snapshot"
        ? initial.currentRevision
        : initial.delta.currentRevision;
    const next = tracker.synchronize(revision, changed);
    expect(next.kind).toBe("delta");
    if (next.kind === "delta")
      expect(next.delta.discoveryJobs.upserts).toEqual(changed.discoveryJobs);
    expect(JSON.stringify(next)).not.toContain(body);
  });

  it("sends the short fit assessment and reloads detail when its write-up changes", () => {
    const explained = "Synthetic preference verdict written by the model.";
    const full = DiscoveryJobViewSchema.parse({
      ...job(),
      matchAssessment: {
        score: 80,
        contextFingerprint: "context",
        postingFingerprint: "posting",
        reasons: ["Synthetic reason."],
        dimensions: {
          preferenceAlignment: { state: "mixed", explanation: explained },
          evidenceConfidence: { level: "moderate", supportedCount: 3 },
        },
        judgment: {
          source: "full",
          judgedAt: "2026-10-13T00:00:00.000Z",
          score: 80,
          recommendation: "strong_fit",
          roleExplanation: explained,
          reasons: ["Synthetic judged reason."],
          summary: "Synthetic one-line summary.",
        },
      },
    });
    const row = toRendererJob(full);
    expect(JobListRowSchema.parse(row)).toEqual(row);
    expect(JSON.stringify(row)).not.toContain(explained);
    expect(JSON.stringify(row)).not.toContain("Synthetic judged reason.");
    expect(row.matchAssessment).toMatchObject({
      score: 80,
      contextFingerprint: "context",
      reasons: ["Synthetic reason."],
      dimensions: {
        preferenceAlignment: { state: "mixed" },
        evidenceConfidence: { level: "moderate", supportedCount: 3 },
      },
      judgment: { source: "full", summary: "Synthetic one-line summary." },
    });
    const rewritten = toRendererJob({
      ...full,
      matchAssessment: {
        ...full.matchAssessment,
        dimensions: {
          ...full.matchAssessment.dimensions,
          preferenceAlignment: {
            ...full.matchAssessment.dimensions.preferenceAlignment,
            explanation: `${explained} Revised.`,
          },
        },
      },
    });
    expect(rewritten.matchAssessment).toEqual(row.matchAssessment);
    expect(rewritten.detailRevision).not.toBe(row.detailRevision);
  });

  it("keeps all 3,003 identities while 10KB listing bodies stay out of IPC", () => {
    const seed = job();
    const jobs = Array.from({ length: 3003 }, (_, index) => ({
      ...seed,
      id: `job-${index}`,
    }));
    for (const row of jobs) Object.freeze(row);
    const started = performance.now();
    const sent = toRendererWorkspaceSnapshot(workspaceWith(jobs));
    const coldMs = performance.now() - started;
    const warmStarted = performance.now();
    const warm = toRendererWorkspaceSnapshot(workspaceWith([...jobs]));
    const warmMs = performance.now() - warmStarted;
    expect(warm.discoveryJobs[3002]).toBe(sent.discoveryJobs[3002]);
    expect(sent.discoveryJobs).toHaveLength(3003);
    expect(new Set(sent.discoveryJobs.map((row) => row.id)).size).toBe(3003);
    expect(sent.discoveryJobs.at(-1)?.id).toBe("job-3002");
    const payload = JSON.stringify(sent.discoveryJobs);
    expect(payload).not.toContain(body);
    expect(payload).not.toContain('"description"');
    expect(payload.length).toBeLessThan(body.length * jobs.length);
    console.info("renderer-list-projection-scale", {
      jobs: jobs.length,
      listingBytesPerJob: body.length,
      listPayloadBytes: payload.length,
      coldMs: Math.round(coldMs),
      warmMs: Math.round(warmMs),
    });
  });

  it("does not cache caller-owned mutable jobs or mutable collection membership", () => {
    const stored = job();
    const workspace = workspaceWith([stored]);
    const first = toRendererWorkspaceSnapshot(workspace);
    stored.status = "shortlisted";
    stored.description = "Updated full description";
    const second = toRendererWorkspaceSnapshot(workspace);
    expect(second.discoveryJobs[0]?.status).toBe("shortlisted");
    expect(second.discoveryJobs[0]?.detailRevision).not.toBe(
      first.discoveryJobs[0]?.detailRevision,
    );
    workspace.discoveryJobs.push({ ...stored, id: "job-2" });
    expect(toRendererWorkspaceSnapshot(workspace).discoveryJobs).toHaveLength(
      2,
    );
    expect(first.discoveryJobs).toHaveLength(1);
    // A frozen collection alone does not make its caller-owned rows immutable.
    Object.freeze(workspace.discoveryJobs);
    toRendererWorkspaceSnapshot(workspace);
    stored.company = "Updated employer";
    expect(
      toRendererWorkspaceSnapshot(workspace).discoveryJobs[0]?.company,
    ).toBe("Updated employer");
  });

  it("invalidates full detail when only another source's stored listing changes", () => {
    const stored = job();
    const first = toRendererJob(stored);
    const sighting = stored.provenance[0]!;
    const updated = {
      ...stored,
      provenance: [
        {
          ...sighting,
          listingFacts: {
            ...sighting.listingFacts!,
            description: "Updated other listing",
          },
        },
      ],
    };
    expect(toRendererJob(updated).detailRevision).not.toBe(
      first.detailRevision,
    );
    expect(toRendererJob(updated).provenance[0]).not.toHaveProperty(
      "listingFacts",
    );
  });

  it("keeps each source's resume checkpoint and job id lists in main", () => {
    const run = {
      id: "run-1",
      targetExecutions: [
        {
          targetId: "board",
          agentCheckpoint: { revision: 2, collectedJobs: [{ title: "A" }] },
          inspectedJobIds: ["job-1", "job-2"],
          encounteredJobIds: ["job-1"],
          jobsInspected: 2,
        },
        { targetId: "other", agentCheckpoint: null, encounteredJobIds: [] },
      ],
    };
    const workspace = {
      ...workspaceWith([]),
      activeDiscoveryRun: run,
      recentDiscoveryRuns: [run],
    } as unknown as JobFinderWorkspaceSnapshot;
    const sent = toRendererWorkspaceSnapshot(workspace);
    expect(
      sent.activeDiscoveryRun?.targetExecutions.map(
        (entry) => entry.agentCheckpoint,
      ),
    ).toEqual([null, null]);
    expect(
      sent.recentDiscoveryRuns[0]?.targetExecutions[0]?.agentCheckpoint,
    ).toBeNull();
    const board = sent.activeDiscoveryRun?.targetExecutions[0];
    expect(board?.inspectedJobIds).toBeUndefined();
    expect(board?.encounteredJobIds).toEqual([]);
    expect(board?.jobsInspected).toBe(2);
    expect(sent.activeDiscoveryRun?.targetExecutions[1]).toBe(
      run.targetExecutions[1],
    );
    expect(run.targetExecutions[0]?.agentCheckpoint).not.toBeNull();
    expect(run.targetExecutions[0]?.encounteredJobIds).toEqual(["job-1"]);
  });
});
