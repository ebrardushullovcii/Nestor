import {
  ApplicationAttemptSchema,
  DiscoveryLedgerEntrySchema,
  ListingSignalRecordSchema,
  type DiscoveryLedgerEntry,
  type ListingSignalRecord,
  type SavedJob,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createSeed } from "../workspace-service.test-support";
import {
  findClosedListingPhrase,
  projectDiscoveryJobViews,
} from "./listing-activity";

const hour = (value: number) =>
  `2026-08-23T${String(value).padStart(2, "0")}:00:00.000Z`;

test("unchanged immutable rows retain their activity view while changed evidence replaces it", () => {
  const saved = Object.freeze(job());
  const input = { jobs: [saved], listingSignals: [] };
  const first = projectDiscoveryJobViews(input)[0]!;
  expect(projectDiscoveryJobViews(input)[0]).toBe(first);
  const changed = projectDiscoveryJobViews({
    ...input,
    listingSignals: [
      ListingSignalRecordSchema.parse({
        id: "closed_signal",
        jobId: saved.id,
        signal: "closed",
        detectedAt: hour(11),
        provenance: "system",
        confidence: 1,
        explanation: "Closed",
        detail: null,
        recoveryGuidance: "Choose another listing.",
      }),
    ],
  })[0]!;
  expect(changed).not.toBe(first);
  expect(changed.listingActivity.status).toBe("closed");
  expect(projectDiscoveryJobViews(input)[0]?.listingActivity.status).toBe(
    first.listingActivity.status,
  );
});

function job(overrides: Partial<SavedJob> = {}): SavedJob {
  return {
    ...createSeed().savedJobs[0]!,
    id: "job-activity",
    sourceJobId: "activity-1",
    canonicalUrl: "https://jobs.example.com/activity-1",
    applicationUrl: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    ...overrides,
  };
}

function ledger(
  target: SavedJob,
  overrides: Partial<DiscoveryLedgerEntry> = {},
): DiscoveryLedgerEntry {
  return DiscoveryLedgerEntrySchema.parse({
    id: "ledger-activity",
    canonicalUrl: target.canonicalUrl,
    applicationUrl: target.applicationUrl,
    source: target.source,
    sourceJobId: target.sourceJobId,
    providerKey: target.providerKey,
    providerBoardToken: target.providerBoardToken,
    providerIdentifier: target.providerIdentifier,
    title: target.title,
    company: target.company,
    location: target.location,
    postedAt: target.postedAt,
    postedAtText: target.postedAtText,
    targetId: "target-1",
    firstSeenAt: hour(8),
    lastSeenAt: hour(9),
    inactiveAt: hour(10),
    latestStatus: "inactive",
    ...overrides,
  });
}

function signal(
  target: SavedJob,
  kind: "stale" | "closed" | "suspicious",
  overrides: Partial<ListingSignalRecord> = {},
): ListingSignalRecord {
  return ListingSignalRecordSchema.parse({
    id: `signal-${kind}`,
    jobId: target.id,
    signal: kind,
    detail: `${kind} detail`,
    detectedAt: hour(11),
    confidence: 0.9,
    provenance: "browser",
    explanation: `Explicit ${kind} evidence.`,
    recoveryGuidance: "Review the listing.",
    ...overrides,
  });
}

function activity(input: {
  job: SavedJob;
  ledger?: DiscoveryLedgerEntry[];
  signals?: ListingSignalRecord[];
}) {
  return projectDiscoveryJobViews({
    jobs: [input.job],
    listingSignals: input.signals ?? [],
  })[0]!.listingActivity;
}

