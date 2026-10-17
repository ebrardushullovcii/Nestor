import { DiscoveryRunRecordSchema } from "@nestor/contracts";

export function round3SearchRun() {
  return DiscoveryRunRecordSchema.parse({
    id: "round3-counts",
    campaignId: "plan",
    state: "completed",
    startedAt: "2026-10-05T10:00:00.000Z",
    targetIds: ["source"],
    targetExecutions: [
      {
        targetId: "source",
        adapterKind: "auto",
        state: "completed",
        jobsReviewed: 28,
        jobsInspected: 52,
        jobsStaged: 25,
        duplicatesMerged: 3,
        jobsSkippedByLedger: 24,
        rejectedListings: [],
        listingsDeferred: 0,
        pagesCovered: 7,
        sourceCounts: [
          {
            sourceId: "source",
            label: "Example board",
            startingUrl: "https://example.test",
            inspected: 52,
            saved: 25,
            rejected: 0,
            duplicates: 27,
            deferred: 0,
            pagesCovered: 7,
          },
        ],
      },
    ],
    summary: {
      validJobsFound: 22,
      jobsStaged: 25,
      duplicatesMerged: 3,
      targetsPlanned: 1,
      targetsCompleted: 1,
      report: {
        version: 2,
        measuredAt: "2026-10-05T10:01:00.000Z",
        found: 52,
        unique: 25,
        new: 25,
        saved: 25,
        retained: 22,
        worthOpening: 21,
        duplicates: 27,
        rejected: 0,
        deferred: 0,
        pagesCovered: 7,
        sources: [
          {
            targetId: "source",
            inspected: 52,
            saved: 25,
            rejected: 0,
            duplicates: 27,
            deferred: 0,
            pagesCovered: 7,
          },
        ],
      },
    },
  });
}
