import { describe, expect, test } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  ResumeImportFieldCandidateSummarySchema,
} from "@nestor/contracts";
import {
  buildProfilePayload,
  buildSearchPreferencesPayload,
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  hasProfileDraftChanges,
  hasSearchPreferencesDraftChanges,
} from "./profile-editor";

function createProfile() {
  return CandidateProfileSchema.parse({
    id: "candidate_1",
    firstName: "Alex",
    lastName: "Vanguard",
    fullName: "Alex Vanguard",
    headline: "Senior systems designer",
    summary: "Builds resilient workflows.",
    currentLocation: "London, UK",
    yearsExperience: 10,
    email: "alex@example.com",
    phone: "+44 7700 900123",
    baseResume: {
      id: "resume_1",
      fileName: "alex-vanguard.txt",
      uploadedAt: "2026-03-20T10:00:00.000Z",
    },
    workEligibility: {},
    professionalSummary: {},
    targetRoles: ["Principal Designer"],
    locations: ["Remote"],
    skills: ["Figma"],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
  });
}

describe("profile editor legacy full name preservation", () => {
  function createLegacyFullNameProfile() {
    return CandidateProfileSchema.parse({
      ...createProfile(),
      firstName: null,
      middleName: null,
      lastName: null,
      fullName: "Legacy Assembled Name",
    });
  }

  test("round-trips a legacy assembled full name through an unrelated save when split name inputs stay blank", () => {
    const profile = createLegacyFullNameProfile();
    const values = createProfileEditorValues(profile);
    values.identity.headline = "Updated headline";

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeDefined();
    expect(result.payload?.fullName).toBe("Legacy Assembled Name");
    expect(result.payload?.firstName).toBeNull();
    expect(result.payload?.middleName).toBeNull();
    expect(result.payload?.lastName).toBeNull();
    expect(result.payload?.headline).toBe("Updated headline");
  });

  test("does not guess split names while preserving a legacy assembled full name", () => {
    const profile = createLegacyFullNameProfile();
    const values = createProfileEditorValues(profile);

    const result = buildProfilePayload(profile, values);

    expect(result.payload?.fullName).toContain("Legacy Assembled Name");
    expect(result.payload?.firstName).toBeNull();
    expect(result.payload?.lastName).toBeNull();
  });

  test("assembles a new full name whenever any split name input is meaningfully present", () => {
    const profile = createLegacyFullNameProfile();
    const values = createProfileEditorValues(profile);
    values.identity.firstName = "Jordan";
    values.identity.lastName = "Rivera";

    const result = buildProfilePayload(profile, values);

    expect(result.payload?.fullName).toBe("Jordan Rivera");
    expect(result.payload?.firstName).toBe("Jordan");
    expect(result.payload?.lastName).toBe("Rivera");
    expect(result.payload?.middleName).toBeNull();
  });

  test("still lets an explicit clear of previously stored split names clear the full name", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);
    values.identity.firstName = "";
    values.identity.middleName = "";
    values.identity.lastName = "";

    const result = buildProfilePayload(profile, values);

    expect(result.payload?.firstName).toBeNull();
    expect(result.payload?.middleName).toBeNull();
    expect(result.payload?.lastName).toBeNull();
    expect(result.payload?.fullName).toBeNull();
  });

  test("round-trips a stale placeholder full name without turning it into a fact", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      firstName: null,
      middleName: null,
      lastName: null,
      fullName: "New Candidate",
    });
    const values = createProfileEditorValues(profile);
    values.identity.summary = "Unrelated summary edit";

    const result = buildProfilePayload(profile, values);

    expect(result.payload?.fullName).toBe("New Candidate");
    expect(result.payload?.summary).toBe("Unrelated summary edit");
    expect(result.payload?.firstName).toBeNull();
    expect(result.payload?.lastName).toBeNull();
  });
});

