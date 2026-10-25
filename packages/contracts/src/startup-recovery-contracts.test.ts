import { describe, expect, it } from "vitest";

import {
  JobFinderStartupDatabaseRecoveryFactSchema,
  JobFinderStartupResetRecoveryFactSchema,
} from "./index";

function restoredFact(): Record<string, unknown> {
  return {
    status: "restored",
    incidentId: "incident-1",
    restoredFrom: "backup",
    lossWindow: {
      detectedAtIso: "2026-08-20T10:00:00.000Z",
      quarantinedDatabaseModifiedAtIso: null,
      restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
    },
    quarantinedArtifactBasenames: ["job-finder-workspace.sqlite.quarantine-a"],
    restoredAtIso: "2026-08-20T10:05:00.000Z",
    dismissedAtIso: null,
  };
}

function blockedFact(): Record<string, unknown> {
  return {
    status: "blocked",
    incidentId: "incident-2",
    outcome: "salvage-required",
    candidates: [
      { kind: "backup", status: "invalid", failedStage: "integrity-check" },
      { kind: "backup-prev", status: "missing", failedStage: null },
    ],
    quarantineBasenames: [],
  };
}

describe("startup database recovery fact contract", () => {
  it("parses idle, restored, and blocked facts without changing known fields", () => {
    expect(JobFinderStartupDatabaseRecoveryFactSchema.parse({ status: "idle" }))
      .toEqual({ status: "idle" });
    expect(JobFinderStartupDatabaseRecoveryFactSchema.parse(restoredFact()))
      .toEqual(restoredFact());
    expect(JobFinderStartupDatabaseRecoveryFactSchema.parse(blockedFact()))
      .toEqual(blockedFact());
  });

  it("rejects non-objects and unknown statuses", () => {
    const malformed = [
      null,
      "restored",
      42,
      { status: "surprise" },
      {},
    ];

    for (const fact of malformed) {
      expect(
        JobFinderStartupDatabaseRecoveryFactSchema.safeParse(fact).success,
        JSON.stringify(fact),
      ).toBe(false);
    }
  });

  it("rejects malformed restored facts", () => {
    const malformed = [
      { ...restoredFact(), incidentId: "" },
      { ...restoredFact(), incidentId: 7 },
      { ...restoredFact(), restoredFrom: "elsewhere" },
      { ...restoredFact(), restoredFrom: undefined },
      {
        ...restoredFact(),
        lossWindow: {
          detectedAtIso: "not-a-date",
          quarantinedDatabaseModifiedAtIso: null,
          restoredSnapshotModifiedAtIso: null,
        },
      },
      {
        ...restoredFact(),
        lossWindow: {
          detectedAtIso: "2026-08-20T10:00:00.000Z",
          quarantinedDatabaseModifiedAtIso: 1234567890123,
          restoredSnapshotModifiedAtIso: null,
        },
      },
      { ...restoredFact(), quarantinedArtifactBasenames: [42] },
      { ...restoredFact(), quarantinedArtifactBasenames: ["ok", ""] },
      { ...restoredFact(), quarantinedArtifactBasenames: "backup" },
      { ...restoredFact(), dismissedAtIso: "yesterday" },
      { ...restoredFact(), restoredAtIso: undefined },
    ];

    for (const fact of malformed) {
      expect(
        JobFinderStartupDatabaseRecoveryFactSchema.safeParse(fact).success,
        JSON.stringify(fact),
      ).toBe(false);
    }
  });

  it("rejects malformed blocked facts", () => {
    const malformed = [
      { ...blockedFact(), outcome: "mystery-outcome" },
      { ...blockedFact(), incidentId: "" },
      {
        ...blockedFact(),
        candidates: [{ kind: "backup", status: "invalid", failedStage: null }],
      },
      {
        ...blockedFact(),
        candidates: [
          { kind: "backup", status: "invalid", failedStage: "defragment" },
        ],
      },
      {
        ...blockedFact(),
        candidates: [{ kind: "backup", status: "valid", failedStage: "open" }],
      },
      { ...blockedFact(), candidates: "backup" },
      { ...blockedFact(), quarantineBasenames: [null] },
    ];

    for (const fact of malformed) {
      expect(
        JobFinderStartupDatabaseRecoveryFactSchema.safeParse(fact).success,
        JSON.stringify(fact),
      ).toBe(false);
    }
  });

  it("keeps legacy offset-style timestamps parseable instead of requiring strict UTC", () => {
    expect(
      JobFinderStartupDatabaseRecoveryFactSchema.parse({
        ...restoredFact(),
        restoredAtIso: "2026-08-20T10:05:00+02:00",
      }).status,
    ).toBe("restored");
    expect(
      JobFinderStartupDatabaseRecoveryFactSchema.safeParse({
        ...restoredFact(),
        restoredAtIso:
          "2026-08-20T10:05:00.000000000000000000000000000000000000001Z",
      }).success,
    ).toBe(false);
  });

  it("normalizes a legacy candidate that omitted failedStage for a valid snapshot", () => {
    const parsed = JobFinderStartupDatabaseRecoveryFactSchema.parse({
      ...blockedFact(),
      candidates: [{ kind: "backup", status: "valid" }],
    });

    expect(parsed).toEqual({
      ...blockedFact(),
      candidates: [{ kind: "backup", status: "valid", failedStage: null }],
    });
  });

  it("strips unexpected keys so future fields cannot silently widen the disclosure", () => {
    expect(
      JobFinderStartupDatabaseRecoveryFactSchema.parse({
        status: "idle",
        rawError: "SQLITE_CORRUPT: /Users/someone/secret.sqlite",
      }),
    ).toEqual({ status: "idle" });

    const parsed = JobFinderStartupDatabaseRecoveryFactSchema.parse({
      ...restoredFact(),
      sourcePath: "/Users/someone/Library/Application Support/workspace.sqlite",
    });
    expect(Object.keys(parsed).sort()).toEqual(
      Object.keys(restoredFact()).sort(),
    );
  });
});

