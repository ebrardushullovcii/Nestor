import { expect, test, vi } from "vitest";
import {
  SavedJobSchema,
  JobDiscoveryTargetSchema,
  readDiscoveryPreparation,
  readPreparedDiscoveryFingerprints,
  readPreparedBodySalaryRange,
  assessJobPostingDetailQuality,
  type SavedJob,
  type JobPosting,
} from "@nestor/contracts";
import { createSavedJob, createSeed } from "../workspace-service.test-fixtures";
import {
  prepareDiscoveryPosting,
  prepareBodySalaryRange,
} from "./discovery-posting-preparation";
import { enrichDiscoveredPosting, mergeDiscoveredPostings } from "./matching";
import { applyListingDetailToJob } from "./listing-detail-enrichment";
import {
  createDiscoveryListingFingerprints,
  createDiscoveryProvenance,
} from "./workspace-discovery-ledger";
import { createJobIdentityIndex, prepareJobIdentity } from "./job-identity";
import { toProviderAwarePosting } from "./discovery-posting-normalization";
import { inferSourceIntelligenceFromTarget } from "./workspace-source-intelligence";
import * as compensation from "./matching-compensation";
import * as contracts from "@nestor/contracts";
import { copyView } from "@nestor/core";
import {
  applySavedJobDelta,
  prepareSavedJobForSearch,
} from "./workspace-discovery-methods";
import { createDiscoverySavedJobWriter } from "./discovery-saved-job-writer";
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

test("preparing a legacy job preserves lazy fields for plan-only writes and releases raw preparation", async () => {
  const legacy = structuredClone(preparedJob());
  const read = vi.fn(() => body);
  Object.defineProperty(legacy, "description", {
    enumerable: true,
    configurable: true,
    get: read,
  });
  Object.freeze(legacy);
  const { prepared, working } = prepareSavedJobForSearch(legacy);
  expect(Object.getOwnPropertyDescriptor(working, "description")).toMatchObject(
    { get: read },
  );
  expect(
    Object.getOwnPropertyDescriptor(prepared, "description"),
  ).toMatchObject({ value: body });
  expect(readDiscoveryPreparation(working)?.content).toBeUndefined();
  expect(
    readDiscoveryPreparation(working)?.fingerprints?.basis,
  ).toBeUndefined();
  expect(
    readDiscoveryPreparation(working)?.savedIdentity?.basis,
  ).toBeUndefined();
  const reads = read.mock.calls.length;
  expect(contracts.readPreparedSavedJobIdentity(working)).not.toBeNull();
  const commit = vi.fn().mockResolvedValue(undefined);
  const writer = createDiscoverySavedJobWriter({
    persistedJobs: [legacy],
    toStoredJob: (job) => job,
    merge: applySavedJobDelta,
    commit,
    persistDiscovery: () => Promise.resolve(),
  });
  writer.stage(
    copyView(working, {
      planAssessments: { test: { ...working.matchAssessment, score: 71 } },
    }),
  );
  await writer.persist();
  expect(commit).toHaveBeenCalledWith(
    expect.objectContaining({
      upserts: [],
      updateJobIds: [],
      planAssessments: [
        expect.objectContaining({ jobId: legacy.id, planId: "test" }),
      ],
    }),
  );
  expect(read).toHaveBeenCalledTimes(reads);
});

test("triage and merge carry the same computed screening hints", () => {
  const first = enrichDiscoveredPosting(preparedJob(), undefined);
  const carried = readDiscoveryPreparation(first)!.screeningHints!.value;
  const second = enrichDiscoveredPosting(first, undefined);
  expect(readDiscoveryPreparation(second)!.screeningHints!.value).toBe(carried);
  expect(second.screeningHints).toEqual(first.screeningHints);
});

