import { describe, expect, it } from "vitest";

import {
  collapsesSideMenuWithAssistant,
  JobFinderSettingsSchema,
  UpdateWorkspaceBehaviorInputSchema,
} from "./workspace";

const storedBeforeTheSetting = {
  resumeFormat: "pdf",
  resumeTemplateId: "classic_ats",
  fontPreset: "inter_requisite",
  appearanceTheme: "system",
  humanReviewRequired: true,
  allowAutoSubmitOverride: false,
};

describe("collapse the side menu while the assistant is open", () => {
  it("reads settings stored before the field existed as on", () => {
    const settings = JobFinderSettingsSchema.parse(storedBeforeTheSetting);
    expect(settings.collapseSideMenuWithAssistant).toBeUndefined();
    expect(collapsesSideMenuWithAssistant(settings)).toBe(true);
  });

  it("keeps the person's choice to turn it off", () => {
    const settings = JobFinderSettingsSchema.parse({
      ...storedBeforeTheSetting,
      collapseSideMenuWithAssistant: false,
    });
    expect(collapsesSideMenuWithAssistant(settings)).toBe(false);
  });

  it("can be changed through the workspace behavior update", () => {
    expect(
      UpdateWorkspaceBehaviorInputSchema.parse({
        collapseSideMenuWithAssistant: false,
      }),
    ).toEqual({ collapseSideMenuWithAssistant: false });
  });
});
