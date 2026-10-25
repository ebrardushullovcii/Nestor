import { afterEach, expect, test } from "vitest";
import {
  DiscoveryLedgerEntrySchema,
  FitJudgmentSchema,
} from "@nestor/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  createTempRepository,
  createSavedJob,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

for (const storage of ["memory", "file"] as const) {
  test(`${storage} Home activity retains global ambiguity, plan closure and committed changes for selected ids`, async () => {
    let repo: JobFinderRepository;
    if (storage === "memory")
      repo = createInMemoryJobFinderRepository(createSeed());
    else {
      const temp = await createTempRepository("nestor-home-activity-");
      cleanups.push(temp.cleanup);
      repo = await temp.createRepository();
      cleanups.push(() => repo.close());
    }
    const job = createSavedJob({ id: "selected", applicationUrl: null });
    const duplicate = { ...job, id: "other_identity_candidate" };
    await repo.commitSavedJobDelta({ upserts: [job] });
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: [
        DiscoveryLedgerEntrySchema.parse({
          id: "unrelated_ledger_id",
          canonicalUrl: job.canonicalUrl,
          source: job.source,
          sourceJobId: job.sourceJobId,
          title: job.title,
          company: job.company,
          location: job.location,
          targetId: "synthetic",
          firstSeenAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          inactiveAt: "2026-10-24T00:00:00.000Z",
          latestStatus: "inactive",
        }),
      ],
    }));
    const read = () =>
      repo.readDiscoveryHomeProjection([job.id, job.id, "missing"]);
    expect((await read()).listingActivities).toMatchObject([
      {
        jobId: job.id,
        listingActivity: {
          status: "inactive",
          ledgerEntryId: "unrelated_ledger_id",
        },
      },
    ]);
    await repo.commitSavedJobDelta({ upserts: [duplicate] });
    expect((await read()).listingActivities).toMatchObject([
      { jobId: job.id, listingActivity: { status: "active" } },
    ]);
    const assessment = {
      ...job.matchAssessment,
      judgment: FitJudgmentSchema.parse({
        source: "batch",
        judgedAt: "2026-10-24T00:00:00.000Z",
        score: 60,
        recommendation: "skip",
        listingClosed: true,
        listingClosedEvidence: "Synthetic closure evidence",
      }),
    };
    await repo.commitSavedJobDelta({
      upserts: [{ ...job, planAssessments: { synthetic_plan: assessment } }],
    });
    expect(
      (await repo.readDiscoveryHomeProjection([job.id], "synthetic_plan"))
        .listingActivities,
    ).toMatchObject([
      {
        jobId: job.id,
        listingActivity: {
          status: "closed",
          detail: 'The page says "Synthetic closure evidence".',
        },
      },
    ]);
    await repo.commitSavedJobDelta({
      upserts: [
        { ...job, planAssessments: { synthetic_plan: job.matchAssessment } },
      ],
    });
    expect(
      (await repo.readDiscoveryHomeProjection([job.id], "synthetic_plan"))
        .listingActivities,
    ).toMatchObject([{ jobId: job.id, listingActivity: { status: "active" } }]);
    expect((await read()).listingActivities).toMatchObject([
      { jobId: job.id, listingActivity: { status: "active" } },
    ]);
    expect(await repo.readDiscoveryHomeProjection([])).not.toHaveProperty(
      "discoveryLedger",
    );
  });
}
