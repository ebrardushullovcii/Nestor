import { expect, test } from "vitest";
import { DiscoveryLedgerEntrySchema } from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-fixtures";
import { createListingActivityIdentityIndex } from "./listing-activity-identity-index";
import { createListingActivityChangeResolver } from "./listing-activity-changes";

test("a new ambiguous identity invalidates the old job's inactive view, including removed evidence", () => {
  const first = Object.freeze(createSeed().savedJobs[0]!);
  const duplicate = Object.freeze({ ...first, id: `${first.id}_duplicate` });
  const beforeJobs = Object.freeze([first]);
  const jobs = Object.freeze([first, duplicate]);
  const ledger = Object.freeze([
    Object.freeze(
      DiscoveryLedgerEntrySchema.parse({
        ...first,
        id: "inactive_evidence",
        targetId: "synthetic",
        latestStatus: "inactive",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        lastSeenAt: "2026-10-01T00:00:00.000Z",
        inactiveAt: "2026-10-22T00:00:00.000Z",
      }),
    ),
  ]);
  const resolve = createListingActivityChangeResolver(
    createListingActivityIdentityIndex(),
  );
  const input = {
    beforeJobs,
    jobs,
    beforeById: new Map([[first.id, first]]),
    changed: [duplicate],
    removed: [],
    beforeLedger: ledger,
    ledger,
  };
  expect(resolve(input).has(first.id)).toBe(true);
  expect(resolve({ ...input, ledger: Object.freeze([]) }).has(first.id)).toBe(
    true,
  );
});
