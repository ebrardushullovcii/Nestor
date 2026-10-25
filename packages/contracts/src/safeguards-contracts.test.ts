import { describe, expect, it } from "vitest";

import {
  JobFinderIntelligenceSafeguardsSchema,
  SafeguardDismissalSchema,
  safeguardEntryKindValues,
} from "./job-finder-intelligence";

const now = "2026-08-15T10:00:00.000Z";


describe("safeguard dismissal records", () => {
  it("records a reversible dismissal with an exact reference", () => {
    const dismissal = SafeguardDismissalSchema.parse({
      id: "dismissal_1",
      kind: "listing_signal",
      referenceId: "signal_1",
      reason: "rechecked",
      note: "Re-verified the listing.",
      dismissedAt: now,
    });

    expect(dismissal.kind).toBe("listing_signal");
    expect(dismissal.reason).toBe("rechecked");
    expect(dismissal.note).toBe("Re-verified the listing.");
  });

  it("rejects unknown kinds, reasons, and authority-carrying keys", () => {
    expect(
      SafeguardDismissalSchema.safeParse({
        id: "dismissal_1",
        kind: "final_submit",
        referenceId: "signal_1",
        reason: "rechecked",
        dismissedAt: now,
      }).success,
    ).toBe(false);

    expect(
      SafeguardDismissalSchema.safeParse({
        id: "dismissal_1",
        kind: "listing_signal",
        referenceId: "signal_1",
        reason: "because_i_say_so",
        dismissedAt: now,
      }).success,
    ).toBe(false);

    expect(
      SafeguardDismissalSchema.safeParse({
        id: "dismissal_1",
        kind: "listing_signal",
        referenceId: "signal_1",
        reason: "rechecked",
        dismissedAt: now,
        submitAuthorized: true,
      }).success,
    ).toBe(false);
  });

  it("defaults the dismissal collection to empty inside safeguards state", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({});
    expect(safeguards.safeguardDismissals).toEqual([]);
    expect(safeguardEntryKindValues).toContain("company_cap_limit");
  });
});

