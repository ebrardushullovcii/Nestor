import type { ApplyBlocker } from "@nestor/browser-agent";
import { createHash } from "node:crypto";
import type * as ApplicationPreparation from "../internal/agent-application-preparation";
import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/invented-personal-answers.json";
import ownWords from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/own-words.json";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  type ApplicationReviewAnswer,
  ApplicationReviewCardSchema,
  ApplicationAuthorityStopConditionsSchema,
  ApplyExecutionResultSchema,
  SourceInstructionArtifactSchema,
  SubmissionOutcomeRecordSchema,
  UPLOAD_ATTACHED_ANSWER,
  type FoundJob,
  type ApplyExecutionResult,
  type RawApplyPage,
} from "@nestor/contracts";
import { createApplicationStore } from "@nestor/db/applications";
import {
  createJobSitesStore,
  createResumeStore,
  createSendGuards,
  openJobStore,
} from "@nestor/db/job-store";
import { afterEach, expect, it, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import {
  createApplicationService,
  type ApplicationServiceDeps,
} from "./application-service";
import { describeFormQuestion } from "./questions";

const preparation = vi.hoisted(() => ({
  answers: [] as ApplicationReviewAnswer[],
  blocker: null as ApplyBlocker | null,
  uploadsConfirmed: [] as boolean[],
  /** The file field the run saw accepted on the form, if any. */
  attachedField: "Resume" as string | null,
  readAnswers:
    undefined as ApplicationPreparation.AgentApplicationPreparationInput["readReusableAnswers"],
}));

vi.mock("../internal/agent-application-preparation", async (importOriginal) => {
  const actual = await importOriginal<typeof ApplicationPreparation>();
  return {
    ...actual,
    createApplyFormPreparer: (
      input: Parameters<typeof actual.createApplyFormPreparer>[0],
    ) => {
      preparation.readAnswers = input.readReusableAnswers;
      preparation.uploadsConfirmed.push(
        (input.uploadsConfirmedByPerson ?? []).length > 0,
      );
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
          answers: preparation.answers,
          pageUrl: input.executionInput.job.canonicalUrl,
          preparedAt: new Date().toISOString(),
          attachments: preparation.attachedField
            ? [
                {
                  label: "Resume",
                  fileName: "resume.pdf",
                  field: preparation.attachedField,
                },
              ]
            : [],
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

it("shares one blocked-site item, closes tabs, and never retries the site or subsequent jobs", async () => {
  const f = await setup(2, 1, { onDisk: true });
  preparation.blocker = {
    code: "browser_blocked",
    requiresPerson: true,
    summary: "The site refused this browser.",
    detail: "Open the job by hand.",
    nextActionLabel: "Open in my browser",
  };
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "blocked" }).rows,
    ).toHaveLength(2),
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  const tasks = f.applications.needsYou.list().rows;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.blockedUrl).toBe(
    f.execute.mock.calls[0]?.[1].job.canonicalUrl,
  );
  expect(
    f.applications.needsYou.details(tasks[0]!.id)?.applications,
  ).toHaveLength(2);
  expect(await f.service.checkAccess(tasks[0]!.id)).toBe(false);
  expect(f.browser.readApplicationPageBinding).not.toHaveBeenCalled();
  expect(f.browser.releaseApplicationPageBinding).toHaveBeenCalledTimes(2);
  f.applications.applyJobs({ selection: { ids: f.ids } });
  expect(
    f.applications.listApplications({ state: "queued" }).rows,
  ).toHaveLength(0);
  f.service.stop();
  f.jobs.close();
  const jobs = openJobStore(f.dbPath);
  const applications = createApplicationStore(jobs);
  const restarted = createApplicationService({ ...f.deps, jobs, applications });
  cleanups.unshift(() => {
    restarted.stop();
    jobs.close();
  });
  await restarted.start();
  expect(applications.listApplications({ state: "blocked" }).rows).toHaveLength(
    2,
  );
  expect(applications.needsYou.list().rows.map((task) => task.id)).toEqual([
    tasks[0]!.id,
  ]);
  expect(applications.applyJobs({ selection: { ids: f.ids } }).queued).toBe(0);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

it("closes a saved-rule skip without adding a Needs you question", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!({
    ...ready(),
    skipReason: "Neither saved option is offered.",
  });
  await vi.waitFor(() =>
    expect(
      f.applications.listApplications({ state: "skipped" }).rows,
    ).toHaveLength(1),
  );
  expect(f.applications.needsYou.list().total).toBe(0);
  expect(f.browser.releaseApplicationPageBinding).toHaveBeenCalledTimes(1);
});
afterEach(async () => {
  preparation.blocker = null;
  preparation.answers = [];
  preparation.attachedField = "Resume";
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
  count: number,
  concurrency?: number,
  options: { onDisk?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-apply-"));
  const imported = path.join(directory, "imported.txt");
  await writeFile(imported, "Synthetic imported resume");
  const dbPath = options.onDisk
    ? path.join(directory, "job-finder.sqlite")
    : ":memory:";
  const jobs = openJobStore(dbPath);
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
    transferApplicationPageBinding: vi.fn<
      (source: string, oldKey: string, nextKey: string) => Promise<boolean>
    >(() => Promise.resolve(true)),
    handApplicationPageToPerson: vi.fn(() => Promise.resolve()),
    releaseApplicationPageBinding: vi.fn(() => Promise.resolve()),
    readApplicationPageWithPerson: vi.fn<
      NonNullable<BrowserSessionRuntime["readApplicationPageWithPerson"]>
    >(() => Promise.resolve(null as RawApplyPage | null)),
  };
  const authorizeSending = vi.fn<ApplicationServiceDeps["authorizeSending"]>(
    () => Promise.resolve(null),
  );
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
    try {
      jobs.close();
    } catch {
      // A restart test closed it already.
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    applications,
    jobs,
    dbPath,
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

it("passes the job's current site notes and learned Apply instructions to preparation", async () => {
  const f = await setup(1);
  const sites = createJobSitesStore(f.jobs);
  sites.add({ text: "https://replica.test/board" });
  const site = sites.list().rows[0]!;
  sites.update({
    id: site.id,
    label: "Renamed source",
    customInstructions: "Use the guest application.",
  });
  sites.record(site.id, {
    draftInstructionId: "site-draft",
    instructionStatus: "draft",
  });
  f.jobs
    .sql("UPDATE job_sightings SET source_id=? WHERE job_id=?")
    .run(String(site.id), f.ids[0]!);
  const readInputs = f.deps.readInputs.bind(f.deps);
  f.deps.readInputs = async () => ({
    ...(await readInputs()),
    sourceInstructionArtifacts: [
      SourceInstructionArtifactSchema.parse({
        id: "site-draft",
        targetId: String(site.id),
        status: "draft",
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
        basedOnRunId: "synthetic-run",
        applyGuidance: ["Upload the resume before continuing."],
        versionInfo: {
          promptProfileVersion: "test",
          toolsetVersion: "test",
          adapterVersion: "test",
        },
      }),
    ],
  });
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  expect(f.execute.mock.calls[0]![1].instructions).toEqual([
    "Use the guest application.",
    "[Apply] Upload the resume before continuing.",
  ]);
  expect(f.execute.mock.calls[0]![1].listingDiscovery).toEqual({
    label: "Replica",
    url: "https://replica.test/jobs/0",
  });
  expect(f.execute.mock.calls[0]![1].job.canonicalUrl).toBe(
    "https://replica.test/jobs/0",
  );
});

it("keeps the sighting's historical source after its configured site URL changes", async () => {
  const f = await setup(1),
    sites = createJobSitesStore(f.jobs);
  sites.add({ text: "https://original-board.test/" });
  const source = sites.list().rows[0]!;
  f.jobs
    .sql(
      "UPDATE job_sightings SET source_id=?, url=?, source_label=? WHERE job_id=?",
    )
    .run(
      String(source.id),
      "https://original-board.test/jobs/1",
      "Original job board",
      f.ids[0]!,
    );
  sites.update({
    id: source.id,
    url: "https://different-board.test/",
    label: "Different source",
  });
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  expect(f.execute.mock.calls[0]![1].listingDiscovery).toEqual({
    label: "Original job board",
    url: "https://original-board.test/jobs/1",
  });
  expect(f.execute.mock.calls[0]![1].job.canonicalUrl).toBe(
    "https://replica.test/jobs/0",
  );
});

it.each(["paused", "failed"] as const)(
  "a %s preparation never restarts on the same saved answer, including after restart",
  async (state) => {
    const f = await setup(1);
    const question = ApplyExecutionResultSchema.parse({
      ...ready(),
      state,
      questions: [
        {
          id: "source",
          prompt: "My Information — How did you hear about this job? *",
          kind: "other",
          answerControlType: "single_choice",
          answerOptions: ["Job board", "Company website", "Referral", "Other"],
          detectedAt: new Date().toISOString(),
        },
      ],
    }).questions[0]!;
    const job = f.jobs.getJob(f.ids[0]!)!;
    const known = describeFormQuestion(question, job);
    f.applications.needsYou.remember({
      key: known.key,
      input: known.input,
      options: known.options,
      prompt: question.prompt,
      answer: "Job board",
      kind: "other",
      scope: {},
    });
    await f.service.start();
    f.applications.applyJobs({ selection: { ids: f.ids } });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    expect((await preparation.readAnswers!([question]))[0]?.answer).toBe(
      "Job board",
    );
    f.releases.shift()!(
      ApplyExecutionResultSchema.parse({
        ...ready(),
        state,
        questions: [question],
      }),
    );
    const expectedState = state === "paused" ? "needs_you" : "failed";
    await vi.waitFor(() =>
      expect(f.applications.listApplications().rows[0]?.state).toBe(
        expectedState,
      ),
    );
    f.service.stop();
    const restarted = createApplicationService(f.deps);
    cleanups.unshift(() => restarted.stop());
    await restarted.start();
    expect(f.applications.listApplications().rows[0]?.state).toBe(
      expectedState,
    );
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.applications.needsYou.list().total).toBe(
      state === "paused" ? 1 : 0,
    );
  },
);

it("Fill lets the form's own field saves out, keeps uploading while another form saves unrelated answers, but vetoes changed Profile facts", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  const recheck =
    f.execute.mock.calls[0]![1].recheckIntermediateMutationAuthority!;
  expect(f.execute.mock.calls[0]![1]).toMatchObject({
    intermediateMutationsAuthorized: true,
    attachmentUploadsAuthorized: true,
    intermediateMutationAllowedOrigins: [],
  });
  expect(await recheck("https://replica.test")).toBe(true);
  expect(await recheck("https://replica.test", "attachment")).toBe(true);
  f.applications.needsYou.remember({
    key: "salary",
    prompt: "Expected salary",
    answer: "50000",
    input: "number",
    scope: {},
    options: [],
  });
  expect(await recheck("https://replica.test", "attachment")).toBe(true);
  f.seed.profile.phone = "+447700900999";
  expect(await recheck("https://replica.test", "attachment")).toBe(false);
  expect(await recheck("https://replica.test")).toBe(false);
});

it("without a send envelope Send for me fills as Fill does: field saves, uploads frame-pinned", async () => {
  const f = await setup(1);
  f.seed.settings.applicationAutomationMode = "autonomous_submit";
  f.deps.instructionMode = () => Promise.resolve("autonomous_submit");
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } }, "autonomous_submit");
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  const input = f.execute.mock.calls[0]![1];
  expect(input).toMatchObject({
    intermediateMutationsAuthorized: true,
    submitAuthorized: false,
    intermediateMutationAllowedOrigins: [],
  });
  expect(
    await input.recheckIntermediateMutationAuthority!(
      "https://replica.test",
      "answers",
    ),
  ).toBe(true);
  expect(
    await input.recheckIntermediateMutationAuthority!(
      "https://unrelated.test",
      "attachment",
    ),
  ).toBe(false);
  f.seed.settings.applicationAutomationMode = "confirm_before_submit";
  expect(
    await input.recheckIntermediateMutationAuthority!(
      "https://replica.test",
      "attachment",
    ),
  ).toBe(true);
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.listApplications().rows[0]?.state).toBe("ready"),
  );
  expect(f.authorizeSending).toHaveBeenCalledOnce();
});

