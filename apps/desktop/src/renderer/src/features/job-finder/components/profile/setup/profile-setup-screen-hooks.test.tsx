// @vitest-environment jsdom

import type {
  ProfileSetupState,
  ResumeImportFieldCandidateSummary,
} from "@nestor/contracts";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSearchPreferencesPayload } from "../../../lib/profile-editor";
import { buildProfileSetupPayload } from "./profile-setup-screen-actions";
import {
  backgroundConflictNoticeMessage,
  backgroundMergedNoticeMessage,
  useProfileSetupForms,
} from "./profile-setup-screen-hooks";

const profile = CandidateProfileSchema.parse({
  id: "candidate_ready",
  firstName: "Ready",
  lastName: "Candidate",
  fullName: "Ready Candidate",
  headline: "Principal systems designer",
  summary: "Builds workflow platforms.",
  currentLocation: "Prishtina",
  yearsExperience: 10,
  baseResume: {
    id: "resume_ready",
    fileName: "resume.pdf",
    uploadedAt: new Date(0).toISOString(),
    textContent: "Experienced designer.",
    extractionStatus: "needs_text",
  },
  workEligibility: {},
  professionalSummary: {},
  targetRoles: [],
  locations: [],
  skills: [],
  experiences: [
    {
      id: "exp_1",
      companyName: "Original Co",
      title: "Designer",
      startDate: "2018-01",
      isCurrent: true,
    },
    {
      id: "exp_2",
      companyName: "Second Co",
      title: "Junior Designer",
      startDate: "2016-01",
      endDate: "2017-12",
    },
  ],
  education: [],
  certifications: [],
  links: [],
  projects: [],
  spokenLanguages: [],
});

const searchPreferences = JobSearchPreferencesSchema.parse({
  workModes: ["remote"],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
});

const profileSetupState: ProfileSetupState = {
  status: "in_progress",
  currentStep: "essentials",
  completedAt: null,
  reviewItems: [],
  lastResumedAt: null,
};

type ProfileSetupFormProps = Parameters<typeof useProfileSetupForms>[0];

function createInput(
  overrides: Partial<ProfileSetupFormProps> = {},
): ProfileSetupFormProps {
  return {
    latestResumeImportReviewCandidates:
      [] as readonly ResumeImportFieldCandidateSummary[],
    profile,
    profileSetupState,
    searchPreferences,
    ...overrides,
  };
}

