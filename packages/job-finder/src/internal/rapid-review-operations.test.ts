import { describe, expect, test } from "vitest";

import {
  RapidReviewDecisionLogSchema,
  RapidReviewDecisionSchema,
  type RapidReviewDecision,
  type RapidReviewDecisionLog,
  type RapidReviewUndo,
} from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  appendRapidReviewDecision,
  appendRapidReviewDecisions,
  deriveCurrentRapidReviewDecision,
  deriveNextUndecidedJob,
  undoLatestActiveRapidReviewDecision,
} from "./rapid-review-operations";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";
const latest = "2026-08-15T12:00:00.000Z";

function decisionEntry(input: {
  id: string;
  jobId: string;
  kind: "shortlist" | "reject" | "inspect";
  createdAt: string;
  revision?: number;
  undo?: RapidReviewUndo | null;
}): RapidReviewDecision {
  return RapidReviewDecisionSchema.parse({
    id: input.id,
    campaignId: "campaign_1",
    jobId: input.jobId,
    kind: input.kind,
    revision: input.revision ?? 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    undo: input.undo ?? null,
  });
}

function buildLog(entries: RapidReviewDecision[]): RapidReviewDecisionLog {
  return RapidReviewDecisionLogSchema.parse({
    campaignId: "campaign_1",
    entries,
  });
}