it("refuses sendPrepared after a used answer changes post-Ready and refills without a final browser action", async () => {
  const f = await setup(1);
  const saved = f.applications.needsYou.remember({
    key: "salary",
    prompt: "Annual salary expectation",
    answer: "50000",
    kind: "salary_expectation",
    input: "number",
    scope: {},
    options: [],
  });
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  const row = f.applications.listApplications().rows[0]!;
  const answers = await preparation.readAnswers!([
    {
      prompt: "Annual salary expectation",
      kind: "salary_expectation",
      answerControlType: "text",
      answerOptions: [],
      inputConstraints: { type: "number" },
    },
  ]);
  expect(answers[0]?.answer).toBe("50000");
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("ready"),
  );
  const artifact = f.applications.getWork(row.id)!.resumeArtifact;
  const policy = {
    version: 1 as const,
    answerPolicy: {
      approvedAnswerSnapshot: { revision: 1, digest: "a".repeat(64) },
      unknownRequiredQuestion: "pause_for_user" as const,
      unknownEligibility: "pause_for_user" as const,
      unknownLegalRequirement: "pause_for_user" as const,
    },
    stopConditions: ApplicationAuthorityStopConditionsSchema.parse(
      Object.fromEntries(
        ApplicationAuthorityStopConditionsSchema.keyof().options.map((key) => [
          key,
          key === "outcomeUncertain" ? "stop_no_retry" : "pause_for_user",
        ]),
      ),
    ),
  };
  const envelope = ApplicationAuthorityEnvelopeSchema.parse({
    id: "explicit-send",
    mode: "autonomous_submit",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: [String(row.jobId)] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: [artifact.sha256],
    allowedOrigins: ["https://replica.test"],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
    decisionPolicy: {
      ...policy,
      revision: 1,
      digest: createHash("sha256")
        .update(serializeApplicationAuthorityDecisionPolicyForDigest(policy))
        .digest("hex"),
    },
  });
  f.authorizeSending.mockResolvedValue(envelope);
  const finalAction =
    vi.fn<NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>>();
  f.deps.browser.executeExactlyOneFinalAction = finalAction;
  const arm = vi.spyOn(f.applications, "beginSubmission");
  f.applications.needsYou.saveAnswer({ id: saved.id, answer: "52000" });
  expect(await f.service.sendPrepared(row.id)).toBe(false);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  expect(f.applications.getApplication(row.id)).toMatchObject({
    state: "running",
    mode: "confirm_before_submit",
    attempt: row.attempt + 1,
  });
  expect(arm).not.toHaveBeenCalled();
  expect(finalAction).not.toHaveBeenCalled();
});

