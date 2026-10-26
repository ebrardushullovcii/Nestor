import { describe, expect, test } from "vitest";

import { extractExplicitWorkEligibility } from "./internal/resume-import-literal-extraction";
import { mergeExperienceRecords } from "./internal/profile-merge";
import { splitCertificationNameYear } from "./internal/resume-import-reconciliation";
import {
  createAiClient,
  createFreshStartSeedProfile,
  createSeed,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

function bundle(fullText: string) {
  return createTestBundle({ fullText });
}

describe("work eligibility the resume states outright", () => {
  test("reads an EU citizen who needs no sponsorship", () => {
    const result = extractExplicitWorkEligibility(
      bundle(
        "Morgan Lee\nLisbon, Portugal\nWork authorization: EU citizen, authorized to work in the European Union. No visa sponsorship required.",
      ),
    );

    expect(result.authorizedWorkCountries?.values).toEqual(["European Union"]);
    expect(result.requiresVisaSponsorship?.value).toBe(false);
  });

  test("reads several named countries and a stated need for sponsorship", () => {
    const result = extractExplicitWorkEligibility(
      bundle(
        "Priya Shah\nLegally authorized to work in the US and Canada\nWill require H-1B visa sponsorship for new roles.",
      ),
    );

    expect(result.authorizedWorkCountries?.values).toEqual([
      "United States",
      "Canada",
    ]);
    expect(result.requiresVisaSponsorship?.value).toBe(true);
  });

  test("never infers eligibility from where the person lives or works", () => {
    const result = extractExplicitWorkEligibility(
      bundle(
        "Jamie Rivers\nStaff Frontend Engineer\nBerlin, Germany\nLed design system modernization for teams in Germany and Canada.",
      ),
    );

    expect(result.authorizedWorkCountries).toBeNull();
    expect(result.requiresVisaSponsorship).toBeNull();
  });

  test("ignores work the person did for other people", () => {
    const result = extractExplicitWorkEligibility(
      bundle(
        "Immigration paralegal\nHelped clients obtain work permits for Canada and prepared visa sponsorship letters for employees.",
      ),
    );

    expect(result.authorizedWorkCountries).toBeNull();
    expect(result.requiresVisaSponsorship).toBeNull();
  });
});

describe("work eligibility the resume does not state", () => {
  // A wrong value here is a legal misstatement on a real application, so a
  // negated, pending or unrelated sentence must yield nothing and setup asks.
  test.each([
    "Not authorized to work in the United States; will require H-1B sponsorship.",
    "Not currently authorized to work in the US",
    "I am not a US citizen",
    "Non-EU citizen",
    "Relocating to Canada in 2027; not yet eligible to work in Canada",
    "Awaiting green card; currently on H-1B",
    "Green card application in progress",
    "Not a green card holder",
    "German national team player (U19)",
    "Built the eligibility checker for the European Union citizenship portal",
    "Software Engineer, U.S. Citizenship and Immigration Services (contract), 2019 - 2021",
    "Applied for a work permit in Canada (pending)",
    "Eligible to work in Canada (pending)",
    "Authorized to work in the US: No",
    "Helped clients obtain work permits for Canada",
    "Seeking roles that offer visa sponsorship",
    "Open to companies that provide sponsorship",
    "Redesigned the Irish passport renewal flow",
  ])("no country from %s", (line) => {
    expect(
      extractExplicitWorkEligibility(bundle(line)).authorizedWorkCountries,
    ).toBeNull();
  });

  test.each([
    ["Sponsorship required: No", false],
    ["Visa sponsorship required: No", false],
    ["Requires visa sponsorship: No", false],
    ["Need visa sponsorship? No", false],
    ["Sponsorship required: Yes", true],
    ["Work authorization: US citizen. Sponsorship: not required", false],
    ["Authorized to work in the US without sponsorship", false],
    ["No visa sponsorship required", false],
    ["EU citizen, no sponsorship needed", false],
    ["Will need sponsorship in the future", true],
    [
      "Not authorized to work in the United States; will require H-1B sponsorship.",
      true,
    ],
    ["Not open to relocation, requires sponsorship", true],
  ] as const)("sponsorship from %s is %s", (line, expected) => {
    expect(
      extractExplicitWorkEligibility(bundle(line)).requiresVisaSponsorship
        ?.value,
    ).toBe(expected);
  });

  test.each([
    "Seeking roles that offer visa sponsorship",
    "Open to companies that provide sponsorship",
    "Helped clients obtain work permits for Canada",
    "Does the company sponsor visas? No",
  ])("no sponsorship answer from %s", (line) => {
    expect(
      extractExplicitWorkEligibility(bundle(line)).requiresVisaSponsorship,
    ).toBeNull();
  });

  test.each([
    [
      "Work authorization: US citizen. Sponsorship: not required",
      ["United States"],
    ],
    ["Authorized to work in the US without sponsorship", ["United States"]],
    ["Authorized to work in the U.S. and Canada", ["United States", "Canada"]],
    ["EU citizen, no sponsorship needed", ["European Union"]],
    ["Eligible to work in the EU and UK", ["European Union", "United Kingdom"]],
    ["U.S. Citizen", ["United States"]],
    ["Green card holder", ["United States"]],
    ["I have a green card", ["United States"]],
    ["Holds a British passport", ["United Kingdom"]],
    ["Canadian permanent resident", ["Canada"]],
    ["Not a US citizen, but authorized to work in Canada", ["Canada"]],
  ] as const)("countries from %s", (line, expected) => {
    expect(
      extractExplicitWorkEligibility(bundle(line)).authorizedWorkCountries
        ?.values,
    ).toEqual(expected);
  });
});

const ALEX_WITH_ELIGIBILITY = [
  "Alex Vanguard",
  "Senior systems designer",
  "London, UK",
  "alex@example.com",
  "Authorized to work in the United Kingdom. No visa sponsorship required.",
].join("\n");

function importInput(seed: ReturnType<typeof createSeed>, text: string) {
  return {
    baseResume: {
      ...seed.profile.baseResume,
      id: "resume_eligibility_import",
      fileName: "alex.txt",
      textContent: text,
    },
    documentBundle: createTestBundle({ fullText: text }),
  };
}

describe("importing a resume that states work eligibility", () => {
  test("fills empty eligibility answers so setup and applications never ask again", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(seed, ALEX_WITH_ELIGIBILITY),
    );

    expect(snapshot.profile.workEligibility.authorizedWorkCountries).toEqual([
      "United Kingdom",
    ]);
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(
      false,
    );
  });

  test("never replaces answers the person saved; a difference waits for review", async () => {
    const seed = createSeed();
    seed.profile = {
      ...seed.profile,
      workEligibility: {
        ...seed.profile.workEligibility,
        authorizedWorkCountries: ["Portugal"],
        requiresVisaSponsorship: true,
      },
    };
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(seed, ALEX_WITH_ELIGIBILITY),
    );

    expect(snapshot.profile.workEligibility.authorizedWorkCountries).toEqual([
      "Portugal",
    ]);
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(true);
    expect(
      snapshot.latestResumeImportReviewCandidates.some(
        (candidate) => candidate.target.section === "work_eligibility",
      ),
    ).toBe(true);
  });
});

