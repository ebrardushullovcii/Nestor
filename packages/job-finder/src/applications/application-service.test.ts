import type { ApplyBlocker } from "@nestor/browser-agent";
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
  type ApplyExecutionResult,
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

const preparation = vi.hoisted(() => ({
  blocker: null as ApplyBlocker | null,
}));

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
          pauses: preparation.blocker
            ? [
                {
                  code: "page_blocked",
                  question: null,
                  summary: preparation.blocker.summary,
                  blocker: preparation.blocker,
                },
              ]
            : [],
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
  preparation.blocker = null;
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
  const releases: ((result?: ApplyExecutionResult) => void)[] = [];
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
        releases.push((result = ready()) => resolve(result));
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
    focusApplicationPageBinding: vi.fn(() => Promise.resolve(false)),
    readApplicationPageBinding: vi.fn<
      (source: string, key: string) => Promise<RawApplyPage | null>
    >(() => Promise.resolve(null)),
    reloadApplicationPageBinding: vi.fn<
      (source: string, key: string, applicationUrl?: string) => Promise<void>
    >(() => Promise.resolve()),
    transferApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
    handApplicationPageToPerson: vi.fn(() => Promise.resolve()),
    releaseApplicationPageBinding: vi.fn(() => Promise.resolve()),
    readApplicationPageWithPerson: vi.fn<
      NonNullable<BrowserSessionRuntime["readApplicationPageWithPerson"]>
    >(() => Promise.resolve(null as RawApplyPage | null)),
  };
  const authorizeSending = vi.fn(() => Promise.resolve(null));
  const onError = vi.fn();
  const authorityRepository = {
    recoverArmedSubmissionAttempts: vi.fn(() =>
      Promise.resolve({ recovered: 0 }),
    ),
    listSubmissionOutcomeRecords: vi.fn(() => Promise.resolve([])),
  } as unknown as ApplicationServiceDeps["authorityRepository"];
  const deps: ApplicationServiceDeps = {
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
    ...(concurrency === undefined ? {} : { concurrency }),
    onError,
  };
  const service = createApplicationService(deps);
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
    deps,
  };
}

it("returns an answer the form still rejects to Needs you instead of failing with an empty inbox", async () => {
  const f = await setup(1);
  const unanswered = ApplyExecutionResultSchema.parse({
    ...ready(),
    state: "paused",
    questions: [
      {
        id: "salary",
        prompt: "Annual salary expectation",
        kind: "salary_expectation",
        answerControlType: "text",
        inputConstraints: { type: "number" },
        detectedAt: new Date().toISOString(),
      },
    ],
  });
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(unanswered);
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const first = f.applications.needsYou.list().rows[0]!;
  f.applications.needsYou.answer({
    id: first.id,
    answer: "50000",
    remember: true,
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.shift()!(unanswered);
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  expect(f.applications.listApplications().rows[0]?.state).toBe("needs_you");
  expect(f.applications.needsYou.list().rows[0]?.id).not.toBe(first.id);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

it("keeps filling while another form saves unrelated answers, but vetoes changed Profile facts", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  const recheck =
    f.execute.mock.calls[0]![1].recheckIntermediateMutationAuthority!;
  expect(await recheck("https://replica.test")).toBe(true);
  f.applications.needsYou.remember({
    key: "salary",
    prompt: "Expected salary",
    answer: "50000",
    input: "number",
    scope: {},
    options: [],
  });
  expect(await recheck("https://replica.test")).toBe(true);
  f.seed.profile.phone = "+447700900999";
  expect(await recheck("https://replica.test")).toBe(false);
});

it("opens a restored Ready form without preparing or authorizing a send again", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.listApplications().rows[0]?.state).toBe("ready"),
  );
  f.service.stop();
  const restarted = createApplicationService(f.deps);
  cleanups.unshift(() => restarted.stop());
  await restarted.start();
  f.browser.focusApplicationPageBinding.mockResolvedValue(true);
  const row = f.applications.listApplications().rows[0]!;
  expect(await restarted.open(row.id)).toBe(true);
  expect(f.applications.getApplication(row.id)?.state).toBe("ready");
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

it("refills a lost Ready form through the bounded queue and never revives its send instruction", async () => {
  const f = await setup(1);
  f.deps.instructionMode = () => Promise.resolve("autonomous_submit");
  f.seed.settings.applicationAutomationMode = "autonomous_submit";
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } }, "autonomous_submit", {
    conversationId: "send-before-restart",
    mode: "autonomous_submit",
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.listApplications().rows[0]?.state).toBe("ready"),
  );
  f.service.stop();
  f.authorizeSending.mockClear();
  const restarted = createApplicationService(f.deps);
  cleanups.unshift(() => restarted.stop());
  await restarted.start();
  const row = f.applications.listApplications().rows[0]!;
  expect(
    await Promise.all([restarted.open(row.id), restarted.open(row.id)]),
  ).toEqual([true, true]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  expect(f.applications.getApplication(row.id)).toMatchObject({
    state: "running",
    mode: "confirm_before_submit",
    attempt: 2,
  });
  expect(f.execute.mock.calls[1]![1]).toMatchObject({
    submitAuthorized: false,
    applyAutomationMode: "confirm_before_submit",
  });
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("ready"),
  );
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

it("reopens the original account entry after restart and keeps one shared task until both forms continue", async () => {
  const f = await setup(2);
  preparation.blocker = {
    code: "site_login_required",
    requiresPerson: true,
    summary: "Sign in",
    detail: "Sign in",
    nextActionLabel: "Open browser",
  };
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "needs_you" }).rows,
    ).toHaveLength(2),
  );
  f.service.stop();
  const restarted = createApplicationService(f.deps);
  cleanups.unshift(() => restarted.stop());
  await restarted.start();
  const task = f.applications.needsYou.list().rows[0]!;
  const row = f.applications.needsYou.details(task.id)!.applications[0]!;
  f.browser.reloadApplicationPageBinding.mockImplementation(() => {
    f.browser.focusApplicationPageBinding.mockResolvedValue(true);
    return Promise.resolve();
  });
  expect(await restarted.open(row.id)).toBe(true);
  expect(
    f.browser.reloadApplicationPageBinding,
  ).toHaveBeenCalledExactlyOnceWith(
    "target_site",
    `application_${row.id}_attempt_1`,
    f.jobs.getJob(row.jobId)!.url,
  );
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.applications.needsYou.list().total).toBe(1);
  expect(f.applications.needsYou.details(task.id)!.applications).toHaveLength(
    2,
  );
  preparation.blocker = null;
  f.browser.readApplicationPageBinding.mockResolvedValue({
    ...f.personPage,
    bodyText: "Application",
    links: [
      {
        index: 0,
        label: "Continue application",
        href: "https://replica.test/application",
        visible: true,
        target: "",
        topOffset: 0,
      },
    ],
  });
  f.browser.transferApplicationPageBinding.mockResolvedValue(false);
  await restarted.checkAccess(task.id);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(4));
  expect(
    f.execute.mock.calls
      .slice(2)
      .every(([, input]) => input.startingUrl === undefined),
  ).toBe(true);
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "ready" }).rows,
    ).toHaveLength(2),
  );
  expect(f.applications.needsYou.list().total).toBe(0);
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

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
  expect(
    f.execute.mock.calls[0]![1].intermediateMutationAllowedOrigins,
  ).toEqual([]);
  expect(f.execute.mock.calls[0]![1].applyAllowedOrigins).toEqual([
    "https://replica.test",
  ]);
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