const rejectedUpload = () =>
  ApplyExecutionResultSchema.parse({
    ...ready(),
    state: "paused",
    questions: [
      {
        id: "upload_repair",
        prompt: "Resume — upload failed",
        kind: "resume",
        answerControlType: "file",
        detectedAt: new Date().toISOString(),
      },
    ],
  });

it("keeps one upload item per refused form, reopening or refilling it without sending", async () => {
  const f = await setup(2);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.shift()!(rejectedUpload());
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(2));
  const row = f.applications.forJobs([f.ids[0]!])[0]!;
  expect(row.state).toBe("needs_you");
  expect(f.browser.releaseApplicationPageBinding).not.toHaveBeenCalled();
  f.browser.focusApplicationPageBinding.mockResolvedValue(true);
  expect(await f.service.open(row.id)).toBe(true);
  expect(f.browser.handApplicationPageToPerson).toHaveBeenCalled();
  f.browser.focusApplicationPageBinding.mockResolvedValue(false);
  expect(await f.service.open(row.id)).toBe(true);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("ready"),
  );
  expect(f.applications.needsYou.list().total).toBe(1);
  expect(f.applications.getApplication(row.id)?.mode).toBe(row.mode);
  expect(f.authorizeSending).not.toHaveBeenCalled();
});