describe("profile editor stored location preservation", () => {
  function createImportedLocationProfile() {
    return CandidateProfileSchema.parse({
      ...createProfile(),
      // An imported line can carry detail the split parts do not - here a
      // postal code. Recomposing "city, region, country" on load turned this
      // into "Cedar Park, TX, United States", so an untouched profile never
      // matched its own saved record.
      currentLocation: "Cedar Park, TX 78613",
      currentCity: "Cedar Park",
      currentRegion: "TX",
      currentCountry: "United States",
    });
  }

  test("an untouched profile is not dirty when the stored location differs from its parts", () => {
    const profile = createImportedLocationProfile();
    const result = buildProfilePayload(
      profile,
      createProfileEditorValues(profile),
    );

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.currentLocation).toBe("Cedar Park, TX 78613");
    expect(hasProfileDraftChanges(profile, result.payload)).toBe(false);
  });

  test("an unrelated edit still leaves the stored location intact", () => {
    const profile = createImportedLocationProfile();
    const values = createProfileEditorValues(profile);
    const result = buildProfilePayload(profile, {
      ...values,
      identity: { ...values.identity, headline: "Staff systems designer" },
    });

    expect(result.payload?.currentLocation).toBe("Cedar Park, TX 78613");
    expect(hasProfileDraftChanges(profile, result.payload)).toBe(true);
  });

  test("editing a location part rebuilds the location line", () => {
    const profile = createImportedLocationProfile();
    const values = createProfileEditorValues(profile);
    const result = buildProfilePayload(profile, {
      ...values,
      identity: { ...values.identity, currentCity: "Austin" },
    });

    expect(result.payload?.currentLocation).toBe("Austin, TX, United States");
    expect(result.payload?.currentCity).toBe("Austin");
    expect(hasProfileDraftChanges(profile, result.payload)).toBe(true);
  });

  test("clearing every location part clears the location line", () => {
    const profile = createImportedLocationProfile();
    const values = createProfileEditorValues(profile);
    const result = buildProfilePayload(profile, {
      ...values,
      identity: {
        ...values.identity,
        currentCity: "",
        currentCountry: "",
        currentLocation: "",
        currentRegion: "",
      },
    });

    expect(result.payload?.currentLocation).toBeNull();
  });
});