describe("confirming eligibility review items", () => {
  test("confirming a later item never undoes an edit made after an earlier one", async () => {
    const seed = createSeed();
    seed.profile = {
      ...seed.profile,
      workEligibility: {
        ...seed.profile.workEligibility,
        authorizedWorkCountries: ["Portugal"],
        requiresVisaSponsorship: true,
      },
    };
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });
    const imported = await profileWork.runResumeImport(
      importInput(seed, ALEX_WITH_ELIGIBILITY),
    );
    const items = imported.profileSetupState.reviewItems.filter(
      (item) =>
        item.status === "pending" && item.target.domain === "work_eligibility",
    );
    const sponsorshipItem = items.find(
      (item) => item.target.key === "requiresVisaSponsorship",
    );
    const countriesItem = items.find(
      (item) => item.target.key === "authorizedWorkCountries",
    );
    expect(sponsorshipItem).toBeDefined();
    expect(countriesItem).toBeDefined();

    let snapshot = await profileWork.applyProfileSetupReviewAction(
      sponsorshipItem!.id,
      "confirm",
    );
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(
      false,
    );

    // The person sets it back by hand.
    snapshot = await profileWork.saveProfile({
      ...snapshot.profile,
      workEligibility: {
        ...snapshot.profile.workEligibility,
        requiresVisaSponsorship: true,
      },
    });
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(true);

    snapshot = await profileWork.applyProfileSetupReviewAction(
      countriesItem!.id,
      "confirm",
    );
    expect(snapshot.profile.workEligibility.authorizedWorkCountries).toEqual([
      "United Kingdom",
    ]);
    expect(snapshot.profile.workEligibility.requiresVisaSponsorship).toBe(true);
  });
});