it("keeps Send for me through an upload repair and drops the upload item when the form stops on another question", async () => {
  const f = await setup(1);
  f.deps.instructionMode = () => Promise.resolve("autonomous_submit");
  f.seed.settings.applicationAutomationMode = "autonomous_submit";
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } }, "autonomous_submit", {
    conversationId: "send-with-upload",
    mode: "autonomous_submit",
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const row = f.applications.listApplications().rows[0]!;
  expect(await f.service.open(row.id)).toBe(true);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  expect(f.applications.getApplication(row.id)?.mode).toBe("autonomous_submit");
  expect(f.authorizeSending).toHaveBeenCalledTimes(2);
  f.releases.shift()!(
    ApplyExecutionResultSchema.parse({
      ...ready(),
      state: "paused",
      questions: [
        {
          id: "salary",
          prompt: "Annual salary expectation",
          kind: "salary_expectation",
          answerControlType: "text",
          detectedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await vi.waitFor(() =>
    expect(
      f.applications.needsYou.list().rows.map((task) => task.prompt),
    ).toEqual(["Annual salary expectation"]),
  );
  expect(f.applications.getApplication(row.id)?.state).toBe("needs_you");
});

it("drops the upload item once the person's page shows the file arrived, and finishes the form", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const file = {
    index: 0,
    tagName: "input",
    inputType: "file",
    role: "",
    id: "resume",
    name: "resume",
    label: "Resume",
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "resume.pdf",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
  const form = (nearby: string): RawApplyPage => ({
    ...f.personPage,
    title: "Apply",
    bodyText: "Apply",
    controls: [{ ...file, upload: { described: "", nearby, shown: false } }],
  });
  f.browser.readApplicationPageWithPerson.mockResolvedValue(
    form("Resume Upload rejected by server"),
  );
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(f.applications.needsYou.list().total).toBe(1);
  f.browser.readApplicationPageWithPerson.mockResolvedValue(
    form("Resume resume.pdf"),
  );
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2), {
    timeout: 5_000,
  });
  expect(f.applications.needsYou.list().total).toBe(0);
});

it("keeps the upload item while the person's page shows only another field's file confirmed", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const file = (id: string, label: string, value: string) => ({
    index: id === "resume" ? 0 : 1,
    tagName: "input",
    inputType: "file",
    role: "",
    id,
    name: id,
    label,
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value,
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  });
  // The cover letter arrived; the resume input is still empty.
  f.browser.readApplicationPageWithPerson.mockResolvedValue({
    ...f.personPage,
    title: "Apply",
    bodyText: "Apply",
    controls: [
      {
        ...file("resume", "Resume", ""),
        upload: { described: "", nearby: "", shown: false },
      },
      {
        ...file("letter", "Cover letter", "letter.pdf"),
        upload: {
          described: "",
          nearby: "letter.pdf",
          shown: false,
          network: "accepted",
        },
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(
    f.applications.needsYou.list().rows.map((task) => task.prompt),
  ).toEqual(["Resume — upload failed"]);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("refills with the person's word when they say the file is attached on the site", async () => {
  const f = await setup(1);
  preparation.uploadsConfirmed.length = 0;
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const row = f.applications.listApplications().rows[0]!;
  // An earlier attempt cannot settle the item.
  expect(
    f.applications.needsYou.dropQuestion(
      row.id,
      row.attempt + 1,
      "upload_repair",
    ),
  ).toBe(false);
  const task = f.applications.needsYou.list().rows[0]!;
  f.applications.needsYou.answer({
    id: task.id,
    answer: UPLOAD_ATTACHED_ANSWER,
    remember: false,
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(preparation.uploadsConfirmed).toEqual([false, true]),
  );
  // The word lasts that one refill: the next refusal asks again, and the
  // attempt after it does not inherit the earlier confirmation.
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("needs_you"),
  );
  expect(await f.service.open(row.id)).toBe(true);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
  expect(preparation.uploadsConfirmed).toEqual([false, true, false]);
});

it("never makes Ready or sends a form whose refused upload is still open, whatever a later run saw", async () => {
  const f = await setup(1);
  f.deps.instructionMode = () => Promise.resolve("autonomous_submit");
  f.seed.settings.applicationAutomationMode = "autonomous_submit";
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } }, "autonomous_submit", {
    conversationId: "send-with-open-upload",
    mode: "autonomous_submit",
  });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const row = f.applications.listApplications().rows[0]!;
  // The rerun resumes past the file's step and reports the form ready.
  preparation.attachedField = null;
  expect(await f.service.open(row.id)).toBe(true);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("needs_you"),
  );
  expect(f.applications.needsYou.list().total).toBe(1);
  expect(f.applications.beginSubmission(row.id, row.attempt + 1)).toBe(false);
  expect(f.browser.handApplicationPageToPerson).not.toHaveBeenCalled();
});

it("keeps the upload item when a later run attaches a different field's file", async () => {
  const f = await setup(1);
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  f.releases.shift()!(rejectedUpload());
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(1));
  const row = f.applications.listApplications().rows[0]!;
  // The rerun settles the cover letter, not the refused resume.
  preparation.attachedField = "Cover letter";
  expect(await f.service.open(row.id)).toBe(true);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.getApplication(row.id)?.state).toBe("needs_you"),
  );
  expect(
    f.applications.needsYou.list().rows.map((task) => task.prompt),
  ).toEqual(["Resume — upload failed"]);
});

