import { describe, expect, test } from "vitest";

import {
  JobPostingSchema,
  type DiscoveryLedgerEntry,
  type JobPosting,
} from "@nestor/contracts";

import {
  applyInactiveLedgerMarks,
  createDiscoveryFreshnessDigest,
  createDiscoveryLedgerIndex,
  createDiscoveryListingFingerprints,
  rememberDiscoveryListingFingerprints,
  reuseDiscoveryPostingPreparation,
  findDiscoveryLedgerEntry,
  formatDiscoveryFreshnessDigest,
  recordDiscoveredPostingInLedger,
  shouldSkipPostingFromLedger,
} from "./workspace-discovery-ledger";

function createPosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "job_1",
    discoveryMethod: "browser_agent",
    collectionMethod: "careers_page",
    canonicalUrl: "https://example.com/jobs/job-1",
    applicationUrl: "https://example.com/jobs/job-1/apply",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-03-19T09:00:00.000Z",
    discoveredAt: "2026-03-20T09:00:00.000Z",
    salaryText: "$150,000",
    detailQuality: "detail_enriched",
    summary: "Build reliable customer-facing software.",
    description:
      "Build reliable customer-facing software with TypeScript and React.",
    keySkills: ["TypeScript", "React"],
    responsibilities: ["Ship reliable product improvements."],
    minimumQualifications: ["Five years of software engineering experience."],
    preferredQualifications: [],
    benefits: ["Health insurance"],
    ...overrides,
  });
}

test("schema and triage copies reuse prepared fingerprints only while all fingerprint inputs match", () => {
  const source = createPosting();
  const expected = createDiscoveryListingFingerprints(source);
  rememberDiscoveryListingFingerprints(source, expected);
  const copy = JobPostingSchema.parse({
    ...source,
    titleTriageOutcome: "skip_title",
  });
  expect(reuseDiscoveryPostingPreparation(source, copy)).toBe(copy);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(createDiscoveryListingFingerprints(copy)).toEqual(expected);
  const edited = JobPostingSchema.parse({
    ...source,
    description: "A changed listing with new requirements.",
  });
  reuseDiscoveryPostingPreparation(source, edited);
  expect(Object.isFrozen(edited)).toBe(false);
  expect(createDiscoveryListingFingerprints(edited)).not.toEqual(expected);
});

function createLedgerEntry(
  overrides: Partial<DiscoveryLedgerEntry> = {},
): DiscoveryLedgerEntry {
  const fingerprintPosting = createPosting({
    detailQuality: overrides.detailQuality ?? "detail_enriched",
  });
  return {
    id: "ledger_1",
    canonicalUrl: fingerprintPosting.canonicalUrl,
    applicationUrl: fingerprintPosting.applicationUrl,
    source: fingerprintPosting.source,
    sourceJobId: fingerprintPosting.sourceJobId,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    providerUpdatedAt: fingerprintPosting.providerUpdatedAt,
    title: fingerprintPosting.title,
    company: fingerprintPosting.company,
    location: fingerprintPosting.location,
    postedAt: fingerprintPosting.postedAt,
    postedAtText: fingerprintPosting.postedAtText,
    targetId: "target_one",
    collectionMethod: fingerprintPosting.collectionMethod,
    detailQuality: fingerprintPosting.detailQuality,
    fingerprints: createDiscoveryListingFingerprints(fingerprintPosting),
    firstSeenAt: "2026-03-20T09:00:00.000Z",
    lastSeenAt: "2026-03-20T09:00:00.000Z",
    lastAppliedAt: null,
    lastEnrichedAt: "2026-03-20T09:05:00.000Z",
    inactiveAt: null,
    latestStatus: "enriched",
    titleTriageOutcome: "pass",
    skipReason: null,
    ...overrides,
  };
}

