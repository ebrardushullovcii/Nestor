import { CandidateProfileSchema } from "./profile";
import { intendedAccountEmail } from "./profile-contacts";
import { describe, expect, it } from "vitest";
import {
  BrowserAgentPermissionsSchema,
  browserAgentPermissionsOf,
} from "./browser-permissions";
import { JobFinderSettingsSchema } from "./workspace";

const off = {
  solveCaptchas: false,
  signIn: false,
  googleSignIn: false,
  createAccounts: false,
};

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

it("uses the existing application email before primary email, without a new permission field", () => {
  const profile = CandidateProfileSchema.parse({
    id: "synthetic-google",
    yearsExperience: 1,
    baseResume: {
      id: "synthetic",
      fileName: "synthetic.txt",
      uploadedAt: "2026-11-03T18:00:00Z",
      extractionStatus: "ready",
      textContent: "Fictional identity",
    },
    email: "primary@example.test",
    applicationIdentity: { preferredEmail: "  Intended@Example.test  " },
  });
  expect(intendedAccountEmail(profile)).toBe("Intended@Example.test");
  expect(
    intendedAccountEmail({
      ...profile,
      applicationIdentity: {
        ...profile.applicationIdentity,
        preferredEmail: null,
      },
    }),
  ).toBe("primary@example.test");
  for (const preferredEmail of ["", " ", "not-an-email"]) {
    expect(
      intendedAccountEmail({
        ...profile,
        applicationIdentity: { ...profile.applicationIdentity, preferredEmail },
      }),
    ).toBeNull();
  }
  expect(
    BrowserAgentPermissionsSchema.safeParse({
      googleEmail: "target@example.test",
    }).success,
  ).toBe(false);
});