describe("startup reset recovery fact contract", () => {
  it("parses idle, completed, and degraded facts", () => {
    expect(JobFinderStartupResetRecoveryFactSchema.parse({ status: "idle" }))
      .toEqual({ status: "idle" });
    expect(
      JobFinderStartupResetRecoveryFactSchema.parse({
        status: "completed",
        token: "reset-token-1",
        completedAt: "2026-08-20T10:00:00.000Z",
      }),
    ).toEqual({
      status: "completed",
      token: "reset-token-1",
      completedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(
      JobFinderStartupResetRecoveryFactSchema.parse({
        status: "degraded",
        reason: "marker_quarantined_malformed",
        quarantinedFileName: "job-finder-reset-intent.invalid-a.json",
      }),
    ).toEqual({
      status: "degraded",
      reason: "marker_quarantined_malformed",
      quarantinedFileName: "job-finder-reset-intent.invalid-a.json",
    });
  });

  it("allows a null quarantined file name for degraded facts", () => {
    expect(
      JobFinderStartupResetRecoveryFactSchema.safeParse({
        status: "degraded",
        reason: "reset_recovery_failed",
        quarantinedFileName: null,
      }).success,
    ).toBe(true);
  });

  it("rejects malformed reset recovery facts", () => {
    const malformed = [
      null,
      { status: "surprise" },
      { status: "completed", token: "", completedAt: "2026-08-20T10:00:00Z" },
      {
        status: "completed",
        token: "reset-token-1",
        completedAt: "second tuesday last month",
      },
      { status: "completed", token: "reset-token-1" },
      { status: "degraded", reason: "shrug", quarantinedFileName: null },
      {
        status: "degraded",
        reason: "marker_quarantined_oversized",
        quarantinedFileName: 42,
      },
    ];

    for (const fact of malformed) {
      expect(
        JobFinderStartupResetRecoveryFactSchema.safeParse(fact).success,
        JSON.stringify(fact),
      ).toBe(false);
    }
  });
});
