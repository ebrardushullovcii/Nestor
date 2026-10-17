import { ApplyJobResultSchema } from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test } from "vitest";

import {
  describeApplicationPreparationProgress,
  persistApplicationPreparationProgress,
} from "./application-preparation-progress";
import { createSeed } from "../workspace-service.test-support";

const STARTED_AT = "2026-09-16T10:00:00.000Z";

describe("application preparation progress", () => {
  test("stores a safe filling step without persisting form values", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "result_progress",
        runId: "run_progress",
        jobId: "job_progress",
        state: "planned",
        summary: "Planned",
        detail: "Waiting to start",
        startedAt: STARTED_AT,
        updatedAt: STARTED_AT,
      }),
    );

    await persistApplicationPreparationProgress({
      repository,
      resultId: "result_progress",
      runId: "run_progress",
      jobId: "job_progress",
      progress: {
        step: 7,
        note: 'type → Filled in "Phone" with "+383 44 123 456"',
        progressSteps: 4,
        elapsedMs: 12_000,
      },
      now: () => new Date("2026-09-16T10:00:12.000Z"),
    });

    const [result] = await repository.listApplyJobResults({
      runId: "run_progress",
      jobId: "job_progress",
    });
    expect(result).toMatchObject({
      state: "filling",
      summary: "Filling in application",
      detail: "Filling a text field",
      updatedAt: "2026-09-16T10:00:12.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("+383");
    expect(JSON.stringify(result)).not.toContain("Phone");
  });

  test("does not replace a terminal result with late progress", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const terminal = ApplyJobResultSchema.parse({
      id: "result_done",
      runId: "run_done",
      jobId: "job_done",
      state: "awaiting_review",
      summary: "Ready for review",
      detail: "The form is ready",
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    });
    await repository.upsertApplyJobResult(terminal);

    await persistApplicationPreparationProgress({
      repository,
      resultId: terminal.id,
      runId: terminal.runId,
      jobId: terminal.jobId,
      progress: {
        step: 8,
        note: "asking the assistant what to do next",
        progressSteps: 5,
        elapsedMs: 13_000,
      },
    });

    await expect(
      repository.listApplyJobResults({
        runId: terminal.runId,
        jobId: terminal.jobId,
      }),
    ).resolves.toEqual([terminal]);
  });

  test("uses only fixed safe labels", () => {
    expect(
      describeApplicationPreparationProgress(
        'fill_fields → Filled in "Name". "Jamie Rivers, jamie@example.test"',
      ),
    ).toBe("Filling in form fields");
  });
});
