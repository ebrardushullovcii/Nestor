import { ResumeDraftSchema } from "@nestor/contracts";
import { beforeEach, expect, test, vi } from "vitest";
import type {
  withResumeClaimChecks,
  withResumeClaimFixes,
} from "./resume-claim-checks";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { sanitizeAndCheckResumeDraft } from "./workspace-application-resume-support";

const mocks = vi.hoisted(() => ({
  checks: vi.fn<typeof withResumeClaimChecks>(),
  fixes: vi.fn<typeof withResumeClaimFixes>(),
}));
vi.mock("./resume-claim-checks", () => ({
  withResumeClaimChecks: mocks.checks,
  withResumeClaimFixes: mocks.fixes,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checks.mockImplementation(({ draft }) => Promise.resolve(draft));
  mocks.fixes.mockImplementation(({ draft }) => Promise.resolve(draft));
});

test("sanitizing forwards the same preview signal and remaining writer clock to checks and fixes", async () => {
  const seed = createSeed();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
  const signal = new AbortController().signal;
  const getRemainingBudgetMs = () => 123;
  const draft = ResumeDraftSchema.parse({
    id: "forwarding_draft",
    jobId: job.id,
    status: "draft",
    templateId: "classic_ats",
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    sections: [],
  });
  const ctx = {
    repository,
    aiClient: createAiClient(),
  } as unknown as WorkspaceServiceContext;
  try {
    await sanitizeAndCheckResumeDraft(
      ctx,
      { draft, job, profile: seed.profile },
      {
        signal,
        getRemainingBudgetMs,
        fixGeneratedLines: true,
      },
    );
    expect(mocks.checks).toHaveBeenCalledOnce();
    expect(mocks.fixes).toHaveBeenCalledOnce();
    for (const input of [
      mocks.checks.mock.calls[0]![0],
      mocks.fixes.mock.calls[0]![0],
    ]) {
      expect(input.signal).toBe(signal);
      expect(input.getRemainingBudgetMs).toBe(getRemainingBudgetMs);
    }
  } finally {
    await workspaceService.shutdown();
  }
});

test("standalone sanitizing supplies no writing deadline or signal", async () => {
  const seed = createSeed();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
  const draft = ResumeDraftSchema.parse({
    id: "standalone_forwarding_draft",
    jobId: job.id,
    status: "draft",
    templateId: "classic_ats",
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    sections: [],
  });
  const ctx = {
    repository,
    aiClient: createAiClient(),
  } as unknown as WorkspaceServiceContext;
  try {
    await sanitizeAndCheckResumeDraft(ctx, {
      draft,
      job,
      profile: seed.profile,
    });
    expect(mocks.checks.mock.calls[0]![0].signal).toBeUndefined();
    expect(mocks.checks.mock.calls[0]![0].getRemainingBudgetMs).toBeUndefined();
    expect(mocks.fixes).not.toHaveBeenCalled();
  } finally {
    await workspaceService.shutdown();
  }
});