it("keeps every shared file question's key, and scopes only the upload item to its job", () => {
  const resume = {
    prompt: "Resume",
    kind: "resume" as const,
    answerControlType: "file" as const,
    answerOptions: [],
  };
  const one = { id: 1, location: "Remote" };
  const two = { id: 2, location: "Remote" };
  expect(describeFormQuestion(resume, one).key).toBe(
    describeFormQuestion(resume, two).key,
  );
  const repair = { ...resume, id: "upload_repair" };
  expect(describeFormQuestion(repair, one).key).not.toBe(
    describeFormQuestion(repair, two).key,
  );
  // Two forms waiting on the same button are two items.
  const step = {
    id: "step_handover",
    prompt: 'Press "Save and continue" on the site, then continue',
    kind: "other" as const,
    answerControlType: "text" as const,
    answerOptions: [],
  };
  expect(describeFormQuestion(step, one).key).not.toBe(
    describeFormQuestion(step, two).key,
  );
  expect(describeFormQuestion(step, one).reusePrompt).toBe(false);
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

it("recovers interrupted preparation, settles an interrupted send from its saved outcome or holds it for confirmation, and a restart from disk resends nothing", async () => {
  const f = await setup(3, undefined, { onDisk: true });
  f.applications.applyJobs({ selection: { ids: f.ids } });
  const unknown = f.applications.claimNext()!;
  f.applications.beginSubmission(unknown.id, unknown.attempt);
  const confirmed = f.applications.claimNext()!;
  f.applications.beginSubmission(confirmed.id, confirmed.attempt);
  const filling = f.applications.claimNext()!;
  // The site confirmed one send before the app closed; its outcome was
  // saved. The other send has no saved outcome.
  const at = new Date().toISOString();
  vi.mocked(
    f.deps.authorityRepository.listSubmissionOutcomeRecords,
  ).mockImplementation(({ jobId } = {}) =>
    Promise.resolve(
      jobId === String(confirmed.jobId)
        ? [
            SubmissionOutcomeRecordSchema.parse({
              id: "receipt",
              preflightId: "preflight",
              idempotencyKey: "send",
              authorityEnvelopeId: "permission",
              authorityRevision: 1,
              jobId: String(confirmed.jobId),
              applicationRecordId: `application_${confirmed.id}`,
              runId: `application_run_${confirmed.id}`,
              resultId: `application_${confirmed.id}_attempt_${confirmed.attempt}`,
              outcome: "submitted",
              attemptedAt: at,
              verifiedAt: at,
              evidence: [
                {
                  id: "employer",
                  kind: "employer_site_state",
                  observedAt: at,
                  destination: {
                    origin: "https://replica.test",
                    safePath: "/thanks",
                  },
                  artifactRefId: null,
                  summary: "The employer confirmed receipt.",
                },
              ],
              retry: { eligible: false, blockReason: "submission_confirmed" },
            }),
          ]
        : [],
    ),
  );
  await f.service.start();
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  expect(f.applications.getApplication(unknown.id)?.state).toBe("uncertain");
  expect(f.applications.getApplication(confirmed.id)?.state).toBe("submitted");
  expect(f.applications.getApplication(filling.id)?.attempt).toBe(2);

  // The app closes mid-preparation and opens again on the same file.
  f.service.stop();
  f.jobs.close();
  const jobs = openJobStore(f.dbPath);
  const applications = createApplicationStore(jobs);
  const restarted = createApplicationService({ ...f.deps, jobs, applications });
  cleanups.unshift(() => {
    restarted.stop();
    jobs.close();
  });
  await restarted.start();
  // Only the interrupted preparation runs again. Neither send is replayed
  // or re-authorized, now or after the restart.
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  expect(applications.getApplication(unknown.id)?.state).toBe("uncertain");
  expect(applications.getApplication(confirmed.id)?.state).toBe("submitted");
  expect(f.execute.mock.calls.map(([, input]) => input.job.id)).toEqual([
    String(filling.jobId),
    String(filling.jobId),
  ]);
  expect(f.authorizeSending).not.toHaveBeenCalled();
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
  f.browser.transferApplicationPageBinding.mockImplementation(
    (_source, _old, next) =>
      next === key(first.id, 2)
        ? Promise.reject(
            new Error("The exact prepared application page is no longer open."),
          )
        : Promise.resolve(true),
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
    key(third.id, 2),
    f.jobs.getJob(third.jobId)!.applyUrl ?? f.jobs.getJob(third.jobId)!.url,
  );
  expect(f.browser.reloadApplicationPageBinding).not.toHaveBeenCalledWith(
    "target_site",
    key(first.id, 2),
    expect.anything(),
  );
  // This attempt lost its old tab, so execute opens a fresh application with
  // the shared session rather than reloading a retained binding.
  pages.set(key(second.id, 2), accessible);
  f.releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => {
    expect(f.applications.getApplication(third.id)?.state).toBe("needs_you");
    expect(f.applications.getApplication(second.id)?.state).toBe("ready");
  });
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

function sendEnvelope(jobId: number, sha256: string) {
  const content = {
    version: 1 as const,
    answerPolicy: {
      approvedAnswerSnapshot: { revision: 1, digest: "b".repeat(64) },
      unknownRequiredQuestion: "pause_for_user" as const,
      unknownEligibility: "pause_for_user" as const,
      unknownLegalRequirement: "pause_for_user" as const,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
    },
    stopConditions: {
      unavailableCredentials: "pause_for_user" as const,
      loginRequired: "pause_for_user" as const,
      mfaRequired: "pause_for_user" as const,
      captcha: "pause_for_user" as const,
      antiBot: "pause_for_user" as const,
      accountCreation: "pause_for_user" as const,
      staleObservation: "pause_for_user" as const,
      ambiguousFinalControl: "pause_for_user" as const,
      originDrift: "pause_for_user" as const,
      outcomeUncertain: "stop_no_retry" as const,
    },
  };
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "grounding-authority",
    mode: "confirm_before_submit",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: [String(jobId)] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: true,
    accountCreationAuthorized: false,
    revokedAt: null,
    allowedResumeSha256: [sha256],
    allowedOrigins: ["https://replica.test"],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    decisionPolicy: {
      ...content,
      revision: 1,
      digest: createHash("sha256")
        .update(serializeApplicationAuthorityDecisionPolicyForDigest(content))
        .digest("hex"),
    },
  });
}

it.each([
  ...replay.cases.map((entry) => ({ ...entry, rule: "" })),
  ...["Passport Country", "Citizenship", "Nationality"].map((question) => ({
    question,
    answer: "Germany",
    evidence: [
      { source: "applicant", path: "/location/region", quote: "Germany" },
    ],
    rule: "",
    written: false,
  })),
  ...["What is your top skill?", "What is your go-to monitoring tool?"].map(
    (question) => ({
      question,
      answer: "Playwright",
      evidence: [
        { source: "applicant", path: "/skills/0", quote: "Playwright" },
      ],
      rule: "",
      written: false,
    }),
  ),
  ...ownWords.rules.map((rule) => ({
    question: ownWords.question,
    answer: ownWords.proposed,
    evidence: [],
    rule,
  })),
])(
  "sendPrepared re-grounds a Ready answer before arming: $question",
  async (entry) => {
    const f = await setup(1);
    f.browser.readApplicationPageBinding.mockResolvedValue({
      ...f.personPage,
      bodyText: entry.rule,
    });
    f.seed.profile.yearsExperience = replay.applicant.yearsExperience;
    f.seed.profile.skills = replay.applicant.skills;
    f.seed.profile.currentRegion = "Germany";
    f.seed.profile.workEligibility.requiresVisaSponsorship = false;
    preparation.answers = [
      {
        question: entry.question,
        answer: entry.answer,
        source: "Written for this application",
        written: "written" in entry ? entry.written === true : true,
        groundedIn: [],
      },
    ];
    await f.service.start();
    f.applications.applyJobs({ selection: { ids: f.ids } });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.releases.shift()!();
    await vi.waitFor(() =>
      expect(f.applications.listApplications().rows[0]?.state).toBe("ready"),
    );
    const row = f.applications.listApplications().rows[0]!,
      work = f.applications.getWork(row.id)!;
    f.authorizeSending.mockResolvedValue(
      sendEnvelope(row.jobId, work.resumeArtifact.sha256!),
    );
    const chatWithTools = vi
      .fn<NonNullable<ApplicationServiceDeps["aiClient"]["chatWithTools"]>>()
      .mockResolvedValue({
        toolCalls: [
          {
            id: "lying-check",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  {
                    index: 0,
                    supported: true,
                    reason: "Supported",
                    evidence: entry.evidence.map((evidence) => ({
                      ...evidence,
                      kind: "applicant_fact",
                      claim: entry.answer,
                    })),
                  },
                ],
              }),
            },
          },
        ],
      });
    f.deps.aiClient = { ...f.deps.aiClient, chatWithTools };
    const action = vi.fn();
    Object.assign(f.browser, { executeExactlyOneFinalAction: action });
    expect(await f.service.sendPrepared(row.id)).toBe(false);
    // The lying answer report is not a usable question reading. It gets
    // exactly one retry, then the card is returned to Needs you.
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(action).not.toHaveBeenCalled();
    expect(f.applications.getApplication(row.id)?.state).toBe("needs_you");
    expect(f.applications.needsYou.list().rows[0]?.prompt).toBe(entry.question);
    expect(f.applications.getWork(row.id)?.reviewCard?.answers).toEqual([]);
    expect(f.onError).not.toHaveBeenCalled();
  },
);

