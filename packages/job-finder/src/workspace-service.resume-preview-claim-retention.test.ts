import {
  createJobFinderAiClientFromEnvironment,
  createOpenAiCompatibleJobFinderAiClient,
} from "@nestor/ai-providers";
import { ResumeDraftSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";

import { withResumeClaimChecks } from "./internal/resume-claim-checks";
import { resumeClaimContentHash } from "./internal/resume-workspace-helpers";
import {
  createAiClient,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
  fakeResumeClaimCheck,
} from "./workspace-service.test-support";

async function displacePreviewFromSessionCache() {
  const seed = createSeed();
  const at = "2026-10-14T10:00:00.000Z";
  const pressure = ResumeDraftSchema.parse({
    id: "synthetic_cache_pressure",
    jobId: "job_ready",
    status: "draft",
    templateId: "classic_ats",
    sections: [
      {
        id: "pressure_summary",
        kind: "summary",
        label: "Cache pressure",
        origin: "ai_generated",
        sortOrder: 0,
        text: null,
        entries: [],
        bullets: Array.from({ length: 4_001 }, (_, index) => ({
          id: `pressure_${index}`,
          text: `Independent synthetic cache-pressure accomplishment number ${index}.`,
          origin: "ai_generated",
          updatedAt: at,
        })),
        updatedAt: at,
      },
    ],
    createdAt: at,
    updatedAt: at,
  });
  const checked = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: fakeResumeClaimCheck() },
    draft: pressure,
    job: seed.savedJobs.find((job) => job.id === "job_ready")!,
    profile: seed.profile,
  });
  expect(checked.claimChecks).toHaveLength(4_001);
}

test("final generation reuses the matching preview's checks after more than 4000 unrelated checks", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  const summary =
    "A distinct synthetic specialization retained from the final checked preview despite cache pressure.";
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const check = vi.fn(fakeResumeClaimCheck());
  aiClient.checkResumeClaims = check;
  aiClient.createResumeDraft = async (input) => {
    const draft = {
      ...(await original(input)),
      summary,
      generationProvenance: {
        method: "ai" as const,
        reason: null,
        detail: null,
      },
    };
    await input.renderPreview!({ draft, templateId: "classic_ats" });
    await displacePreviewFromSessionCache();
    return draft;
  };
  const documentManager = createDocumentManager();
  const render = vi.spyOn(documentManager, "renderResumeArtifact");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    documentManager,
  });
  try {
    expect(
      await workspaceService.generateResumeForBatch("job_ready", {
        shouldStop: () => false,
      }),
    ).toEqual({ jobId: "job_ready", outcome: "written" });
    expect(
      check.mock.calls.flatMap(([input]) =>
        input.claims.map((claim) => claim.text),
      ),
    ).toEqual([summary]);
    const saved = (await repository.getResumeDraftByJobId("job_ready"))!;
    expect(saved.claimChecks).toEqual([
      expect.objectContaining({
        contentHash: resumeClaimContentHash(summary),
        verdict: "supported",
      }),
    ]);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]![0].renderDocument).toEqual(
      render.mock.calls[0]![0].renderDocument,
    );
    expect(
      saved.sections.find((section) => section.kind === "summary")?.text,
    ).toBe(summary);
  } finally {
    await workspaceService.shutdown();
  }
});

test("a changed final draft rechecks only its changed wording; a retained line keeps its verdict", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  const previewSummary =
    "Synthetic preview-only specialization before the last writer revision.";
  const finalSummary =
    "Synthetic final specialization after the last writer revision.";
  const retainedLine =
    "A retained synthetic achievement whose surrounding resume context changes.";
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const check = vi.fn(fakeResumeClaimCheck());
  aiClient.checkResumeClaims = check;
  aiClient.createResumeDraft = async (input) => {
    const base = await original(input);
    const draft = {
      ...base,
      summary: previewSummary,
      generationProvenance: {
        method: "ai" as const,
        reason: null,
        detail: null,
      },
      experienceEntries: [
        {
          ...base.experienceEntries[0]!,
          bullets: [retainedLine],
        },
      ],
    };
    await input.renderPreview!({ draft, templateId: "classic_ats" });
    return { ...draft, summary: finalSummary };
  };
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  try {
    await workspaceService.generateResumeForBatch("job_ready", {
      shouldStop: () => false,
    });
    const checkedTexts = check.mock.calls.map(([input]) =>
      input.claims.map((claim) => claim.text),
    );
    expect(checkedTexts).toHaveLength(2);
    expect(checkedTexts[0]).toEqual(
      expect.arrayContaining([previewSummary, retainedLine]),
    );
    expect(checkedTexts[1]).toContain(finalSummary);
    expect(checkedTexts[1]).not.toContain(retainedLine);
    const saved = (await repository.getResumeDraftByJobId("job_ready"))!;
    expect(saved.claimChecks?.map((claim) => claim.contentHash)).toEqual(
      expect.arrayContaining([
        resumeClaimContentHash(finalSummary),
        resumeClaimContentHash(retainedLine),
      ]),
    );
    expect(saved.claimChecks?.map((claim) => claim.contentHash)).not.toContain(
      resumeClaimContentHash(previewSummary),
    );
  } finally {
    await workspaceService.shutdown();
  }
});

