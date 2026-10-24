import { expect, test, vi } from "vitest";
import {
  SavedJobSchema,
  JobDiscoveryTargetSchema,
  readDiscoveryPreparation,
  readPreparedDiscoveryFingerprints,
  assessJobPostingDetailQuality,
  type SavedJob,
} from "@nestor/contracts";
import { createSavedJob, createSeed } from "../workspace-service.test-fixtures";
import { prepareDiscoveryPosting } from "./discovery-posting-preparation";
import { enrichDiscoveredPosting, mergeDiscoveredPostings } from "./matching";
import { applyListingDetailToJob } from "./listing-detail-enrichment";
import {
  createDiscoveryListingFingerprints,
  createDiscoveryProvenance,
} from "./workspace-discovery-ledger";
import { createJobIdentityIndex, prepareJobIdentity } from "./job-identity";
import { toProviderAwarePosting } from "./discovery-posting-normalization";
import { inferSourceIntelligenceFromTarget } from "./workspace-source-intelligence";
import {
  carryPreparedDiscoveryPosting,
  rememberPreparedDiscoveryPosting,
  takePreparedDiscoveryPosting,
} from "./discovery-feed-executor";

const body =
  "Build reliable software with a collaborative product and engineering team. ".repeat(
    15,
  );
const preparedJob = () =>
  prepareDiscoveryPosting(
    createSavedJob({
      ...createSeed().savedJobs[0]!,
      description: body,
      detailQuality: "partial_detail",
    }),
  );

test("an equally titled full incoming listing does not need the saved body to choose richer evidence", () => {
  const posting = { ...preparedJob(), description: body.repeat(10) };
  expect(assessJobPostingDetailQuality(posting)).toBe("detail_enriched");
  const saved = structuredClone(posting);
  const expected = structuredClone(enrichDiscoveredPosting(posting, saved));
  const read = vi.fn(() => {
    throw new Error(
      "Unchanged title and strongest incoming detail do not need the saved body",
    );
  });
  Object.defineProperty(saved, "description", { enumerable: true, get: read });
  expect(structuredClone(enrichDiscoveredPosting(posting, saved))).toEqual(
    expected,
  );
  expect(read).not.toHaveBeenCalled();
});
const mutations = {
  title(job: SavedJob) {
    job.title = "Staff Software Engineer";
  },
  company(job: SavedJob) {
    job.company = "Another Synthetic Company";
  },
  canonicalUrl(job: SavedJob) {
    job.canonicalUrl = "https://example.test/changed";
  },
  applicationUrl(job: SavedJob) {
    job.applicationUrl = "https://example.test/changed/apply";
  },
  description(job: SavedJob) {
    job.description =
      body + "Own a new data platform and its operational reliability.";
  },
};
const paths = {
  normalization: (job: SavedJob) => {
    const target = JobDiscoveryTargetSchema.parse({
      id: "synthetic",
      label: "Synthetic",
      adapterKind: "auto",
      startingUrl: "https://example.test/careers",
    });
    return toProviderAwarePosting({
      posting: job,
      target,
      intelligence: inferSourceIntelligenceFromTarget({
        target,
        currentArtifact: null,
      }),
      adapterKind: "target_site",
      collectionMethod: job.collectionMethod,
      discoveryMethod: job.discoveryMethod,
    });
  },
  enrichment: (job: SavedJob) => enrichDiscoveredPosting(job, undefined),
  merge: (job: SavedJob) => {
    const seed = createSeed();
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [preparedJob()],
      [job],
      (posting) =>
        createDiscoveryProvenance({
          targetId: "prepared_source",
          adapterKind: "auto",
          resolvedAdapterKind: "target_site",
          startingUrl: "https://example.test",
          discoveredAt: "2026-10-24T00:00:00.000Z",
          collectionMethod: posting.collectionMethod,
          providerKey: posting.providerKey,
          providerBoardToken: posting.providerBoardToken,
          titleTriageOutcome: posting.titleTriageOutcome,
        }),
      undefined,
      () => job.matchAssessment,
    );
    return result.newJobs[0] ?? result.mergedJobs[0]!;
  },
  listing: async (job: SavedJob) =>
    (
      await applyListingDetailToJob({
        job,
        attemptedAt: "2026-10-24T00:00:00.000Z",
        assess: () => job.matchAssessment,
        detail: {
          method: "page_text",
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
          salaryText: job.salaryText,
          employmentType: job.employmentType,
          postedAt: job.postedAt,
          validThrough: null,
          workModeHints: job.workMode,
          directApplyUrl: job.applicationUrl,
          keySkills: job.keySkills,
          responsibilities: job.responsibilities,
          minimumQualifications: job.minimumQualifications,
          preferredQualifications: job.preferredQualifications,
          seniority: job.seniority,
        },
      })
    ).job,
};

