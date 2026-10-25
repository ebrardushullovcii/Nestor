import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFileJobFinderRepository } from "@nestor/db";

import {
  createApplyQueueDemoState,
  createResumeWorkspaceDemoState,
} from "./job-finder-demo-state";

/**
 * The apply-queue demo loader resets the workspace with this exact state, so
 * "the loader writes rows" is a claim about SQLite, not about the object it
 * returns. These tests therefore reset a real file repository and count the
 * rows in each apply table after a close and reopen.
 */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createTemporaryWorkspaceFilePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nestor-demo-state-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "job-finder-state.sqlite");
}

function countRows(filePath: string, tableName: string): number {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS total FROM ${tableName}`)
      .get() as { total: number | bigint } | undefined;
    return Number(row?.total ?? 0);
  } finally {
    database.close();
  }
}

describe("apply-queue demo state persistence", () => {
  test("writes durable rows to every apply table the hand-off needs", async () => {
    const filePath = await createTemporaryWorkspaceFilePath();
    const repository = await createFileJobFinderRepository({
      filePath,
      seed: createResumeWorkspaceDemoState(),
    });

    try {
      await repository.reset(createApplyQueueDemoState());
    } finally {
      await repository.close();
    }

    // Counted straight out of SQLite after the handle closed: the five tables
    // the r15 walkthrough measured as 0 rows.
    expect(countRows(filePath, "apply_runs")).toBe(1);
    expect(countRows(filePath, "apply_job_results")).toBe(2);
    expect(countRows(filePath, "application_records")).toBe(2);
    expect(countRows(filePath, "application_attempts")).toBe(2);
    expect(countRows(filePath, "user_action_requests")).toBe(1);

    // Nothing that could imply an authorized or executed submission.
    expect(countRows(filePath, "apply_submit_approvals")).toBe(0);
    expect(countRows(filePath, "submission_execution_grants")).toBe(0);
    expect(countRows(filePath, "submission_armed_markers")).toBe(0);
    expect(countRows(filePath, "submission_outcome_records")).toBe(0);
    expect(countRows(filePath, "application_authority_envelopes")).toBe(0);
  });

  test("reopened rows keep prepare-only truth with no submitted outcome", async () => {
    const filePath = await createTemporaryWorkspaceFilePath();
    const seedingRepository = await createFileJobFinderRepository({
      filePath,
      seed: createResumeWorkspaceDemoState(),
    });

    try {
      await seedingRepository.reset(createApplyQueueDemoState());
    } finally {
      await seedingRepository.close();
    }

    const reopenedRepository = await createFileJobFinderRepository({
      filePath,
      seed: createResumeWorkspaceDemoState(),
    });

    try {
      const [runs, results, records, attempts, requests] = await Promise.all([
        reopenedRepository.listApplyRuns(),
        reopenedRepository.listApplyJobResults(),
        reopenedRepository.listApplicationRecords(),
        reopenedRepository.listApplicationAttempts(),
        reopenedRepository.listUserActionRequests(),
      ]);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.submittedJobs).toBe(0);
      expect(results).toHaveLength(2);
      expect(records).toHaveLength(2);
      expect(attempts).toHaveLength(2);
      expect(requests).toHaveLength(1);

      const recordIds = new Set(records.map((record) => record.id));
      for (const result of results) {
        expect(result.state).not.toBe("submitted");
        expect(result.runId).toBe(runs[0]?.id);
        expect(recordIds.has(result.applicationRecordId ?? "")).toBe(true);
        expect(result.privacyReceipt?.finalSubmitOccurred).toBe(false);
        expect(result.privacyReceipt?.finalSubmitAuthorized).toBe(false);
      }

      for (const attempt of attempts) {
        expect(attempt.outcome).toBeNull();
        expect(attempt.state).toBe("paused");
      }

      expect(records.some((record) => record.status === "submitted")).toBe(
        false,
      );
      expect(requests[0]?.submitAuthorized).toBe(false);
      expect(requests[0]?.accountCreationAuthorized).toBe(false);
    } finally {
      await reopenedRepository.close();
    }
  });
});
