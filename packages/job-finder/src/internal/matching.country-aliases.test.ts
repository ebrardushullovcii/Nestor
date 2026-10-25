import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { createMatchAssessment } from "./matching";
import { canonicalizeLocationAliases } from "./location-normalization";
import {
  createMatchAssessmentSession,
  MATCH_ASSESSMENT_SCORER_VERSION,
} from "./match-assessment-session";
import { applyDiscoveryTitleTriage } from "./workspace-source-intelligence";

describe("US country aliases in saved search places", () => {
  // Whether a place fits is the model's verdict (ADR 0041); what stays here is
  // the spelling of a place used to tell two sightings of one job apart.
  test("country normalization does not merge foreign places or distinct cities", () => {
    expect(canonicalizeLocationAliases("Austria")).toBe("Austria");
    expect(canonicalizeLocationAliases("Austin, TX")).toBe("Austin, Texas");
  });

  test("strict nontechnical discovery keeps a US support job against United States", () => {
    const seed = createSeed();
    const preferences = {
      ...seed.searchPreferences,
      targetRoles: ["Customer Support Specialist"],
      locations: ["United States"],
      workModes: [],
      companyWhitelist: [],
      companyBlacklist: [],
      excludedLocations: [],
      discovery: {
        ...seed.searchPreferences.discovery,
        collectOnlyHardCriteriaMatches: true,
        remoteCountsAsAnyLocation: true,
      },
    };
    const posting = {
      ...seed.savedJobs[0]!,
      title: "Customer Support Specialist",
      location: "USA",
      workMode: ["remote" as const],
      description:
        "Provide chat support and resolve customer account questions.",
    };
    expect(
      applyDiscoveryTitleTriage({
        posting,
        profile: seed.profile,
        searchPreferences: preferences,
      }).outcome,
    ).toBe("pass");
    const calculate = vi.fn(createMatchAssessment);
    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: preferences,
      calculate,
    });
    const current = session.assess(posting);
    const stale = {
      ...current,
      scorerVersion: 11,
      contextFingerprint: current.contextFingerprint!.replace(
        "logic15",
        "logic10",
      ),
      postingFingerprint: current.postingFingerprint!.replace(
        "logic15",
        "logic10",
      ),
      score: 40,
    };
    const resumed = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: preferences,
      calculate,
    });
    const refreshed = resumed.assessPersisted(posting, stale);
    expect(refreshed).not.toBe(stale);
    expect(refreshed.scorerVersion).toBe(MATCH_ASSESSMENT_SCORER_VERSION);
    expect(refreshed.dimensions.preferenceAlignment.state).not.toBe("conflict");
    expect(calculate).toHaveBeenCalledTimes(2);
  });
});