test.each(Object.entries(mutations))(
  "a changed %s cannot retain the worker's old normalized posting",
  (_name, mutate) => {
    const before = preparedJob();
    rememberPreparedDiscoveryPosting(before, paths.normalization(before));
    Object.freeze(before);
    expect(takePreparedDiscoveryPosting(before)).not.toBeNull();
    const changed = { ...before };
    mutate(changed);
    carryPreparedDiscoveryPosting(before, changed);
    Object.freeze(changed);
    expect(takePreparedDiscoveryPosting(changed)).toBeNull();
    const expected = paths.normalization(structuredClone(changed));
    expect(structuredClone(paths.normalization(changed))).toEqual(
      structuredClone(expected),
    );
  },
);

test("only an explicit unchanged screen copy carries worker normalization; mutable and cloned inputs fall back", () => {
  const before = preparedJob();
  rememberPreparedDiscoveryPosting(before, paths.normalization(before));
  expect(takePreparedDiscoveryPosting(before)).toBeNull();
  Object.freeze(before);
  const after = carryPreparedDiscoveryPosting(before, {
    ...before,
    searchRejection: { category: "role", reason: "Synthetic screen result" },
  });
  expect(takePreparedDiscoveryPosting(after)!.searchRejection).toEqual(
    after.searchRejection,
  );
  expect(takePreparedDiscoveryPosting(Object.freeze({ ...before }))).toBeNull();
  const normalized = paths.normalization(Object.freeze({ ...before }));
  expect(
    readDiscoveryPreparation(normalized)!.normalizedPosting,
  ).toBeUndefined();
  expect(
    readDiscoveryPreparation(normalized)!.normalizedPostingSource,
  ).toBeUndefined();
  expect(
    takePreparedDiscoveryPosting(Object.freeze(structuredClone(before))),
  ).toBeNull();
});

for (const [path, apply] of Object.entries(paths))
  for (const [field, mutate] of Object.entries(mutations)) {
    test(`${path} prepares changed ${field} facts`, async () => {
      const original = preparedJob();
      const changed = { ...original };
      mutate(changed);
      // The existing listing fingerprint excludes canonicalUrl; compact
      // identity keys still have to change for that route correction.
      if (field !== "canonicalUrl")
        expect(readPreparedDiscoveryFingerprints(changed)).toBeNull();
      const fresh = structuredClone(changed);
      const actual = await apply(changed);
      const control = await apply(fresh);
      expect(readDiscoveryPreparation(actual)).toBeDefined();
      expect(readPreparedDiscoveryFingerprints(actual)).not.toBeNull();
      expect(createDiscoveryListingFingerprints(actual)).toEqual(
        createDiscoveryListingFingerprints(control),
      );
      expect(prepareJobIdentity(actual)).toEqual(prepareJobIdentity(control));
      expect(structuredClone(actual)).toEqual(structuredClone(control));
    });
  }

test("worker, JSON and schema-shaped rows with no carrier compute identity instead of losing the match", () => {
  const original = preparedJob();
  const index = createJobIdentityIndex([original], (value) => value);
  const messages = [
    structuredClone(original),
    JSON.parse(JSON.stringify(original)) as SavedJob,
    SavedJobSchema.parse(original),
  ];
  for (const posting of messages) {
    expect(readDiscoveryPreparation(posting)).toBeUndefined();
    expect(index.find(posting)).toBe(original);
    expect(createDiscoveryListingFingerprints(posting)).toEqual(
      createDiscoveryListingFingerprints(original),
    );
  }
});
