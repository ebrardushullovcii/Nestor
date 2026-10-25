import { randomUUID } from "node:crypto";
import {
  FitJudgmentSchema,
  DiscoveryRunRecordSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildContextBlock,
  getAssistantSavedSearch,
} from "../prompt";
import type { AssistantTurnSession } from "../tool-kit";
import { getWorkspaceSummaryTool } from "./workspace-tools";
import { queryJobsTool, showJobsTool, updateSourcesTool } from "./jobs-tools";

function world() {
  const { workspaceService: service } = createWorkspaceServiceHarness();
  const session = {
    assertCurrent: () => undefined,
    now: () => "2026-10-05T12:00:00.000Z",
    createId: () => randomUUID(),
    createResultSet: (
      input: Parameters<AssistantTurnSession["createResultSet"]>[0],
    ) => Promise.resolve({ ...input, id: randomUUID() }),
    recordChange: vi.fn(
      (change: Parameters<AssistantTurnSession["recordChange"]>[0]) =>
        Promise.resolve({
          receipt: { id: randomUUID() },
          part: { type: "notice", kind: "info", text: change.summary },
        }),
    ),
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate: vi.fn(),
  } as unknown as AssistantHostPorts;
  return { service, session, ports };
}

function context(snapshot: JobFinderWorkspaceSnapshot) {
  return buildContextBlock({
    snapshot,
    context: null,
    resultSets: [],
    plan: null,
    grants: [],
    pendingQuestions: [],
    now: "2026-10-05T12:00:00.000Z",
  });
}

describe("R3-117 saved search on a return visit", () => {
  it("returns the saved search time and historical counts, never claims a fresh check", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    snapshot.recentDiscoveryRuns = [
      DiscoveryRunRecordSchema.parse({
        id: "old_search",
        state: "completed",
        startedAt: "2026-10-03T09:00:00.000Z",
        completedAt: "2026-10-03T09:10:00.000Z",
        summary: { changeDigest: { new: 5, changed: 0, inactive: 0 } },
      }),
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const expected = {
      startedAt: "2026-10-03T09:00:00.000Z",
      completedAt: "2026-10-03T09:10:00.000Z",
      historicalCounts: { new: 5 },
      availabilitySinceSearch: "not checked by this saved report",
      changesSinceLastVisit: "unknown; no visit comparison snapshot",
    };
    expect(getAssistantSavedSearch(snapshot)).toMatchObject(expected);
    expect((await getWorkspaceSummaryTool.execute({}, ctx)).data).toMatchObject(
      { search: { latestSavedSearch: expected } },
    );
    expect(context(snapshot)).toContain(
      "Latest saved search (historical, not a check on this visit)",
    );
    expect(context(snapshot)).toContain("2026-10-03T09:00:00.000Z");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Do not report zero changed or closed jobs without a fresh comparison",
    );
  });
  it("uses the frozen summary report when a cancelled run's digest is empty", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const run = DiscoveryRunRecordSchema.parse({
      id: "cancelled",
      state: "cancelled",
      startedAt: "2026-10-05T09:00:00.000Z",
      summary: {
        report: { measuredAt: "2026-10-05T09:10:00.000Z", saved: 33, new: 20 },
      },
    });
    snapshot.recentDiscoveryRuns = [run];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    expect(getAssistantSavedSearch(snapshot)).toMatchObject({
      historicalCounts: { saved: 33, new: 20 },
      summaryReport: run.summary.report,
    });
    expect((await getWorkspaceSummaryTool.execute({}, ctx)).data).toMatchObject(
      { search: { latestSavedSearch: { summaryReport: run.summary.report } } },
    );
  });
  it("keeps a search over hundreds of sources to totals and a short digest", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const targetIds = Array.from({ length: 900 }, (_, i) => `target_${i}`);
    const run = DiscoveryRunRecordSchema.parse({
      id: "wide",
      state: "completed",
      startedAt: "2026-10-05T09:00:00.000Z",
      targetIds,
      summary: {
        report: {
          measuredAt: "2026-10-05T09:10:00.000Z",
          saved: 40,
          new: 40,
          sources: targetIds.map((targetId, i) => ({
            targetId,
            inspected: 10,
            saved: i < 8 ? 5 : 0,
            rejected: 0,
            duplicates: 0,
            deferred: 0,
            pagesCovered: 1,
          })),
        },
      },
    });
    snapshot.recentDiscoveryRuns = [run];
    const saved = getAssistantSavedSearch(snapshot);
    expect(saved).toMatchObject({
      sourceCount: 900,
      sourcesWithSavedJobs: 8,
      historicalCounts: { saved: 40, new: 40 },
    });
    expect(saved).not.toHaveProperty("sourceIds");
    expect(saved?.topSourcesBySaved).toHaveLength(5);
    // It rides on every message, so it stays a few hundred bytes.
    expect(JSON.stringify(saved).length).toBeLessThan(1_500);
  });
  it("does not fabricate a comparison when no search was saved", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    snapshot.recentDiscoveryRuns = [];
    expect(getAssistantSavedSearch(snapshot)).toBeNull();
  });
});

