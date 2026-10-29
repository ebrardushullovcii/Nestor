import { describe, expect, it } from "vitest";
import {
  BrowserAgentPermissionsSchema,
  browserAgentPermissionsOf,
} from "./browser-permissions";
import { JobFinderSettingsSchema } from "./workspace";

const off = { solveCaptchas: false, signIn: false, createAccounts: false };

describe("browser agent permissions", () => {
  it("read as all off when nothing was saved", () => {
    expect(browserAgentPermissionsOf(undefined)).toEqual(off);
    expect(browserAgentPermissionsOf({})).toEqual(off);
    // A workspace saved before the permissions existed.
    const older = JobFinderSettingsSchema.parse({
      allowAutoSubmitOverride: false,
      fontPreset: "inter_requisite",
      humanReviewRequired: true,
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      aiBehavior: { jobSearch: { remoteCountsAsAnyLocation: false } },
    });
    expect(older.aiBehavior?.browserPermissions).toEqual(off);
    expect(browserAgentPermissionsOf(older)).toEqual(off);
  });

  it("keep each permission separate", () => {
    expect(
      browserAgentPermissionsOf({
        aiBehavior: { browserPermissions: { createAccounts: true } },
      }),
    ).toEqual({ ...off, createAccounts: true });
  });

  it("reject a permission the app does not know", () => {
    expect(
      BrowserAgentPermissionsSchema.safeParse({ submitApplications: true })
        .success,
    ).toBe(false);
  });
});