test.each([
  (job: JobPosting) => {
    job.location = "Remote Europe";
  },
  (job: JobPosting) => {
    job.summary = "Work authorization is required.";
  },
  (job: JobPosting) => {
    job.description = "Visa sponsorship and relocation available.";
  },
  (job: JobPosting) => {
    job.minimumQualifications.push("Active security clearance");
  },
  (job: JobPosting) => {
    job.preferredQualifications.push("Must travel regularly");
  },
  (job: JobPosting) => {
    job.workMode.push("remote");
  },
])(
  "changed screening inputs recompute rather than reuse carried hints (%#)",
  (mutate) => {
    const job = enrichDiscoveredPosting(preparedJob(), undefined);
    const carried = readDiscoveryPreparation(job)!.screeningHints!.value;
    mutate(job);
    const expected = enrichDiscoveredPosting(structuredClone(job), undefined);
    const result = enrichDiscoveredPosting(job, undefined);
    expect(readDiscoveryPreparation(result)!.screeningHints!.value).not.toBe(
      carried,
    );
    expect(result.screeningHints).toEqual(expected.screeningHints);
  },
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
      body + "Own a new data platform. Salary: EUR 96,000 per year.";
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
      expect(readPreparedBodySalaryRange(actual)).toEqual(
        compensation.extractSalaryRangeFromListingBody(control.description),
      );
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

test("salary is parsed once per arriving text and carried without changing the listing's salary field", () => {
  const parse = vi.spyOn(contracts, "extractSalaryRangeFromListingBody");
  try {
    const job = {
      ...createSeed().savedJobs[0]!,
      salaryText: null,
      description: body + " We offer EUR 96,000 per year.",
    };
    prepareDiscoveryPosting(job);
    prepareDiscoveryPosting({ ...job, title: "Changed title" });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(readPreparedBodySalaryRange(job)).toBe("EUR 96,000 per year");
    expect(job.salaryText).toBeNull();
    const changed = {
      ...job,
      description: body + " We offer USD 99,000 per year.",
    };
    prepareDiscoveryPosting(changed);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(readPreparedBodySalaryRange(changed)).toBe("USD 99,000 per year");
    const copied = { ...job, description: changed.description };
    prepareDiscoveryPosting(copied, changed);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(readPreparedBodySalaryRange(copied)).toBe("USD 99,000 per year");
    const decoded = structuredClone(job);
    expect(prepareBodySalaryRange(decoded)).toBe("EUR 96,000 per year");
    expect(prepareBodySalaryRange(decoded)).toBe("EUR 96,000 per year");
    expect(parse).toHaveBeenCalledTimes(3);
  } finally {
    parse.mockRestore();
  }
});

test("a plan-only delta preserves concurrent status and proven lazy listing fields without opening them", () => {
  const baseline = preparedJob();
  const fingerprints = createDiscoveryListingFingerprints(baseline);
  contracts.writeDiscoveryPreparation(baseline, {
    fingerprints: { owner: baseline, value: fingerprints },
  });
  const read = vi.fn(() => {
    throw new Error("A plan update opened listing text");
  });
  Object.defineProperty(baseline, "description", {
    enumerable: true,
    configurable: true,
    get: read,
  });
  Object.freeze(baseline);
  const current = copyView(baseline, { status: "shortlisted" as const });
  const salary = readPreparedBodySalaryRange(baseline)!;
  contracts.writeDiscoveryPreparation(current, {
    fingerprints: { owner: current, value: fingerprints },
    bodySalaryRange: salary,
  });
  Object.freeze(current);
  const intended = copyView(baseline, {
    planAssessments: { synthetic_plan: baseline.matchAssessment },
  });
  const next = applySavedJobDelta(current, baseline, intended);
  expect(next.status).toBe("shortlisted");
  expect(next.planAssessments?.synthetic_plan).toEqual(
    baseline.matchAssessment,
  );
  expect(Object.getOwnPropertyDescriptor(next, "description")).toMatchObject({
    get: read,
  });
  expect(readPreparedDiscoveryFingerprints(next)).toEqual(fingerprints);
  expect(readPreparedBodySalaryRange(next)).toBe(salary);
  expect(read).not.toHaveBeenCalled();
});

test("a delta changing the listing body recomputes its fingerprints and salary evidence", () => {
  const baseline = preparedJob();
  const before = createDiscoveryListingFingerprints(baseline);
  const intended = prepareDiscoveryPosting({
    ...baseline,
    description: body + " Pay: EUR 96,000 per year.",
  });
  const next = applySavedJobDelta(baseline, baseline, intended);
  expect(next.description).toBe(intended.description);
  expect(createDiscoveryListingFingerprints(next)).toEqual(
    createDiscoveryListingFingerprints(intended),
  );
  expect(createDiscoveryListingFingerprints(next)).not.toEqual(before);
  expect(readPreparedBodySalaryRange(next)).toBe("EUR 96,000 per year");
});