describe("where guided setup opens after an import", () => {
  test("opens Job targets when that is the first step with something to do", async () => {
    const seed = createSeed();
    seed.profileSetupState = {
      status: "in_progress",
      currentStep: "import",
      completedAt: null,
      reviewItems: [],
      lastResumedAt: null,
    };
    // No eligibility statement in this resume: the two answers are the
    // step's open question.
    const text = [
      "Alex Vanguard",
      "Senior systems designer",
      "London, UK",
      "alex@example.com",
    ].join("\n");
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(seed, text),
    );

    expect(snapshot.profileSetupState.status).toBe("in_progress");
    expect(snapshot.profileSetupState.currentStep).toBe("targeting");
  });

  test("does not open on a step whose only item is an optional suggestion", async () => {
    // The first press after every import used to be a stepper chip: setup
    // opened on Extras because an optional proof point sat there.
    const seed = createSeed();
    seed.profileSetupState = {
      status: "not_started",
      currentStep: "import",
      completedAt: null,
      lastResumedAt: null,
      reviewItems: [
        {
          id: "review_optional_proof",
          step: "extras",
          target: { domain: "proof_point", key: "claim", recordId: null },
          label: "Proof point",
          reason: "Imported proof point.",
          severity: "optional",
          status: "pending",
          proposedValue: "Cut release time in half.",
          sourceSnippet: null,
          sourceCandidateId: null,
          sourceRunId: null,
          createdAt: "2026-09-23T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
    };
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(
        seed,
        ["Alex Vanguard", "Senior systems designer", "alex@example.com"].join(
          "\n",
        ),
      ),
    );

    expect(snapshot.profileSetupState.currentStep).toBe("targeting");
  });

  test("leaves a finished setup alone", async () => {
    const seed = createSeed();
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(seed, ALEX_WITH_ELIGIBILITY),
    );

    expect(snapshot.profileSetupState.status).toBe("completed");
  });
});

