import {
  ApplicationQuestionRecordSchema,
  ApplicationAnswerRecordSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  CandidateAssetSchema,
  ApplicationAttemptBlockerSchema,
  type ApplicationQuestionKind,
  type UserActionCommand,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, it, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { createWorkspaceApplicationAnswerMethods } from "./workspace-application-answer-methods";
import { createWorkspaceApplyRunStoreMethods } from "./workspace-apply-run-store-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { persistApplicationUserAction } from "./workspace-application-user-action";

function createHarness(
  options: {
    answerControlType?: "single_choice" | "file";
    answerOptions?: string[];
    candidateAssetResolver?: WorkspaceServiceContext["candidateAssetResolver"];
    questionKind?: ApplicationQuestionKind;
    performUserAction?: (command: UserActionCommand) => Promise<unknown>;
  } = {},
) {
  const now = "2026-08-10T10:00:00.000Z";
  const seed = createSeed();
  const job = seed.savedJobs[0]!;
  const applicationRecordId = "application-answers";
  seed.applicationRecords = [
    ApplicationRecordSchema.parse({
      id: applicationRecordId,
      jobId: job.id,
      title: job.title,
      company: job.company,
      status: job.status,
      lastActionLabel: "Prepared safely",
      nextActionLabel: "Review answers",
      lastUpdatedAt: now,
    }),
  ];
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run-answers",
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [job.id],
      currentJobId: job.id,
      summary: "Prepared safely",
      detail: "Final submission remains disabled.",
      createdAt: now,
      updatedAt: now,
    }),
  ];
  seed.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "result-answers",
      runId: "run-answers",
      jobId: job.id,
      applicationRecordId,
      state: "awaiting_review",
      summary: "Questions need review",
      detail: "No submission occurred.",
      startedAt: now,
      updatedAt: now,
    }),
  ];
  seed.applicationQuestionRecords = [
    ApplicationQuestionRecordSchema.parse({
      id: "question-sponsorship",
      runId: "run-answers",
      jobId: job.id,
      applicationRecordId,
      resultId: "result-answers",
      prompt: "Will you now or later require visa sponsorship?",
      kind: options.questionKind ?? "visa_sponsorship",
      answerControlType: options.answerControlType ?? "single_choice",
      isRequired: true,
      detectedAt: now,
      answerOptions: options.answerOptions ?? ["Yes", "No"],
      status: "detected",
    }),
  ];

  const repository = createInMemoryJobFinderRepository(seed);
  const ctx = {
    repository,
    ...(options.candidateAssetResolver
      ? { candidateAssetResolver: options.candidateAssetResolver }
      : {}),
  } as WorkspaceServiceContext;
  const runStore = createWorkspaceApplyRunStoreMethods(ctx);
  const methods = createWorkspaceApplicationAnswerMethods(
    ctx,
    runStore.getApplyRunDetails,
    options.performUserAction,
  );
  return { job, methods, repository, runStore };
}

function saveCommand(commandId: string, expectedAnswerRevision: number) {
  return {
    commandId,
    runId: "run-answers",
    jobId: "job-1",
    resultId: "result-answers",
    questionId: "question-sponsorship",
    expectedAnswerRevision,
    value: { type: "single_choice" as const, value: "no" },
    saveScope: "application_once" as const,
    submitAuthorized: false as const,
    accountCreationAuthorized: false as const,
  };
}

