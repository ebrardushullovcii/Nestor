import { describe, expect, test } from "vitest";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const RUN_ID = "apply_run_1";
const JOB_ID = "job_1";
const INITIAL_RESULT_ID = "apply_result_initial";
const REPLACEMENT_RESULT_ID = "apply_result_replacement";
const PREPARATION_STARTED_AT = "2026-08-24T09:01:30.000Z";
const PREPARATION_STARTED_LOCAL_DATE = "2026-08-24";

function createInitialResultInput() {
  return {
    id: INITIAL_RESULT_ID,
    runId: RUN_ID,
    jobId: JOB_ID,
    queuePosition: 0,
    state: "planned" as const,
    summary: "Application planned.",
    detail: "Waiting to prepare.",
    startedAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:00:30.000Z",
  };
}

function createReplacementResultInput() {
  return {
    // A fresh payload minted a new result id while keeping the exact
    // run/job lineage of the persisted row. Like production callers, it
    // carries the committed preparation-start facts forward.
    id: REPLACEMENT_RESULT_ID,
    runId: RUN_ID,
    jobId: JOB_ID,
    queuePosition: 0,
    state: "awaiting_review" as const,
    summary: "Questions captured and answers proposed.",
    detail: "The run paused for user review before submit.",
    startedAt: "2026-08-24T09:05:00.000Z",
    updatedAt: "2026-08-24T09:10:00.000Z",
    applicationPreparationStartedAt: PREPARATION_STARTED_AT,
    applicationPreparationStartedLocalDate: PREPARATION_STARTED_LOCAL_DATE,
  };
}

function createClobberingReplacementResultInput() {
  return {
    ...createReplacementResultInput(),
    applicationPreparationStartedAt: null,
    applicationPreparationStartedLocalDate: null,
  };
}

async function seedAnchoredEvidence(repository: JobFinderRepository) {
  await repository.markApplicationPreparationStarted({
    resultId: INITIAL_RESULT_ID,
    runId: RUN_ID,
    jobId: JOB_ID,
    startedAt: PREPARATION_STARTED_AT,
    startedLocalDate: PREPARATION_STARTED_LOCAL_DATE,
  });
  await repository.upsertApplicationQuestionRecord({
    id: "question_1",
    runId: RUN_ID,
    jobId: JOB_ID,
    resultId: INITIAL_RESULT_ID,
    prompt: "Upload your resume",
    detectedAt: "2026-08-24T09:02:00.000Z",
  });
}

async function runLineageUpsertScenario(repository: JobFinderRepository) {
  await repository.upsertApplyJobResult(createInitialResultInput());
  await seedAnchoredEvidence(repository);

  // A different unrelated lineage must remain untouched by the replacement.
  await repository.upsertApplyJobResult({
    id: "apply_result_other",
    runId: "apply_run_2",
    jobId: "job_2",
    queuePosition: 1,
    state: "planned",
    summary: "Other application planned.",
    detail: "Queued behind the active application.",
    startedAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
  });

  await repository.upsertApplyJobResult(createReplacementResultInput());

  const [results, lineageResults, evidence] = await Promise.all([
    repository.listApplyJobResults(),
    repository.listApplyJobResults({ runId: RUN_ID, jobId: JOB_ID }),
    repository.listApplicationQuestionRecords({
      runId: RUN_ID,
      jobId: JOB_ID,
      resultId: INITIAL_RESULT_ID,
    }),
  ]);

  return { results, lineageResults, evidence };
}