describe("appendRapidReviewDecision", () => {
  test("appends a caller-provided decision id and returns a parsed log", () => {
    const result = appendRapidReviewDecision({
      log: buildLog([]),
      decisionId: "decision_shortlist_42",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_42",
        kind: "shortlist",
        createdAt: now,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.log.entries).toHaveLength(1);
    expect(result.entry.id).toBe("decision_shortlist_42");
    expect(result.entry.jobId).toBe("job_42");
    expect(result.entry.kind).toBe("shortlist");
    expect(result.entry.revision).toBe(0);
    expect(result.entry.reason).toBeNull();
    expect(result.entry.undo).toBeNull();
    expect(result.entry.createdAt).toBe(now);
    expect(result.entry.updatedAt).toBe(now);
    expect(RapidReviewDecisionLogSchema.safeParse(result.log).success).toBe(
      true,
    );
  });

  test("preserves append order across successive appends", () => {
    const first = appendRapidReviewDecision({
      log: buildLog([]),
      decisionId: "decision_1",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = appendRapidReviewDecision({
      log: first.log,
      decisionId: "decision_2",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_1",
        kind: "inspect",
        revision: 1,
        createdAt: later,
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.log.entries.map((entry) => entry.id)).toEqual([
      "decision_1",
      "decision_2",
    ]);
    expect(second.entry.revision).toBe(1);
  });

  test("rejects a duplicate decision id", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    const result = appendRapidReviewDecision({
      log,
      decisionId: "decision_1",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_2",
        kind: "reject",
        createdAt: later,
      },
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "duplicate_decision_id",
        message: 'Decision id "decision_1" already exists in the log.',
      },
    });
  });

  test("rejects a decision for a different campaign", () => {
    const result = appendRapidReviewDecision({
      log: buildLog([]),
      decisionId: "decision_1",
      decision: {
        campaignId: "campaign_other",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("campaign_mismatch");
  });

  test("rejects an append that regresses createdAt order", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: later,
      }),
    ]);

    const result = appendRapidReviewDecision({
      log,
      decisionId: "decision_2",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_1",
        kind: "reject",
        createdAt: now,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("created_at_regression");
  });

  test("rejects a blank caller-provided decision id", () => {
    const result = appendRapidReviewDecision({
      log: buildLog([]),
      decisionId: "   ",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_decision_id");
  });

  test("rejects an invalid decision input", () => {
    const result = appendRapidReviewDecision({
      log: buildLog([]),
      decisionId: "decision_1",
      decision: {
        campaignId: "campaign_1",
        jobId: "job_1",
        kind: "bogus",
        createdAt: now,
      } as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_decision_input");
  });
});

describe("appendRapidReviewDecisions", () => {
  test("appends a validated batch atomically in order", () => {
    const result = appendRapidReviewDecisions({
      log: buildLog([]),
      decisions: [
        {
          decisionId: "decision_1",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_1",
            kind: "shortlist",
            createdAt: now,
          },
        },
        {
          decisionId: "decision_2",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_2",
            kind: "inspect",
            createdAt: later,
          },
        },
        {
          decisionId: "decision_3",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_3",
            kind: "reject",
            createdAt: latest,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "decision_1",
      "decision_2",
      "decision_3",
    ]);
    expect(result.log.entries).toHaveLength(3);
    expect(RapidReviewDecisionLogSchema.safeParse(result.log).success).toBe(
      true,
    );
  });

  test("rejects a batch with a duplicate id without applying anything", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_existing",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    const result = appendRapidReviewDecisions({
      log,
      decisions: [
        {
          decisionId: "decision_new",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_2",
            kind: "inspect",
            createdAt: later,
          },
        },
        {
          decisionId: "decision_existing",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_3",
            kind: "reject",
            createdAt: latest,
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "duplicate_decision_id",
        message:
          'Decision id "decision_existing" already exists in the log or the batch.',
      },
    });
  });

  test("rejects a batch with a campaign mismatch before applying entries", () => {
    const result = appendRapidReviewDecisions({
      log: buildLog([]),
      decisions: [
        {
          decisionId: "decision_1",
          decision: {
            campaignId: "campaign_other",
            jobId: "job_1",
            kind: "shortlist",
            createdAt: now,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("campaign_mismatch");
  });

  test("rejects a batch with an invalid decision input", () => {
    const result = appendRapidReviewDecisions({
      log: buildLog([]),
      decisions: [
        {
          decisionId: "decision_1",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_1",
            kind: "reject",
            createdAt: now,
          },
        },
        {
          decisionId: "decision_2",
          decision: {
            campaignId: "campaign_1",
            jobId: "job_2",
            kind: "bogus",
            createdAt: later,
          } as never,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_decision_input");
  });

  test("accepts an empty batch unchanged", () => {
    const log = buildLog([]);
    const result = appendRapidReviewDecisions({ log, decisions: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([]);
    expect(result.log.entries).toEqual([]);
  });
});

describe("undoLatestActiveRapidReviewDecision", () => {
  test("undoes the latest active decision with matching revision", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_shortlist",
        jobId: "job_42",
        kind: "shortlist",
        createdAt: now,
      }),
      decisionEntry({
        id: "decision_inspect",
        jobId: "job_42",
        kind: "inspect",
        createdAt: later,
        revision: 1,
      }),
    ]);

    const result = undoLatestActiveRapidReviewDecision({
      log,
      jobId: "job_42",
      expectedRevision: 1,
      undo: {
        undoneAt: latest,
        reason: "Duplicate job posting",
        restoringDecisionId: "decision_shortlist",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entry.id).toBe("decision_inspect");
    expect(result.entry.revision).toBe(1);
    expect(result.entry.undo).toEqual({
      undoneAt: latest,
      reason: "Duplicate job posting",
      restoringDecisionId: "decision_shortlist",
    });
    expect(result.entry.updatedAt).toBe(latest);
    expect(result.log.entries[0]!.undo).toBeNull();
    expect(RapidReviewDecisionLogSchema.safeParse(result.log).success).toBe(
      true,
    );
  });

  test("skips already-undone entries and undoes the prior active decision", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
      decisionEntry({
        id: "decision_2",
        jobId: "job_1",
        kind: "inspect",
        createdAt: later,
        undo: {
          undoneAt: latest,
          reason: "Changed my mind",
          restoringDecisionId: null,
        },
      }),
    ]);

    const result = undoLatestActiveRapidReviewDecision({
      log,
      jobId: "job_1",
      expectedRevision: 0,
      undo: {
        undoneAt: latest,
        reason: "Re-reviewed the posting",
        restoringDecisionId: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.entry.id).toBe("decision_1");
    expect(result.log.entries[1]!.undo?.reason).toBe("Changed my mind");
  });

  test("fails with no_active_decision when the job has no active decision", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
        undo: {
          undoneAt: later,
          reason: "Undone",
          restoringDecisionId: null,
        },
      }),
    ]);

    const result = undoLatestActiveRapidReviewDecision({
      log,
      jobId: "job_1",
      expectedRevision: 0,
      undo: { undoneAt: latest, reason: null, restoringDecisionId: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("no_active_decision");
  });

  test("fails with revision_mismatch when the expected revision differs", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
        revision: 3,
      }),
    ]);

    const result = undoLatestActiveRapidReviewDecision({
      log,
      jobId: "job_1",
      expectedRevision: 7,
      undo: { undoneAt: later, reason: null, restoringDecisionId: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: "revision_mismatch",
      message:
        'Expected revision 7 but latest active decision for job "job_1" has revision 3.',
      expectedRevision: 7,
      currentRevision: 3,
    });
  });

  test("rejects invalid undo metadata", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    const result = undoLatestActiveRapidReviewDecision({
      log,
      jobId: "job_1",
      expectedRevision: 0,
      undo: { undoneAt: later, reason: "   ", restoringDecisionId: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_undo_metadata");
  });
});

describe("deriveCurrentRapidReviewDecision", () => {
  test("returns the latest active decision for a job", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
      decisionEntry({
        id: "decision_2",
        jobId: "job_1",
        kind: "inspect",
        createdAt: later,
        revision: 1,
      }),
      decisionEntry({
        id: "decision_3",
        jobId: "job_2",
        kind: "reject",
        createdAt: latest,
      }),
    ]);

    const current = deriveCurrentRapidReviewDecision({ log, jobId: "job_1" });

    expect(current?.id).toBe("decision_2");
    expect(current?.kind).toBe("inspect");
  });

  test("returns null for a job with no entries", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    expect(
      deriveCurrentRapidReviewDecision({ log, jobId: "job_missing" }),
    ).toBeNull();
  });

  test("ignores undone entries and falls back to the prior active decision", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
      }),
      decisionEntry({
        id: "decision_2",
        jobId: "job_1",
        kind: "inspect",
        createdAt: later,
        undo: {
          undoneAt: latest,
          reason: "Reverted",
          restoringDecisionId: "decision_1",
        },
      }),
    ]);

    const current = deriveCurrentRapidReviewDecision({ log, jobId: "job_1" });

    expect(current?.id).toBe("decision_1");
  });

  test("returns null when the only decision for a job is undone", () => {
    const log = buildLog([
      decisionEntry({
        id: "decision_1",
        jobId: "job_1",
        kind: "shortlist",
        createdAt: now,
        undo: {
          undoneAt: later,
          reason: "Reverted",
          restoringDecisionId: null,
        },
      }),
    ]);

    expect(
      deriveCurrentRapidReviewDecision({ log, jobId: "job_1" }),
    ).toBeNull();
  });
});