it("Send for me resumes after two Needs-you answers and forwards only the final target once", async () => {
  const f = await setup(1);
  const guards = createSendGuards(f.jobs);
  f.deps.authorityRepository = guards;
  f.seed.settings.applicationAutomationMode = "autonomous_submit";
  f.deps.instructionMode = () => Promise.resolve("autonomous_submit");
  let authority: ReturnType<typeof sendEnvelope> | null = null;
  f.authorizeSending.mockImplementation(async ({ artifact, application }) => {
    if (!authority) {
      authority = {
        ...sendEnvelope(application.jobId, artifact.sha256!),
        mode: "autonomous_submit",
      };
      await guards.commitApplicationAuthorityEnvelope({
        envelope: authority,
        expectedRevision: null,
      });
    }
    return authority;
  });
  const observation = {
    identity: { id: "current-form", revision: 1, digest: "a".repeat(64) },
    page: { origin: "https://replica.test", safePath: "/jobs/0" },
    complete: true,
    controls: [
      {
        identity: { ref: "final-control-5", signature: "c".repeat(64) },
        ordinal: 5,
        kind: "button" as const,
        label: "Submit Application",
        formIndex: -1,
        action: { origin: "https://replica.test", safePath: "/jobs/0" },
      },
    ],
  };
  const observe = vi.fn<
    NonNullable<BrowserSessionRuntime["observeApplicationForm"]>
  >(() => Promise.resolve(observation));
  const action = vi.fn<
    NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>
  >(async (_source, input) => {
    const allowed = await input.veto({
      observation,
      control: observation.controls[0]!,
    });
    expect(allowed).toBe(true);
    return {
      outcome: "submitted",
      reason: "employer_confirmation",
      observation,
      control: observation.controls[0]!,
      facts: {
        actionAttempted: true,
        actionIssued: true,
        actionCompleted: true,
        pageBefore: observation.page,
        pageAfter: observation.page,
        urlChanged: false,
        requestsObservedDuringAction: 1,
      },
      confirmation: {
        observedAt: new Date().toISOString(),
        destination: observation.page,
        summary: "The employer confirmed receipt.",
      },
    };
  });
  Object.assign(f.browser, {
    observeApplicationForm: observe,
    executeExactlyOneFinalAction: action,
  });
  f.browser.readApplicationPageBinding.mockResolvedValue({
    ...f.personPage,
    bodyText: "Completed application",
    actions: [
      {
        ref: "a0",
        index: 0,
        label: "Upload file",
        visible: true,
        disabled: false,
      },
      {
        ref: "a5",
        index: 5,
        label: "Submit Application",
        visible: true,
        disabled: false,
      },
    ],
  });
  await f.service.start();
  f.applications.applyJobs({ selection: { ids: f.ids } }, "autonomous_submit");
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  f.releases.shift()!(
    ApplyExecutionResultSchema.parse({
      ...ready(),
      state: "paused",
      questions: [
        {
          id: "motivation",
          prompt: "Why do you want to join us?",
          kind: "other",
          answerControlType: "text",
          detectedAt: new Date().toISOString(),
        },
        {
          id: "story",
          prompt: "Tell us about a time you solved a problem",
          kind: "other",
          answerControlType: "text",
          detectedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await vi.waitFor(() => expect(f.applications.needsYou.list().total).toBe(2));
  for (const task of f.applications.needsYou.list().rows)
    f.applications.needsYou.answer({
      id: task.id,
      answer: "The person's unchanged recorded answer.",
      remember: true,
    });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
  f.releases.shift()!();
  await vi.waitFor(() =>
    expect(f.applications.listApplications().rows[0]?.state).toBe("submitted"),
  );
  expect(observe).toHaveBeenCalledWith(
    "target_site",
    expect.objectContaining({
      finalActionTargets: [{ ref: "a5", label: "Submit Application" }],
    }),
  );
  expect(action).toHaveBeenCalledOnce();
  expect(f.applications.needsYou.list().total).toBe(0);
  f.service.stop();
  const restarted = createApplicationService(f.deps);
  cleanups.unshift(() => restarted.stop());
  await restarted.start();
  expect(action).toHaveBeenCalledOnce();
  expect(f.onError).not.toHaveBeenCalled();
});