describe("profile editor application identity defaults", () => {
  test("rejects a malformed primary email before a save payload is created", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);
    values.identity.email = "not-an-email";

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeUndefined();
    expect(result.validationMessage).toBe(
      "Email must be a valid email address.",
    );
  });

  test("trims a conventional email and keeps blank optional contact fields valid", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);
    values.identity.email = " alex+jobs@example.co.uk ";
    values.identity.secondaryEmail = "";
    values.applicationIdentity.preferredEmail = "";

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.email).toBe("alex+jobs@example.co.uk");
    expect(result.payload?.secondaryEmail).toBeNull();
    expect(result.payload?.applicationIdentity.preferredEmail).toBe(
      "alex+jobs@example.co.uk",
    );
  });

  test.each([
    ["secondaryEmail", "Secondary email"],
    ["preferredEmail", "Preferred application email"],
  ] as const)("rejects malformed %s values", (field, label) => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    if (field === "secondaryEmail") {
      values.identity.secondaryEmail = "not-an-email";
    } else {
      values.applicationIdentity.preferredEmail = "not-an-email";
    }

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeUndefined();
    expect(result.validationMessage).toBe(
      `${label} must be a valid email address.`,
    );
  });

  test("does not mark a saved profile dirty when professionalSummary.fullSummary is missing", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);
    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeDefined();
    expect(hasProfileDraftChanges(profile, result.payload)).toBe(false);
    expect(result.payload?.professionalSummary.fullSummary).toBeNull();
    expect(result.payload?.summary).toBe(profile.summary);
  });

  test("keeps application contact overrides null when the user is only inheriting main contact info", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);
    const result = buildProfilePayload(profile, values);

    expect(result.payload?.applicationIdentity.preferredEmail).toBeNull();
    expect(result.payload?.applicationIdentity.preferredPhone).toBeNull();
  });

  test("persists explicit application contact overrides when the user enters them", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    values.applicationIdentity.preferredEmail = "apply@example.com";
    values.applicationIdentity.preferredPhone = "+44 7000 000999";

    const result = buildProfilePayload(profile, values);

    expect(result.payload?.applicationIdentity.preferredEmail).toBe(
      "apply@example.com",
    );
    expect(result.payload?.applicationIdentity.preferredPhone).toBe(
      "+44 7000 000999",
    );
  });

  test("prefills unresolved review candidates into empty experience and education form sections", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_1",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Staff/Senior Software Engineer at EdSights",
        value: {
          companyName: "EdSights",
          companyUrl: null,
          title: "Staff/Senior Software Engineer",
          employmentType: null,
          location: "Remote, NY",
          workMode: [],
          startDate: "Sep 2021",
          endDate: "Feb 2026",
          isCurrent: false,
          summary: "Led scalable cloud-native application work.",
          achievements: ["Cut costs by 20%."],
          skills: ["React", "TypeScript"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "Staff/Senior Software Engineer | EdSights",
        evidenceText: "EdSights, Remote, NY — Staff/Senior Software Engineer",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "education_candidate_1",
        target: {
          section: "education",
          key: "record",
          recordId: "education_1",
        },
        label: "Education",
        value: {
          schoolName: "Florida State University",
          degree: "Bachelor’s Degree in Computer Science and Physics",
          fieldOfStudy: null,
          location: "",
          startDate: "May 2011",
          endDate: "Sept 2015",
          summary: null,
        },
        valuePreview: "Florida State University",
        evidenceText:
          "Florida State University — Bachelor’s Degree in Computer Science and Physics",
        confidence: 0.8,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.records.experiences).toHaveLength(1);
    expect(values.records.experiences[0]).toMatchObject({
      companyName: "EdSights",
      title: "Staff/Senior Software Engineer",
      location: "Remote, NY",
    });
    expect(values.records.education).toHaveLength(1);
    expect(values.records.education[0]).toMatchObject({
      schoolName: "Florida State University",
      degree: "Bachelor’s Degree in Computer Science and Physics",
    });
  });

  test("dedupes review candidates that match saved records with different date formats", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      experiences: [
        {
          id: "experience_saved_1",
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: [],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    });

    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_mercury",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Senior Software Engineer at Mercury",
        value: {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: [],
          startDate: "Aug 2024",
          endDate: "",
          isCurrent: true,
          summary: "Leads core product work.",
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "Mercury | Senior Software Engineer | Aug 2024",
        evidenceText: "Senior Software Engineer — Mercury",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.records.experiences).toHaveLength(1);
    expect(values.records.experiences[0]).toMatchObject({
      companyName: "Mercury",
      title: "Senior Software Engineer",
      startDate: "2024-08",
      isCurrent: true,
    });
  });

  test("dedupes duplicate imported experience review candidates when record ids differ", () => {
    const profile = createProfile();

    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_duplicate_1",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Senior Software Engineer at Mercury",
        value: {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: [],
          startDate: "Aug 2024",
          endDate: "",
          isCurrent: true,
          summary: "",
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "Mercury | Senior Software Engineer | Aug 2024",
        evidenceText: "Senior Software Engineer - Mercury",
        confidence: 0.8,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_duplicate_2",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_9",
        },
        label: "Senior Software Engineer at Mercury",
        value: {
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: ["remote"],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          summary: "Leads core product work.",
          achievements: ["Improved frontend performance."],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "Mercury | Senior Software Engineer | 2024-08",
        evidenceText: "Senior Software Engineer - Mercury",
        confidence: 0.86,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.records.experiences).toHaveLength(1);
    expect(values.records.experiences[0]).toMatchObject({
      companyName: "Mercury",
      title: "Senior Software Engineer",
      startDate: "2024-08",
      isCurrent: true,
      summary: "Leads core product work.",
      workMode: ["remote"],
    });
  });

  test("prefills unresolved years-of-experience candidates when the profile is still fresh start", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      id: "candidate_fresh_start",
      firstName: "New",
      lastName: "Candidate",
      fullName: "New Candidate",
      headline: "Import your resume to begin",
      currentLocation: "Set your preferred location",
      yearsExperience: 0,
    });

    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "identity_years_experience_candidate",
        target: { section: "identity", key: "yearsExperience", recordId: null },
        label: "Years of experience",
        value: 12,
        valuePreview: "12",
        evidenceText: "12 years of experience",
        confidence: 0.82,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.identity.yearsExperience).toBe("12");
  });

  test("normalizes imported work mode values before save", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_work_mode",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Senior Software Engineer at Leif",
        value: {
          companyName: "Leif",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: "New York City Metropolitan Area",
          workMode: ["on-site"],
          startDate: "Jul 2021",
          endDate: "Aug 2024",
          isCurrent: false,
          summary: "Built platform features.",
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "Leif | Senior Software Engineer | Jul 2021 | Aug 2024",
        evidenceText:
          "Jul 2021 – Aug 2024 · New York City Metropolitan Area · On-site",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.records.experiences[0]?.workMode).toEqual(["onsite"]);

    values.records.experiences[0]!.summary =
      "Built platform features with onsite collaboration.";

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.experiences[0]?.workMode).toEqual(["onsite"]);
  });

  test("drops unchanged imported provisional experience rows on save", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_keep_review_first",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_candidate_1",
        },
        label: "React Developer at NORTHLANE",
        value: {
          companyName: "NORTHLANE",
          companyUrl: null,
          title: "React Developer",
          employmentType: null,
          location: "Prishtina, Kosovo",
          workMode: ["remote"],
          startDate: "2023-07",
          endDate: "",
          isCurrent: true,
          summary: "Worked on ordering flows.",
          achievements: [],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "NORTHLANE | React Developer",
        evidenceText: "NORTHLANE – React Developer",
        confidence: 0.82,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.experiences).toEqual([]);
  });

  test("keeps imported provisional experience rows after the user edits them", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_keep_after_edit",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_candidate_2",
        },
        label: "React Developer at NORTHLANE",
        value: {
          companyName: "NORTHLANE",
          companyUrl: null,
          title: "React Developer",
          employmentType: null,
          location: "Prishtina, Kosovo",
          workMode: ["remote"],
          startDate: "2023-07",
          endDate: "",
          isCurrent: true,
          summary: "Worked on ordering flows.",
          achievements: [],
          skills: ["React"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        valuePreview: "NORTHLANE | React Developer",
        evidenceText: "NORTHLANE – React Developer",
        confidence: 0.82,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    values.records.experiences[0]!.workMode = ["hybrid"];

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.experiences).toHaveLength(1);
    expect(result.payload?.experiences[0]).toMatchObject({
      companyName: "NORTHLANE",
      title: "React Developer",
      workMode: ["hybrid"],
    });
  });

  test("detects profile draft changes even when the form only reflects imported review preload values", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile, [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "contact_portfolio_candidate",
        target: { section: "contact", key: "portfolioUrl", recordId: null },
        label: "Portfolio URL",
        value: "https://alex-vanguard.dev",
        valuePreview: "https://alex-vanguard.dev",
        evidenceText: "https://alex-vanguard.dev",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ]);

    expect(values.identity.portfolioUrl).toBe("https://alex-vanguard.dev");

    const draftProfile = buildProfilePayload(profile, values).payload;

    expect(draftProfile).toBeDefined();
    expect(hasProfileDraftChanges(profile, draftProfile)).toBe(true);
  });

  test("keeps a currency-less baseline unset instead of inventing USD on rebuild", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: ["Senior Engineer"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      salaryCurrency: null,
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: null,
        currencyStatus: "needs_clarification",
      },
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    expect(values.salaryCurrency).toBe("");

    const draftSearchPreferences = buildSearchPreferencesPayload(
      searchPreferences,
      values,
    ).payload;

    expect(draftSearchPreferences).toBeDefined();
    expect(draftSearchPreferences?.salaryCurrency).toBeNull();
    expect(draftSearchPreferences?.compensation.currency).toBeNull();
    expect(
      hasSearchPreferencesDraftChanges(
        searchPreferences,
        draftSearchPreferences,
      ),
    ).toBe(false);
  });

  test("persists an interval-only change on the amount-less inherited-USD baseline without touching currency state", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: [],
      jobFamilies: [],
      locations: [],
      excludedLocations: [],
      workModes: [],
      seniorityLevels: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: { historyLimit: 5, targets: [] },
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    const untouchedDraft = buildSearchPreferencesPayload(
      searchPreferences,
      values,
    ).payload;

    expect(untouchedDraft).toBeDefined();
    expect(
      hasSearchPreferencesDraftChanges(searchPreferences, untouchedDraft),
    ).toBe(false);

    values.compensationInterval = "month";

    const draftSearchPreferences = buildSearchPreferencesPayload(
      searchPreferences,
      values,
    ).payload;

    expect(draftSearchPreferences?.compensation).toEqual({
      minimum: null,
      maximum: null,
      interval: "month",
      currency: null,
      currencyStatus: "needs_clarification",
    });
    expect(draftSearchPreferences?.salaryCurrency).toBe("USD");
    expect(
      hasSearchPreferencesDraftChanges(
        searchPreferences,
        draftSearchPreferences,
      ),
    ).toBe(true);
  });

  test("persists an interval-only change on a currency-less baseline without inventing USD", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: ["Senior Engineer"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      salaryCurrency: null,
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: null,
        currencyStatus: "needs_clarification",
      },
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    values.compensationInterval = "month";

    const draftSearchPreferences = buildSearchPreferencesPayload(
      searchPreferences,
      values,
    ).payload;

    expect(draftSearchPreferences?.compensation).toEqual({
      minimum: null,
      maximum: null,
      interval: "month",
      currency: null,
      currencyStatus: "needs_clarification",
    });
    expect(draftSearchPreferences?.salaryCurrency).toBeNull();
    expect(
      hasSearchPreferencesDraftChanges(
        searchPreferences,
        draftSearchPreferences,
      ),
    ).toBe(true);
  });

  test("normalizes an explicitly entered currency to uppercase", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: ["Senior Engineer"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    values.salaryCurrency = "eur";

    const draftSearchPreferences = buildSearchPreferencesPayload(
      searchPreferences,
      values,
    ).payload;

    expect(draftSearchPreferences?.salaryCurrency).toBe("EUR");
    expect(draftSearchPreferences?.compensation.currency).toBe("EUR");
    expect(draftSearchPreferences?.compensation.currencyStatus).toBe(
      "explicit",
    );
  });

  test("edits compensation as a typed range without converting the visible monthly amounts", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: ["Senior Engineer"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      compensation: {
        minimum: 3000,
        maximum: 4000,
        interval: "month",
        currency: "EUR",
        currencyStatus: "explicit",
      },
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    expect(values).toMatchObject({
      minimumSalaryUsd: "3000",
      targetSalaryUsd: "4000",
      compensationInterval: "month",
      salaryCurrency: "EUR",
    });

    values.targetSalaryUsd = "4500";
    const result = buildSearchPreferencesPayload(searchPreferences, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.compensation).toEqual({
      minimum: 3000,
      maximum: 4500,
      interval: "month",
      currency: "EUR",
      currencyStatus: "explicit",
    });
    expect(result.payload?.minimumSalaryUsd).toBeNull();
    expect(result.payload?.targetSalaryUsd).toBeNull();
  });

  test("requires a valid range and preserves an unresolved currency explicitly", () => {
    const searchPreferences = JobSearchPreferencesSchema.parse({
      targetRoles: ["Senior Engineer"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    });
    const values = createSearchPreferencesEditorValues(searchPreferences);

    values.minimumSalaryUsd = "4000";
    values.targetSalaryUsd = "3000";
    values.compensationInterval = "month";
    expect(
      buildSearchPreferencesPayload(searchPreferences, values)
        .validationMessage,
    ).toContain("Maximum compensation");

    values.targetSalaryUsd = "5000";
    values.salaryCurrency = "";
    const result = buildSearchPreferencesPayload(searchPreferences, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.compensation).toEqual({
      minimum: 4000,
      maximum: 5000,
      interval: "month",
      currency: null,
      currencyStatus: "needs_clarification",
    });
    expect(result.payload?.minimumSalaryUsd).toBeNull();
    expect(result.payload?.targetSalaryUsd).toBeNull();
  });

  test("blocks the save when a project row is started but missing its name", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    values.projects = [
      {
        id: "project_kept",
        name: "Shipped project",
        projectType: "",
        summary: "",
        role: "",
        skills: "",
        outcome: "",
        projectUrl: "",
        repositoryUrl: "",
        caseStudyUrl: "",
      },
      {
        id: "project_incomplete",
        name: "",
        projectType: "",
        summary: "Half-written summary",
        role: "",
        skills: "",
        outcome: "",
        projectUrl: "",
        repositoryUrl: "",
        caseStudyUrl: "",
      },
    ];

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeUndefined();
    expect(result.validationMessage).toContain("incomplete project row");
    expect(result.validationMessage).toContain("Half-written summary");
  });

  test("blocks the save when a language row is started but missing its name", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    values.languages = [
      {
        id: "language_incomplete",
        language: "",
        proficiency: "Fluent",
        interviewPreference: false,
        notes: "",
      },
    ];

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeUndefined();
    expect(result.validationMessage).toContain("incomplete language row");
  });

  test("blocks the save when a proof bank row is started but missing its claim", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    values.proofBank = [
      {
        id: "proof_incomplete",
        title: "Led migration",
        claim: "",
        heroMetric: "",
        supportingContext: "",
        roleFamilies: "",
        projectIds: "",
        linkIds: "",
      },
    ];

    const result = buildProfilePayload(profile, values);

    expect(result.payload).toBeUndefined();
    expect(result.validationMessage).toContain("incomplete proof bank row");
  });

  test("still saves fully empty optional rows without inventing data", () => {
    const profile = createProfile();
    const values = createProfileEditorValues(profile);

    values.projects = [
      {
        id: "project_empty",
        name: "",
        projectType: "",
        summary: "",
        role: "",
        skills: "",
        outcome: "",
        projectUrl: "",
        repositoryUrl: "",
        caseStudyUrl: "",
      },
    ];

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.projects).toEqual([]);
  });

  test("keeps manual duplicate experience rows while collapsing duplicate import candidates", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      experiences: [
        {
          id: "experience_manual_1",
          companyName: "Mercury",
          companyUrl: null,
          title: "Senior Software Engineer",
          employmentType: null,
          location: null,
          workMode: [],
          startDate: "2024-08",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    });

    const baseValues = createProfileEditorValues(profile);
    // Simulate an untouched import candidate that duplicates the manual
    // record exactly once it reaches the persisted record shape.
    baseValues.records.experiences = [
      ...baseValues.records.experiences,
      {
        id: "experience_candidate_dup",
        companyName: "Mercury",
        companyUrl: "",
        title: "Senior Software Engineer",
        employmentType: "",
        location: "",
        workMode: [],
        startDate: "2024-08",
        endDate: "",
        isCurrent: true,
        summary: "",
        achievements: "",
        skills: "",
        domainTags: "",
        peopleManagementScope: "",
        ownershipScope: "",
        sourceCandidateId: "candidate_duplicate",
        sourceCandidateFingerprint: "candidate-duplicate-fingerprint",
      },
    ];

    const result = buildProfilePayload(profile, baseValues);

    expect(result.validationMessage).toBeUndefined();
    // The manually created duplicate survives; only the import-candidate copy
    // is collapsed.
    expect(result.payload?.experiences).toHaveLength(1);
    expect(result.payload?.experiences[0]?.id).toBe("experience_manual_1");
  });

  test("keeps Main skills authoritative so deleting a skill from Main sticks", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      skills: ["Figma", "Python"],
      skillGroups: {
        coreSkills: ["Python"],
        tools: ["Figma"],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
    });
    const values = createProfileEditorValues(profile);

    // The user deletes Python from the Main skills field.
    values.profileSkills = "Figma";

    const result = buildProfilePayload(profile, values);

    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.skills).toEqual(["Figma"]);
    expect(result.payload?.skillGroups.coreSkills).toEqual(["Python"]);
  });

  test("round-trips saved role families through the editor values unchanged", () => {
    const profile = CandidateProfileSchema.parse({
      ...createProfile(),
      proofBank: [
        {
          id: "proof_saved",
          title: "Led redesign",
          claim: "Cut onboarding time by 18%.",
          heroMetric: null,
          supportingContext: null,
          roleFamilies: ["frontend", "fullstack"],
          projectIds: [],
          linkIds: [],
        },
      ],
    });

    const values = createProfileEditorValues(profile);
    expect(values.proofBank[0]?.roleFamilies).toBe("frontend\nfullstack");

    const result = buildProfilePayload(profile, values);
    expect(result.validationMessage).toBeUndefined();
    expect(result.payload?.proofBank[0]?.roleFamilies).toEqual([
      "frontend",
      "fullstack",
    ]);
    expect(hasProfileDraftChanges(profile, result.payload)).toBe(false);
  });
});

