// @vitest-environment jsdom

import type { ResumeImportFieldCandidateSummary } from "@nordri/contracts";
import {
  CandidateEducationSchema,
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nordri/contracts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildProfilePayload,
  createProfileEditorValues,
} from "../lib/profile-editor";
import {
  backgroundConflictNoticeMessage,
  backgroundMergedNoticeMessage,
  buildCanonicalAwareProfilePayload,
  mergeDirtyEditorValues,
  useProfileScreenForms,
} from "./profile-screen-hooks";

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

type ProfileScreenFormProps = Parameters<typeof useProfileScreenForms>[0];

function createInput(
  overrides: Partial<ProfileScreenFormProps> = {},
): ProfileScreenFormProps {
  return {
    latestResumeImportReviewCandidates:
      [] as readonly ResumeImportFieldCandidateSummary[],
    profile,
    searchPreferences,
    ...overrides,
  };
}

function renderProfileScreenForms(initialInput: ProfileScreenFormProps) {
  return renderHook(
    (input: ProfileScreenFormProps) => useProfileScreenForms(input),
    { initialProps: initialInput },
  );
}

describe("mergeDirtyEditorValues identity-safe arrays", () => {
  it("maps dirty rows by id onto reordered incoming rows", () => {
    const incoming = [
      { id: "exp_2", companyName: "Beta", title: "Renamed Beta" },
      { id: "exp_1", companyName: "Alpha" },
    ];
    const draft = [
      { id: "exp_1", companyName: "Alpha Edited" },
      { id: "exp_2", companyName: "Beta" },
    ];

    const outcome = mergeDirtyEditorValues(incoming, draft, [
      { companyName: true },
      {},
    ]);

    expect(outcome.status).toBe("merged");
    expect(outcome.status === "merged" && outcome.value).toEqual([
      { id: "exp_2", companyName: "Beta", title: "Renamed Beta" },
      { id: "exp_1", companyName: "Alpha Edited" },
    ]);
  });

  it("conflicts atomically when a dirty record id is absent from incoming", () => {
    const outcome = mergeDirtyEditorValues(
      [{ id: "exp_1", companyName: "Alpha" }],
      [
        { id: "exp_1", companyName: "Alpha Edited" },
        { id: "exp_2", companyName: "Removed Co" },
      ],
      [{}, { companyName: true }],
    );

    expect(outcome.status).toBe("conflict");
  });

  it("conflicts when incoming rows carry duplicate or invalid ids", () => {
    const duplicateOutcome = mergeDirtyEditorValues(
      [
        { id: "exp_1", companyName: "A" },
        { id: "exp_1", companyName: "B" },
      ],
      [{ id: "exp_1", companyName: "Edited A" }],
      [{ companyName: true }],
    );
    expect(duplicateOutcome.status).toBe("conflict");

    const invalidOutcome = mergeDirtyEditorValues(
      [{ companyName: "No Id" }],
      [{ id: "exp_1", companyName: "Edited A" }],
      [{ companyName: true }],
    );
    expect(invalidOutcome.status).toBe("conflict");
  });

  it("conflicts when duplicate dirty draft rows share one id", () => {
    const outcome = mergeDirtyEditorValues(
      [{ id: "exp_1", companyName: "A" }],
      [
        { id: "exp_1", companyName: "A Edited" },
        { id: "exp_1", companyName: "A Edited Again" },
      ],
      [{ companyName: true }, { companyName: true }],
    );

    expect(outcome.status).toBe("conflict");
  });

  it("conflicts when a dirty list rows are primitives without stable ids", () => {
    const outcome = mergeDirtyEditorValues(
      ["alpha", "beta"],
      ["alpha", "beta edited"],
      [false, true],
    );

    expect(outcome.status).toBe("conflict");
  });

  it("adopts clean lists wholesale without requiring record ids", () => {
    const incoming = [{ companyName: "Incoming" }];

    const outcome = mergeDirtyEditorValues(incoming, [], [undefined]);

    expect(outcome.status).toBe("merged");
    expect(outcome.status === "merged" && outcome.value).toBe(incoming);
  });
});