describe("listing activity projection", () => {
  test("an apply-agent closure supersedes active discovery without closing another job", () => {
    const target = job({ lastSeenAt: hour(9), lastVerifiedActiveAt: hour(9) });
    const other = job({
      id: "other",
      canonicalUrl: "https://jobs.example.com/other",
      lastSeenAt: hour(9),
    });
    const attempt = ApplicationAttemptSchema.parse({
      id: "closed-attempt",
      jobId: target.id,
      applicationRecordId: "record",
      state: "failed",
      outcome: "shortlisted",
      nextActionLabel: "Find another job",
      summary: "This job is closed.",
      detail: "No longer accepting applications.",
      startedAt: hour(10),
      updatedAt: hour(10),
      completedAt: hour(10),
      blocker: {
        code: "application_closed",
        summary: "This job is closed.",
        detail: "No longer accepting applications.",
      },
    });
    const views = projectDiscoveryJobViews({
      jobs: [target, other],
      listingSignals: [],
      applicationAttempts: [attempt],
    });
    expect(views.map((view) => view.listingActivity.status)).toEqual([
      "closed",
      "active",
    ]);
  });

  test("returns unknown without an activity observation", () => {
    expect(activity({ job: job() })).toEqual({ status: "unknown" });
  });

  test("uses the newest saved active observation", () => {
    expect(
      activity({
        job: job({
          lastSeenAt: hour(9),
          lastVerifiedActiveAt: hour(10),
        }),
      }),
    ).toEqual({
      status: "active",
      observedAt: hour(10),
      evidence: "last_verified_active_at",
    });
  });

  test.each(["stale", "closed"] as const)(
    "retains explicit %s signal provenance and explanation",
    (kind) => {
      const target = job();
      expect(
        activity({ job: target, signals: [signal(target, kind)] }),
      ).toEqual({
        status: kind,
        observedAt: hour(11),
        signalId: `signal-${kind}`,
        provenance: "browser",
        explanation: `Explicit ${kind} evidence.`,
        detail: `${kind} detail`,
        confidence: 0.9,
      });
    },
  );

  test("ignores suspicious signals", () => {
    const target = job();
    expect(
      activity({ job: target, signals: [signal(target, "suspicious")] }),
    ).toEqual({ status: "unknown" });
  });

  test("newer observations reactivate old signals and ties use closed, stale, inactive, active precedence", () => {
    const reactivated = job({ lastSeenAt: hour(12) });
    expect(
      activity({
        job: reactivated,
        signals: [signal(reactivated, "closed", { detectedAt: hour(11) })],
      }),
    ).toMatchObject({ status: "active", observedAt: hour(12) });

    const target = job({ lastSeenAt: hour(10) });
    expect(
      activity({
        job: target,
        ledger: [ledger(target, { inactiveAt: hour(10) })],
        signals: [
          signal(target, "stale", { detectedAt: hour(10) }),
          signal(target, "closed", { detectedAt: hour(10) }),
        ],
      }),
    ).toMatchObject({ status: "closed", observedAt: hour(10) });

    expect(
      activity({
        job: target,
        ledger: [ledger(target, { inactiveAt: hour(10) })],
        signals: [signal(target, "stale", { detectedAt: hour(10) })],
      }),
    ).toMatchObject({ status: "stale" });
  });

  test("does not apply a ledger fact when strong identity aliases collide", () => {
    const first = job({ id: "first", sourceJobId: "shared-id" });
    const second = job({
      id: "second",
      sourceJobId: "other-id",
      canonicalUrl: "https://jobs.example.com/second",
    });

    expect(
      projectDiscoveryJobViews({
        jobs: [first, second],
        listingSignals: [],
      }).map((view) => view.listingActivity.status),
    ).toEqual(["unknown", "unknown"]);
  });
});

describe("a listing the model read as closed", () => {
  // The model reads the listing when it judges the job and says whether the
  // listing itself is closed, quoting it (ADR 0041); no phrase list decides.
  function judgedJob(listingClosed: boolean, evidence: string | null) {
    const base = job({
      id: "job-judged",
      description: "About the team. This position has been filled.",
      lastSeenAt: hour(11),
    });
    return {
      ...base,
      matchAssessment: {
        ...base.matchAssessment,
        judgment: {
          source: "batch" as const,
          judgedAt: hour(11),
          contextFingerprint: null,
          postingFingerprint: null,
          score: 5,
          recommendation: "skip" as const,
          role: "unknown" as const,
          roleExplanation: null,
          preferences: "unknown" as const,
          preferencesExplanation: null,
          locationReach: "unknown" as const,
          reasons: [],
          gaps: [],
          listingClosed,
          listingClosedEvidence: evidence,
        },
      },
    };
  }

  test("closes a listing the model read as closed, quoting it", () => {
    const closed = judgedJob(true, "This position has been filled.");
    const [view] = projectDiscoveryJobViews({
      jobs: [closed],
      listingSignals: [],
    });

    expect(view?.listingActivity.status).toBe("closed");
    expect(findClosedListingPhrase(closed)).toBe(
      "This position has been filled.",
    );
  });

  test("leaves a listing the model read as open active, whatever its words", () => {
    const open = judgedJob(false, null);
    const [view] = projectDiscoveryJobViews({
      jobs: [open],
      listingSignals: [],
    });

    expect(findClosedListingPhrase(open)).toBeNull();
    expect(view?.listingActivity.status).toBe("active");
  });

  test("leaves an unjudged listing active", () => {
    const open = job({
      id: "job-open",
      description: "We are hiring a backend engineer. Apply today.",
      lastSeenAt: hour(11),
    });

    const [view] = projectDiscoveryJobViews({
      jobs: [open],
      listingSignals: [],
    });

    expect(view?.listingActivity.status).toBe("active");
  });
});
