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

  test("names the form's step and says a slow or retried step carries on", () => {
    expect(
      describeApplicationPreparationProgress(
        'form step 2 of 5: fill_fields → Filled in "Phone". +1 555 0100',
      ),
    ).toBe("Step 2 of 5: filling in form fields");
    expect(
      describeApplicationPreparationProgress(
        "form step 3 of 6: asking the assistant what to do next",
      ),
    ).toBe("Step 3 of 6: thinking about the next form step");
    expect(
      describeApplicationPreparationProgress(
        "the assistant did not answer before this turn's time limit",
      ),
    ).toBe("The assistant is slow to answer; asking again");
    expect(
      describeApplicationPreparationProgress(
        "retrying the same assistant turn after a temporary service failure",
      ),
    ).toBe("The AI service had a brief problem; asking again");
    expect(
      describeApplicationPreparationProgress("fill_fields → took too long"),
    ).toBe("The page is slow to respond; looking again");
    expect(
      describeApplicationPreparationProgress(
        'click → browser failure: The page did not answer "Phone".',
      ),
    ).toBe("A form step needs another approach");
    expect(
      describeApplicationPreparationProgress("reading the application form"),
    ).toBe("Opening the application form");
  });

  test("uses only fixed safe labels", () => {
    expect(
      describeApplicationPreparationProgress(
        'fill_fields → Filled in "Name". "Jamie Rivers, jamie@example.test"',
      ),
    ).toBe("Filling in form fields");
  });
});
