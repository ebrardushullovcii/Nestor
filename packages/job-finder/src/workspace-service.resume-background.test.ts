import { expect, test, vi } from "vitest";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import { createAiClient } from "./workspace-service.test-runtimes";

test("opening one resume reads targeted job rows without loading every saved job", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  const all = vi.spyOn(repository, "listSavedJobs");
  const targeted = vi.spyOn(repository, "listSavedJobsByIds");
  await workspaceService.getResumeWorkspace("job_ready");
  expect(all).not.toHaveBeenCalled();
  expect(
    targeted.mock.calls.every(
      ([ids]) => ids.length === 1 && ids[0] === "job_ready",
    ),
  ).toBe(true);
});

test("opening several resumes bounds detached model checks to two", async () => {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 6 }, (_, index) => ({
    ...base,
    id: `resume_${index}`,
    canonicalUrl: `https://example.test/resume_${index}`,
    matchAssessment: {
      ...base.matchAssessment,
      requirementsSource: "deterministic" as const,
    },
    planAssessments: {},
  }));
  seed.resumeDrafts = [];
  seed.tailoredAssets = [];
  const aiClient = createAiClient();
  const signals: AbortSignal[] = [];
  const assess = vi
    .spyOn(aiClient, "assessJobFit")
    .mockImplementation((input) => {
      if (input.signal) signals.push(input.signal);
      return new Promise(() => {});
    });
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  for (const job of seed.savedJobs)
    await workspaceService.getResumeWorkspace(job.id);
  await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(2));
  await workspaceService.shutdown();
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("reset aborts detached resume fit checks and blocks their late writes", async () => {
  const aiClient = createAiClient();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    aiClient,
  });
  await workspaceService.generateResume("job_ready");
  const selected = (await repository.listSavedJobsByIds(["job_ready"]))[0]!;
  await repository.commitSavedJobDelta({
    upserts: [
      {
        ...selected,
        matchAssessment: {
          ...selected.matchAssessment,
          requirementsSource: "deterministic",
        },
        planAssessments: {},
      },
    ],
  });
  let finish!: (
    value: Awaited<ReturnType<typeof aiClient.assessJobFit>>,
  ) => void;
  let signal: AbortSignal | undefined;
  const response = await aiClient.assessJobFit({
    profile: await repository.getProfile(),
    searchPreferences: await repository.getSearchPreferences(),
    job: selected,
    assessmentDate: "2026-10-13",
  });
  const assess = vi
    .spyOn(aiClient, "assessJobFit")
    .mockImplementation((input) => {
      signal = input.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
  await workspaceService.getResumeWorkspace("job_ready");
  await vi.waitFor(() => expect(assess).toHaveBeenCalledOnce());
  await workspaceService.resetWorkspace({
    ...createSeed(),
    profile: await repository.getProfile(),
    searchPreferences: await repository.getSearchPreferences(),
    settings: await repository.getSettings(),
    savedJobs: [selected],
  });
  expect(signal?.aborted).toBe(true);
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  finish(response);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(commit).not.toHaveBeenCalled();
});

test("Resume Studio opens while listing fit is still being checked and keeps one check", async () => {
  const aiClient = createAiClient();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    aiClient,
  });
  await workspaceService.generateResume("job_ready");
  const draft = await repository.getResumeDraftByJobId("job_ready");
  let rejectCheck: ((reason: Error) => void) | undefined;
  const assess = vi.spyOn(aiClient, "assessJobFit").mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectCheck = reject;
      }),
  );
  const jobs = await repository.listSavedJobs();
  const job = jobs.find((entry) => entry.id === "job_ready")!;
  await repository.commitSavedJobDelta({
    upserts: [
      {
        ...job,
        matchAssessment: {
          ...job.matchAssessment,
          requirementsSource: "deterministic",
        },
        planAssessments: {},
      },
    ],
  });
  const workspace = await workspaceService.getResumeWorkspace("job_ready");
  expect(workspace.draft.id).toBe(draft!.id);
  expect(workspace.listingCheckState).toBe("checking");
  expect(
    (await workspaceService.getResumeWorkspace("job_ready")).listingCheckState,
  ).toBe("checking");
  await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(1));
  rejectCheck!(new Error("Synthetic failure"));
  await vi.waitFor(async () =>
    expect(
      (await workspaceService.getResumeWorkspace("job_ready"))
        .listingCheckState,
    ).toBe("failed"),
  );
  expect(
    (await repository.getResumeDraftByJobId("job_ready"))!.sections,
  ).toEqual(draft!.sections);
});

test("saving only job sources leaves an approved resume current", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  await workspaceService.generateResume("job_ready");
  const draft = (await repository.getResumeDraftByJobId("job_ready"))!;
  await repository.upsertResumeDraft({
    ...draft,
    status: "approved",
    approvedAt: draft.updatedAt,
    approvedExportId: "synthetic_export",
  });
  const profile = await repository.getProfile();
  const preferences = await repository.getSearchPreferences();
  await workspaceService.saveProfileAndSearchPreferences(profile, {
    ...preferences,
    discovery: { ...preferences.discovery, targets: [] },
  });
  expect((await repository.getResumeDraftByJobId("job_ready"))!.status).toBe(
    "approved",
  );
});