describe("deriveNextUndecidedJob", () => {
  test("returns the first undecided job in the supplied order", () => {
    const [jobReady, jobGenerating] = createSeed().savedJobs;
    const log = buildLog([
      decisionEntry({
        id: "decision_generating",
        jobId: jobGenerating!.id,
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    const next = deriveNextUndecidedJob({
      log,
      jobs: [jobReady!, jobGenerating!],
    });

    expect(next?.id).toBe(jobReady!.id);
  });

  test("respects the caller-supplied order", () => {
    const [jobReady, jobGenerating] = createSeed().savedJobs;
    const log = buildLog([
      decisionEntry({
        id: "decision_ready",
        jobId: jobReady!.id,
        kind: "shortlist",
        createdAt: now,
      }),
    ]);

    const next = deriveNextUndecidedJob({
      log,
      jobs: [jobGenerating!, jobReady!],
    });

    expect(next?.id).toBe(jobGenerating!.id);
  });

  test("returns null when every supplied job is decided", () => {
    const [jobReady, jobGenerating] = createSeed().savedJobs;
    const log = buildLog([
      decisionEntry({
        id: "decision_ready",
        jobId: jobReady!.id,
        kind: "shortlist",
        createdAt: now,
      }),
      decisionEntry({
        id: "decision_generating",
        jobId: jobGenerating!.id,
        kind: "reject",
        createdAt: later,
      }),
    ]);

    expect(
      deriveNextUndecidedJob({ log, jobs: [jobReady!, jobGenerating!] }),
    ).toBeNull();
  });

  test("treats a job whose latest decision was undone as undecided", () => {
    const [jobReady, jobGenerating] = createSeed().savedJobs;
    const log = buildLog([
      decisionEntry({
        id: "decision_ready",
        jobId: jobReady!.id,
        kind: "shortlist",
        createdAt: now,
        undo: {
          undoneAt: later,
          reason: "Reverted",
          restoringDecisionId: null,
        },
      }),
    ]);

    const next = deriveNextUndecidedJob({
      log,
      jobs: [jobReady!, jobGenerating!],
    });

    expect(next?.id).toBe(jobReady!.id);
  });
});
