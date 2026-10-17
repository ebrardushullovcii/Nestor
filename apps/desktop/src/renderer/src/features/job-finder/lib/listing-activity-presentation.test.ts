import { describe, expect, it } from "vitest";
import type { ListingActivity } from "@nestor/contracts";
import { presentListingActivity } from "./listing-activity-presentation";

describe("presentListingActivity", () => {
  it.each([
    {
      activity: { status: "unknown" } satisfies ListingActivity,
      expected: "Listing availability is unknown.",
    },
    {
      activity: {
        status: "active",
        observedAt: "2026-08-23T10:00:00.000Z",
        evidence: "last_verified_active_at",
      } satisfies ListingActivity,
      expected: "Last seen on source 23 Aug 2026.",
    },
    {
      activity: {
        status: "inactive",
        observedAt: "2026-08-22T10:00:00.000Z",
        ledgerEntryId: "ledger_1",
        provenance: "discovery_ledger",
        explanation: "The source refresh completed without this job.",
      } satisfies ListingActivity,
      expected:
        "Not found in latest full source refresh on 22 Aug 2026. This does not prove the listing is closed. The source refresh completed without this job.",
    },
    {
      activity: {
        status: "stale",
        observedAt: "2026-08-21T10:00:00.000Z",
        signalId: "signal_stale",
        provenance: "browser",
        explanation: "The apply control was missing.",
        detail: "An expiry message was visible.",
        confidence: 0.8,
      } satisfies ListingActivity,
      expected:
        "This listing may no longer be open — opening the page last saw it on 21 Aug 2026. The apply control was missing. An expiry message was visible.",
    },
    {
      activity: {
        status: "closed",
        observedAt: "2026-08-20T10:00:00.000Z",
        signalId: "signal_closed",
        provenance: "provider",
        explanation: "The provider marked the role closed.",
        detail: null,
        confidence: 1,
      } satisfies ListingActivity,
      expected:
        "Reported closed by the job site's own listing feed on 20 Aug 2026. The provider marked the role closed.",
    },
  ])(
    "presents $activity.status with exact observed evidence",
    ({ activity, expected }) => {
      expect(presentListingActivity(activity).description).toBe(expected);
    },
  );
});
