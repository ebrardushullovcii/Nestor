import type * as ApplicationPreparation from "../internal/agent-application-preparation";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  type FoundJob,
  type RawApplyPage,
} from "@nestor/contracts";
import { createApplicationStore } from "@nestor/db/applications";
import { createResumeStore, openJobStore } from "@nestor/db/job-store";
import { afterEach, expect, it, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createApplicationService,
  type ApplicationServiceDeps,
} from "./application-service";

vi.mock("../internal/agent-application-preparation", async (importOriginal) => {
  const actual = await importOriginal<typeof ApplicationPreparation>();
  return {
    ...actual,
    createApplyFormPreparer: (
      input: Parameters<typeof actual.createApplyFormPreparer>[0],
    ) => {
      input.onPrepared?.({
        result: {
          outcome: "ready_to_send",
          reason: "Ready",
          steps: 1,
          finalUrl: input.executionInput.job.canonicalUrl,
          filled: [],
          attachments: [],
          pauses: [],
          notes: [],
          timeline: [],
          modelTurns: 0,
          readyToSend: { actionRef: "submit", actionLabel: "Apply" },
        },
        reviewCard: ApplicationReviewCardSchema.parse({
          siteLabel: "Replica",
          pageUrl: input.executionInput.job.canonicalUrl,
          preparedAt: new Date().toISOString(),
        }),
        handoff: {
          status: "awaiting_your_review",
          reason: "Ready",
          finalAction: { actionRef: "submit", actionLabel: "Apply" },
        },
      });
      return vi.fn();
    },
  };
});

const ready = () =>
  ApplyExecutionResultSchema.parse({
    state: "ready",
    summary: "Ready",
    detail: "Filled form",
    submittedAt: null,
    outcome: null,
    nextActionLabel: "Open form",
  });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(count: number, concurrency?: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-apply-"));
  const imported = path.join(directory, "imported.txt");
  await writeFile(imported, "Synthetic imported resume");
  const jobs = openJobStore(":memory:");
  const resumes = createResumeStore(jobs);
  const applications = createApplicationStore(jobs);
  const seed = createSeed();
  seed.profile.baseResume.storagePath = imported;
  const ids = jobs.saveFoundJobs({
    searchId: null,
    jobs: Array.from(
      { length: count },
      (_, i): FoundJob => ({
        title: `Engineer ${i}`,
        company: "Replica",
        location: "Remote",
        workModes: ["remote"],
        url: `https://replica.test/jobs/${i}`,
        applyUrl: null,
        sourceId: "replica",
        sourceLabel: "Replica",
        sourceJobId: String(i),
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Synthetic posting",
      }),
    ),
  }).added;
  jobs.setStage(ids, "shortlisted");
  for (const id of ids) {
    resumes.startWriting(id, "original");
    resumes.finishWriting(id, null);
    resumes.approve(id, null);
  }
  const releases: (() => void)[] = [];
  const execute = vi.fn<
    NonNullable<BrowserSessionRuntime["executeApplicationFlow"]>
  >(
    (_source, _input, options) =>
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Stopped")),
          { once: true },
        );
        releases.push(() => resolve(ready()));
      }),
  );
  const personPage: RawApplyPage = {
    url: "https://replica.test/jobs/0",
    title: "Thanks",
    bodyText: "Thank you for applying. Your application has been received.",
    headings: [],
    controls: [],
    actions: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
  const browser = {
    executeApplicationFlow: execute,
    handApplicationPageToPerson: vi.fn(() => Promise.resolve()),
    releaseApplicationPageBinding: vi.fn(() => Promise.resolve()),
    readApplicationPageWithPerson: vi.fn(() =>
      Promise.resolve(null as RawApplyPage | null),
    ),
  };
  const authorizeSending = vi.fn(() => Promise.resolve(null));
  const onError = vi.fn();
  const authorityRepository = {
    recoverArmedSubmissionAttempts: vi.fn(() =>
      Promise.resolve({ recovered: 0 }),
    ),
    listSubmissionOutcomeRecords: vi.fn(() => Promise.resolve([])),
  } as unknown as ApplicationServiceDeps["authorityRepository"];
  const service = createApplicationService({
    jobs,
    applications,
    browser: browser as unknown as BrowserSessionRuntime,
    aiClient: createDeterministicJobFinderAiClient(),
    documentManager: {} as ApplicationServiceDeps["documentManager"],
    authorityRepository,
    readInputs: () =>
      Promise.resolve({
        profile: seed.profile,
        settings: seed.settings,
        searchPreferences: seed.searchPreferences,
      }),
    isPaused: () => Promise.resolve(false),
    isHoldingCurrent: () => Promise.resolve(false),
    authorizeSending,
    concurrency,
    onError,
  });
  cleanups.push(async () => {
    service.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    jobs.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    applications,
    jobs,
    ids,
    imported,
    seed,
    browser,
    execute,
    releases,
    authorizeSending,
    onError,
    personPage,
  };
}

it("defaults to four preparations and leaves additional applications queued", async () => {
  const f = await setup(5);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(4));
  expect(
    f.applications.listApplications({ state: "queued" }).rows,
  ).toHaveLength(1);
});

