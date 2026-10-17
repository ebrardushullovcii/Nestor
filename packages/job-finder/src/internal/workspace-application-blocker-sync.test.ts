import { ApplicationRecordSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import {
  listStaleMissingResumeBlockerClearances,
  reconcileStaleMissingResumeBlockers,
} from "./workspace-application-blocker-sync";
import { withApplicationRecordTransition } from "./application-crm";
import { isApprovedTailoredResumeReadyForApply } from "./matching-review-queue";

describe("workspace-application-blocker-sync", () => {
  test("clears missing-resume blockers when tailored resume readiness matches Shortlisted", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exportedSnapshot.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(exportArtifact).toBeTruthy();
    await workspaceService.approveResume("job_ready", exportArtifact!.id);

    const [draft, exports, assets, records] = await Promise.all([
      repository.getResumeDraftByJobId("job_ready"),
      repository.listResumeExportArtifacts({ jobId: "job_ready" }),
      repository.listTailoredAssets(),
      repository.listApplicationRecords(),
    ]);
    const asset = assets.find((entry) => entry.jobId === "job_ready") ?? null;
    expect(draft).toBeTruthy();
    expect(asset).toBeTruthy();
    expect(
      isApprovedTailoredResumeReadyForApply({
        draft,
        exports,
        asset,
      }).ready,
    ).toBe(true);

    const blockedRecord = ApplicationRecordSchema.parse({
      ...(records[0] ??
        createSeed().applicationRecords[0] ?? {
          id: "application_record_job_ready",
          jobId: "job_ready",
          title: "Senior Product Designer",
          company: "Signal Systems",
          status: "ready_for_review",
          lastActionLabel: "Apply copilot blocked before launch.",
          nextActionLabel:
            "Export and approve a tailored resume before retrying apply copilot.",
          lastUpdatedAt: "2026-08-27T00:00:00.000Z",
          lastAttemptState: "failed",
          questionSummary: {
            total: 0,
            answered: 0,
            unansweredRequired: 0,
          },
          consentSummary: {
            status: "none",
            pendingCount: 0,
          },
          replaySummary: {
            checkpointCount: 0,
            evidenceCount: 0,
            lastUrl: null,
          },
          events: [],
        }),
      jobId: "job_ready",
      latestBlocker: {
        code: "missing_resume",
        summary:
          "An approved tailored resume is required before apply copilot can start.",
      },
      nextActionLabel:
        "Export and approve a tailored resume before retrying apply copilot.",
    });
    await repository.upsertApplicationRecord(blockedRecord);

    const clearances = listStaleMissingResumeBlockerClearances({
      applicationRecords: [blockedRecord],
      resumeDrafts: draft ? [draft] : [],
      resumeExportArtifacts: exports,
      tailoredAssets: asset ? [asset] : [],
      detectedAt: "2026-08-27T00:01:00.000Z",
    });

    expect(clearances).toHaveLength(1);
    expect(clearances[0]?.latestBlocker).toBeNull();

    const reviewBlockedRecord = ApplicationRecordSchema.parse({
      ...blockedRecord,
      id: "application_record_resume_review",
      latestBlocker: {
        code: "requires_manual_review",
        summary: "Confirm the intentionally hidden work-history role.",
      },
      nextActionLabel: "Open the resume and confirm the hidden role.",
    });
    expect(
      listStaleMissingResumeBlockerClearances({
        applicationRecords: [reviewBlockedRecord],
        resumeDrafts: draft ? [draft] : [],
        resumeExportArtifacts: exports,
        tailoredAssets: asset ? [asset] : [],
        detectedAt: "2026-08-27T00:01:00.000Z",
      })[0],
    ).toMatchObject({
      id: reviewBlockedRecord.id,
      latestBlocker: null,
      nextActionLabel: "Retry preparation when you are ready.",
    });

    const reconciled = await reconcileStaleMissingResumeBlockers(repository, {
      applicationRecords: [blockedRecord],
      resumeDrafts: draft ? [draft] : [],
      resumeExportArtifacts: exports,
      tailoredAssets: asset ? [asset] : [],
      detectedAt: "2026-08-27T00:01:00.000Z",
    });

    expect(reconciled[0]?.latestBlocker).toBeNull();
    expect(
      (await repository.listApplicationRecords()).find(
        (record) => record.id === blockedRecord.id,
      )?.latestBlocker,
    ).toBeNull();

    await repository.upsertApplicationRecord(blockedRecord);
    let releaseConcurrentTransition!: () => void;
    const concurrentTransitionGate = new Promise<void>((resolve) => {
      releaseConcurrentTransition = resolve;
    });
    let markConcurrentUpdateSaved!: () => void;
    const concurrentUpdateSaved = new Promise<void>((resolve) => {
      markConcurrentUpdateSaved = resolve;
    });
    const concurrentlyUpdatedRecord = ApplicationRecordSchema.parse({
      ...blockedRecord,
      latestBlocker: {
        code: "site_login_required",
        summary: "Sign-in is required before preparation can continue.",
      },
      lastActionLabel: "Employer sign-in requested.",
      nextActionLabel: "Sign in, then retry preparation.",
      lastUpdatedAt: "2026-08-27T00:02:00.000Z",
    });
    const concurrentTransition = withApplicationRecordTransition(
      repository,
      blockedRecord.id,
      async () => {
        await repository.upsertApplicationRecord(concurrentlyUpdatedRecord);
        markConcurrentUpdateSaved();
        await concurrentTransitionGate;
      },
    );
    await concurrentUpdateSaved;

    const reconciliation = reconcileStaleMissingResumeBlockers(repository, {
      applicationRecords: [blockedRecord],
      resumeDrafts: draft ? [draft] : [],
      resumeExportArtifacts: exports,
      tailoredAssets: asset ? [asset] : [],
      detectedAt: "2026-08-27T00:03:00.000Z",
    });
    releaseConcurrentTransition();
    await concurrentTransition;

    const [reconciledAfterConcurrentUpdate] = await reconciliation;
    expect(reconciledAfterConcurrentUpdate).toEqual(concurrentlyUpdatedRecord);
    expect(
      (await repository.listApplicationRecords()).find(
        (record) => record.id === blockedRecord.id,
      ),
    ).toEqual(concurrentlyUpdatedRecord);
  });
});
