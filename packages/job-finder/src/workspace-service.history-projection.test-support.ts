import {
  JobFinderRepositoryStateSchema,
  SavedJobSchema,
} from "@nordri/contracts";
import { createSeed } from "./workspace-service.test-fixtures";

/** Synthetic only. Parse the complete fixture so built QA can reuse its JSON. */
export function createHistoryScaleSeed(jobCount = 3000, historyCount = 1000) {
  const seed = createSeed();
  const at = "2026-10-13T10:00:00.000Z";
  const documentBody =
    "NORDRI_SCALE_DOCUMENT_BODY Synthetic resume paragraph. ".repeat(180);
  const activityBody =
    "NORDRI_SCALE_APPLICATION_BODY Synthetic retained activity. ".repeat(180);
  const visualBody =
    "NORDRI_SCALE_VISUAL_HISTORY Synthetic captured observation. ".repeat(100);
  seed.savedJobs = Array.from({ length: jobCount }, (_, i) =>
    SavedJobSchema.parse({
      ...seed.savedJobs[0],
      id: `scale_job_${i}`,
      sourceJobId: `scale_source_${i}`,
      title: `Synthetic scale engineer ${i}`,
      company: `Synthetic scale company ${i}`,
      employerDomain: null,
      employerWebsiteUrl: null,
      canonicalUrl: `https://example.test/jobs/${i}`,
      applicationUrl: `https://example.test/jobs/${i}/apply`,
      status: i < historyCount ? "ready_for_review" : "discovered",
      provenance: [],
    }),
  );
  const history = Array.from(
    { length: Math.min(historyCount, jobCount) },
    (_, i) => {
      const jobId = `scale_job_${i}`;
      const draftId = `scale_draft_${i}`;
      const runId = `scale_run_${i}`;
      const recordId = `scale_application_${i}`;
      // The first selected document is short enough for an ordinary export QA.
      const body =
        i === 0
          ? "NORDRI_SCALE_DOCUMENT_BODY Synthetic candidate who builds reliable software."
          : documentBody;
      const observation = {
        id: `scale_observation_${i}`,
        snapshotId: `scale_snapshot_${i}`,
        observedAt: at,
        purpose: "apply_checkpoint",
        providerKind: "deterministic",
        providerLabel: "Synthetic fixture",
        summary: visualBody,
      };
      return {
        asset: {
          id: `scale_asset_${i}`,
          jobId,
          kind: "resume",
          status: "ready",
          label: `Scale resume ${i}`,
          version: "v1",
          templateName: "Chronology Classic",
          compatibilityScore: 90,
          progressPercent: 100,
          updatedAt: at,
          contentText: body,
          previewSections: [{ heading: "Summary", lines: [body] }],
          generationMethod: "deterministic",
        },
        draft: {
          id: draftId,
          jobId,
          status: "needs_review",
          templateId: "classic_ats",
          createdAt: at,
          updatedAt: at,
          sections: [
            {
              id: `scale_section_${i}`,
              kind: "summary",
              label: "Summary",
              text: body,
              origin: "deterministic_fallback",
              sortOrder: 0,
              updatedAt: at,
            },
          ],
        },
        artifact: {
          id: `scale_export_${i}`,
          draftId,
          jobId,
          format: "pdf",
          filePath: `/synthetic/scale-export-${i}.pdf`,
          templateId: "classic_ats",
          exportedAt: at,
          isApproved: false,
        },
        research: {
          id: `scale_research_${i}`,
          jobId,
          sourceUrl: `https://example.test/company/${i}`,
          fetchedAt: at,
          extractedText: documentBody,
          companyNotes: documentBody,
          fetchStatus: "success",
        },
        run: {
          id: runId,
          mode: "copilot",
          state: "completed",
          jobIds: [jobId],
          createdAt: at,
          updatedAt: at,
          completedAt: at,
          summary: "Synthetic historical application",
          detail: "Synthetic retained run",
          totalJobs: 1,
          skippedJobs: 1,
        },
        result: {
          id: `scale_result_${i}`,
          runId,
          jobId,
          applicationRecordId: recordId,
          queuePosition: 0,
          state: "skipped",
          summary: "Synthetic skipped application",
          detail: "Synthetic retained result",
          startedAt: at,
          updatedAt: at,
          completedAt: at,
          visualObservationSets: [observation],
        },
        record: {
          id: recordId,
          jobId,
          title: `Synthetic scale engineer ${i}`,
          company: `Synthetic scale company ${i}`,
          status: "archived",
          lastAttemptState: "cancelled",
          lastActionLabel: "Synthetic archived application",
          nextActionLabel: null,
          lastUpdatedAt: at,
          events: [
            {
              id: `scale_event_${i}`,
              at,
              title: "Synthetic history",
              detail: activityBody,
              emphasis: "neutral",
            },
          ],
        },
        attempt: {
          id: `scale_attempt_${i}`,
          jobId,
          applicationRecordId: recordId,
          state: "cancelled",
          summary: "Synthetic historical attempt",
          detail: "Synthetic retained attempt",
          startedAt: at,
          updatedAt: at,
          completedAt: at,
          outcome: "archived",
          nextActionLabel: null,
          checkpoints: [
            {
              id: `scale_checkpoint_${i}`,
              at,
              label: "Synthetic checkpoint",
              detail: activityBody,
              state: "cancelled",
            },
          ],
          visualObservationSets: [observation],
        },
      };
    },
  );
  return JobFinderRepositoryStateSchema.parse({
    ...seed,
    tailoredAssets: history.map((row) => row.asset),
    resumeDrafts: history.map((row) => row.draft),
    resumeExportArtifacts: history.map((row) => row.artifact),
    resumeResearchArtifacts: history.map((row) => row.research),
    applyRuns: history.map((row) => row.run),
    applyJobResults: history.map((row) => row.result),
    applicationRecords: history.map((row) => row.record),
    applicationAttempts: history.map((row) => row.attempt),
    discovery: {
      ...seed.discovery,
      runState: "idle",
      activeRun: null,
      recentRuns: [],
      pendingDiscoveryJobs: [],
      discoveryLedger: [],
    },
  });
}
