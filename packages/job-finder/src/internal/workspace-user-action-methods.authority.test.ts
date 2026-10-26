import {
  ApplicationQuestionRecordSchema,
  ApplyJobResultSchema,
  SavedJobSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createWorkspaceServiceHarness,
  createSeed,
} from "../workspace-service.test-support";
import * as authorityResolution from "./apply-authority-resolution";
import { findManualAnswerStepsCoveredBy } from "./workspace-user-action-methods";

const now = "2026-10-13T10:00:00.000Z";
const salaryPrompt = "Expected salary";
const salaryAnswer = "45000 EUR per year";

function answerSeed() {
  const seed = createSeed();
  seed.savedJobs = Array.from({ length: 3 }, (_, index) =>
    SavedJobSchema.parse({
      ...seed.savedJobs[0],
      id: `job_${index}`,
      sourceJobId: `job_${index}`,
      canonicalUrl: `https://example.com/jobs/${index}`,
      applicationUrl: `https://example.com/jobs/${index}/apply`,
      company: `Synthetic company ${index}`,
      status: "discovered",
    }),
  );
  seed.userActionRequests = Array.from({ length: 3 }, (_, index) =>
    UserActionRequestSchema.parse({
      id: `request_${index}`,
      dedupeKey: `request_${index}`,
      revision: 1,
      kind: "manual_answer",
      state: "pending",
      requirement: "required",
      scope: {
        type: "application",
        runId: "run_salary",
        jobId: `job_${index}`,
        resultId: `result_${index}`,
        applicationRecordId: `application_${index}`,
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: `blocker_${index}`,
      },
      title: "Answer the salary question",
      summary: "A required answer needs the person.",
      createdAt: now,
      updatedAt: now,
    }),
  );
  seed.applicationQuestionRecords = seed.userActionRequests.map((_, index) =>
    ApplicationQuestionRecordSchema.parse({
      id: `question_${index}`,
      runId: "run_salary",
      jobId: `job_${index}`,
      resultId: `result_${index}`,
      applicationRecordId: `application_${index}`,
      prompt: salaryPrompt,
      kind: "salary_expectation",
      answerControlType: "text",
      isRequired: true,
      detectedAt: now,
      status: "detected",
    }),
  );
  seed.applyJobResults = seed.userActionRequests.map((_, index) =>
    ApplyJobResultSchema.parse({
      id: `result_${index}`,
      runId: "run_salary",
      jobId: `job_${index}`,
      applicationRecordId: `application_${index}`,
      state: "blocked",
      summary: "A salary answer needs review.",
      detail: "Synthetic pending application.",
      startedAt: now,
      updatedAt: now,
      privacyReceipt: {
        generatedAt: now,
        lineage: {
          runId: "run_salary",
          jobId: `job_${index}`,
          resultId: `result_${index}`,
          applicationRecordId: `application_${index}`,
        },
        destination: {
          origin: "https://example.com",
          safePath: `/jobs/${index}/apply`,
        },
        resume: {
          source: "original_upload",
          fileName: "synthetic-resume.pdf",
          sha256: index.toString(16).padStart(64, "0"),
        },
      },
    }),
  );
  seed.settings = { ...seed.settings, salaryDisclosure: "answer_from_profile" };
  seed.tailoredAssets = [];
  return seed;
}

function cover(repository: JobFinderRepository, prompt = salaryPrompt) {
  return findManualAnswerStepsCoveredBy({
    ctx: { repository },
    answered: [{ prompt, answer: salaryAnswer }],
    request: null,
    savedForFuture: true,
  });
}

function freezeFacts<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeFacts(child);
    Object.freeze(value);
  }
  return value;
}

afterEach(() => vi.restoreAllMocks());