test("stored preview checks are invalidated when the checker's job context changes", async () => {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
  const at = "2026-10-14T11:00:00.000Z";
  const draft = ResumeDraftSchema.parse({
    id: "job_context_preview",
    jobId: job.id,
    status: "draft",
    templateId: "classic_ats",
    sections: [
      {
        id: "summary",
        kind: "summary",
        label: "Summary",
        text: "Synthetic generated context-sensitive summary.",
        origin: "ai_generated",
        sortOrder: 0,
        updatedAt: at,
      },
    ],
    createdAt: at,
    updatedAt: at,
  });
  const check = vi.fn(fakeResumeClaimCheck());
  const first = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: check },
    draft,
    job,
    profile: seed.profile,
  });
  const second = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: check },
    draft: first,
    job: {
      ...job,
      description: "A changed listing with different claim context.",
    },
    profile: seed.profile,
  });
  expect(check).toHaveBeenCalledTimes(2);
  expect(second.claimChecks![0]!.evidenceKey).not.toBe(
    first.claimChecks![0]!.evidenceKey,
  );
});
test("a funding error inside preview stops queued writers and survives a flattened agent error", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const provider = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic",
    baseUrl: "https://synthetic.example.test/v1",
    model: "synthetic",
  });
  aiClient.checkResumeClaims = (input) => provider.checkResumeClaims!(input);
  const onProviderBlocked = vi.fn();
  let observedBeforeAgentStopped = false;
  aiClient.createResumeDraft = async (input) => {
    const draft = {
      ...(await original(input)),
      summary:
        "A synthetic generated line requiring a preview claim check before funding blocks it.",
    };
    try {
      await input.renderPreview!({ draft, templateId: "classic_ats" });
    } catch {
      observedBeforeAgentStopped = onProviderBlocked.mock.calls.length === 1;
      // Mirrors the agent's tool failure receipt, which drops the tool cause.
      throw new Error("Resume writer stopped: permanent_failure");
    }
    return draft;
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ error: { message: "SYNTHETIC_PRIVATE_BODY" } }),
      {
        status: 402,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  const documentManager = createDocumentManager();
  const render = vi.spyOn(documentManager, "renderResumeArtifact");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    documentManager,
  });
  try {
    const receipt = await workspaceService.generateResumeForBatch("job_ready", {
      shouldStop: () => false,
      onProviderBlocked,
    });
    expect(receipt).toMatchObject({
      jobId: "job_ready",
      outcome: "blocked",
      providerBlock: { reason: "funding" },
    });
    expect(observedBeforeAgentStopped).toBe(true);
    expect(onProviderBlocked).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(await repository.getResumeDraftByJobId("job_ready")).toBeNull();
    const failed = await repository.getTailoredAssetByJobId("job_ready");
    // An outage in the person's words: the AI is bundled, so its account
    // details are never theirs to read.
    expect(failed?.failureMessage).toContain(
      "The AI service is unavailable right now",
    );
    expect(failed?.failureMessage).not.toMatch(
      /SYNTHETIC_PRIVATE_BODY|permanent_failure|insufficient funds|provider/,
    );
  } finally {
    fetchMock.mockRestore();
    await workspaceService.shutdown();
  }
});

test("a batch resume the AI service turns away for load is put off, not failed", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  // A listing with enough to tailor toward, so the writer asks the model.
  seed.savedJobs = seed.savedJobs.map((job) =>
    job.id === "job_ready"
      ? {
          ...job,
          description:
            "Synthetic platform team building a TypeScript and React design system, GraphQL gateways, Playwright test suites, Kubernetes deployments, PostgreSQL schema migrations, observability with OpenTelemetry, accessibility audits and Storybook documentation for a payments product used by clinics across Europe.",
        }
      : job,
  );
  const aiClient = createJobFinderAiClientFromEnvironment({
    NESTOR_AI_API_KEY: "synthetic",
    NESTOR_AI_BASE_URL: "https://synthetic.example.test/v1",
    NESTOR_AI_MAX_ATTEMPTS: "1",
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { message: "SYNTHETIC_BUSY" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  try {
    const receipt = await workspaceService.generateResumeForBatch("job_ready", {
      shouldStop: () => false,
    });
    expect(receipt).toEqual({ jobId: "job_ready", outcome: "not_started" });
    expect(fetchMock).toHaveBeenCalled();
    // Nothing is saved as a failed resume: the job still needs one.
    expect(
      (await repository.getTailoredAssetByJobId("job_ready"))?.failureMessage ??
        null,
    ).toBeNull();
    expect(await repository.getResumeDraftByJobId("job_ready")).toBeNull();
  } finally {
    fetchMock.mockRestore();
    await workspaceService.shutdown();
  }
});