it("starts approved jobs immediately, caps preparation, and leaves Original forms for the person's click", async () => {
  const f = await setup(4, 2);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  expect(
    f.applications.listApplications({ state: "queued" }).rows,
  ).toHaveLength(2);
  expect(f.execute.mock.calls[0]![1].resumeArtifact.filePath).toBe(f.imported);
  f.releases.shift()!();
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
  const row = f.applications.forJobs([
    Number(f.execute.mock.calls[0]![1].job.id),
  ])[0]!;
  expect(row.state).toBe("ready");
  expect(f.jobs.getJob(row.jobId)?.stage).toBe("resume");
  expect(f.browser.handApplicationPageToPerson).toHaveBeenCalledWith(
    "target_site",
    `application_${row.id}_attempt_1`,
  );
  expect(f.authorizeSending).not.toHaveBeenCalled();
  await f.service.stopApplication(row.id);
  expect(f.applications.getApplication(row.id)?.state).toBe("stopped");
  expect(f.browser.releaseApplicationPageBinding).toHaveBeenCalledWith(
    "target_site",
    `application_${row.id}_attempt_1`,
  );
});

it("records the person's confirmed submission, moves Approved to applied, and closes that exact tab", async () => {
  const f = await setup(1);
  vi.useFakeTimers();
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.listApplications().rows[0]?.state).toBe("ready"),
  );
  f.browser.readApplicationPageWithPerson.mockResolvedValue(f.personPage);
  await vi.advanceTimersByTimeAsync(2_000);
  const row = f.applications.listApplications().rows[0]!;
  expect(row.state).toBe("submitted");
  expect(f.jobs.getJob(row.jobId)?.stage).toBe("applied");
  expect(f.applications.getSubmissionReceipt(row.id)?.outcome).toBe(
    "submitted",
  );
  expect(f.browser.releaseApplicationPageBinding).toHaveBeenCalledWith(
    "target_site",
    `application_${row.id}_attempt_1`,
  );
  expect(f.applications.applyJobs({ selection: { ids: f.ids } }).queued).toBe(
    0,
  );
});

it("recovers interrupted preparation but holds an interrupted send for confirmation", async () => {
  const f = await setup(2);
  f.applications.applyJobs({ selection: { ids: f.ids } });
  const sending = f.applications.claimNext()!;
  f.applications.beginSubmission(sending.id, sending.attempt);
  const filling = f.applications.claimNext()!;
  await f.service.start();
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  expect(f.applications.getApplication(sending.id)?.state).toBe("uncertain");
  expect(f.applications.getApplication(filling.id)?.attempt).toBe(2);
});