describe("education and certificates the model names in its own words", () => {
  test("keeps the school, the dates and one dated certificate", async () => {
    const text = [
      "Alex Vanguard",
      "Senior systems designer",
      "alex@example.com",
      "Education",
      "Coimbra Institute of Technology",
      "BSc Software Engineering",
      "2010 - 2013",
      "Certifications",
      "AWS Certified Solutions Architect - Associate (2022)",
    ].join("\n");
    const seed = createSeed();
    seed.profile = { ...seed.profile, education: [], certifications: [] };
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible" as const,
            analysisProviderLabel: "Test AI",
            // What the live model returned for this layout: the school as
            // "institution", years as numbers, the certificate year as
            // "year", and a second read of the certificate with the year in
            // its name.
            candidates:
              input.stage === "background"
                ? [
                    createStageCandidate({
                      target: {
                        section: "education",
                        key: "coimbra_institute_bsc_software_engineering",
                        recordId: null,
                      },
                      label: "Education",
                      value: {
                        institution: "Coimbra Institute of Technology",
                        degree: "BSc Software Engineering",
                        startYear: 2010,
                        endYear: "2013",
                      },
                      sourceBlockIds: ["page_1_block_5", "page_1_block_6"],
                      confidence: 0.97,
                      recommendation: "auto_apply",
                    }),
                    createStageCandidate({
                      target: {
                        section: "certification",
                        key: "aws_certified_solutions_architect_associate",
                        recordId: null,
                      },
                      label: "Certification",
                      value: {
                        name: "AWS Certified Solutions Architect - Associate",
                        issuer: "AWS",
                        year: "2022",
                      },
                      sourceBlockIds: ["page_1_block_9"],
                      confidence: 0.96,
                      recommendation: "auto_apply",
                    }),
                    createStageCandidate({
                      target: {
                        section: "certification",
                        key: "record",
                        recordId: "certification_1",
                      },
                      label: "Certification",
                      value: {
                        name: "AWS Certified Solutions Architect - Associate (2022)",
                        issuer: null,
                        issueDate: null,
                      },
                      sourceBlockIds: ["page_1_block_9"],
                      confidence: 0.76,
                    }),
                  ]
                : [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await profileWork.runResumeImport(
      importInput(seed, text),
    );

    expect(
      snapshot.profile.education.map((entry) => [
        entry.schoolName,
        entry.degree,
        entry.startDate,
        entry.endDate,
      ]),
    ).toContainEqual([
      "Coimbra Institute of Technology",
      "BSc Software Engineering",
      "2010",
      "2013",
    ]);
    expect(
      snapshot.profile.certifications.map((entry) => [
        entry.name,
        entry.issuer,
        entry.issueDate,
      ]),
    ).toEqual([
      ["AWS Certified Solutions Architect - Associate", "AWS", "2022"],
    ]);
  });
});

describe("splitCertificationNameYear", () => {
  test.each([
    [
      "AWS Certified Solutions Architect - Associate (2022)",
      "AWS Certified Solutions Architect - Associate",
      "2022",
    ],
    [
      "Certified Kubernetes Administrator, 2024",
      "Certified Kubernetes Administrator",
      "2024",
    ],
    [
      "ISO/IEC 27001:2022 Lead Auditor",
      "ISO/IEC 27001:2022 Lead Auditor",
      null,
    ],
    ["Scrum Master", "Scrum Master", null],
  ])("%s", (input, name, year) => {
    expect(splitCertificationNameYear(input)).toEqual({ name, year });
  });
});

describe("importing again into a profile the person has edited", () => {
  test("keeps their email, certificates and restructured roles", async () => {
    const seed = createSeed();
    const edited = createFreshStartSeedProfile();
    seed.profile = {
      ...edited,
      firstName: "Morgan",
      lastName: "Lee",
      fullName: "Morgan Lee",
      headline: "Senior Backend Engineer",
      // Changed by the person after the first import; the preferred
      // application email still holds the resume's, as it did in the app.
      email: "morgan@lee-mail.test",
      applicationIdentity: {
        ...edited.applicationIdentity,
        preferredEmail: "morgan.lee@example.test",
      },
      certifications: [
        {
          id: "certification_aws",
          name: "AWS Certified Solutions Architect - Associate",
          issuer: "AWS",
          issueDate: "2022",
          expiryDate: null,
          credentialUrl: null,
          isDraft: false,
        },
        {
          id: "certification_cka",
          name: "Certified Kubernetes Administrator",
          issuer: "Linux Foundation",
          issueDate: "2024-05",
          expiryDate: null,
          credentialUrl: null,
          isDraft: false,
        },
      ],
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          // Split by the Assistant: the old card keeps the id the import
          // would build for the resume's own reading of the role.
          id: "experience_acme_payments_senior_backend_engineer_2021_03",
          companyName: "Acme Payments",
          title: "Backend Engineer",
          startDate: "2021-03",
          endDate: "2022-12",
          isCurrent: false,
        },
        {
          ...seed.profile.experiences[0]!,
          id: "experience_acme_senior",
          companyName: "Acme Payments",
          title: "Senior Backend Engineer",
          startDate: "2023-01",
          endDate: null,
          isCurrent: true,
        },
      ],
    };
    const text = [
      "Morgan Lee",
      "Senior Backend Engineer",
      "Lisbon, Portugal",
      "morgan.lee@example.test",
      "Experience",
      "Acme Payments",
      "Senior Backend Engineer",
      "March 2021 - Present",
      "- Led the migration of the settlement service to Go microservices.",
      "Certifications",
      "AWS Certified Solutions Architect - Associate (2022)",
    ].join("\n");
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_reimport",
        fileName: "morgan.txt",
        textContent: text,
      },
      documentBundle: createTestBundle({ fullText: text }),
    });

    expect(snapshot.profile.email).toBe("morgan@lee-mail.test");
    expect(
      snapshot.profile.certifications.map((entry) => entry.name),
    ).toContain("Certified Kubernetes Administrator");
    const ids = snapshot.profile.experiences.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      snapshot.profile.experiences.map((entry) => [
        entry.title,
        entry.startDate,
      ]),
    ).toEqual([
      ["Backend Engineer", "2021-03"],
      ["Senior Backend Engineer", "2023-01"],
    ]);
  });
});