describe("useProfileSetupForms background-snapshot durability", () => {
  it("keeps corrections and removed rows through step changes until the finish save", () => {
    const initial = createInput({
      searchPreferences: {
        ...searchPreferences,
        targetRoles: ["Freelance designer", "Product designer"],
      },
    });
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: initial },
    );
    act(() =>
      result.current.profileForm.setValue(
        "identity.headline",
        "Product designer",
        { shouldDirty: true },
      ),
    );
    rerender({
      ...initial,
      profile: structuredClone(initial.profile),
      profileSetupState: { ...profileSetupState, currentStep: "background" },
    });
    act(() => result.current.experienceArray.remove(0));
    rerender({
      ...initial,
      profileSetupState: { ...profileSetupState, currentStep: "targeting" },
    });
    act(() =>
      result.current.preferencesForm.setValue(
        "targetRoles",
        "Product designer",
        { shouldDirty: true },
      ),
    );
    rerender({
      ...initial,
      profileSetupState: { ...profileSetupState, currentStep: "extras" },
    });
    const savedProfile = buildProfileSetupPayload(
      initial.profile,
      result.current.profileForm.getValues(),
    ).payload;
    const savedPreferences = buildSearchPreferencesPayload(
      initial.searchPreferences,
      result.current.preferencesForm.getValues(),
    ).payload;
    expect(savedProfile?.headline).toBe("Product designer");
    expect(
      savedProfile?.experiences.map((experience) => experience.id),
    ).toEqual(["exp_2"]);
    expect(savedPreferences?.targetRoles).toEqual(["Product designer"]);
    expect(result.current.hasUserDraftChanges).toBe(true);
  });

  it("keeps dirty profile and preference drafts across identical-content snapshot commits", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Dirty setup headline",
        {
          shouldDirty: true,
        },
      );
      result.current.preferencesForm.setValue(
        "targetRoles",
        "Product Manager, Program Manager",
        { shouldDirty: true },
      );
    });
    expect(result.current.hasUserDraftChanges).toBe(true);

    // A background workspace action commits a full snapshot: fresh object
    // identities, unchanged content.
    rerender(
      createInput({
        profile: { ...profile },
        searchPreferences: { ...searchPreferences },
      }),
    );

    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Dirty setup headline",
    );
    expect(result.current.preferencesForm.getValues("targetRoles")).toBe(
      "Product Manager, Program Manager",
    );
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBeNull();
    expect(result.current.hasBackgroundConflict).toBe(false);
  });

  it("adopts an untouched canonical field while preserving a dirty field, dirty flag, and notice", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Dirty setup headline",
        {
          shouldDirty: true,
        },
      );
    });

    rerender(
      createInput({
        profile: {
          ...profile,
          headline: "External canonical headline",
          currentLocation: "Berlin",
        },
      }),
    );

    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Dirty setup headline",
    );
    expect(
      result.current.profileForm.getValues("identity.currentLocation"),
    ).toBe("Berlin");
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundMergedNoticeMessage,
    );
    expect(result.current.hasBackgroundConflict).toBe(false);
  });

  it("reorders merged experience rows while keeping each dirty edit on its own record id", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.0.companyName",
        "Draft Edit Co",
        { shouldDirty: true },
      );
    });

    const reorderedWithTweak = {
      ...profile,
      experiences: [
        { ...profile.experiences[1]!, title: "Renamed Junior Designer" },
        { ...profile.experiences[0]! },
      ],
    };
    rerender(createInput({ profile: reorderedWithTweak }));

    const experienceRows = result.current.profileForm.getValues(
      "records.experiences",
    ) as Array<{ id: string; companyName: string; title: string }>;

    expect(experienceRows.map((row) => row.id)).toEqual(["exp_2", "exp_1"]);
    expect(experienceRows.find((row) => row.id === "exp_1")?.companyName).toBe(
      "Draft Edit Co",
    );
    expect(experienceRows.find((row) => row.id === "exp_2")?.title).toBe(
      "Renamed Junior Designer",
    );
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundMergedNoticeMessage,
    );
    expect(result.current.hasBackgroundConflict).toBe(false);
  });

  it("aborts atomically when the background removes a locally edited record", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.1.companyName",
        "Draft Second Co",
        { shouldDirty: true },
      );
    });

    rerender(
      createInput({
        profile: { ...profile, experiences: [profile.experiences[0]!] },
      }),
    );

    // Entire local draft stays exactly as it was: no sparse rows, no partial
    // adoption, dirty guard unchanged.
    const experienceRows = result.current.profileForm.getValues(
      "records.experiences",
    ) as Array<{ id: string; companyName: string }>;

    expect(experienceRows).toHaveLength(2);
    expect(experienceRows.every((row) => row.id && row.companyName)).toBe(true);
    expect(experienceRows.find((row) => row.id === "exp_2")?.companyName).toBe(
      "Draft Second Co",
    );
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundConflictNoticeMessage,
    );
    expect(result.current.hasBackgroundConflict).toBe(true);

    // The previous baseline is retained for stale-save protection: an echo
    // computed against it still lands fully clean.
    const userSaveEcho = buildProfileSetupPayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!userSaveEcho) {
      throw new Error("Expected the kept draft to build a valid payload.");
    }

    rerender(createInput({ profile: userSaveEcho }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.backgroundMergeNotice).toBeNull();
    expect(result.current.hasBackgroundConflict).toBe(false);
  });

  it("conflicts instead of merging when background rows carry duplicate ids", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.0.companyName",
        "Draft Edit Co",
        { shouldDirty: true },
      );
    });

    rerender(
      createInput({
        profile: {
          ...profile,
          experiences: [
            {
              ...profile.experiences[0]!,
              id: "duplicate_id",
              companyName: "Rival Co",
            },
            {
              ...profile.experiences[1]!,
              id: "duplicate_id",
              title: "Other Title",
            },
          ],
        },
      }),
    );

    const experienceRows = result.current.profileForm.getValues(
      "records.experiences",
    ) as Array<{ id: string; companyName: string }>;

    expect(experienceRows).toHaveLength(2);
    expect(experienceRows.find((row) => row.id === "exp_1")?.companyName).toBe(
      "Draft Edit Co",
    );
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundConflictNoticeMessage,
    );
    expect(result.current.hasBackgroundConflict).toBe(true);
  });

  it("merges background experience records while keeping dirty rows in field arrays", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.0.companyName",
        "Draft Edit Co",
        { shouldDirty: true },
      );
    });

    rerender(
      createInput({
        profile: {
          ...profile,
          experiences: [
            ...profile.experiences,
            {
              ...profile.experiences[0]!,
              id: "exp_new",
              companyName: "Background Co",
              title: "Principal Designer",
            },
          ],
        },
      }),
    );

    const experienceRows = result.current.profileForm.getValues(
      "records.experiences",
    ) as Array<{ id: string; companyName: string }>;

    expect(experienceRows).toHaveLength(3);
    expect(experienceRows.find((row) => row.id === "exp_1")?.companyName).toBe(
      "Draft Edit Co",
    );
    expect(
      experienceRows.find((row) => row.id === "exp_new")?.companyName,
    ).toBe("Background Co");
    expect(result.current.hasUserDraftChanges).toBe(true);
  });

  it("rebases fully clean without notice when an own-save echo changes canonical content", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Saved setup headline",
        {
          shouldDirty: true,
        },
      );
    });

    // Mirror of the setup save action: the committed profile comes back
    // carrying the saved step content.
    const savedProfile = buildProfileSetupPayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!savedProfile) {
      throw new Error(
        "Expected the saved setup step to build a valid payload.",
      );
    }
    expect(savedProfile.headline).toBe("Saved setup headline");

    rerender(createInput({ profile: savedProfile }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Saved setup headline",
    );
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("adopts a save echo whose committed content matches the prior baseline so the form lands clean", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    // Whitespace-only edits stay dirty in the form while their committed
    // fingerprint matches the previous baseline.
    act(() => {
      result.current.profileForm.setValue(
        "identity.resumeText",
        `${profile.baseResume.textContent}   `,
        { shouldDirty: true },
      );
    });
    expect(result.current.hasUserDraftChanges).toBe(true);

    // The successful step save returns the stored profile with unchanged
    // normalized content; adoption must still rebase the form to clean.
    rerender(createInput({ profile: { ...profile } }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.resumeText")).toBe(
      "Experienced designer.",
    );
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("saves merged current canonical data with local dirty values and clears the notice", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Merged draft headline",
        {
          shouldDirty: true,
        },
      );
    });

    const externallyUpdatedProfile = {
      ...profile,
      headline: "External canonical headline",
      currentLocation: "Berlin",
    };
    rerender(createInput({ profile: externallyUpdatedProfile }));
    expect(result.current.backgroundMergeNotice).not.toBeNull();

    // Mirror of the setup step save after the merge: the payload is
    // reconciled against the current canonical baseline, not stale data.
    const mergedSavePayload = buildProfileSetupPayload(
      externallyUpdatedProfile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!mergedSavePayload) {
      throw new Error(
        "Expected the merged setup draft to build a valid payload.",
      );
    }
    expect(mergedSavePayload.headline).toBe("Merged draft headline");
    expect(mergedSavePayload.currentLocation).toBe("Berlin");

    rerender(createInput({ profile: mergedSavePayload }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Merged draft headline",
    );
    expect(
      result.current.profileForm.getValues("identity.currentLocation"),
    ).toBe("Berlin");
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("discards dirty drafts and reloads the newest canonical values after an unresolved conflict", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.1.companyName",
        "Draft Second Co",
        { shouldDirty: true },
      );
    });

    rerender(
      createInput({
        profile: { ...profile, experiences: [profile.experiences[0]!] },
      }),
    );
    expect(result.current.hasBackgroundConflict).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundConflictNoticeMessage,
    );

    // A newer canonical snapshot lands while the conflict is still
    // unresolved; discarding must restore THIS data, not the earlier draft
    // baseline the conflict first appeared against.
    const newerCanonicalProfile = {
      ...profile,
      headline: "Newer canonical headline",
      experiences: [profile.experiences[0]!],
    };
    rerender(createInput({ profile: newerCanonicalProfile }));
    expect(result.current.hasBackgroundConflict).toBe(true);

    act(() => {
      result.current.discardEditsAndReloadCanonical();
    });

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasBackgroundConflict).toBe(false);
    expect(result.current.backgroundMergeNotice).toBeNull();
    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Newer canonical headline",
    );
    const experienceRows = result.current.profileForm.getValues(
      "records.experiences",
    ) as Array<{ id: string; companyName: string }>;
    expect(experienceRows.map((row) => row.id)).toEqual(["exp_1"]);
    expect(experienceRows[0]?.companyName).toBe("Original Co");

    // Reloaded state is quiescent: replaying the same snapshot neither
    // resurrects the notice nor re-dirties the forms.
    rerender(createInput({ profile: { ...newerCanonicalProfile } }));
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasBackgroundConflict).toBe(false);
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("keeps the conflict choice visible when the other surface resolves its own merge", () => {
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput() },
    );

    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.1.companyName",
        "Draft Second Co",
        { shouldDirty: true },
      );
    });

    // One commit: the profile merge aborts while search preferences adopt a
    // clean background change. The preference resolution must neither clear
    // the outstanding profile conflict nor hide its reload affordance behind
    // a "merged" message.
    rerender(
      createInput({
        profile: { ...profile, experiences: [profile.experiences[0]!] },
        searchPreferences: { ...searchPreferences, locations: ["Berlin"] },
      }),
    );

    expect(result.current.preferencesForm.getValues("locations")).toBe(
      "Berlin",
    );
    expect(result.current.profileForm.formState.isDirty).toBe(true);
    expect(result.current.hasBackgroundConflict).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundConflictNoticeMessage,
    );

    act(() => {
      result.current.discardEditsAndReloadCanonical();
    });

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasBackgroundConflict).toBe(false);
    expect(result.current.backgroundMergeNotice).toBeNull();
  });
});

