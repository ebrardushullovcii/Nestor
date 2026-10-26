import { afterEach, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import {
  PROFILE_WORKFLOW_CHANNEL,
  ResumeImportRunSchema,
  canRetrySavedResumeImport,
  type ProfileWorkflowResult,
} from "@nestor/contracts";
import { createProfileService } from "@nestor/job-finder";
import { createJobFinderRepository, openJobStore } from "@nestor/db/job-store";

const store = openJobStore(":memory:");
const repository = createJobFinderRepository(store);
// The service this read runs through, as the app's runtime builds it; the
// parts a read never touches are left empty.
const service = createProfileService({
  repository,
  aiClient: {} as never,
  browserRuntime: {} as never,
  documentManager: { listResumeTemplates: () => [] } as never,
});

vi.mock("../services/job-store", () => ({ getJobStore: () => store }));
vi.mock("../services/job-finder/runtime", () => ({
  getProfileService: () => Promise.resolve(service),
}));
vi.mock("../services/job-finder/import-resume", () => ({
  isDesktopResumeImportActive: () => false,
}));

const { registerProfileWorkflowRoutes } = await import("./profile-workflow");

afterEach(() => store.close());

it("reads an import the app closed on as interrupted, so it can be tried again", async () => {
  await repository.replaceResumeImportRunArtifacts({
    run: ResumeImportRunSchema.parse({
      id: "import_cut_off",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "resume.pdf",
      trigger: "import",
      status: "extracting",
      startedAt: "2026-10-26T10:00:00.000Z",
    }),
    documentBundles: [],
    fieldCandidates: [],
  });
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  registerProfileWorkflowRoutes({
    handle: (
      channel: string,
      handler: (event: unknown, payload: unknown) => unknown,
    ) => handlers.set(channel, handler),
  } as unknown as IpcMain);

  const result = (await handlers.get(PROFILE_WORKFLOW_CHANNEL)!(
    {},
    { type: "read" },
  )) as ProfileWorkflowResult;

  expect(result.state.latestResumeImportRun).toMatchObject({
    id: "import_cut_off",
    status: "failed",
    failureKind: "interrupted",
  });
  expect(canRetrySavedResumeImport(result.state.latestResumeImportRun)).toBe(
    true,
  );
  // The store keeps it that way for the next read.
  expect((await repository.getLatestResumeImportRun())?.status).toBe("failed");
});
