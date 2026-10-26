import { describe, expect, it } from "vitest";

import {
  JobFinderStartupResetRecoveryFactSchema,
} from "./index";

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