describe("useProfileSetupForms draft-edit revision signals", () => {
  it("reports each genuine setup edit while already dirty across both form surfaces and ignores unchanged commits", () => {
    const onDraftEdited = vi.fn();
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput({ onDraftEdited }) },
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Dirty setup headline",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // The preferences surface takes a further edit while the profile surface
    // is already dirty; one signal per genuine edit, no dirty transition
    // needed.
    act(() => {
      result.current.preferencesForm.setValue(
        "targetRoles",
        "Product Manager, Program Manager",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
    expect(result.current.hasUserDraftChanges).toBe(true);

    rerender(
      createInput({
        onDraftEdited,
        profile: { ...profile },
        searchPreferences: { ...searchPreferences },
      }),
    );
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
  });

  it("stays silent through hydration, an own-save echo, and discard-and-reload", () => {
    const onDraftEdited = vi.fn();
    const { result, rerender } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput({ onDraftEdited }) },
    );

    // Canonical hydration seeds the forms silently.
    expect(onDraftEdited).not.toHaveBeenCalled();

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Saved setup headline",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // The committed snapshot carrying the saved draft rebases the forms to
    // clean; its reset must not read as a revision.
    const savedProfile = buildProfileSetupPayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!savedProfile) {
      throw new Error("Expected the saved draft to build a valid payload.");
    }
    rerender(createInput({ onDraftEdited, profile: savedProfile }));
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // After a background conflict abort, discard-and-reload reseeds both
    // forms silently.
    act(() => {
      result.current.profileForm.setValue(
        "records.experiences.1.companyName",
        "Draft Second Co",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(2);

    rerender(
      createInput({
        onDraftEdited,
        profile: { ...profile, experiences: [profile.experiences[0]!] },
      }),
    );
    expect(result.current.hasBackgroundConflict).toBe(true);
    expect(onDraftEdited).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.discardEditsAndReloadCanonical();
    });
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasBackgroundConflict).toBe(false);
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
  });

  it("signals structural row edits exactly once via wrapped mutators while reseeds stay silent", () => {
    const onDraftEdited = vi.fn();
    const { result } = renderHook(
      (input: ProfileSetupFormProps) => useProfileSetupForms(input),
      { initialProps: createInput({ onDraftEdited }) },
    );

    // Array-resync events on mount remain filtered.
    expect(onDraftEdited).not.toHaveBeenCalled();

    // Appending a record is one user-authored structural edit: exactly one
    // signal even though RHF's array-resync event follows it.
    act(() => {
      result.current.experienceArray.append({
        id: "experience_wrapped_1",
        companyName: "",
        companyUrl: "",
        title: "",
        employmentType: "",
        location: "",
        workMode: [],
        startDate: "",
        endDate: "",
        isCurrent: false,
        summary: "",
        achievements: "",
        skills: "",
        domainTags: "",
        peopleManagementScope: "",
        ownershipScope: "",
      });
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // Removing that record is another single structural edit.
    act(() => {
      result.current.experienceArray.remove(
        result.current.experienceArray.fields.length - 1,
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
    // Removing the newly appended row restores the exact canonical values,
    // even though both user actions correctly advanced the revision signal.
    expect(result.current.hasUserDraftChanges).toBe(false);

    // Canonical discard reseeds stay silent around structural edits.
    act(() => {
      result.current.discardEditsAndReloadCanonical();
    });
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
  });
});

it("the person's own setup save may mirror a contact without announcing a background merge", () => {
  const { result, rerender } = renderHook(
    (input: ProfileSetupFormProps) => useProfileSetupForms(input),
    {
      initialProps: createInput({
        profile: {
          ...profile,
          email: "old@synthetic.example",
          applicationIdentity: {
            ...profile.applicationIdentity,
            preferredEmail: "old@synthetic.example",
          },
        },
      }),
    },
  );
  act(() =>
    result.current.profileForm.setValue(
      "identity.email",
      "new@synthetic.example",
      { shouldDirty: true },
    ),
  );
  const submitted = buildProfileSetupPayload(
    profile,
    result.current.profileForm.getValues(),
  ).payload!;
  act(() => result.current.markOwnSave(submitted, searchPreferences));
  rerender(
    createInput({
      profile: {
        ...submitted,
        applicationIdentity: {
          ...submitted.applicationIdentity,
          preferredEmail: "new@synthetic.example",
        },
      },
    }),
  );
  expect(result.current.backgroundMergeNotice).toBeNull();
  expect(result.current.hasUserDraftChanges).toBe(false);
  expect(
    result.current.profileForm.getValues("applicationIdentity.preferredEmail"),
  ).toBe("new@synthetic.example");
});

it("keeps a newer edit while the person's own setup save is in flight", () => {
  const { result, rerender } = renderHook(
    (input: ProfileSetupFormProps) => useProfileSetupForms(input),
    {
      initialProps: createInput(),
    },
  );
  act(() =>
    result.current.profileForm.setValue(
      "identity.email",
      "new@synthetic.example",
      { shouldDirty: true },
    ),
  );
  const submitted = buildProfileSetupPayload(
    profile,
    result.current.profileForm.getValues(),
  ).payload!;
  act(() => result.current.markOwnSave(submitted, searchPreferences));
  act(() =>
    result.current.profileForm.setValue(
      "identity.email",
      "newer@synthetic.example",
      { shouldDirty: true },
    ),
  );
  rerender(createInput({ profile: submitted }));
  expect(result.current.profileForm.getValues("identity.email")).toBe(
    "newer@synthetic.example",
  );
  expect(result.current.hasUserDraftChanges).toBe(true);
});
