import { expect, it } from "vitest";

import { JobFinderSettingsSectionSchema } from "./job-finder-navigation";
import {
  JobFinderSettingsSchema,
  UpdateWorkspaceBehaviorInputSchema,
} from "./workspace";

it("drops retired search and browser choices when reading an older workspace", () => {
  const settings = JobFinderSettingsSchema.parse({
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    discoveryOnly: true,
    keepSessionAlive: false,
  });
  expect(settings).not.toHaveProperty("discoveryOnly");
  expect(settings).not.toHaveProperty("keepSessionAlive");
});

it("cannot change the retired settings through workspace updates", () => {
  expect(
    UpdateWorkspaceBehaviorInputSchema.parse({
      discoveryOnly: true,
      keepSessionAlive: false,
    }),
  ).toEqual({});
});

it("cannot navigate to the retired Browser & saved jobs section", () => {
  expect(
    JobFinderSettingsSectionSchema.safeParse("workspace-behavior").success,
  ).toBe(false);
});
