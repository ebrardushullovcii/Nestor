import { describe, expect, test, vi } from "vitest";
import {
  ResumeImportRunSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";
import { waitForAssistantResumeImport } from "./resume-import-completion";

function harness(input: { active?: boolean; accepted?: number } = {}) {
  const run = ResumeImportRunSchema.parse({
    id: "scan-import",
    sourceResumeId: "scan-resume",
    sourceResumeFileName: "resume-scanned.pdf",
    status: "applied",
    startedAt: "2026-09-30T12:00:00.000Z",
    modelRoles: { vision: { status: "completed", timeoutMs: 1_000 } },
    candidateCounts: { autoApplied: input.accepted ?? 0 },
  });
  const profile = createFreshStartCandidateProfile();
  profile.baseResume = {
    ...profile.baseResume,
    id: run.sourceResumeId,
    fileName: run.sourceResumeFileName,
  };
  const snapshot = {
    profile,
    latestResumeImportRun: run,
    visionProvider: null,
  };
  const state = {
    activeVisionRunIds: input.active ? [run.id] : [],
    resumeImportRuns: [run],
    resumeImportDocumentBundles: [],
    resumeImportFieldCandidates: [],
  };
  const service = {
    getResumeImportState: vi.fn(() => Promise.resolve({ ...state })),
    readProfile: vi.fn(() => Promise.resolve(profile)),
  };
  return { run, profile, snapshot, state, service };
}

describe("sidebar resume import completion", () => {
  test("waits through reconciliation even when vision already says completed", async () => {
    const h = harness({ active: true });
    let finished = false;
    const waiting = waitForAssistantResumeImport(h.service, h.snapshot, {
      readProfile: h.service.readProfile,
    }).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(false);
    expect(h.service.readProfile).not.toHaveBeenCalled();
    h.profile.fullName = "Alex Scan";
    h.run.candidateCounts.autoApplied = 1;
    h.state.activeVisionRunIds = [];
    await waiting;
    expect(finished).toBe(true);
    expect(
      h.service.getResumeImportState.mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("does not wait for another scan or require raw text when this scan has review candidates", async () => {
    const h = harness();
    h.run.candidateCounts.needsReview = 2;
    h.state.activeVisionRunIds = ["unrelated-import"];
    expect(h.profile.baseResume.extractionStatus).toBe("needs_text");
    await expect(
      waitForAssistantResumeImport(h.service, h.snapshot, {
        readProfile: h.service.readProfile,
      }),
    ).resolves.toBeUndefined();
  });

  test("reports an empty import truthfully while preserving an existing profile", async () => {
    const empty = harness();
    await expect(
      waitForAssistantResumeImport(empty.service, empty.snapshot, {
        readProfile: empty.service.readProfile,
      }),
    ).rejects.toThrow("no usable profile details were recovered");
    const existing = harness();
    existing.profile.fullName = "Alex Existing";
    await expect(
      waitForAssistantResumeImport(existing.service, existing.snapshot, {
        readProfile: existing.service.readProfile,
      }),
    ).resolves.toBeUndefined();
    expect(existing.profile.fullName).toBe("Alex Existing");
  });

  test("uses the import's configured vision timeout and does not call an unfinished scan unreadable", async () => {
    const h = harness({ active: true });
    if (!h.run.modelRoles) throw new Error("Expected model roles");
    h.run.modelRoles.vision.timeoutMs = 25;
    await expect(
      waitForAssistantResumeImport(h.service, h.snapshot, {
        readProfile: h.service.readProfile,
      }),
    ).rejects.toThrow("visual scan is still finishing");
    expect(h.service.readProfile).not.toHaveBeenCalled();
  });

  test("Stop aborts the wait without claiming import success", async () => {
    const h = harness({ active: true });
    const controller = new AbortController();
    const waiting = expect(
      waitForAssistantResumeImport(h.service, h.snapshot, {
        signal: controller.signal,
        readProfile: h.service.readProfile,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await waiting;
    expect(h.service.readProfile).not.toHaveBeenCalled();
  });

  test("a superseded import does not report the replacement's profile as its own result", async () => {
    const h = harness({ accepted: 1 });
    h.service.readProfile.mockResolvedValue({
      ...h.profile,
      baseResume: { ...h.profile.baseResume, id: "replacement-resume" },
    });
    await expect(
      waitForAssistantResumeImport(h.service, h.snapshot, {
        readProfile: h.service.readProfile,
      }),
    ).rejects.toThrow("Another resume replaced this import");
  });
});