it("automatically carries every waiting page on after one site sign-in and MFA, checking each checkpoint", async () => {
  const f = await setup(3);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  preparation.blocker = {
    code: "site_login_required",
    requiresPerson: true,
    summary: "Sign in to continue",
    detail: "Sign in",
    nextActionLabel: "Open browser",
  };
  const pages = new Map<string, RawApplyPage>();
  const key = (id: number, attempt = 1) =>
    `application_${id}_attempt_${attempt}`;
  const base = {
    ...f.personPage,
    title: "Sign in",
    bodyText: "Sign in to continue",
  };
  f.browser.readApplicationPageBinding.mockImplementation((_source, id) =>
    Promise.resolve(pages.get(id) ?? base),
  );
  let personKey: string | null = null;
  f.browser.readApplicationPageWithPerson.mockImplementation((_source, id) =>
    Promise.resolve(id === personKey ? (pages.get(id) ?? null) : null),
  );
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "needs_you" }).rows,
    ).toHaveLength(3),
  );
  const rows = f.applications
    .listApplications()
    .rows.sort((a, b) => a.id - b.id);
  const first = rows[0]!;
  const second = rows[1]!;
  const third = rows[2]!;
  const task = f.applications.needsYou.list().rows[0]!;
  expect(f.applications.needsYou.list().total).toBe(1);
  personKey = key(first.id);
  pages.set(personKey, { ...base, bodyText: "Enter your verification code" });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.applications.needsYou.list().rows[0]).toMatchObject({
    id: task.id,
    kind: "mfa",
  });
  expect(f.execute).toHaveBeenCalledTimes(3);
  // A blank or error document is never evidence that sign-in succeeded.
  pages.set(personKey, { ...base, bodyText: "Page not found" });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.applications.getApplication(first.id)?.state).toBe("needs_you");
  const accessible: RawApplyPage = {
    ...base,
    bodyText: "Application",
    links: [
      {
        index: 0,
        label: "Continue application",
        href: "https://replica.test/application",
        visible: true,
        target: "",
        topOffset: 0,
      },
    ],
  };
  preparation.blocker = null;
  f.browser.transferApplicationPageBinding.mockRejectedValueOnce(
    new Error("The exact prepared application page is no longer open."),
  );
  pages.set(personKey, accessible);
  f.browser.reloadApplicationPageBinding.mockImplementation((_source, id) => {
    // One page still has its own challenge. Sharing the cookie is not proof.
    pages.set(
      id,
      id === key(third.id, 2)
        ? { ...base, bodyText: "Verify you are human" }
        : accessible,
    );
    return Promise.resolve();
  });
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(6), {
    timeout: 5000,
  });
  expect(f.browser.reloadApplicationPageBinding).toHaveBeenCalledWith(
    "target_site",
    key(second.id, 2),
    "https://replica.test/jobs/1",
  );
  expect(f.browser.reloadApplicationPageBinding).not.toHaveBeenCalledWith(
    "target_site",
    key(first.id, 2),
    expect.anything(),
  );
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() =>
    expect(f.applications.getApplication(third.id)?.state).toBe("needs_you"),
  );
  expect(f.applications.getApplication(second.id)?.state).toBe("ready");
  expect(
    f.applications.needsYou.details(task.id)?.applications.map((row) => row.id),
  ).toEqual([third.id]);
  personKey = key(third.id, 2);
  pages.set(personKey, accessible);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(7));
  expect(f.applications.needsYou.list().total).toBe(0);
  expect(f.applications.needsYou.listAnswers().total).toBe(0);
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "ready" }).rows,
    ).toHaveLength(3),
  );
  expect(f.authorizeSending).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
});
