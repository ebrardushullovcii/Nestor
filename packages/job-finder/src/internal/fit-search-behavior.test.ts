import { expect, test } from "vitest";
import { buildFitVerdictContext } from "@nestor/ai-providers";
import { AiBehaviorPreferenceSchema } from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-fixtures";
import { withSettingsFitBehavior } from "./fit-search-behavior";
import { buildLegacyVerdictFingerprintMap } from "./legacy-fit-fingerprints";
import {
  createFitVerdictFingerprint,
  createMatchAssessmentContextFingerprint,
} from "./match-assessment-session";

test("Settings remote policy reaches the legacy model context and both cache fingerprints", () => {
  const seed = createSeed();
  const on = withSettingsFitBehavior(seed.searchPreferences, seed.settings);
  const off = withSettingsFitBehavior(seed.searchPreferences, {
    aiBehavior: {
      ...AiBehaviorPreferenceSchema.parse(seed.settings.aiBehavior ?? {}),
      jobSearch: {
        selectivity: "best_matches",
        remoteCountsAsAnyLocation: false,
      },
    },
  });
  expect(JSON.stringify(buildFitVerdictContext(seed.profile, on))).toContain(
    '"Remote work can be outside preferred places":true',
  );
  expect(JSON.stringify(buildFitVerdictContext(seed.profile, off))).toContain(
    '"Remote work can be outside preferred places":false',
  );
  expect(createFitVerdictFingerprint(seed.profile, on)).not.toBe(
    createFitVerdictFingerprint(seed.profile, off),
  );
  expect(createMatchAssessmentContextFingerprint(seed.profile, on)).not.toBe(
    createMatchAssessmentContextFingerprint(seed.profile, off),
  );
  expect(
    seed.searchPreferences.discovery.remoteCountsAsAnyLocation,
  ).toBeUndefined();
});

test("legacy rebinding uses Settings and cannot bind an on-policy verdict to the off policy", () => {
  const seed = createSeed();
  const behavior = AiBehaviorPreferenceSchema.parse(
    seed.settings.aiBehavior ?? {},
  );
  const settings = {
    aiBehavior: {
      ...behavior,
      jobSearch: {
        ...behavior.jobSearch,
        remoteCountsAsAnyLocation: false,
      },
    },
  };
  const map = buildLegacyVerdictFingerprintMap({
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    settings,
    campaignState: null,
  });
  const on = withSettingsFitBehavior(seed.searchPreferences, seed.settings);
  const off = withSettingsFitBehavior(seed.searchPreferences, settings);
  expect(
    map.has(createMatchAssessmentContextFingerprint(seed.profile, off)),
  ).toBe(true);
  expect(
    map.has(createMatchAssessmentContextFingerprint(seed.profile, on)),
  ).toBe(false);
});

test("explicit search selectivity and the Settings default reach hard-criteria collection", () => {
  const seed = createSeed();
  expect(
    withSettingsFitBehavior(
      { ...seed.searchPreferences, searchSelectivity: "best_matches" },
      seed.settings,
    ).discovery.collectOnlyHardCriteriaMatches,
  ).toBe(true);
  expect(
    withSettingsFitBehavior(
      { ...seed.searchPreferences, searchSelectivity: "wide_net" },
      seed.settings,
    ).discovery.collectOnlyHardCriteriaMatches,
  ).toBe(false);
  expect(
    withSettingsFitBehavior(
      { ...seed.searchPreferences, searchSelectivity: undefined },
      {
        aiBehavior: {
          ...AiBehaviorPreferenceSchema.parse(seed.settings.aiBehavior ?? {}),
          jobSearch: {
            selectivity: "wide_net",
            remoteCountsAsAnyLocation: true,
          },
        },
      },
    ).discovery.collectOnlyHardCriteriaMatches,
  ).toBe(false);
});