describe("R3-142 fit scores beside cards", () => {
  it("returns current saved scores from the exact read used to draw the cards", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const job = snapshot.discoveryJobs[0]!;
    job.discoveryMethod = "browser_agent";
    job.matchAssessment = {
      ...job.matchAssessment,
      score: 75,
      contextFingerprint: "current_profile",
      postingFingerprint: "current_listing",
      judgment: FitJudgmentSchema.parse({
        source: "full",
        judgedAt: ctx.session.now(),
        score: 75,
        recommendation: "review_before_applying",
      }),
    };
    ctx.service.getWorkspaceProjection = vi.fn(() => Promise.resolve(snapshot));
    const canonicalRead = vi.spyOn(ctx.service, "getWorkspaceSnapshot");
    const first = await showJobsTool.execute({ jobIds: [job.id, job.id] }, ctx);
    expect(first.data).toMatchObject({
      jobs: [{ id: job.id, fit: "75% fit" }],
    });
    expect(first.parts?.[0]).toMatchObject({
      rows: [{ id: job.id, status: "75% fit" }],
      totalCount: 1,
    });
    job.matchAssessment.score = 81;
    const reassessed = await showJobsTool.execute({ jobIds: [job.id] }, ctx);
    expect(reassessed.data).toMatchObject({ jobs: [{ fit: "81% fit" }] });
    expect(reassessed.parts?.[0]).toMatchObject({
      rows: [{ status: "81% fit" }],
    });
    expect(canonicalRead).not.toHaveBeenCalled();
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Never reuse a score from an earlier conversation read",
    );
  });
});

it("R3-120 tells the model that scans have no readable text and extraction can fail", async () => {
  const { importResumeTool, readDocumentTool } =
    await import("./profile-tools");
  for (const copy of [
    ASSISTANT_SYSTEM_PROMPT,
    importResumeTool.description,
    readDocumentTool.description,
  ]) {
    expect(copy.toLowerCase()).toContain(
      "scanned image pdfs have no readable text",
    );
    expect(copy).toContain("Markdown");
  }
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "do not promise that a scan is fine",
  );
  expect(importResumeTool.description).toContain("success is not guaranteed");
});

it("R3-121 adds employer-labelled sources and renames an existing source", async () => {
  const ctx = world();
  const before = await ctx.service.getWorkspaceSnapshot();
  const original = before.searchPreferences.discovery.targets[0]!;
  const result = await updateSourcesTool.execute(
    updateSourcesTool.input.parse({
      namedSources: [
        { url: "https://careers.example.test/jobs", label: "Paper Interfaces" },
        {
          url: "https://careers.example.test/jobs/",
          label: "Paper Interfaces",
        },
      ],
      renameSources: [{ sourceId: original.id, label: "Moneybox" }],
    }),
    ctx,
  );
  const after = await ctx.service.getWorkspaceSnapshot();
  expect(
    after.searchPreferences.discovery.targets.find(
      (target) => target.id === original.id,
    ),
  ).toMatchObject({ label: "Moneybox", startingUrl: original.startingUrl });
  expect(
    after.searchPreferences.discovery.targets.filter(
      (target) => target.label === "Paper Interfaces",
    ),
  ).toHaveLength(1);
  expect(result.data).toMatchObject({ added: [{ label: "Paper Interfaces" }] });
});

it("R3-128 keeps a complete manual profile search-ready without an imported resume", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.browserSession.driver = "uninitialized";
  snapshot.browserSession.status = "unknown";
  snapshot.profile.baseResume.fileName = "";
  snapshot.profile.baseResume.storagePath = null;
  snapshot.profile.fullName = "Synthetic Manual Candidate";
  snapshot.profile.email = "manual@example.test";
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  expect((await getWorkspaceSummaryTool.execute({}, ctx)).data).toMatchObject({
    search: {
      canStartSearch: true,
      resumeRequired: false,
      missingRequirements: [],
    },
  });
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Start manually is a complete route",
  );
});

it("R3-110 treats capability reporting as a write and excludes advice-only requests", async () => {
  const { reportMissingCapabilityTool } = await import("./workspace-tools");
  expect(reportMissingCapabilityTool.effect).toBe("local_write");
  expect(reportMissingCapabilityTool.description).toContain(
    "Never call for advice-only questions",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "do not record a capability report",
  );
});

it("R3-122 reports the jobs actually found without guaranteeing the requested count", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "including fewer than requested or none",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never fill a shortfall with unsuitable jobs",
  );
});

it("R3-157 treats keeping the person's words as Original and asks before allowing Light edits", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("mean Original, not Light");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("ask before selecting Light");
});

it("R3-125 gives source explanations and the current sending boundary before requesting a URL", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.settings.applicationAutomationMode = "autonomous_submit";
  expect(context(snapshot)).toContain(
    "Current saved sending mode: autonomous_submit",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Sources are the job pages Job Finder searches",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Answer every question in a mixed request before asking",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "An employer form may save entered answers",
  );
});