describe("workspace application answer methods", () => {
  it.each([
    ["reusable_profile", "none"],
    ["reusable_profile", "prior_answer"],
    ["reusable_profile", "user"],
    ["application_once", "none"],
    ["application_once", "prior_answer"],
    ["application_once", "user"],
  ] as const)(
    "%s answers respect reuse across open applications with an existing %s answer",
    async (saveScope, existingSource) => {
      const { job, repository, methods } = createHarness({
        questionKind: "other",
      });
      const peerJob = { ...job, id: "job-peer" };
      await repository.commitSavedJobDelta({ upserts: [peerJob] });
      const run = (await repository.listApplyRuns())[0]!;
      await repository.upsertApplyRun({
        ...run,
        jobIds: [job.id, peerJob.id],
        totalJobs: 2,
      });
      const result = (await repository.listApplyJobResults())[0]!;
      const question = (await repository.listApplicationQuestionRecords())[0]!;
      const record = (await repository.listApplicationRecords())[0]!;
      await repository.upsertApplicationRecord({
        ...record,
        id: "record-peer",
        jobId: peerJob.id,
      });
      await repository.upsertApplyJobResult({
        ...result,
        id: "result-peer",
        jobId: peerJob.id,
        applicationRecordId: "record-peer",
      });
      await repository.upsertApplicationQuestionRecord({
        ...question,
        id: "question-peer",
        jobId: peerJob.id,
        resultId: "result-peer",
        applicationRecordId: "record-peer",
      });
      if (existingSource !== "none")
        await repository.upsertApplicationAnswerRecord(
          ApplicationAnswerRecordSchema.parse({
            id: "peer-suggestion",
            runId: run.id,
            jobId: peerJob.id,
            resultId: "result-peer",
            applicationRecordId: "record-peer",
            questionId: "question-peer",
            status: "suggested",
            revision: 1,
            text: "Yes",
            value: { type: "single_choice", value: "Yes" },
            sourceKind: existingSource,
            sourceId: "previous",
            createdAt: "2026-08-10T10:00:00.000Z",
          }),
        );
      await methods.saveApplicationAnswer({
        ...saveCommand("save-batch", 0),
        jobId: job.id,
        saveScope,
      });
      const peerAnswers = await repository.listApplicationAnswerRecords({
        questionId: "question-peer",
      });
      const reused =
        saveScope === "reusable_profile" && existingSource !== "user";
      expect(peerAnswers).toHaveLength(
        (existingSource === "none" ? 0 : 1) + (reused ? 1 : 0),
      );
      expect(
        peerAnswers.find((answer) =>
          answer.sourceId?.startsWith("save-batch_reuse"),
        )?.text,
      ).toBe(reused ? "No" : undefined);
    },
  );

  it.each([
    ["Canada", false],
    ["United Kingdom", true],
  ] as const)(
    "does not copy eligibility to %s with conditional permission %s",
    async (country, conditional) => {
      const { job, repository, methods } = createHarness();
      await repository.commitSavedJobDelta({
        upserts: [
          { ...job, location: "United Kingdom" },
          { ...job, id: "job-other-country", location: country },
        ],
      });
      if (conditional)
        await repository.commitProfileUpdate((profile) => ({
          ...profile,
          workEligibility: {
            ...profile.workEligibility,
            limitedWorkPermissions: [
              {
                country: "United Kingdom",
                conditions: "Part-time work only, at most 20 hours weekly",
                requiresFutureSponsorship: true,
              },
            ],
          },
        }));
      const run = (await repository.listApplyRuns())[0]!;
      await repository.upsertApplyRun({
        ...run,
        jobIds: [job.id, "job-other-country"],
        totalJobs: 2,
      });
      const record = (await repository.listApplicationRecords())[0]!;
      await repository.upsertApplicationRecord({
        ...record,
        id: "record-other-country",
        jobId: "job-other-country",
      });
      const result = (await repository.listApplyJobResults())[0]!;
      const question = (await repository.listApplicationQuestionRecords())[0]!;
      await repository.upsertApplyJobResult({
        ...result,
        id: "result-other-country",
        jobId: "job-other-country",
        applicationRecordId: "record-other-country",
      });
      await repository.upsertApplicationQuestionRecord({
        ...question,
        id: "question-other-country",
        jobId: "job-other-country",
        resultId: "result-other-country",
        applicationRecordId: "record-other-country",
      });
      await methods.saveApplicationAnswer({
        ...saveCommand("save-country", 0),
        jobId: job.id,
        saveScope: "reusable_profile",
      });
      expect(
        await repository.listApplicationAnswerRecords({
          questionId: "question-other-country",
        }),
      ).toEqual([]);
    },
  );
  it.each(["blocked", "awaiting_review"] as const)(
    "continues the exact %s step once after its last required answer is saved",
    async (state) => {
      const performUserAction = vi.fn().mockResolvedValue(undefined);
      const { job, repository, methods } = createHarness({ performUserAction });
      const result = (await repository.listApplyJobResults())[0]!;
      await repository.upsertApplyJobResult({ ...result, state });
      await persistApplicationUserAction({
        repository,
        applicationRecordId: result.applicationRecordId!,
        job,
        runId: result.runId,
        resultId: result.id,
        replayCheckpointId: "checkpoint-answers",
        blocker: ApplicationAttemptBlockerSchema.parse({
          code: "missing_candidate_answer",
          userActionKind: "manual_answer",
          summary: "Answer the employer question.",
          questionIds: ["question-sponsorship"],
          url: job.applicationUrl ?? job.canonicalUrl,
        }),
        occurredAt: "2026-08-10T10:00:00.000Z",
      });
      const question = (await repository.listApplicationQuestionRecords())[0]!;
      await repository.upsertApplicationQuestionRecord({
        ...question,
        id: "question-second",
        prompt: "A second required answer",
      });
      await repository.upsertApplicationQuestionRecord({
        ...question,
        id: "question-profile",
        prompt: "An already answered profile question",
        status: "answered",
        selectedAnswerId: "answer-profile",
        submittedAnswer: "No",
      });
      await repository.upsertApplicationAnswerRecord(
        ApplicationAnswerRecordSchema.parse({
          id: "answer-profile",
          runId: result.runId,
          jobId: job.id,
          resultId: result.id,
          questionId: "question-profile",
          applicationRecordId: result.applicationRecordId,
          text: "No",
          value: { type: "single_choice", value: "No" },
          sourceKind: "profile",
          sourceId: "profile-eligibility",
          createdAt: "2026-08-10T10:00:00.000Z",
        }),
      );
      await methods.saveApplicationAnswer({
        ...saveCommand("save-first", 0),
        jobId: job.id,
      });
      expect(performUserAction).not.toHaveBeenCalled();
      const last = {
        ...saveCommand("save-last", 0),
        jobId: job.id,
        questionId: "question-second",
      };
      await Promise.all([
        methods.saveApplicationAnswer(last),
        methods.saveApplicationAnswer(last),
      ]);
      expect(performUserAction).toHaveBeenCalledTimes(1);
      const request = (await repository.listUserActionRequests())[0]!;
      expect(performUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "confirm_done",
          requestId: request.id,
          expectedRevision: request.revision,
          submitAuthorized: false,
          accountCreationAuthorized: false,
        }),
      );
    },
  );

  it("does not resume a ready form just because a historical answer was edited", async () => {
    const performUserAction = vi.fn().mockResolvedValue(undefined);
    const { job, methods } = createHarness({ performUserAction });
    await methods.saveApplicationAnswer({
      ...saveCommand("save-ready", 0),
      jobId: job.id,
    });
    expect(performUserAction).not.toHaveBeenCalled();
  });

  it.each([
    ["legal_consent", "result-answers"],
    ["login", "result-answers"],
    ["manual_answer", "another-result"],
  ])(
    "does not complete %s on %s when saving an answer",
    async (kind, resultId) => {
      const performUserAction = vi.fn().mockResolvedValue(undefined);
      const { job, repository, methods } = createHarness({ performUserAction });
      const result = (await repository.listApplyJobResults())[0]!;
      await repository.upsertApplyJobResult({ ...result, state: "blocked" });
      await persistApplicationUserAction({
        repository,
        applicationRecordId: result.applicationRecordId!,
        job,
        runId: result.runId,
        resultId,
        replayCheckpointId: "checkpoint-answers",
        blocker: ApplicationAttemptBlockerSchema.parse({
          code: "missing_candidate_answer",
          userActionKind: kind,
          summary: "A separate person-owned step remains.",
          questionIds: ["question-sponsorship"],
          url: job.applicationUrl ?? job.canonicalUrl,
        }),
        occurredAt: "2026-08-10T10:00:00.000Z",
      });
      await methods.saveApplicationAnswer({
        ...saveCommand("save-isolated", 0),
        jobId: job.id,
      });
      expect(performUserAction).not.toHaveBeenCalled();
    },
  );

  it("saves, replaces, and clears an exact application answer by revision", async () => {
    const { job, methods } = createHarness();
    const command = { ...saveCommand("save-1", 0), jobId: job.id };

    const saved = await methods.saveApplicationAnswer(command);
    expect(saved.questionRecords[0]).toEqual(
      expect.objectContaining({
        selectedAnswerId: "application_answer_save-1",
        submittedAnswer: "No",
        status: "answered",
      }),
    );
    expect(saved.answerRecords).toEqual([
      expect.objectContaining({
        id: "application_answer_save-1",
        applicationRecordId: "application-answers",
        text: "No",
        value: { type: "single_choice", value: "No" },
        revision: 1,
        supersedesAnswerId: null,
      }),
    ]);

    const replaced = await methods.saveApplicationAnswer({
      ...command,
      commandId: "save-2",
      expectedAnswerRevision: 1,
      value: { type: "single_choice", value: "Yes" },
    });
    expect(replaced.answerRecords.at(-1)).toEqual(
      expect.objectContaining({
        id: "application_answer_save-2",
        applicationRecordId: "application-answers",
        text: "Yes",
        revision: 2,
        supersedesAnswerId: "application_answer_save-1",
      }),
    );

    const cleared = await methods.clearApplicationAnswer({
      commandId: "clear-3",
      runId: command.runId,
      jobId: job.id,
      resultId: command.resultId,
      questionId: command.questionId,
      expectedAnswerRevision: 2,
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    expect(cleared.questionRecords[0]).toEqual(
      expect.objectContaining({
        selectedAnswerId: null,
        submittedAnswer: null,
        status: "detected",
      }),
    );
    expect(cleared.answerRecords.at(-1)).toEqual(
      expect.objectContaining({
        id: "application_answer_clear-3",
        applicationRecordId: "application-answers",
        status: "rejected",
        value: null,
        revision: 3,
        supersedesAnswerId: "application_answer_save-2",
      }),
    );
  });

  it("rejects stale editors and choices the employer did not offer", async () => {
    const { job, methods } = createHarness();
    await methods.saveApplicationAnswer({
      ...saveCommand("save-current", 0),
      jobId: job.id,
    });

    await expect(
      methods.saveApplicationAnswer({
        ...saveCommand("save-stale", 0),
        jobId: job.id,
      }),
    ).rejects.toThrow(/changed in another view/i);
    await expect(
      methods.saveApplicationAnswer({
        ...saveCommand("save-invalid", 1),
        jobId: job.id,
        value: { type: "single_choice", value: "Maybe" },
      }),
    ).rejects.toThrow(/not one of the choices/i);
  });

  it("allows only one concurrent save at an expected answer revision", async () => {
    const { job, methods, repository } = createHarness();

    const results = await Promise.allSettled([
      methods.saveApplicationAnswer({
        ...saveCommand("concurrent-save-a", 0),
        jobId: job.id,
        value: { type: "single_choice", value: "No" },
      }),
      methods.saveApplicationAnswer({
        ...saveCommand("concurrent-save-b", 0),
        jobId: job.id,
        value: { type: "single_choice", value: "Yes" },
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(Error);
      const message =
        rejected.reason instanceof Error
          ? rejected.reason.message
          : String(rejected.reason);
      expect(message).toMatch(/changed in another view/i);
    }

    const answers = await repository.listApplicationAnswerRecords({
      questionId: "question-sponsorship",
    });
    expect(answers).toHaveLength(1);
    expect(answers[0]?.revision).toBe(1);
    expect(["No", "Yes"]).toContain(answers[0]?.text);
    expect((await repository.listApplicationQuestionRecords())[0]).toEqual(
      expect.objectContaining({
        selectedAnswerId: answers[0]?.id,
        submittedAnswer: answers[0]?.text,
        status: "answered",
      }),
    );
  });

  it("allows only one concurrent save or clear at an expected revision", async () => {
    const { job, methods, repository } = createHarness();
    await methods.saveApplicationAnswer({
      ...saveCommand("concurrent-baseline", 0),
      jobId: job.id,
    });

    const results = await Promise.allSettled([
      methods.saveApplicationAnswer({
        ...saveCommand("concurrent-replace", 1),
        jobId: job.id,
        value: { type: "single_choice", value: "Yes" },
      }),
      methods.clearApplicationAnswer({
        commandId: "concurrent-clear",
        runId: "run-answers",
        jobId: job.id,
        resultId: "result-answers",
        questionId: "question-sponsorship",
        expectedAnswerRevision: 1,
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(Error);
      const message =
        rejected.reason instanceof Error
          ? rejected.reason.message
          : String(rejected.reason);
      expect(message).toMatch(/changed in another view/i);
    }

    const answers = await repository.listApplicationAnswerRecords({
      questionId: "question-sponsorship",
    });
    expect(answers).toHaveLength(2);
    expect(answers.filter((answer) => answer.revision === 2)).toHaveLength(1);
    const latest = answers.find((answer) => answer.revision === 2);
    const question = (await repository.listApplicationQuestionRecords())[0];
    expect(question).toBeDefined();
    if (latest?.status === "rejected") {
      expect(question).toEqual(
        expect.objectContaining({
          selectedAnswerId: null,
          submittedAnswer: null,
          status: "detected",
        }),
      );
    } else {
      expect(question).toEqual(
        expect.objectContaining({
          selectedAnswerId: latest?.id,
          submittedAnswer: latest?.text,
          status: "answered",
        }),
      );
    }
  });

  it("can save a reviewed text answer to Profile without overwriting a conflict", async () => {
    const { job, methods, repository } = createHarness();
    await methods.saveApplicationAnswer({
      ...saveCommand("save-reusable", 0),
      jobId: job.id,
      saveScope: "reusable_profile",
    });

    const profile = await repository.getProfile();
    expect(profile.answerBank.customAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: expect.not.stringContaining(
            "Application location:",
          ) as unknown,
          applicationScope: expect.objectContaining({
            location: "Remote",
          }) as unknown,
          answer: "No",
        }),
      ]),
    );
  });

  it("keeps a profile edit that lands between the question context and the reusable append", async () => {
    const { job, methods, repository } = createHarness();
    const commitProfileUpdate = repository.commitProfileUpdate.bind(repository);
    let interleavedEditLanded = false;
    vi.spyOn(repository, "commitProfileUpdate").mockImplementation(
      (updater) => {
        if (!interleavedEditLanded) {
          interleavedEditLanded = true;
          return repository.getProfile().then(async (current) => {
            await repository.saveProfile({
              ...current,
              headline: "Interleaved headline",
            });
            return commitProfileUpdate(updater);
          });
        }
        return commitProfileUpdate(updater);
      },
    );

    const details = await methods.saveApplicationAnswer({
      ...saveCommand("save-interleaved", 0),
      jobId: job.id,
      saveScope: "reusable_profile",
    });
    expect(details.answerRecords).toHaveLength(1);

    const profile = await repository.getProfile();
    expect(profile.headline).toBe("Interleaved headline");
    expect(profile.answerBank.customAnswers).toEqual([
      expect.objectContaining({
        question: expect.not.stringContaining(
          "Application location:",
        ) as unknown,
        applicationScope: expect.objectContaining({
          location: "Remote",
        }) as unknown,
        answer: "No",
      }),
    ]);
  });

  it("appends once when two identical reusable answers race", async () => {
    const { job, methods, repository } = createHarness();

    const results = await Promise.allSettled([
      methods.saveApplicationAnswer({
        ...saveCommand("race-same-a", 0),
        jobId: job.id,
        saveScope: "reusable_profile",
      }),
      methods.saveApplicationAnswer({
        ...saveCommand("race-same-b", 0),
        jobId: job.id,
        value: { type: "single_choice" as const, value: "No" },
        saveScope: "reusable_profile",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);

    const profile = await repository.getProfile();
    expect(profile.fullName).toBe("Alex Vanguard");
    expect(profile.answerBank.customAnswers).toHaveLength(1);
    expect(profile.answerBank.customAnswers[0]).toEqual(
      expect.objectContaining({
        question: expect.not.stringContaining(
          "Application location:",
        ) as unknown,
        applicationScope: expect.objectContaining({
          location: "Remote",
        }) as unknown,
        answer: "No",
      }),
    );

    const answers = await repository.listApplicationAnswerRecords({
      questionId: "question-sponsorship",
    });
    expect(answers.map((answer) => answer.revision)).toEqual([1]);
  });

  it("rejects one conflicting reusable answer without losing profile data", async () => {
    const { job, methods, repository } = createHarness();

    const results = await Promise.allSettled([
      methods.saveApplicationAnswer({
        ...saveCommand("race-conflict-a", 0),
        jobId: job.id,
        saveScope: "reusable_profile",
      }),
      methods.saveApplicationAnswer({
        ...saveCommand("race-conflict-b", 0),
        jobId: job.id,
        value: { type: "single_choice" as const, value: "Yes" },
        saveScope: "reusable_profile",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      const message =
        rejected.reason instanceof Error
          ? rejected.reason.message
          : String(rejected.reason);
      expect(message).toMatch(
        /different reusable answer|changed in another view/i,
      );
    }

    const profile = await repository.getProfile();
    expect(profile.fullName).toBe("Alex Vanguard");
    expect(profile.answerBank.customAnswers).toHaveLength(1);
    expect(["No", "Yes"]).toContain(
      profile.answerBank.customAnswers[0]?.answer,
    );

    const answers = await repository.listApplicationAnswerRecords({
      questionId: "question-sponsorship",
    });
    expect(answers).toHaveLength(1);
  });

  it("replaces a different saved answer when the person saves a new one", async () => {
    const { job, methods, repository } = createHarness();

    await methods.saveApplicationAnswer({
      ...saveCommand("save-first", 0),
      jobId: job.id,
      saveScope: "reusable_profile",
    });
    const details = await methods.saveApplicationAnswer({
      ...saveCommand("save-second", 1),
      jobId: job.id,
      value: { type: "single_choice" as const, value: "Yes" },
      saveScope: "reusable_profile",
    });

    expect(details.answerRecords.at(-1)?.revision).toBe(2);
    const profile = await repository.getProfile();
    expect(profile.answerBank.customAnswers).toHaveLength(1);
    expect(profile.answerBank.customAnswers[0]?.answer).toBe("Yes");
  });

  it("keeps command retries idempotent", async () => {
    const { job, methods } = createHarness();
    const command = { ...saveCommand("same-command", 0), jobId: job.id };

    const first = await methods.saveApplicationAnswer(command);
    const retry = await methods.saveApplicationAnswer(command);

    expect(first.answerRecords).toHaveLength(1);
    expect(retry.answerRecords).toHaveLength(1);
    expect(retry.answerRecords[0]?.revision).toBe(1);
  });

  it("rejects a saved file answer scoped to another job before writing", async () => {
    const asset = CandidateAssetSchema.parse({
      id: "letter-other",
      kind: "cover_letter",
      originalName: "letter.txt",
      mime: "text/plain",
      byteSize: 100,
      sha256: "a".repeat(64),
      createdAt: "2026-08-10T10:00:00.000Z",
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
      forJob: { jobId: "job-other", title: "Engineer", company: "Cedar" },
    });
    const { job, methods, repository } = createHarness({
      answerControlType: "file",
      answerOptions: [],
      questionKind: "cover_letter",
      candidateAssetResolver: {
        resolveForApplication: () =>
          Promise.resolve({ asset, loadVerifiedBytes: vi.fn() }),
      },
    });
    await expect(
      methods.saveApplicationAnswer({
        ...saveCommand("wrong-job-file", 0),
        jobId: job.id,
        value: { type: "asset_ref", assetId: asset.id },
      }),
    ).rejects.toThrow("That file was written for another job.");
    expect(
      await repository.listApplicationAnswerRecords({
        questionId: "question-sponsorship",
      }),
    ).toEqual([]);
  });

  it("stores only metadata for an exact consented file answer", async () => {
    const asset = CandidateAssetSchema.parse({
      id: "asset-portfolio",
      kind: "portfolio",
      originalName: "portfolio.pdf",
      mime: "application/pdf",
      byteSize: 100,
      sha256: "a".repeat(64),
      createdAt: "2026-08-10T10:00:00.000Z",
      sensitivity: "sensitive",
      consentScope: "job_application_attachment",
      retention: "until_deleted",
    });
    const loadVerifiedBytes = vi.fn(() =>
      Promise.resolve(new Uint8Array([1, 2, 3])),
    );
    const resolveForApplication = vi.fn(() =>
      Promise.resolve({ asset, loadVerifiedBytes }),
    );
    const { job, methods } = createHarness({
      answerControlType: "file",
      answerOptions: [],
      candidateAssetResolver: { resolveForApplication },
      questionKind: "portfolio",
    });

    const details = await methods.saveApplicationAnswer({
      ...saveCommand("save-asset", 0),
      jobId: job.id,
      value: { type: "asset_ref", assetId: asset.id },
    });

    expect(resolveForApplication).toHaveBeenCalledWith(asset.id);
    expect(details.answerRecords[0]).toEqual(
      expect.objectContaining({
        text: "portfolio.pdf",
        value: { type: "asset_ref", assetId: asset.id },
      }),
    );
    expect(JSON.stringify(details)).not.toContain("C:/private");
  });
});