describe("canonical-aware profile saves", () => {
  it("keeps an assistant-updated canonical field while applying a real manual edit", () => {
    const draftValues = createProfileEditorValues(profile);
    draftValues.identity.headline = "Manual headline edit";
    const result = buildCanonicalAwareProfilePayload({
      draftValues,
      dirtyFields: { identity: { headline: true } },
      latestResumeImportReviewCandidates: [],
      profile: {
        ...profile,
        summary: "Assistant-updated summary",
      },
    });

    expect(result.payload?.headline).toBe("Manual headline edit");
    expect(result.payload?.summary).toBe("Assistant-updated summary");
  });

  it("uses the canonical profile when only another form is dirty", () => {
    const result = buildCanonicalAwareProfilePayload({
      draftValues: createProfileEditorValues(profile),
      dirtyFields: {},
      latestResumeImportReviewCandidates: [],
      profile: {
        ...profile,
        summary: "Assistant-updated summary",
      },
    });

    expect(result.payload?.summary).toBe("Assistant-updated summary");
  });
});

describe("useProfileScreenForms background-snapshot durability", () => {
  it("adopts a clean assistant reorder and remains clean", () => {
    const education = [
      CandidateEducationSchema.parse({
        id: "education_1",
        schoolName: "University of Somewhere",
        degree: "BSc",
      }),
      CandidateEducationSchema.parse({
        id: "education_2",
        schoolName: "Berlin Product Academy",
        degree: "Certificate",
      }),
    ];
    const initialProfile = { ...profile, education };
    const { result, rerender } = renderProfileScreenForms(
      createInput({ profile: initialProfile }),
    );

    rerender(
      createInput({
        profile: { ...initialProfile, education: [...education].reverse() },
      }),
    );

    expect(
      result.current.profileForm
        .getValues("records.education")
        .map((entry) => entry.id),
    ).toEqual(["education_2", "education_1"]);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(result.current.hasUserDraftChanges).toBe(false);
  });

  it("keeps dirty profile and preference drafts across identical-content snapshot commits", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Dirty draft headline",
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
      "Dirty draft headline",
    );
    expect(result.current.preferencesForm.getValues("targetRoles")).toBe(
      "Product Manager, Program Manager",
    );
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("adopts an untouched canonical field while preserving a dirty field, dirty flag, and notice", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Dirty draft headline",
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
      "Dirty draft headline",
    );
    expect(
      result.current.profileForm.getValues("identity.currentLocation"),
    ).toBe("Berlin");
    expect(result.current.hasUserDraftChanges).toBe(true);
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundMergedNoticeMessage,
    );
  });

  it("reorders merged experience rows while keeping each dirty edit on its own record id", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

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
  });

  it("aborts atomically when the background removes a locally edited record", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

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
    const userSaveEcho = buildProfilePayload(
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
    const { result, rerender } = renderProfileScreenForms(createInput());

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

  it("rebases fully clean without notice when an own-save echo changes canonical content", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Saved headline",
        {
          shouldDirty: true,
        },
      );
    });

    // Mirror of the screen save handler: the committed profile comes back
    // carrying the saved draft content.
    const savedProfile = buildProfilePayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!savedProfile) {
      throw new Error("Expected the saved draft to build a valid payload.");
    }
    expect(savedProfile.headline).toBe("Saved headline");

    rerender(createInput({ profile: savedProfile }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Saved headline",
    );
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("keeps a language row added while a profile save is in flight", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());
    act(() =>
      result.current.profileForm.setValue(
        "identity.headline",
        "Saved headline",
        { shouldDirty: true },
      ),
    );
    const saved = buildProfilePayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload!;
    act(() =>
      result.current.backgroundArrays.languageArray.append({
        id: "language_added",
        language: "",
        proficiency: "",
        interviewPreference: false,
        notes: "",
      }),
    );
    rerender(createInput({ profile: saved }));
    expect(
      result.current.profileForm
        .getValues("languages")
        .some((row) => row.id === "language_added"),
    ).toBe(true);
    expect(
      result.current.backgroundArrays.languageArray.fields.map((row) => row.id),
    ).toEqual(
      result.current.profileForm.getValues("languages").map((row) => row.id),
    );
    const keptCount =
      result.current.backgroundArrays.languageArray.fields.length;
    act(() =>
      result.current.backgroundArrays.languageArray.append({
        id: "language_second",
        language: "",
        proficiency: "",
        interviewPreference: false,
        notes: "",
      }),
    );
    expect(result.current.backgroundArrays.languageArray.fields).toHaveLength(
      keptCount + 1,
    );
    expect(
      result.current.backgroundArrays.languageArray.fields.map((row) => row.id),
    ).toEqual(
      result.current.profileForm.getValues("languages").map((row) => row.id),
    );
    rerender(createInput({ profile: saved }));
    expect(result.current.backgroundArrays.languageArray.fields).toHaveLength(
      keptCount + 1,
    );
    expect(result.current.profileForm.getValues("identity.headline")).toBe(
      "Saved headline",
    );
  });

  it("rebases a resume-text save echo when persistence refreshes resume metadata", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());
    const recoveredResumeText = `${profile.baseResume.textContent}\nRecovered detail`;

    act(() => {
      result.current.profileForm.setValue(
        "identity.resumeText",
        recoveredResumeText,
        { shouldDirty: true },
      );
    });

    const savedProfile = buildProfilePayload(
      profile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!savedProfile) {
      throw new Error(
        "Expected the resume-text draft to build a valid payload.",
      );
    }

    rerender(
      createInput({
        profile: {
          ...savedProfile,
          baseResume: {
            ...savedProfile.baseResume,
            textUpdatedAt: "2026-08-28T10:05:00.000Z",
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            analysisWarnings: [],
          },
        },
      }),
    );

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.resumeText")).toBe(
      recoveredResumeText,
    );
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("adopts a save echo whose committed content matches the prior baseline so the form lands clean", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

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

    // The successful save returns the stored profile with unchanged
    // normalized content; adoption must still rebase the form to clean.
    rerender(createInput({ profile: { ...profile } }));

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.profileForm.getValues("identity.resumeText")).toBe(
      "Experienced designer.",
    );
    expect(result.current.backgroundMergeNotice).toBeNull();
  });

  it("saves merged current canonical data with local dirty values and clears the notice", () => {
    const { result, rerender } = renderProfileScreenForms(createInput());

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

    // Mirror of the screen save handler after the merge: the payload is
    // reconciled against the current canonical baseline, not stale data.
    const mergedSavePayload = buildProfilePayload(
      externallyUpdatedProfile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!mergedSavePayload) {
      throw new Error("Expected the merged draft to build a valid payload.");
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
    const { result, rerender } = renderProfileScreenForms(createInput());

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
    const { result, rerender } = renderProfileScreenForms(createInput());

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

describe("useProfileScreenForms draft-edit revision signals", () => {
  it("reports each genuine edit while already dirty and stays silent when snapshots commit unchanged content", () => {
    const onDraftEdited = vi.fn();
    const { result, rerender } = renderProfileScreenForms(
      createInput({ onDraftEdited }),
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "First draft headline",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // The surface is already dirty, so this second genuine edit produces no
    // dirty transition; the per-edit revision signal must still report it.
    act(() => {
      result.current.preferencesForm.setValue(
        "targetRoles",
        "Product Manager, Program Manager",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
    expect(result.current.hasUserDraftChanges).toBe(true);

    // Identical-content snapshot commits neither reseed the forms nor count
    // as revisions.
    rerender(
      createInput({
        onDraftEdited,
        profile: { ...profile },
        searchPreferences: { ...searchPreferences },
      }),
    );
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
    expect(result.current.hasUserDraftChanges).toBe(true);
  });

  it("does not report hydration, background merges, own-save echoes, or discard-and-reload as revisions", () => {
    const onDraftEdited = vi.fn();
    const { result, rerender } = renderProfileScreenForms(
      createInput({ onDraftEdited }),
    );

    // Canonical hydration seeds both forms silently.
    expect(onDraftEdited).not.toHaveBeenCalled();

    // A background merge adopts fresh canonical data under kept dirty edits;
    // its keep-dirty reseed must not read as a user edit.
    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Merged draft headline",
        { shouldDirty: true },
      );
    });
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    const externallyUpdatedProfile = {
      ...profile,
      headline: "External canonical headline",
      currentLocation: "Berlin",
    };
    rerender(createInput({ onDraftEdited, profile: externallyUpdatedProfile }));
    expect(result.current.backgroundMergeNotice).toBe(
      backgroundMergedNoticeMessage,
    );
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // An own-save echo rebases the forms to clean silently.
    const savedProfile = buildProfilePayload(
      externallyUpdatedProfile,
      result.current.profileForm.getValues(),
    ).payload;
    if (!savedProfile) {
      throw new Error("Expected the merged draft to build a valid payload.");
    }
    rerender(createInput({ onDraftEdited, profile: savedProfile }));
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(onDraftEdited).toHaveBeenCalledTimes(1);

    // A conflict abort keeps values in place without a reseed or a signal.
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

    // Discard-and-reload reseeds both forms from canonical data silently.
    act(() => {
      result.current.discardEditsAndReloadCanonical();
    });
    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasBackgroundConflict).toBe(false);
    expect(onDraftEdited).toHaveBeenCalledTimes(2);
  });

  it("signals structural row edits exactly once via wrapped mutators while reseeds stay silent", () => {
    const onDraftEdited = vi.fn();
    const { result } = renderProfileScreenForms(createInput({ onDraftEdited }));

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

describe("useProfileScreenForms save-state truth on load", () => {
  // An imported location line can carry detail the split parts do not. The
  // editor derives `currentLocation` from those parts, so recomposing it
  // unconditionally made a freshly loaded Profile differ from its own saved
  // record forever: the footer read "Unsaved changes on this page." and Save
  // was enabled before the user typed anything.
  const importedLocationProfile = CandidateProfileSchema.parse({
    ...profile,
    currentLocation: "Cedar Park, TX 78613",
    currentCity: "Cedar Park",
    currentRegion: "TX",
    currentCountry: "United States",
  });

  it("reports no unsaved changes for an untouched imported profile", () => {
    const { result } = renderProfileScreenForms(
      createInput({ profile: importedLocationProfile }),
    );

    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(result.current.hasUserDraftChanges).toBe(false);
  });

  it("does not treat editor normalization as an unsaved import after saving sources", () => {
    const importedProfile = CandidateProfileSchema.parse({
      ...profile,
      skills: ["TypeScript."],
      portfolioUrl: "portfolio.example.com",
      professionalSummary: { fullSummary: "A longer imported summary." },
    });
    const { result, rerender } = renderProfileScreenForms(
      createInput({ profile: importedProfile }),
    );

    // A source-only save deliberately returns the exact stored profile.
    // The footer must compare what Save writes, not a normalized round trip.
    act(() => {
      result.current.preferencesForm.setValue("locations", "London", {
        shouldDirty: true,
      });
    });
    const savedProfile = buildCanonicalAwareProfilePayload({
      profile: importedProfile,
      draftValues: result.current.profileForm.getValues(),
      dirtyFields: result.current.profileForm.formState.dirtyFields,
      latestResumeImportReviewCandidates: [],
    }).payload;
    expect(savedProfile).toEqual(importedProfile);

    rerender(
      createInput({
        profile: structuredClone(importedProfile),
        searchPreferences: JobSearchPreferencesSchema.parse({
          ...searchPreferences,
          locations: ["London"],
        }),
      }),
    );

    expect(result.current.hasUserDraftChanges).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("reports unsaved changes as soon as a field is edited", () => {
    const { result } = renderProfileScreenForms(
      createInput({ profile: importedLocationProfile }),
    );

    act(() => {
      result.current.profileForm.setValue(
        "identity.headline",
        "Staff systems designer",
        { shouldDirty: true },
      );
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
  });
});

it("preserves every saved profile value when only job sources are edited", () => {
  const result = buildCanonicalAwareProfilePayload({
    profile,
    draftValues: createProfileEditorValues(profile, []),
    dirtyFields: {},
    latestResumeImportReviewCandidates: [],
  });
  expect(result.payload).toBe(profile);
});