it("R3-127 exposes required and preferred listing evidence separately for comparisons", async () => {
  const { jobEvidence, jobDetail } = await import("./format");
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  const job = snapshot.discoveryJobs[0]!;
  job.minimumQualifications = ["Agile certification", "Confluence"];
  job.preferredQualifications = ["Financial-services experience is a big plus"];
  for (const read of [jobEvidence(job), jobDetail(job)]) {
    expect(read).toMatchObject({
      minimumQualifications: ["Agile certification", "Confluence"],
      preferredQualifications: ["Financial-services experience is a big plus"],
    });
  }
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Never turn preferred sector experience into a requirement",
  );
});

it("R3-161 restricts a top-five query to the requested local origin and reports its shortfall", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  const base = snapshot.discoveryJobs[0]!;
  snapshot.discoveryJobs = [
    {
      ...base,
      id: "local",
      status: "discovered",
      canonicalUrl: "http://127.0.0.1:47950/paper/jobs/1",
      company: "Paper Interfaces",
    },
    {
      ...base,
      id: "real",
      status: "discovered",
      canonicalUrl: "https://employer.example.test/jobs/1",
      company: "Synthetic Real Employer",
    },
    {
      ...base,
      id: "other_port",
      status: "discovered",
      canonicalUrl: "http://127.0.0.1:47951/jobs/1",
    },
  ];
  snapshot.companyJobs = [];
  snapshot.dismissedDiscoveryJobs = [];
  ctx.service.getWorkspaceProjection = vi.fn(() => Promise.resolve(snapshot));
  const canonicalRead = vi.spyOn(ctx.service, "getWorkspaceSnapshot");
  const result = await queryJobsTool.execute(
    queryJobsTool.input.parse({
      scope: "all",
      listingOrigins: ["http://127.0.0.1:47950"],
      limit: 5,
      show: false,
    }),
    ctx,
  );
  expect(result.data).toMatchObject({
    total: 1,
    jobs: [{ id: "local" }],
    sourceRestriction: { listingOrigins: ["http://127.0.0.1:47950"] },
  });
  expect(canonicalRead).not.toHaveBeenCalled();
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "do not widen sources without the person's request",
  );
});

it("R3-214 describes a combined Undo for edits sharing one receipt", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("share one combined Undo action");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Never promise separate Undo buttons unless there are separate change receipts",
  );
});

it("R3-200 directs a factual letter to the correct application's built-in editor and export", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "read get_application_run for the correct job",
  );
  for (const label of [
    "Application documents",
    "Exact attachment question",
    "Edit proposed text",
    "Save edit as new revision",
    "Approve",
    "Export",
  ])
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(label);
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("does not send the application");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("not an outside editor");
});

it("R3-061 exposes remote-country facts and keeps Americas separate from sponsorship", async () => {
  const { jobEvidence } = await import("./format");
  const ctx = world();
  const job = (await ctx.service.getWorkspaceSnapshot()).discoveryJobs[0]!;
  job.location = "Remote Americas";
  job.screeningHints.remoteGeographies = ["Americas"];
  job.screeningHints.sponsorshipText = "No sponsorship statement published";
  expect(jobEvidence(job)).toMatchObject({
    location: "Remote Americas",
    remoteGeographies: ["Americas"],
    sponsorshipText: "No sponsorship statement published",
  });
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "'Remote Americas' includes Canada and the US geographically",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "say when Canada hiring is unconfirmed",
  );
});

it("R3-062 gives the model the full country restriction and asks it to answer first in the person's language", async () => {
  const { jobDetail } = await import("./format");
  const ctx = world();
  const job = (await ctx.service.getWorkspaceSnapshot()).discoveryJobs[0]!;
  job.location = "Remote United Kingdom";
  job.description = `${"Synthetic role details. ".repeat(300)}You must reside and work in the United Kingdom.`;
  expect(jobDetail(job).description).toContain(
    "You must reside and work in the United Kingdom",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "answer the country question first, in the person's language",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Germany does not meet a UK-only residence/work-location requirement",
  );
});

it("requires a text answer first and supporting cards only", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "answer the question in text first",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Do not reply with only a card or a question back",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("finish with a text answer");
});

it("reports source switches from saved state and counts only actual switch changes", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  const source = snapshot.searchPreferences.discovery.targets[0]!;
  await updateSourcesTool.execute(
    updateSourcesTool.input.parse({ disableIds: [source.id] }),
    ctx,
  );
  const result = await updateSourcesTool.execute(
    updateSourcesTool.input.parse({ disableIds: [source.id] }),
    ctx,
  );
  expect(result.summary).toContain("0 turned off");
  const expectedSources: unknown = expect.arrayContaining([
    expect.objectContaining({ id: source.id, enabled: false }),
  ]);
  expect(result.data).toMatchObject({
    sources: expectedSources,
  });
});