describe("saved-answer application authority", () => {
  test("an unrelated answer reads no jobs, results, or salary authority on repeated checks", async () => {
    const repository = createInMemoryJobFinderRepository(answerSeed());
    const allJobs = vi.spyOn(repository, "listSavedJobs");
    const targetJobs = vi.spyOn(repository, "listSavedJobsByIds");
    const results = vi.spyOn(repository, "listApplyJobResults");
    const authority = vi.spyOn(
      authorityResolution,
      "resolveApplyAuthorityForJob",
    );

    expect(await cover(repository, "Years of experience")).toEqual([]);
    expect(await cover(repository, "Years of experience")).toEqual([]);
    expect(allJobs).not.toHaveBeenCalled();
    expect(targetJobs).not.toHaveBeenCalled();
    expect(results).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
    expect(await repository.listApplicationAnswerRecords()).toEqual([]);
  });

  test("matching requests batch only their jobs and use exact frozen result facts for each authority check", async () => {
    const base = createInMemoryJobFinderRepository(answerSeed());
    const repository: JobFinderRepository = {
      ...base,
      listSavedJobsByIds: async (ids) =>
        freezeFacts(await base.listSavedJobsByIds(ids)),
      listApplyJobResults: async (scope) =>
        freezeFacts(await base.listApplyJobResults(scope)),
    };
    const allJobs = vi.spyOn(repository, "listSavedJobs");
    const targetJobs = vi.spyOn(repository, "listSavedJobsByIds");
    const results = vi.spyOn(repository, "listApplyJobResults");
    const authority = vi.spyOn(
      authorityResolution,
      "resolveApplyAuthorityForJob",
    );

    const covered = await cover(repository, " Expected salary? ");
    expect(covered).toHaveLength(3);
    expect(allJobs).not.toHaveBeenCalled();
    expect(targetJobs).toHaveBeenCalledTimes(1);
    expect(new Set(targetJobs.mock.calls[0]![0])).toEqual(
      new Set(Array.from({ length: 3 }, (_, index) => `job_${index}`)),
    );
    expect(results).toHaveBeenCalledTimes(3);
    expect(authority).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      expect(results).toHaveBeenCalledWith({
        runId: "run_salary",
        jobId: `job_${index}`,
        applicationRecordId: `application_${index}`,
      });
      const authorityInput = authority.mock.calls.find(
        ([input]) => input.job.id === `job_${index}`,
      )?.[0];
      expect(authorityInput?.resumeSha256).toBe(
        index.toString(16).padStart(64, "0"),
      );
      expect(authorityInput?.applicationUrl).toBe(
        `https://example.com/jobs/${index}/apply`,
      );
      expect(Object.isFrozen(authorityInput?.job)).toBe(true);
      expect(
        covered.find((step) => step.request.id === `request_${index}`),
      ).toMatchObject({
        request: { revision: 1 },
        answers: [{ questionId: `question_${index}`, answer: salaryAnswer }],
      });
    }
    expect(await repository.listApplicationAnswerRecords()).toEqual([]);
  });

  test("fact caches stay within one check and never cache salary permission", async () => {
    const base = createInMemoryJobFinderRepository(answerSeed());
    let checks = 0;
    const repository: JobFinderRepository = {
      ...base,
      getSettings: async () => ({
        ...(await base.getSettings()),
        salaryDisclosure:
          checks++ < 1 ? "answer_from_profile" : "pause_for_user",
      }),
    };
    expect(await cover(repository)).toHaveLength(1);
    expect(checks).toBe(3);
    expect(await cover(repository)).toEqual([]);
    expect(checks).toBe(6);

    const jobs = vi.spyOn(base, "listSavedJobsByIds");
    const first = await cover(base);
    expect(first).toHaveLength(3);
    await base.commitSettingsUpdate((current) => ({
      ...current,
      salaryDisclosure: "pause_for_user",
    }));
    expect(await cover(base)).toEqual([]);
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  test("repeated steps share facts, while distinct applications of one job keep their own result and revision", async () => {
    const seed = answerSeed();
    const requests = seed.userActionRequests.slice(0, 3);
    const firstScope = requests[0]!.scope;
    const secondScope = {
      ...requests[1]!.scope,
      jobId: "job_0",
      runId: "run_salary_second",
    };
    seed.userActionRequests = [
      requests[0]!,
      UserActionRequestSchema.parse({ ...requests[1], scope: secondScope }),
      UserActionRequestSchema.parse({
        ...requests[2],
        scope: firstScope,
        revision: 7,
      }),
    ];
    seed.applicationQuestionRecords = seed.applicationQuestionRecords
      .slice(0, 2)
      .map((question, index) => ({
        ...question,
        jobId: "job_0",
        runId: index === 0 ? "run_salary" : "run_salary_second",
      }));
    seed.applyJobResults = seed.applyJobResults
      .slice(0, 2)
      .map((result, index) =>
        ApplyJobResultSchema.parse({
          ...result,
          jobId: "job_0",
          runId: index === 0 ? "run_salary" : "run_salary_second",
          privacyReceipt: result.privacyReceipt && {
            ...result.privacyReceipt,
            lineage: {
              ...result.privacyReceipt.lineage,
              jobId: "job_0",
              runId: index === 0 ? "run_salary" : "run_salary_second",
            },
          },
        }),
      );
    const repository = createInMemoryJobFinderRepository(seed);
    const jobs = vi.spyOn(repository, "listSavedJobsByIds");
    const results = vi.spyOn(repository, "listApplyJobResults");
    const authority = vi.spyOn(
      authorityResolution,
      "resolveApplyAuthorityForJob",
    );
    const covered = await cover(repository);
    expect(covered).toHaveLength(3);
    expect(jobs).toHaveBeenCalledExactlyOnceWith(["job_0"]);
    expect(results).toHaveBeenCalledTimes(2);
    expect(authority).toHaveBeenCalledTimes(3);
    expect(
      authority.mock.calls.map(([input]) => input.resumeSha256).sort(),
    ).toEqual(["0".repeat(64), "0".repeat(64), "0".repeat(63) + "1"]);
    expect(
      covered.find((step) => step.request.id === "request_1")?.answers,
    ).toEqual([{ questionId: "question_1", answer: salaryAnswer }]);
    expect(
      covered.find((step) => step.request.id === "request_2"),
    ).toMatchObject({
      request: { revision: 7 },
      answers: [{ questionId: "question_0", answer: salaryAnswer }],
    });

    // A later check must see new result facts rather than an earlier digest.
    const result = seed.applyJobResults[1]!;
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        ...result,
        privacyReceipt: result.privacyReceipt && {
          ...result.privacyReceipt,
          resume: { ...result.privacyReceipt.resume, sha256: "f".repeat(64) },
        },
      }),
    );
    authority.mockClear();
    await cover(repository);
    expect(authority.mock.calls.map(([input]) => input.resumeSha256)).toContain(
      "f".repeat(64),
    );
  });

  test("unmatched optional pay and partially matched required steps do not read salary facts", async () => {
    const seed = answerSeed();
    seed.userActionRequests = seed.userActionRequests.slice(0, 2);
    const questions = seed.applicationQuestionRecords.slice(0, 2);
    seed.applicationQuestionRecords = [
      { ...questions[0]!, isRequired: false },
      questions[1]!,
      ...questions.map((question) => ({
        ...question,
        id: `${question.id}_experience`,
        prompt: "Years of experience",
        kind: "experience" as const,
      })),
    ];
    const repository = createInMemoryJobFinderRepository(seed);
    const jobs = vi.spyOn(repository, "listSavedJobsByIds");
    const results = vi.spyOn(repository, "listApplyJobResults");
    const covered = await cover(repository, "Years of experience");
    expect(covered.map((step) => step.request.id)).toEqual(["request_0"]);
    expect(covered[0]?.answers).toEqual([
      { questionId: "question_0_experience", answer: salaryAnswer },
    ]);
    expect(jobs).not.toHaveBeenCalled();
    expect(results).not.toHaveBeenCalled();
  });

  test.each(["getWorkspaceSnapshot", "getWorkspaceProjection"] as const)(
    "%s adds no salary-recovery collection reads for one unrelated saved answer",
    async (reader) => {
      const seed = answerSeed();
      const {
        repository,
        workspaceService: service,
        savedAnswers,
      } = createWorkspaceServiceHarness({ seed });
      savedAnswers.upsert({
        key: "unrelated_answer",
        label: "Years of experience",
        prompt: "Years of experience",
        answer: "5 years",
        kind: "other",
      });
      const read = service[reader];
      if (!read) throw new Error("Display projection is unavailable.");
      const authority = vi.spyOn(
        authorityResolution,
        "resolveApplyAuthorityForJob",
      );
      const allJobs = vi.spyOn(repository, "listSavedJobs");
      const targetJobs = vi.spyOn(repository, "listSavedJobsByIds");
      const results = vi.spyOn(repository, "listApplyJobResults");
      for (let refresh = 0; refresh < 2; refresh += 1) {
        allJobs.mockClear();
        results.mockClear();
        await read.call(service);
        // Canonical rendering reads jobs once; display rendering borrows them.
        // Recovery and rendering read results at most once each (the display
        // path borrows cached collections); saved-answer coverage adds none.
        expect(allJobs).toHaveBeenCalledTimes(
          reader === "getWorkspaceSnapshot" ? 1 : 0,
        );
        expect(results.mock.calls.length).toBeLessThanOrEqual(3);
      }
      expect(targetJobs).not.toHaveBeenCalled();
      expect(authority).not.toHaveBeenCalled();
      expect(await repository.listApplicationAnswerRecords()).toEqual([]);
      expect(
        (await repository.listUserActionRequests()).every(
          (request) => request.state === "pending" && request.revision === 1,
        ),
      ).toBe(true);
    },
  );
});