function expectConformanceOutcome(outcome: {
  results: readonly unknown[];
  lineageResults: readonly unknown[];
  evidence: readonly unknown[];
}) {
  // The changed incoming id must not mint a second row for the lineage.
  expect(outcome.results).toHaveLength(2);
  expect(outcome.lineageResults).toHaveLength(1);

  const [survivor, untouched] = outcome.results as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];

  // The persisted identity wins over the incoming id...
  expect(survivor?.id).toBe(INITIAL_RESULT_ID);
  // ...while the remaining content comes from the replacement payload.
  expect(survivor?.state).toBe("awaiting_review");
  expect(survivor?.summary).toBe("Questions captured and answers proposed.");
  expect(survivor?.updatedAt).toBe("2026-08-24T09:10:00.000Z");
  // Immutable preparation-start facts survive the lineage replacement.
  expect(survivor?.applicationPreparationStartedAt).toBe(
    PREPARATION_STARTED_AT,
  );
  expect(survivor?.applicationPreparationStartedLocalDate).toBe(
    PREPARATION_STARTED_LOCAL_DATE,
  );

  expect(untouched?.id).toBe("apply_result_other");

  // Evidence anchored to the persisted result id stays resolvable instead
  // of being orphaned under the replaced identity.
  expect(outcome.evidence).toHaveLength(1);
}

describe("apply job result lineage conformance", () => {
  test("keeps one row per lineage with the persisted identity in both repositories", async () => {
    const temp = await createTempRepository(
      "nestor-apply-result-lineage-conformance-",
    );
    let fileRepository: Awaited<
      ReturnType<typeof temp.createRepository>
    > | null = null;

    try {
      fileRepository = await temp.createRepository();
      const fileOutcome = await runLineageUpsertScenario(fileRepository);
      expectConformanceOutcome(fileOutcome);

      await fileRepository.close();
      fileRepository = null;

      const memoryRepository = createInMemoryJobFinderRepository(createSeed());
      const memoryOutcome = await runLineageUpsertScenario(memoryRepository);
      expectConformanceOutcome(memoryOutcome);

      // Both repositories converge on the same durable outcome.
      expect(memoryOutcome.results).toEqual(fileOutcome.results);
      expect(memoryOutcome.evidence).toEqual(fileOutcome.evidence);

      // The file repository keeps the invariant across a reopen.
      const reopenedRepository = await temp.createRepository();
      try {
        const reopenedResults = await reopenedRepository.listApplyJobResults();
        expect(reopenedResults).toEqual(fileOutcome.results);
      } finally {
        await reopenedRepository.close();
      }
    } finally {
      if (fileRepository) await fileRepository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("rejects preparation-start clobbering in both repositories without leaving partial rows", async () => {
    const temp = await createTempRepository(
      "nestor-apply-result-lineage-clobber-",
    );
    let fileRepository: Awaited<
      ReturnType<typeof temp.createRepository>
    > | null = null;

    try {
      fileRepository = await temp.createRepository();
      await runLineageUpsertScenario(fileRepository);

      // The file repository performs its transaction synchronously, so the
      // immutability guard surfaces as a synchronous throw.
      expect(() =>
        fileRepository!.upsertApplyJobResult(
          createClobberingReplacementResultInput(),
        ),
      ).toThrow("Application preparation start is immutable once committed.");

      const fileResults = await fileRepository.listApplyJobResults({
        runId: RUN_ID,
        jobId: JOB_ID,
      });
      expect(fileResults).toHaveLength(1);
      expect(fileResults[0]?.id).toBe(INITIAL_RESULT_ID);
      expect(fileResults[0]?.applicationPreparationStartedAt).toBe(
        PREPARATION_STARTED_AT,
      );

      const memoryRepository = createInMemoryJobFinderRepository(createSeed());
      await runLineageUpsertScenario(memoryRepository);

      // Both repositories guard before their async boundary, so the
      // immutability violation surfaces as a synchronous throw.
      expect(() =>
        memoryRepository.upsertApplyJobResult(
          createClobberingReplacementResultInput(),
        ),
      ).toThrow("Application preparation start is immutable once committed.");

      const memoryResults = await memoryRepository.listApplyJobResults({
        runId: RUN_ID,
        jobId: JOB_ID,
      });
      expect(memoryResults).toEqual(fileResults);
    } finally {
      if (fileRepository) await fileRepository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});
