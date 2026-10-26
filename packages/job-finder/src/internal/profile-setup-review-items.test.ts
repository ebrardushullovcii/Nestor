import { describe, expect, test } from "vitest";
import {
  ProfileSetupStateSchema,
  ResumeImportFieldCandidateSchema,
  createFreshStartCandidateProfile,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { createSeed } from "../profile-service.test-support";
import {
  buildProfileSetupReviewItems,
  resolvePendingReviewItemsAfterExplicitSave,
} from "./profile-setup-review-items";

const createdAt = "2026-07-16T10:00:00.000Z";

function candidate(input: {
  id: string;
  key: string;
  label: string;
  recordId?: string | null;
  evidenceText?: string | null;
  section?: ResumeImportFieldCandidate["target"]["section"];
  resolution?: ResumeImportFieldCandidate["resolution"];
  value: ResumeImportFieldCandidate["value"];
}): ResumeImportFieldCandidate {
  return ResumeImportFieldCandidateSchema.parse({
    id: input.id,
    runId: "resume_import_education",
    target: {
      section: input.section ?? "education",
      key: input.key,
      recordId: input.recordId ?? null,
    },
    label: input.label,
    sourceKind: "model_background",
    value: input.value,
    confidence: 0.9,
    evidenceText: input.evidenceText ?? null,
    resolution: input.resolution ?? "needs_review",
    createdAt,
  });
}

describe("buildProfileSetupReviewItems", () => {
  test("keeps empty work history as a suggestion for people without previous roles", () => {
    const seed = createSeed();
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: { ...seed.profile, experiences: [], projects: [] },
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(items.filter((item) => item.target.domain === "experience")).toEqual(
      [
        expect.objectContaining({
          label: "Work history",
          severity: "recommended",
          status: "pending",
          proposedValue: null,
          sourceCandidateId: null,
          target: { domain: "experience", key: "record", recordId: null },
        }),
      ],
    );
    expect(
      items.find((item) => item.label === "Work history")?.reason,
    ).toContain("You can finish setup without a previous role");
  });

  test("refreshes an older required work-history item without inventing experience", () => {
    const seed = createSeed();
    const profile = { ...seed.profile, experiences: [], projects: [] };
    const input = {
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    };
    const items = buildProfileSetupReviewItems({
      ...input,
      currentState: null,
    });
    const storedItems = items.map((item) =>
      item.target.domain === "experience"
        ? { ...item, severity: "critical" as const }
        : item,
    );
    const refreshed = buildProfileSetupReviewItems({
      ...input,
      currentState: ProfileSetupStateSchema.parse({
        status: "in_progress",
        reviewItems: storedItems,
      }),
    });

    expect(
      refreshed.find((item) => item.label === "Work history"),
    ).toMatchObject({
      severity: "recommended",
      status: "pending",
      proposedValue: null,
    });
    expect(profile.experiences).toEqual([]);
  });

  test.each(["experience", "education"] as const)(
    "keeps an imported %s suggestion optional when no background is saved",
    (section) => {
      const seed = createSeed();
      const imported = candidate({
        id: `imported_${section}`,
        section,
        key: "record",
        label: section === "experience" ? "Work history" : "Education",
        value:
          section === "experience"
            ? { companyName: "Example Hotel", title: "Receptionist" }
            : {
                schoolName: "Example College",
                degree: "Hospitality certificate",
              },
      });
      const items = buildProfileSetupReviewItems({
        currentState: null,
        documentBundle: null,
        now: createdAt,
        profile: { ...seed.profile, experiences: [], education: [] },
        candidates: [imported],
        searchPreferences: seed.searchPreferences,
      });

      expect(
        items.find((item) => item.sourceCandidateId === imported.id),
      ).toMatchObject({
        severity: "recommended",
        status: "pending",
      });
    },
  );

  test("keeps a dismissed missing-field item dismissed", () => {
    const seed = createSeed();
    const emptyHistoryProfile = {
      ...seed.profile,
      experiences: [],
      projects: [],
    };
    const buildInput = {
      documentBundle: null,
      now: createdAt,
      profile: emptyHistoryProfile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    };
    const items = buildProfileSetupReviewItems({
      ...buildInput,
      currentState: null,
    });
    const workHistory = items.find((item) => item.label === "Work history");
    expect(workHistory?.status).toBe("pending");

    const dismissed = items.map((item) =>
      item.id === workHistory?.id
        ? { ...item, status: "dismissed" as const }
        : item,
    );
    const rebuilt = buildProfileSetupReviewItems({
      ...buildInput,
      currentState: ProfileSetupStateSchema.parse({
        status: "in_progress",
        reviewItems: dismissed,
      }),
    });

    expect(rebuilt.find((item) => item.label === "Work history")?.status).toBe(
      "dismissed",
    );
  });

  test("keeps an existing role's missing work mode as an imported review item", () => {
    const seed = createSeed();
    const workModeCandidate = candidate({
      id: "experience_work_mode",
      section: "experience",
      key: "workMode",
      recordId: "experience_1",
      label: "Work mode",
      value: "remote",
    });
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates: [workModeCandidate],
      searchPreferences: seed.searchPreferences,
    });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Work mode",
          status: "pending",
          sourceCandidateId: workModeCandidate.id,
          target: {
            domain: "experience",
            key: "workMode",
            recordId: "experience_1",
          },
        }),
      ]),
    );
  });

  test("does not create duplicate scalar blockers after a complete education record is confirmed", () => {
    const seed = createSeed();
    const candidates = [
      candidate({
        id: "education_record",
        key: "record",
        label: "Education",
        recordId: "education_1",
        resolution: "auto_applied",
        value: {
          schoolName: "University of Prishtina",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          location: "Prishtina, Kosovo",
        },
      }),
      candidate({
        id: "education_school",
        key: "institution",
        label: "School name",
        value: "University of Prishtina",
      }),
      candidate({
        id: "education_degree",
        key: "degree",
        label: "Degree",
        value: "Bachelor of Science",
      }),
      candidate({
        id: "education_field",
        key: "fieldOfStudy",
        label: "Field of study",
        value: "Computer Science",
      }),
      candidate({
        id: "education_location",
        key: "location",
        label: "Location",
        value: "Prishtina, Kosovo",
      }),
    ];

    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates,
      searchPreferences: seed.searchPreferences,
    });

    expect(items.map((item) => item.label)).not.toEqual(
      expect.arrayContaining([
        "School name",
        "Degree",
        "Field of study",
        "Location",
      ]),
    );
  });

  test("keeps an uncovered education scalar visible for review", () => {
    const seed = createSeed();
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates: [
        candidate({
          id: "education_record",
          key: "record",
          label: "Education",
          recordId: "education_1",
          value: {
            schoolName: "University of Prishtina",
            degree: "Bachelor of Science",
          },
        }),
        candidate({
          id: "education_field",
          key: "fieldOfStudy",
          label: "Field of study",
          value: "Computer Science",
        }),
      ],
      searchPreferences: seed.searchPreferences,
    });

    expect(items.map((item) => item.label)).toContain("Field of study");
  });

  test("clears the location item when the structured fields carry a place", () => {
    const seed = createSeed();
    const emptyLocation = {
      ...seed.profile,
      currentLocation: "",
      currentCity: null,
      currentRegion: null,
      currentCountry: null,
    };

    expect(
      buildProfileSetupReviewItems({
        currentState: null,
        documentBundle: null,
        now: createdAt,
        profile: emptyLocation,
        candidates: [],
        searchPreferences: seed.searchPreferences,
      }).map((item) => item.label),
    ).toContain("Location");

    // Profile Basics writes city and country; guided setup writes one line.
    // Either one answers the question.
    expect(
      buildProfileSetupReviewItems({
        currentState: null,
        documentBundle: null,
        now: createdAt,
        profile: {
          ...emptyLocation,
          currentCity: "Budapest",
          currentCountry: "Hungary",
        },
        candidates: [],
        searchPreferences: seed.searchPreferences,
      }).map((item) => item.label),
    ).not.toContain("Location");
  });

  test("omits saved suggestions and resolves an older pending item once its value is saved", () => {
    const seed = createSeed();
    const locationCandidate = candidate({
      id: "saved_location",
      section: "location",
      key: "currentLocation",
      label: "Location",
      value: "Paris, France",
    });
    const initialItems = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates: [locationCandidate],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      initialItems.find(
        (item) => item.sourceCandidateId === locationCandidate.id,
      )?.status,
    ).toBe("pending");

    const unchangedItems = buildProfileSetupReviewItems({
      currentState: { ...seed.profileSetupState, reviewItems: initialItems },
      documentBundle: null,
      now: "2026-07-16T10:30:00.000Z",
      profile: seed.profile,
      candidates: [locationCandidate],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      unchangedItems.find(
        (item) => item.sourceCandidateId === locationCandidate.id,
      ),
    ).toMatchObject({
      status: "pending",
      resolvedAt: null,
    });

    const savedProfile = { ...seed.profile, currentLocation: "Paris, France" };
    const refreshedItems = buildProfileSetupReviewItems({
      currentState: { ...seed.profileSetupState, reviewItems: initialItems },
      documentBundle: null,
      now: "2026-07-16T11:00:00.000Z",
      profile: savedProfile,
      candidates: [locationCandidate],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      refreshedItems.find(
        (item) => item.sourceCandidateId === locationCandidate.id,
      ),
    ).toMatchObject({
      status: "confirmed",
      resolvedAt: "2026-07-16T11:00:00.000Z",
    });
    expect(
      buildProfileSetupReviewItems({
        currentState: null,
        documentBundle: null,
        now: createdAt,
        profile: savedProfile,
        candidates: [locationCandidate],
        searchPreferences: seed.searchPreferences,
      }).filter((item) => item.sourceCandidateId === locationCandidate.id),
    ).toHaveLength(0);
  });

  test("deduplicates repeated evidence lines in review snippets", () => {
    const seed = createSeed();
    const evidence = "Bachelor of Science in Computer Science";
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates: [
        candidate({
          id: "education_degree_evidence",
          key: "degree",
          label: "Degree",
          value: evidence,
          evidenceText: `${evidence}\n  bachelor   of science in computer science  `,
        }),
      ],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      items.find(
        (item) => item.sourceCandidateId === "education_degree_evidence",
      )?.sourceSnippet,
    ).toBe(evidence);
  });

  test("creates critical field-targeted items for missing first and last names", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      firstName: null,
      middleName: null,
      lastName: null,
      fullName: null,
    };
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(items.find((item) => item.target.key === "firstName")).toMatchObject(
      {
        step: "essentials",
        target: { domain: "identity", key: "firstName", recordId: null },
        label: "First name",
        severity: "critical",
        status: "pending",
      },
    );
    expect(items.find((item) => item.target.key === "lastName")).toMatchObject({
      step: "essentials",
      target: { domain: "identity", key: "lastName", recordId: null },
      label: "Last name",
      severity: "critical",
      status: "pending",
    });
  });

  test("a preferred display name never satisfies the required legal identity fields", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      firstName: null,
      lastName: null,
      fullName: null,
      preferredDisplayName: "Alex V.",
    };
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });
    const nameItems = items.filter((item) =>
      ["firstName", "lastName"].includes(item.target.key),
    );

    expect(nameItems.map((item) => item.target.key)).toEqual([
      "firstName",
      "lastName",
    ]);
    for (const item of nameItems) {
      expect(item.reason).toContain("profile and application fields");
      expect(item.reason).toContain(
        "preferred display name remains how Job Finder addresses you",
      );
      expect(item.reason.toLowerCase()).not.toContain("legal");
    }
  });

  test("stale fresh-start placeholder names still count as missing identity", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      firstName: "New",
      lastName: "Candidate",
      middleName: null,
      fullName: "New Candidate",
    };
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(items.some((item) => item.target.key === "firstName")).toBe(true);
    expect(items.some((item) => item.target.key === "lastName")).toBe(true);
  });

  test("does not add split-name blockers when a real full name already exists", () => {
    const seed = createSeed();
    const profile = {
      ...seed.profile,
      firstName: null,
      lastName: null,
      middleName: null,
    };
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      items.some((item) => ["firstName", "lastName"].includes(item.target.key)),
    ).toBe(false);
  });

  test("fresh-start profiles get a critical years-of-experience requirement spelled out", () => {
    const seed = createSeed();
    const profile = {
      ...createFreshStartCandidateProfile(),
      email: "new.candidate@example.com",
    };
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    // Zero years is a true answer for a first job, so the item nudges but
    // never blocks finishing setup.
    expect(
      items.find((item) => item.target.key === "yearsExperience"),
    ).toMatchObject({
      severity: "recommended",
    });
    expect(
      items.find((item) => item.target.key === "yearsExperience")?.reason,
    ).toContain("Zero is fine if this is your first job.");
  });

  test("keeps years of experience recommended outside the fresh-start rule", () => {
    const seed = createSeed();
    const items = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: { ...seed.profile, yearsExperience: 0 },
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      items.find((item) => item.target.key === "yearsExperience"),
    ).toMatchObject({
      severity: "recommended",
    });
    expect(
      items.find((item) => item.target.key === "yearsExperience")?.reason,
    ).not.toContain("fresh-start");
  });

  test("resolves a saved zero years value for an existing missing-field item", () => {
    const seed = createSeed();
    const profile = { ...seed.profile, yearsExperience: 0 };
    const initialItems = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });
    const yearsItem = initialItems.find(
      (item) => item.target.key === "yearsExperience",
    );

    expect(yearsItem).toMatchObject({
      status: "pending",
      proposedValue: null,
    });

    const refreshedItems = buildProfileSetupReviewItems({
      currentState: {
        ...seed.profileSetupState,
        reviewItems: initialItems,
      },
      documentBundle: null,
      now: "2026-07-16T11:00:00.000Z",
      profile,
      candidates: [],
      searchPreferences: seed.searchPreferences,
    });

    expect(
      refreshedItems.find((item) => item.target.key === "yearsExperience"),
    ).toMatchObject({
      status: "edited",
      resolvedAt: "2026-07-16T11:00:00.000Z",
    });
  });
  test("resolves an imported suggestion as edited when the user saves a different value", () => {
    const seed = createSeed();
    const locationsCandidate = candidate({
      id: "suggested_preferred_locations",
      section: "search_preferences",
      key: "locations",
      label: "Preferred locations",
      value: ["Cedar Park, TX"],
    });
    const currentSearchPreferences = {
      ...seed.searchPreferences,
      locations: [] as string[],
    };
    const initialItems = buildProfileSetupReviewItems({
      currentState: null,
      documentBundle: null,
      now: createdAt,
      profile: seed.profile,
      candidates: [locationsCandidate],
      searchPreferences: currentSearchPreferences,
    });
    const pendingItem = initialItems.find(
      (item) => item.sourceCandidateId === locationsCandidate.id,
    );

    expect(pendingItem).toMatchObject({
      status: "pending",
      proposedValue: "Cedar Park, TX",
      target: { domain: "search_preferences", key: "locations" },
    });

    // The user keeps their own city instead of the imported proposal. That is
    // an explicit edit, not an unresolved suggestion.
    const nextSearchPreferences = {
      ...currentSearchPreferences,
      locations: ["Austin, TX"],
    };
    const savedState = resolvePendingReviewItemsAfterExplicitSave({
      currentProfile: seed.profile,
      currentSearchPreferences,
      nextProfile: seed.profile,
      nextSearchPreferences,
      profileSetupState: {
        ...seed.profileSetupState,
        reviewItems: initialItems,
      },
      now: "2026-07-16T11:00:00.000Z",
    });

    expect(
      savedState.reviewItems.find(
        (item) => item.sourceCandidateId === locationsCandidate.id,
      ),
    ).toMatchObject({
      status: "edited",
      resolvedAt: "2026-07-16T11:00:00.000Z",
    });

    // The following derivation must keep that resolution instead of reopening
    // the item just because the proposal was never accepted verbatim.
    const refreshedItems = buildProfileSetupReviewItems({
      currentState: savedState,
      documentBundle: null,
      now: "2026-07-16T11:30:00.000Z",
      profile: seed.profile,
      candidates: [locationsCandidate],
      searchPreferences: nextSearchPreferences,
    });

    expect(
      refreshedItems.find(
        (item) => item.sourceCandidateId === locationsCandidate.id,
      ),
    ).toMatchObject({
      status: "edited",
      resolvedAt: "2026-07-16T11:00:00.000Z",
    });
  });
});