describe("workspace-discovery-ledger", () => {
  test("reuses worker fingerprints across copies, but changing any material input computes a new digest", () => {
    const worker = createPosting();
    const fingerprints = createDiscoveryListingFingerprints(worker);
    rememberDiscoveryListingFingerprints(worker, fingerprints);
    const copy = JobPostingSchema.parse(worker);
    expect(createDiscoveryListingFingerprints(copy)).toEqual(fingerprints);
    const owned = createDiscoveryListingFingerprints(copy);
    owned.card = "caller-owned";
    expect(createDiscoveryListingFingerprints(copy)).toEqual(fingerprints);
    copy.description += " A changed description.";
    expect(createDiscoveryListingFingerprints(copy).detail).not.toBe(
      fingerprints.detail,
    );
    copy.description = worker.description;
    copy.workMode.push("hybrid");
    expect(createDiscoveryListingFingerprints(copy).card).not.toBe(
      fingerprints.card,
    );
    expect(worker.workMode).toEqual(["remote"]);
  });
  test("classifies new, unchanged, changed, and reactivated listings", () => {
    const unchanged = createPosting();
    const changed = createPosting({
      sourceJobId: "job_2",
      canonicalUrl: "https://example.com/jobs/job-2",
      applicationUrl: "https://example.com/jobs/job-2/apply",
      title: "Platform Engineer",
    });
    const reactivated = createPosting({
      sourceJobId: "job_3",
      canonicalUrl: "https://example.com/jobs/job-3",
      applicationUrl: "https://example.com/jobs/job-3/apply",
      title: "Frontend Engineer",
    });
    const fresh = createPosting({
      sourceJobId: "job_4",
      canonicalUrl: "https://example.com/jobs/job-4",
      applicationUrl: "https://example.com/jobs/job-4/apply",
      title: "Product Engineer",
    });
    const result = createDiscoveryFreshnessDigest({
      ledger: [
        createLedgerEntry(),
        createLedgerEntry({
          id: "ledger_2",
          sourceJobId: changed.sourceJobId,
          canonicalUrl: changed.canonicalUrl,
          title: "Software Engineer",
        }),
        createLedgerEntry({
          id: "ledger_3",
          sourceJobId: reactivated.sourceJobId,
          canonicalUrl: reactivated.canonicalUrl,
          title: reactivated.title,
          latestStatus: "inactive",
          inactiveAt: "2026-03-20T08:00:00.000Z",
        }),
      ],
      postings: [fresh, changed, unchanged, reactivated],
    });

    expect(result.total).toBe(4);
    expect(result.counts).toEqual({
      new: 1,
      unchanged: 1,
      changed: 1,
      reactivated: 1,
    });
    expect(result.digest).toMatch(/^v1_[0-9a-f]{16}$/u);
    expect(formatDiscoveryFreshnessDigest(result)).toBe(
      `Freshness: 1 new, 1 unchanged, 1 changed, 1 reactivated. Digest ${result.digest}.`,
    );
  });

  test("treats a newer provider timestamp as a material listing change", () => {
    const providerUpdatedAt = "2026-03-20T11:00:00.000Z";
    const posting = createPosting({ providerUpdatedAt });
    const existingPosting = createPosting({
      providerUpdatedAt: "2026-03-20T10:00:00.000Z",
    });
    const entry = createLedgerEntry({
      providerUpdatedAt: existingPosting.providerUpdatedAt,
      fingerprints: createDiscoveryListingFingerprints(existingPosting),
    });

    const result = createDiscoveryFreshnessDigest({
      ledger: [entry],
      postings: [posting],
    });
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: entry,
      posting: createPosting({
        detailQuality: "card_only",
        providerUpdatedAt,
      }),
      triageOutcome: "pass",
    });

    expect(result.counts.changed).toBe(1);
    expect(decision.skip).toBe(false);
  });

  test("persists the newest provider timestamp and fingerprints it", () => {
    const existingPosting = createPosting({
      providerUpdatedAt: "2026-03-20T10:00:00.000Z",
    });
    const existing = createLedgerEntry({
      providerUpdatedAt: existingPosting.providerUpdatedAt,
      fingerprints: createDiscoveryListingFingerprints(existingPosting),
    });
    const newerPosting = createPosting({
      providerUpdatedAt: "2026-03-20T11:00:00.000Z",
    });
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [existing],
      posting: newerPosting,
      targetId: "target_one",
      seenAt: "2026-03-20T11:05:00.000Z",
      status: "enriched",
    });

    expect(ledger[0]?.providerUpdatedAt).toBe("2026-03-20T11:00:00.000Z");
    expect(ledger[0]?.fingerprints?.material).not.toBe(
      existing.fingerprints?.material,
    );
  });

  test("creates the same freshness digest regardless of collection order", () => {
    const postings = [
      createPosting(),
      createPosting({
        sourceJobId: "job_2",
        canonicalUrl: "https://example.com/jobs/job-2",
        applicationUrl: "https://example.com/jobs/job-2/apply",
      }),
    ];
    const ledger = [createLedgerEntry()];

    const forward = createDiscoveryFreshnessDigest({ ledger, postings });
    const reverse = createDiscoveryFreshnessDigest({
      ledger,
      postings: [...postings].reverse(),
    });

    expect(reverse).toEqual(forward);
  });

  test("treats legacy entries without fingerprints as changed", () => {
    const result = createDiscoveryFreshnessDigest({
      ledger: [createLedgerEntry({ fingerprints: null })],
      postings: [createPosting()],
    });

    expect(result.counts).toEqual({
      new: 0,
      unchanged: 0,
      changed: 1,
      reactivated: 0,
    });
  });
  test("does not match distinct jobs that only share title and company", () => {
    const result = findDiscoveryLedgerEntry([createLedgerEntry()], {
      canonicalUrl: "https://example.com/jobs/job-2",
      source: "target_site",
      sourceJobId: "job_2",
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
    });

    expect(result).toBeNull();
  });

  test("matches canonical URL aliases that only differ by tracking parameters and trailing slash", () => {
    const result = findDiscoveryLedgerEntry(
      [
        createLedgerEntry({
          canonicalUrl:
            "https://example.com/jobs/job-1/?utm_source=linkedin&utm_medium=job-board",
        }),
      ],
      {
        canonicalUrl: "https://example.com/jobs/job-1",
        source: "target_site",
        sourceJobId: "different-source-id",
        providerKey: null,
        providerBoardToken: null,
        providerIdentifier: null,
      },
    );

    expect(result?.id).toBe("ledger_1");
  });

  test("matches provider identity aliases when the canonical URL changes", () => {
    const result = findDiscoveryLedgerEntry(
      [
        createLedgerEntry({
          canonicalUrl: "https://boards.example.com/jobs/old-route",
          providerKey: "greenhouse",
          providerBoardToken: "acme",
          providerIdentifier: "acme",
        }),
      ],
      {
        canonicalUrl: "https://boards.example.com/jobs/new-route",
        source: "target_site",
        sourceJobId: "job_1",
        providerKey: "greenhouse",
        providerBoardToken: "acme",
        providerIdentifier: "acme",
      },
    );

    expect(result?.id).toBe("ledger_1");
  });

  test("uses a unique URL to disambiguate colliding source IDs", () => {
    const first = createLedgerEntry({
      id: "ledger_acme_123",
      canonicalUrl: "https://jobs.acme.example/roles/123",
      sourceJobId: "123",
      providerKey: "greenhouse",
      providerBoardToken: "acme",
      providerIdentifier: "acme",
    });
    const second = createLedgerEntry({
      id: "ledger_beta_123",
      canonicalUrl: "https://jobs.beta.example/roles/123",
      sourceJobId: "123",
      providerKey: "greenhouse",
      providerBoardToken: "beta",
      providerIdentifier: "beta",
    });

    const result = findDiscoveryLedgerEntry([first, second], {
      canonicalUrl: "https://jobs.beta.example/roles/123?utm_source=replay",
      source: "target_site",
      sourceJobId: "123",
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
    });

    expect(result?.id).toBe("ledger_beta_123");
  });

  test("returns no match when the only known alias collides", () => {
    const first = createLedgerEntry({
      id: "ledger_acme_123",
      canonicalUrl: "https://jobs.acme.example/roles/123",
      sourceJobId: "123",
    });
    const second = createLedgerEntry({
      id: "ledger_beta_123",
      canonicalUrl: "https://jobs.beta.example/roles/123",
      sourceJobId: "123",
    });

    const result = findDiscoveryLedgerEntry([first, second], {
      canonicalUrl: "https://jobs.gamma.example/roles/123",
      source: "target_site",
      sourceJobId: "123",
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
    });

    expect(result).toBeNull();
  });

  test("does not let conflicting unique aliases select the wrong posting", () => {
    const first = createLedgerEntry({
      id: "ledger_acme_123",
      canonicalUrl: "https://jobs.acme.example/roles/123",
      sourceJobId: "123",
    });
    const second = createLedgerEntry({
      id: "ledger_beta_456",
      canonicalUrl: "https://jobs.beta.example/roles/456",
      sourceJobId: "456",
    });

    const result = findDiscoveryLedgerEntry([first, second], {
      canonicalUrl: first.canonicalUrl,
      source: "target_site",
      sourceJobId: second.sourceJobId ?? "",
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
    });

    expect(result).toBeNull();
  });

  test("uses provider identity to isolate same-ID jobs from different sources", () => {
    const greenhouseEntry = createLedgerEntry({
      id: "ledger_greenhouse_123",
      canonicalUrl: "https://jobs.acme.example/roles/123",
      sourceJobId: "123",
      providerKey: "greenhouse",
      providerBoardToken: "acme",
      providerIdentifier: "acme",
    });
    const workdayEntry = createLedgerEntry({
      id: "ledger_workday_123",
      canonicalUrl: "https://beta.wd5.myworkdayjobs.com/jobs/job/123",
      sourceJobId: "123",
      providerKey: "workday",
      providerBoardToken: "beta",
      providerIdentifier: "beta",
    });

    const result = findDiscoveryLedgerEntry([greenhouseEntry, workdayEntry], {
      canonicalUrl: "https://beta.wd5.myworkdayjobs.com/jobs/job/new-route",
      source: "target_site",
      sourceJobId: "123",
      providerKey: "workday",
      providerBoardToken: "beta",
      providerIdentifier: "beta",
    });

    expect(result?.id).toBe("ledger_workday_123");
  });

  test("preserves existing jobs when recording an ambiguous alias collision", () => {
    const first = createLedgerEntry({
      id: "ledger_acme_123",
      canonicalUrl: "https://jobs.acme.example/roles/123",
      sourceJobId: "123",
    });
    const second = createLedgerEntry({
      id: "ledger_beta_123",
      canonicalUrl: "https://jobs.beta.example/roles/123",
      sourceJobId: "123",
    });
    const incoming = createPosting({
      canonicalUrl: "https://jobs.gamma.example/roles/123",
      applicationUrl: "https://jobs.gamma.example/roles/123/apply",
      sourceJobId: "123",
      company: "Gamma",
    });

    const result = recordDiscoveredPostingInLedger({
      ledger: [first, second],
      posting: incoming,
      targetId: "target_gamma",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "seen",
    });

    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(
      result.find((entry) => entry.company === "Gamma")?.canonicalUrl,
    ).toBe(incoming.canonicalUrl);
  });

  test("keeps a live ledger index collision-safe as entries are recorded", () => {
    let ledger: DiscoveryLedgerEntry[] = [];
    const index = createDiscoveryLedgerIndex(ledger);
    const first = createPosting({
      canonicalUrl: "https://jobs.acme.example/roles/123",
      applicationUrl: "https://jobs.acme.example/roles/123/apply",
      sourceJobId: "123",
      company: "Acme",
    });
    const second = createPosting({
      canonicalUrl: "https://jobs.beta.example/roles/123",
      applicationUrl: "https://jobs.beta.example/roles/123/apply",
      sourceJobId: "123",
      company: "Beta",
    });

    ledger = recordDiscoveredPostingInLedger({
      ledger,
      index,
      posting: first,
      targetId: "target_acme",
      seenAt: first.discoveredAt,
      status: "seen",
    });
    ledger = recordDiscoveredPostingInLedger({
      ledger,
      index,
      posting: second,
      targetId: "target_beta",
      seenAt: second.discoveredAt,
      status: "seen",
    });
    ledger = recordDiscoveredPostingInLedger({
      ledger,
      index,
      posting: createPosting({
        ...second,
        canonicalUrl: `${second.canonicalUrl}?utm_source=replay`,
        title: "Senior Software Engineer",
      }),
      targetId: "target_beta",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "seen",
    });

    expect(ledger).toHaveLength(2);
    expect(ledger.find((entry) => entry.company === "Beta")?.title).toBe(
      "Senior Software Engineer",
    );
    expect(index.find(first)?.company).toBe("Acme");
    expect(index.find(second)?.title).toBe("Senior Software Engineer");
  });

  test("legacy URL-only entries remain addressable without claiming ambiguous URLs", () => {
    const uniqueLegacy = createLedgerEntry({
      id: "ledger_legacy_unique",
      canonicalUrl: "https://legacy.example/jobs/unique/",
      sourceJobId: null,
      fingerprints: null,
    });
    const duplicateLegacy = createLedgerEntry({
      id: "ledger_legacy_duplicate",
      canonicalUrl: "https://legacy.example/jobs/duplicate",
      sourceJobId: null,
      fingerprints: null,
    });
    const duplicateLegacyTwo = createLedgerEntry({
      id: "ledger_legacy_duplicate_two",
      canonicalUrl: "https://legacy.example/jobs/duplicate?utm_source=old",
      sourceJobId: null,
      fingerprints: null,
    });

    expect(
      findDiscoveryLedgerEntry([uniqueLegacy], {
        canonicalUrl: "https://legacy.example/jobs/unique?utm_medium=replay",
        source: "target_site",
        sourceJobId: null,
        providerKey: null,
        providerBoardToken: null,
        providerIdentifier: null,
      })?.id,
    ).toBe(uniqueLegacy.id);
    expect(
      findDiscoveryLedgerEntry([duplicateLegacy, duplicateLegacyTwo], {
        canonicalUrl: "https://legacy.example/jobs/duplicate",
        source: "target_site",
        sourceJobId: null,
        providerKey: null,
        providerBoardToken: null,
        providerIdentifier: null,
      }),
    ).toBeNull();
  });
  test("skips an unchanged known card before another scoring pass", () => {
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: createLedgerEntry(),
      posting: createPosting({ detailQuality: "card_only" }),
      triageOutcome: "pass",
    });

    expect(decision).toEqual({
      skip: true,
      reason: "Already retained from an earlier unchanged run.",
      outcome: "skip_existing",
    });
  });

  test("refreshes a same-ID listing when material card evidence changes", () => {
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: createLedgerEntry(),
      posting: createPosting({
        detailQuality: "card_only",
        title: "Senior Software Engineer",
      }),
      triageOutcome: "pass",
    });

    expect(decision).toEqual({
      skip: false,
      reason: null,
      outcome: "pass",
    });
  });

  test("refreshes a same-ID listing when detail evidence changes", () => {
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: createLedgerEntry(),
      posting: createPosting({
        description:
          "Build a newly scoped platform with TypeScript, React, and Go.",
      }),
      triageOutcome: "pass",
    });

    expect(decision.skip).toBe(false);
  });

  test("safely refreshes a legacy enriched entry without fingerprints", () => {
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: createLedgerEntry({ fingerprints: null }),
      posting: createPosting({ detailQuality: "card_only" }),
      triageOutcome: "pass",
    });

    expect(decision).toEqual({
      skip: false,
      reason: "Legacy discovery history needs one safe refresh.",
      outcome: "pass",
    });
  });

  test("refreshes inactive or expired history so a reactivated listing is verified", () => {
    const decision = shouldSkipPostingFromLedger({
      ledgerEntry: createLedgerEntry({
        latestStatus: "inactive",
        inactiveAt: "2026-03-20T09:10:00.000Z",
      }),
      posting: createPosting({ detailQuality: "card_only" }),
      triageOutcome: "pass",
    });

    expect(decision.skip).toBe(false);
  });

  test("preserves enriched detail evidence when an unchanged URL alias is seen as a card", () => {
    const existing = createLedgerEntry();
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [existing],
      posting: createPosting({
        canonicalUrl: "https://example.com/jobs/job-1/?utm_source=linkedin",
        detailQuality: "card_only",
        titleTriageOutcome: "skip_existing",
      }),
      targetId: "target_one",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "enriched",
      skipReason: "Already retained from an earlier unchanged run.",
    });

    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.canonicalUrl).toBe("https://example.com/jobs/job-1");
    expect(ledger[0]?.detailQuality).toBe("detail_enriched");
    expect(ledger[0]?.fingerprints).toEqual(existing.fingerprints);
    expect(ledger[0]?.lastEnrichedAt).toBe("2026-03-20T09:05:00.000Z");
  });

  test("downgrades stale detail and records a new card fingerprint after material change", () => {
    const existing = createLedgerEntry();
    const changedPosting = createPosting({
      detailQuality: "card_only",
      location: "New York, NY",
    });
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [existing],
      posting: changedPosting,
      targetId: "target_one",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "seen",
    });

    expect(ledger[0]?.detailQuality).toBe("card_only");
    expect(ledger[0]?.lastEnrichedAt).toBeNull();
    expect(ledger[0]?.fingerprints?.card).toBe(
      createDiscoveryListingFingerprints(changedPosting).card,
    );
    expect(ledger[0]?.fingerprints?.card).not.toBe(existing.fingerprints?.card);
  });

  test("preserves applied status even when the listing changes", () => {
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [
        createLedgerEntry({
          latestStatus: "applied",
          lastAppliedAt: "2026-03-20T09:10:00.000Z",
        }),
      ],
      posting: createPosting({ title: "Senior Software Engineer" }),
      targetId: "target_one",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "applied",
    });

    expect(ledger[0]?.latestStatus).toBe("applied");
    expect(ledger[0]?.lastAppliedAt).toBe("2026-03-20T10:00:00.000Z");
  });

  test("does not mark jobs inactive after a partial or failed inventory", () => {
    const ledger = applyInactiveLedgerMarks({
      ledger: [createLedgerEntry()],
      targetId: "target_one",
      seenCanonicalUrls: [],
      occurredAt: "2026-03-20T10:00:00.000Z",
      allowInactiveMarking: false,
    });

    expect(ledger[0]?.latestStatus).toBe("enriched");
    expect(ledger[0]?.inactiveAt).toBeNull();
  });

  test("marks unseen entries inactive after a complete inventory", () => {
    const ledger = applyInactiveLedgerMarks({
      ledger: [createLedgerEntry()],
      targetId: "target_one",
      seenCanonicalUrls: [],
      occurredAt: "2026-03-20T10:00:00.000Z",
      allowInactiveMarking: true,
    });

    expect(ledger[0]?.latestStatus).toBe("inactive");
    expect(ledger[0]?.inactiveAt).toBe("2026-03-20T10:00:00.000Z");
  });

  test("clears inactive state and refreshes fingerprints when a listing reactivates", () => {
    const existing = createLedgerEntry({
      latestStatus: "inactive",
      inactiveAt: "2026-03-20T09:10:00.000Z",
    });
    const reactivatedPosting = createPosting({
      detailQuality: "card_only",
      location: "Boston, MA",
    });
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [existing],
      posting: reactivatedPosting,
      targetId: "target_one",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "seen",
    });

    expect(ledger[0]?.latestStatus).toBe("seen");
    expect(ledger[0]?.inactiveAt).toBeNull();
    expect(ledger[0]?.fingerprints?.card).toBe(
      createDiscoveryListingFingerprints(reactivatedPosting).card,
    );
  });

  test("clears stale skip reasons when a skipped posting is restored", () => {
    const ledger = recordDiscoveredPostingInLedger({
      ledger: [
        createLedgerEntry({
          latestStatus: "skipped",
          titleTriageOutcome: "skip_existing",
          skipReason: "Already retained from an earlier run.",
        }),
      ],
      posting: createPosting(),
      targetId: "target_one",
      seenAt: "2026-03-20T10:00:00.000Z",
      status: "enriched",
    });

    expect(ledger[0]?.latestStatus).toBe("enriched");
    expect(ledger[0]?.skipReason).toBeNull();
  });
});
