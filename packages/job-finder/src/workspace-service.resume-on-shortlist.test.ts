import { expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

// Resumes start writing the moment a job is shortlisted (ADR 0076).

function seedWith(count: number) {
  const seed = createSeed();
  const base = seed.savedJobs.find((job) => job.id === "job_ready")!;
  seed.savedJobs = Array.from({ length: count }, (_, index) =>
    SavedJobSchema.parse({
      ...base,
      id: `short_${index}`,
      canonicalUrl: `https://jobs.example.test/short/${index}`,
      sourceJobId: `short_${index}`,
      status: "discovered",
      planAssessments: {},
    }),
  );
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  return seed;
}

/** The test AI, reporting a configured provider so the switch applies. */
function configuredAi() {
  const aiClient = createAiClient();
  const status = aiClient.getStatus();
  aiClient.getStatus = () => ({ ...status, kind: "openai_compatible" });
  return aiClient;
}

async function drafted(
  repository: ReturnType<typeof createWorkspaceServiceHarness>["repository"],
  jobId: string,
) {
  return repository.getResumeDraftByJobId(jobId);
}

async function waitingIds(
  repository: ReturnType<typeof createWorkspaceServiceHarness>["repository"],
) {
  return (
    (await repository.getIntelligenceState()).resumeOnShortlistJobIds ?? []
  );
}

test("shortlisting writes each job's resume through the batch path", async () => {
  const seed = seedWith(3);
  seed.savedJobs[2] = {
    ...seed.savedJobs[2]!,
    resumeApplicationMode: "original_resume",
  };
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: configuredAi(),
  });
  await workspaceService.queueJobsForReview!(["short_0", "short_1", "short_2"]);
  await vi.waitFor(
    async () => {
      expect(await drafted(repository, "short_0")).not.toBeNull();
      expect(await drafted(repository, "short_1")).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  await vi.waitFor(async () =>
    expect(await waitingIds(repository)).toEqual([]),
  );
  // Original keeps the person's own file: nothing is written for it.
  expect(await drafted(repository, "short_2")).toBeNull();
  const [job] = await repository.listSavedJobsByIds(["short_0"]);
  expect(job?.status).toBe("ready_for_review");
});

test("the switch off leaves resumes for the person to create", async () => {
  const seed = seedWith(1);
  seed.settings = { ...seed.settings, writeResumesOnShortlist: false };
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: configuredAi(),
  });
  await workspaceService.queueJobsForReview!(["short_0"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await waitingIds(repository)).toEqual([]);
  expect(await drafted(repository, "short_0")).toBeNull();
});

test("without a configured AI the job stays as it is today", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: seedWith(1),
  });
  await workspaceService.queueJobsForReview!(["short_0"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await waitingIds(repository)).toEqual([]);
  expect(await drafted(repository, "short_0")).toBeNull();
});

test("moving a job back while its resume is written saves nothing", async () => {
  const aiClient = configuredAi();
  const original = aiClient.createResumeDraft.bind(aiClient);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  aiClient.createResumeDraft = async (input) => {
    started = true;
    await gate;
    return original(input);
  };
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: seedWith(1),
    aiClient,
  });
  await workspaceService.queueJobsForReview!(["short_0"]);
  await vi.waitFor(() => expect(started).toBe(true), { timeout: 10_000 });
  await workspaceService.removeJobFromReview("short_0");
  expect(await waitingIds(repository)).toEqual([]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await drafted(repository, "short_0")).toBeNull();
  const [job] = await repository.listSavedJobsByIds(["short_0"]);
  expect(job?.status).toBe("shortlisted");
});

test("pause holds the queue and Continue writes it", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: seedWith(1),
    aiClient: configuredAi(),
  });
  await workspaceService.setActivityControl({ paused: true });
  await workspaceService.queueJobsForReview!(["short_0"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await waitingIds(repository)).toEqual(["short_0"]);
  expect(await drafted(repository, "short_0")).toBeNull();
  await workspaceService.setActivityControl({ paused: false });
  await vi.waitFor(
    async () => expect(await drafted(repository, "short_0")).not.toBeNull(),
    { timeout: 10_000 },
  );
});

test("a queue saved before a restart carries on", async () => {
  const seed = seedWith(1);
  seed.savedJobs[0] = { ...seed.savedJobs[0]!, status: "drafting" };
  seed.intelligence = {
    ...seed.intelligence,
    resumeOnShortlistJobIds: ["short_0"],
  };
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: configuredAi(),
  });
  await workspaceService.continueResumesOnShortlist!();
  await vi.waitFor(
    async () => expect(await drafted(repository, "short_0")).not.toBeNull(),
    { timeout: 10_000 },
  );
  await vi.waitFor(async () =>
    expect(await waitingIds(repository)).toEqual([]),
  );
});
