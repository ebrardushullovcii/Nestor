import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { ApplyJobResultSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { hasLiveUnresolvedApplicationPage } from "./workspace-service";
import {
  createBrowserRuntime,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("application browser-session retention", () => {
  test("keeps an older prepared form when a newer result submitted or failed", async () => {
    const { repository } = createWorkspaceServiceHarness();
    const timestamp = "2026-09-22T15:00:00.000Z";
    const result = (input: {
      id: string;
      state: "awaiting_review" | "submitted" | "failed";
      jobId: string;
    }) =>
      ApplyJobResultSchema.parse({
        id: input.id,
        runId: `run_${input.id}`,
        jobId: input.jobId,
        state: input.state,
        summary: input.state,
        detail: input.state,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: input.state === "awaiting_review" ? null : timestamp,
      });

    await repository.upsertApplyJobResult(
      result({
        id: "result_older_prepared",
        state: "awaiting_review",
        jobId: "job_ready",
      }),
    );
    await repository.upsertApplyJobResult(
      result({
        id: "result_newer_submitted",
        state: "submitted",
        jobId: "job_generating",
      }),
    );
    await repository.upsertApplyJobResult(
      result({
        id: "result_newer_failed",
        state: "failed",
        jobId: "job_generating",
      }),
    );

    const hasApplicationPageBinding = vi.fn(
      (_source: "target_site", bindingKey: string) =>
        Promise.resolve(bindingKey === "result_older_prepared"),
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...createBrowserRuntime(),
      hasApplicationPageBinding,
    };

    await expect(
      hasLiveUnresolvedApplicationPage({
        browserRuntime,
        repository,
        source: "target_site",
      }),
    ).resolves.toBe(true);
    expect(hasApplicationPageBinding).toHaveBeenCalledTimes(1);
    expect(hasApplicationPageBinding).toHaveBeenCalledWith(
      "target_site",
      "result_older_prepared",
    );
  });

  test("allows cleanup when only terminal application results remain", async () => {
    const { repository } = createWorkspaceServiceHarness();
    const timestamp = "2026-09-22T15:00:00.000Z";
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "result_submitted",
        runId: "run_submitted",
        jobId: "job_ready",
        state: "submitted",
        summary: "Submitted",
        detail: "Submitted",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      }),
    );
    const hasApplicationPageBinding = vi.fn(() => Promise.resolve(true));
    const browserRuntime: BrowserSessionRuntime = {
      ...createBrowserRuntime(),
      hasApplicationPageBinding,
    };

    await expect(
      hasLiveUnresolvedApplicationPage({
        browserRuntime,
        repository,
        source: "target_site",
      }),
    ).resolves.toBe(false);
    expect(hasApplicationPageBinding).not.toHaveBeenCalled();
  });

  test("keeps an outcome-uncertain page even when its result is failed", async () => {
    const { repository } = createWorkspaceServiceHarness();
    const timestamp = "2026-09-22T15:00:00.000Z";
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "result_uncertain",
        runId: "run_uncertain",
        jobId: "job_ready",
        applicationRecordId: "application_uncertain",
        state: "failed",
        summary: "Submission outcome is uncertain.",
        detail: "Check the employer page.",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        privacyReceipt: {
          generatedAt: timestamp,
          lineage: {
            runId: "run_uncertain",
            jobId: "job_ready",
            resultId: "result_uncertain",
            applicationRecordId: "application_uncertain",
          },
          destination: {
            origin: "https://example.com",
            safePath: "/apply",
          },
          resume: {
            source: "original_upload",
            sourceDocumentId: "resume_1",
            fileName: "resume.pdf",
            sha256: "a".repeat(64),
          },
          finalSubmitOccurred: false,
          submissionOutcome: {
            id: "outcome_uncertain",
            preflightId: "preflight_uncertain",
            idempotencyKey: "submit_uncertain",
            authorityEnvelopeId: "authority_uncertain",
            authorityRevision: 1,
            runId: "run_uncertain",
            jobId: "job_ready",
            resultId: "result_uncertain",
            applicationRecordId: "application_uncertain",
            outcome: "outcome_uncertain",
            attemptedAt: timestamp,
            verifiedAt: null,
            evidence: [],
            retry: { eligible: false, blockReason: "outcome_uncertain" },
          },
        },
      }),
    );
    const hasApplicationPageBinding = vi.fn(() => Promise.resolve(true));
    const browserRuntime: BrowserSessionRuntime = {
      ...createBrowserRuntime(),
      hasApplicationPageBinding,
    };

    await expect(
      hasLiveUnresolvedApplicationPage({
        browserRuntime,
        repository,
        source: "target_site",
      }),
    ).resolves.toBe(true);
    expect(hasApplicationPageBinding).toHaveBeenCalledWith(
      "target_site",
      "result_uncertain",
    );
  });
});