test("R3-065 saves limited German permission and future sponsorship together", () => {
  const profile = createProfile();
  const values = createProfileEditorValues(profile);
  values.eligibility.authorizedWorkCountries = "Lebanon";
  values.eligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "Student permission, at most 20 hours weekly during term",
      requiresFutureSponsorship: "yes",
    },
  ];
  const saved = buildProfilePayload(profile, values).payload!;
  expect(saved.workEligibility.authorizedWorkCountries).toEqual(["Lebanon"]);
  expect(saved.workEligibility.limitedWorkPermissions?.[0]).toMatchObject({
    country: "Germany",
    requiresFutureSponsorship: true,
  });
  expect(
    createProfileEditorValues(saved).eligibility.limitedWorkPermissions,
  ).toEqual(values.eligibility.limitedWorkPermissions);
});

test("R3-105 saves day shifts and a 20–30 hour week, rejecting reversed hours", () => {
  const preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
  });
  const values = createSearchPreferencesEditorValues(preferences);
  values.shiftPreference = "day";
  values.minimumWeeklyHours = "20";
  values.maximumWeeklyHours = "30";
  const saved = buildSearchPreferencesPayload(preferences, values).payload!;
  expect(saved.shiftPreference).toBe("day");
  expect(saved.weeklyHours).toEqual({ minimum: 20, maximum: 30 });
  expect(createSearchPreferencesEditorValues(saved).maximumWeeklyHours).toBe(
    "30",
  );
  values.maximumWeeklyHours = "10";
  expect(
    buildSearchPreferencesPayload(preferences, values).validationMessage,
  ).toContain("Maximum weekly hours");
});

test("R3-138 saves an OTE pay floor and preserves it on unrelated edits", () => {
  const preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: 160000,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
  });
  const values = createSearchPreferencesEditorValues(preferences);
  expect(values.compensationBasis).toBe("base");
  values.compensationBasis = "total_ote";
  const saved = buildSearchPreferencesPayload(preferences, values).payload!;
  expect(saved.compensation).toMatchObject({
    minimum: 160000,
    basis: "total_ote",
  });
  expect(
    buildSearchPreferencesPayload(
      saved,
      createSearchPreferencesEditorValues(saved),
    ).payload?.compensation,
  ).toEqual(saved.compensation);
});

test("normalizes a bare portfolio domain and removes trailing skill punctuation", () => {
  const profile = createProfile();
  const values = createProfileEditorValues(profile);
  values.identity.portfolioUrl = "portfolio.example.test";
  values.profileSkills = "SAP EWM.\nSQL";
  const result = buildProfilePayload(profile, values);
  expect(result.payload?.portfolioUrl).toBe("https://portfolio.example.test/");
  expect(result.payload?.skills).toEqual(["SAP EWM", "SQL"]);
});
