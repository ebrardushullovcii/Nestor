import type {
  JobDiscoveryTarget,
  SavedJobDiscoveryProvenance,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { getDiscoverySourceLabels } from "./discovery-source-attribution";

const provenance = {
  targetId: "target_primary",
  adapterKind: "auto",
  resolvedAdapterKind: "target_site",
  startingUrl: "https://www.jobs.example.test/search?token=private#results",
  discoveredAt: "2026-08-23T10:00:00.000Z",
  collectionMethod: "listing_route",
  providerKey: null,
  providerBoardToken: null,
  titleTriageOutcome: "pass",
} satisfies SavedJobDiscoveryProvenance;

const configuredTarget = {
  id: "target_primary",
  label: "My very long configured source name",
  startingUrl: "https://configured.example.test/jobs",
  enabled: true,
  adapterKind: "auto",
  customInstructions: null,
  instructionStatus: "missing",
  validatedInstructionId: null,
  draftInstructionId: null,
  lastDebugRunId: null,
  lastVerifiedAt: null,
  staleReason: null,
} satisfies JobDiscoveryTarget;

describe("getDiscoverySourceLabels", () => {
  it("prefers the currently configured target label", () => {
    expect(getDiscoverySourceLabels([provenance], [configuredTarget])).toEqual([
      "My very long configured source name",
    ]);
  });

  it("uses only a sanitized hostname after a target is removed", () => {
    expect(getDiscoverySourceLabels([provenance], [])).toEqual([
      "jobs.example.test",
    ]);
  });

  it("falls back truthfully to adapter and collection method for malformed URLs", () => {
    expect(
      getDiscoverySourceLabels(
        [{ ...provenance, startingUrl: "not a valid URL" }],
        [],
      ),
    ).toEqual(["Target site · Listing route"]);
  });

  it("deduplicates and sorts multiple source labels deterministically", () => {
    expect(
      getDiscoverySourceLabels(
        [
          provenance,
          { ...provenance, targetId: "target_duplicate" },
          {
            ...provenance,
            targetId: "target_alpha",
            startingUrl: "https://alpha.example.test/jobs?q=secret",
          },
        ],
        [],
      ),
    ).toEqual(["alpha.example.test", "jobs.example.test"]);
  });

  it("reuses cached target labels per array identity and rebuilds on a new identity", () => {
    const renamedProvenance = { ...provenance, targetId: "target_renamed" };
    const trackedTarget = {
      ...configuredTarget,
      id: "target_renamed",
      label: "Original configured label",
    } satisfies JobDiscoveryTarget;
    const targets = [trackedTarget];

    expect(getDiscoverySourceLabels([renamedProvenance], targets)).toEqual([
      "Original configured label",
    ]);

    trackedTarget.label = "Renamed configured label";

    expect(getDiscoverySourceLabels([renamedProvenance], targets)).toEqual([
      "Original configured label",
    ]);
    expect(
      getDiscoverySourceLabels([renamedProvenance], [trackedTarget]),
    ).toEqual(["Renamed configured label"]);
  });
});

it("keeps the saved source label and URL after a source is deleted", () => {
  const sighting = { ...provenance, sourceLabel: "Lantern Services careers" };
  expect(getDiscoverySourceLabels([sighting], [])).toEqual([
    "Lantern Services careers",
  ]);
  expect(sighting.startingUrl).toBe(provenance.startingUrl);
});