describe("importing again after setup was finished", () => {
  test("a split role read as one keeps setup finished and asks nothing blocking", async () => {
    const seed = createSeed();
    const edited = createFreshStartSeedProfile();
    const base = seed.profile.experiences[0]!;
    seed.profile = {
      ...edited,
      firstName: "Morgan",
      lastName: "Lee",
      fullName: "Morgan Lee",
      headline: "Senior Backend Engineer",
      currentLocation: "Lisbon, Portugal",
      yearsExperience: 6,
      email: "morgan.lee@example.test",
      experiences: [
        {
          ...base,
          id: "experience_acme_payments_senior_backend_engineer_2021_03",
          companyName: "Acme Payments",
          title: "Backend Engineer",
          startDate: "2021-03",
          endDate: "2022-12",
          isCurrent: false,
          location: null,
        },
        {
          ...base,
          id: "experience_acme_senior",
          companyName: "Acme Payments",
          title: "Senior Backend Engineer",
          startDate: "2023-01",
          endDate: null,
          isCurrent: true,
          location: null,
        },
      ],
    };
    const text = [
      "Morgan Lee",
      "Senior Backend Engineer",
      "Lisbon, Portugal",
      "morgan.lee@example.test",
      "Experience",
      "Acme Payments",
      "Senior Backend Engineer",
      "March 2021 - Present",
      "- Led the migration of the settlement service to Go microservices.",
    ].join("\n");
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: createAiClient(),
    });
    const before = await profileWork.read();
    expect(before.profileSetupState.status).toBe("completed");

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_reimport_split",
        fileName: "morgan.txt",
        textContent: text,
      },
      documentBundle: createTestBundle({ fullText: text }),
    });

    expect(snapshot.profileSetupState.status).toBe("completed");
    expect(
      snapshot.profile.experiences.map((entry) => [
        entry.title,
        entry.startDate,
      ]),
    ).toEqual([
      ["Backend Engineer", "2021-03"],
      ["Senior Backend Engineer", "2023-01"],
    ]);
    expect(
      snapshot.profileSetupState.reviewItems.filter(
        (item) => item.status === "pending" && item.severity === "critical",
      ),
    ).toEqual([]);
  });

  test("a new role at another company is added and setup stays finished", async () => {
    const seed = createSeed();
    const fresh = createFreshStartSeedProfile();
    seed.profile = {
      ...fresh,
      firstName: "Morgan",
      lastName: "Lee",
      fullName: "Morgan Lee",
      email: "morgan@example.test",
      headline: "Backend Engineer",
      currentLocation: "Lisbon, Portugal",
      yearsExperience: 5,
      experiences: [
        {
          ...createSeed().profile.experiences[0]!,
          id: "experience_acme",
          companyName: "Acme Payments",
          title: "Backend Engineer",
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
        },
      ],
    };
    const text = [
      "Morgan Lee",
      "morgan@example.test",
      "Experience",
      "Globex",
      "Staff Engineer",
      "2024-01 - Present",
      "- Led the payments platform rewrite across four teams.",
      "Acme Payments",
      "Backend Engineer",
      "2021-03 - 2023-12",
    ].join("\n");
    const { profileWork } = createProfileServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible" as const,
            analysisProviderLabel: "Test AI",
            candidates:
              input.stage === "experience"
                ? [
                    createStageCandidate({
                      target: {
                        section: "experience",
                        key: "record",
                        recordId: "experience_globex",
                      },
                      label: "Experience",
                      value: {
                        companyName: "Globex",
                        title: "Staff Engineer",
                        startDate: "2024-01",
                        endDate: null,
                        isCurrent: true,
                        summary:
                          "Owns the payments platform and its migration.",
                        achievements: [
                          "Led the payments platform rewrite across four teams.",
                        ],
                        skills: ["Go"],
                      },
                      sourceBlockIds: ["page_1_block_3", "page_1_block_4"],
                      confidence: 0.95,
                      recommendation: "auto_apply",
                      overall: 0.93,
                    }),
                  ]
                : [],
            notes: [],
          });
        },
      },
    });

    const snapshot = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_reimport_new_role",
        fileName: "morgan.txt",
        textContent: text,
      },
      documentBundle: createTestBundle({ fullText: text }),
    });

    expect(snapshot.profileSetupState.status).toBe("completed");
    expect(
      snapshot.profile.experiences.map((entry) => entry.companyName),
    ).toEqual(expect.arrayContaining(["Acme Payments", "Globex"]));
    expect(snapshot.profile.experiences).toHaveLength(2);
    expect(
      snapshot.profileSetupState.reviewItems.filter(
        (item) => item.status === "pending" && item.severity === "critical",
      ),
    ).toEqual([]);
  });
});

describe("mergeExperienceRecords", () => {
  test("keeps the saved order of the person's roles", () => {
    const base = createSeed().profile.experiences[0]!;
    const sparse = {
      ...base,
      id: "experience_recent",
      companyName: "Acme Payments",
      title: "Senior Backend Engineer",
      startDate: "2023-01",
      summary: null,
      achievements: [],
      skills: [],
    };
    const rich = {
      ...base,
      id: "experience_older",
      companyName: "Northwind Data",
      title: "Backend Engineer",
      startDate: "2018-06",
      achievements: ["Built ingestion pipelines.", "Owned the schema."],
      skills: ["Python"],
    };

    expect(
      mergeExperienceRecords([sparse, rich], []).map((entry) => entry.id),
    ).toEqual(["experience_recent", "experience_older"]);
  });
});
