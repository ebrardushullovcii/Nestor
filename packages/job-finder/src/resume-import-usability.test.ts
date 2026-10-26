import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ResumeImportFieldCandidateSchema,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./internal/resume-import-apply";
import { reconcileCandidates } from "./internal/resume-import-reconciliation";
import { extractLiteralCandidates } from "./internal/resume-import-literal-extraction";
import { validateResumeImportSourceCandidate } from "./internal/resume-import-source-validation";
import { toCandidate } from "./internal/resume-import-candidate-utils";
import {
  createFreshStartSeedProfile,
  createSeed,
} from "./test-fixtures";
import {
  createAiClient,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";
import {
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
} from "./internal/resume-record-identity";

const text = `Taylor Example
Columbus, OH, United States
taylor@example.test
Experience
Operations Coordinator at Cedar Services
January 2021 - December 2025
- Scheduled deliveries and maintained customer records.
Education
Cedar Community College — Associate of Applied Science in Business Administration, 2020
Skills
Microsoft Excel, Customer service
Languages
English - fluent
Spanish - conversational
Work preferences
Full-time
USD 70,000 minimum
Certifications
Service Foundations — Cedar Training (2022)
Records Management — Maple Institute (2023)
Projects
Inventory Tracker
Technologies: Microsoft Excel
- Created an inventory workbook for a fictional community center.
https://example.test/inventory
Volunteer Scheduler
Technologies: Microsoft Access
- Built a shift schedule for a fictional volunteer group.
https://example.test/scheduler`;
const bundle = createTestBundle({ fullText: text });
const seed = createSeed();
seed.searchPreferences = {
  ...seed.searchPreferences,
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: null,
  compensation: {
    minimum: null,
    maximum: null,
    interval: "year",
    currency: null,
    currencyStatus: "needs_clarification",
  },
};
const profile = () => ({
  ...createFreshStartSeedProfile(),
  skills: [],
  experiences: [],
  education: [],
  certifications: [],
  projects: [],
  spokenLanguages: [],
});
const createdAt = "2026-10-01T10:00:00.000Z";
function candidate(
  section: ResumeImportFieldCandidate["target"]["section"],
  key: string,
  value: ResumeImportFieldCandidate["value"],
  id = key,
): ResumeImportFieldCandidate {
  return ResumeImportFieldCandidateSchema.parse({
    ...createStageCandidate({
      target: { section, key, recordId: null },
      label: id,
      value,
      confidence: 0.95,
      overall: 0.95,
      sourceBlockIds: [bundle.blocks[0]?.id ?? "header"],
    }),
    id,
    runId: "usability",
    sourceKind: "model_background",
    resolution: "needs_review",
    createdAt,
    resolvedAt: null,
  });
}
function reconcile(candidates: ResumeImportFieldCandidate[], source = bundle) {
  return reconcileCandidates(
    profile(),
    seed.searchPreferences,
    candidates,
    source,
  );
}
function apply(candidates: ResumeImportFieldCandidate[]) {
  return applyResolvedResumeImportCandidatesToWorkspace({
    profile: profile(),
    searchPreferences: { ...seed.searchPreferences, employmentTypes: [] },
    candidates,
    analysisProviderKind: "deterministic",
    analysisProviderLabel: "Test",
    analysisWarnings: [],
  });
}
async function fallbackCandidates() {
  const client = createAiClient();
  const candidates = extractLiteralCandidates("usability", bundle, createdAt);
  for (const stage of [
    "identity_summary",
    "experience",
    "background",
    "shared_memory",
  ] as const) {
    const result = await client.extractResumeImportStage({
      stage,
      existingProfile: profile(),
      existingSearchPreferences: seed.searchPreferences,
      documentBundle: bundle,
    });
    candidates.push(
      ...result.candidates.map((draft, index) =>
        toCandidate(
          bundle,
          "usability",
          "model_background",
          createdAt,
          draft,
          index + candidates.length,
        ),
      ),
    );
  }
  return candidates;
}
const role = {
  title: "Operations Coordinator",
  companyName: "Cedar Services",
  startDate: "2021-01",
  endDate: "2025-12",
  achievements: ["Scheduled deliveries and maintained customer records."],
};
const education = {
  schoolName: "Cedar Community College",
  degree: "Associate of Applied Science",
  fieldOfStudy: "Business Administration",
  endDate: "2020",
};

describe("resume import N-019 and N-043", () => {
  test("N-019 rejects activity-derived model roles, headlines and targets", () => {
    const source = createTestBundle({
      fullText:
        "Objective\nSeeking an Information Systems Analyst role.\nExperience\nNetwork Administrator Co-op at Cedar Networks\nEducation\nCedar University\nActivities\nHouse Manager at Student House\n2024 - Present",
    });
    const result = reconcile(
      [
        candidate(
          "experience",
          "record",
          {
            title: "House Manager",
            companyName: "Student House",
            startDate: "2024",
            isCurrent: true,
          },
          "house-role",
        ),
        candidate("identity", "headline", "House Manager", "house-headline"),
        candidate("search_preferences", "targetRoles", [
          "House Manager",
          "Network Administrator Co-op",
        ]),
      ],
      source,
    );
    expect(result.find((item) => item.id === "house-role")?.resolution).toBe(
      "rejected",
    );
    expect(
      result.find((item) => item.id === "house-headline")?.resolution,
    ).toBe("rejected");
    expect(
      result.find((item) => item.target.key === "targetRoles")?.value,
    ).toEqual(["Information Systems Analyst"]);
  });
  test("N-019 uses a visual section label, not the word volunteer in a paid job title", () => {
    const source = createTestBundle({
      fullText:
        "Experience\nVolunteer Coordinator at Cedar Services\n2021 - 2025",
    });
    const make = (regionHint: string, id: string) =>
      ResumeImportFieldCandidateSchema.parse({
        ...candidate(
          "experience",
          "record",
          { ...role, title: "Volunteer Coordinator" },
          id,
        ),
        sourceKind: "vision_omni",
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 1,
            regionHint,
            confidence: 0.95,
            uncertaintyNotes: [],
          },
        ],
      });
    expect(
      reconcile([make("Activities section", "activity")], source)[0]
        ?.resolution,
    ).toBe("rejected");
    expect(
      reconcile([make("Volunteer Coordinator role", "paid")], source)[0]
        ?.resolution,
    ).toBe("auto_applied");
  });
  test("N-043.1 removes headings from model skill lists", () => {
    expect(
      apply(
        reconcile([
          candidate("skill", "skills", [
            "Work preferences",
            "Microsoft Excel",
            "Customer service",
          ]),
        ]),
      ).profile.skills,
    ).toEqual(["Microsoft Excel", "Customer service"]);
  });
  test("N-043.2 folds duplicate education and matches replacement to the saved degree", () => {
    const first = apply(
      reconcile([
        candidate(
          "education",
          "record",
          { schoolName: education.schoolName },
          "school-stub",
        ),
        candidate("education", "record", education, "degree-1"),
        candidate(
          "education",
          "record",
          { ...education, fieldOfStudy: null },
          "degree-2",
        ),
      ]),
    );
    expect(first.profile.education).toHaveLength(1);
    const replacement = reconcileCandidates(
      first.profile,
      first.searchPreferences,
      [candidate("education", "record", education)],
      bundle,
    );
    expect(replacement[0]?.resolutionReason).toBe(
      "already_matches_workspace_value",
    );
    expect(
      areEquivalentEducationRecords(first.profile.education[0], education),
    ).toBe(true);
  });
  test("N-043.2 keeps malformed education available for review", () => {
    const result = reconcile([
      candidate("education", "record", {
        schoolName: "Cedar Community College Associate Degree 2020",
        degree: "Associate Degree",
      }),
    ]);
    expect(result[0]?.resolution).toBe("needs_review");
    expect(apply(result).profile.education).toHaveLength(0);
  });
  test("N-043.3 saves complete city, region and country despite model truncation", () => {
    const result = reconcile([
      candidate("location", "currentLocation", "OH, United States"),
      ...extractLiteralCandidates("usability", bundle, createdAt),
    ]);
    expect(apply(result).profile).toMatchObject({
      currentLocation: "Columbus, OH, United States",
      currentCity: "Columbus",
      currentRegion: "OH",
      currentCountry: "United States",
    });
  });
  test.each([
    "Operations Coordinator at Cedar Services",
    "Operations Coordinator, Cedar Services",
  ])("N-043.4 splits model role and target: %s", (title) => {
    const imported = apply(
      reconcile([
        candidate("experience", "record", { ...role, title, companyName: "" }),
        candidate("search_preferences", "targetRoles", [title]),
      ]),
    );
    expect(imported.profile.experiences[0]).toMatchObject({
      title: role.title,
      companyName: role.companyName,
    });
    expect(imported.searchPreferences.targetRoles).toEqual([role.title]);
  });
  test("N-043.5 saves the explicit full-time preference", () => {
    expect(
      apply(reconcile(extractLiteralCandidates("usability", bundle, createdAt)))
        .searchPreferences.employmentTypes,
    ).toEqual(["Full-time"]);
  });
  test("N-043.6 saves explicit annual minimum pay and currency", () => {
    const imported = apply(
      reconcile(extractLiteralCandidates("usability", bundle, createdAt)),
    );
    expect(imported.searchPreferences.compensation).toMatchObject({
      minimum: 70000,
      interval: "year",
      currency: "USD",
      currencyStatus: "explicit",
    });
    expect(imported.searchPreferences.minimumSalaryUsd).toBe(70000);
    expect(imported.searchPreferences.salaryCurrency).toBe("USD");
  });
  test("N-043.7 rejects preferences, disclaimers and repeated footers as languages", () => {
    const source = createTestBundle({
      fullText:
        "Languages\nEnglish - fluent\nWork preferences\nAnnual Salary - USD 70,000 minimum\nDisclaimer - This document is for review only.\nPrepared for review - fluent\nLanguages\nSpanish - conversational\nPrepared for review - fluent",
    });
    source.blocks = source.blocks.map((block, index) => ({
      ...block,
      pageNumber: index < 6 ? 1 : 2,
    }));
    const result = reconcile(
      [
        candidate(
          "language",
          "record",
          { language: "English", proficiency: "fluent" },
          "english",
        ),
        candidate(
          "language",
          "record",
          { language: "Annual Salary", proficiency: "USD 70,000 minimum" },
          "salary",
        ),
        candidate(
          "language",
          "record",
          {
            language: "Disclaimer",
            proficiency: "This document is for review only.",
          },
          "disclaimer",
        ),
        candidate(
          "language",
          "record",
          { language: "Prepared for review", proficiency: "fluent" },
          "footer",
        ),
      ],
      source,
    );
    expect(
      result
        .filter((item) => item.resolution === "auto_applied")
        .map((item) => item.id),
    ).toEqual(["english"]);
    expect(
      result.filter((item) => item.resolution === "rejected"),
    ).toHaveLength(3);
  });
  test("N-043.7 keeps an uncertain language available for review", () => {
    expect(
      reconcile([
        candidate("language", "record", {
          language: "Lumerian",
          proficiency: "level unknown",
        }),
      ])[0]?.resolution,
    ).toBe("needs_review");
  });
  test("N-043.8 removes model-created multi-word skill fragments", () => {
    expect(
      apply(
        reconcile([
          candidate("skill", "skills", [
            "Microsoft Excel",
            "Microsoft",
            "Excel",
            "Customer service",
          ]),
        ]),
      ).profile.skills,
    ).toEqual(["Microsoft Excel", "Customer service"]);
  });
  test("N-043.8 keeps Excel when the source also lists it separately", () => {
    const source = createTestBundle({
      fullText: "Skills\nMicrosoft Excel, Excel",
    });
    expect(
      apply(
        reconcile(
          [candidate("skill", "skills", ["Microsoft Excel", "Excel"])],
          source,
        ),
      ).profile.skills,
    ).toEqual(["Microsoft Excel", "Excel"]);
  });
  test("N-043.9 rejects a location job and target while keeping the real role", () => {
    const imported = apply(
      reconcile([
        candidate(
          "experience",
          "record",
          { ...role, title: "Columbus, OH, United States", companyName: "" },
          "location-job",
        ),
        candidate("experience", "record", role, "real-job"),
        candidate("search_preferences", "targetRoles", [
          "Columbus, OH, United States",
          role.title,
        ]),
      ]),
    );
    expect(imported.profile.experiences).toHaveLength(1);
    expect(imported.searchPreferences.targetRoles).toEqual([role.title]);
  });
  test("N-043.10 rejects raw merged project headers covered by structured source items", () => {
    const result = reconcile([
      candidate(
        "project",
        "record",
        {
          name: "Inventory Tracker",
          skills: ["Microsoft Excel"],
          projectUrl: "https://example.test/inventory",
        },
        "project-1",
      ),
      candidate(
        "project",
        "record",
        {
          name: "Volunteer Scheduler",
          skills: ["Microsoft Access"],
          projectUrl: "https://example.test/scheduler",
        },
        "project-2",
      ),
      candidate(
        "project",
        "record",
        {
          name: "Inventory Tracker Technologies: Microsoft Excel; Volunteer Scheduler Technologies: Microsoft Access",
        },
        "combined-object",
      ),
      candidate(
        "project",
        "record",
        "Inventory Tracker Technologies: Microsoft Excel https://example.test/inventory Volunteer Scheduler Technologies: Microsoft Access https://example.test/scheduler",
        "raw-projects",
      ),
    ]);
    expect(apply(result).profile.projects).toHaveLength(2);
    expect(result.find((item) => item.id === "raw-projects")?.resolution).toBe(
      "rejected",
    );
  });
  test("N-043.10 leaves a partially covered raw project section available for review", () => {
    const result = reconcile([
      candidate(
        "project",
        "record",
        { name: "Inventory Tracker" },
        "structured",
      ),
      candidate(
        "project",
        "record",
        "Inventory Tracker and another project whose title was unreadable",
        "raw",
      ),
    ]);
    expect(result.find((item) => item.id === "raw")?.resolution).toBe(
      "needs_review",
    );
  });
  test("N-043.10 deduplicates dated and undated certification reads", () => {
    const result = reconcile([
      candidate(
        "certification",
        "record",
        { name: "Service Foundations — Cedar Training (2022)", issuer: null },
        "cert-1",
      ),
      candidate(
        "certification",
        "record",
        {
          name: "Service Foundations",
          issuer: "Cedar Training",
          issueDate: "2022",
        },
        "cert-2",
      ),
      candidate(
        "certification",
        "record",
        { name: "Records Management — Maple Institute (2023)", issuer: null },
        "cert-3",
      ),
      candidate(
        "certification",
        "record",
        {
          name: "Records Management",
          issuer: "Maple Institute",
          issueDate: "2023",
        },
        "cert-4",
      ),
    ]);
    expect(apply(result).profile.certifications).toHaveLength(2);
  });
  test("N-043.11 matches repeated roles, split qualifications and locations", () => {
    const first = apply(
      reconcile([
        candidate("experience", "record", role),
        candidate("education", "record", education),
        candidate("location", "currentLocation", "Columbus, OH, United States"),
      ]),
    );
    const replacement = reconcileCandidates(
      first.profile,
      first.searchPreferences,
      [
        candidate("experience", "record", {
          ...role,
          startDate: "January 2021",
          endDate: "December 2025",
        }),
        candidate("education", "record", {
          ...education,
          degree: "Associate of Applied Science in Business Administration",
          fieldOfStudy: null,
        }),
        candidate("location", "currentLocation", "OH, United States"),
      ],
      bundle,
    );
    expect(
      replacement.every(
        (item) => item.resolutionReason === "already_matches_workspace_value",
      ),
    ).toBe(true);
    expect(
      areEquivalentExperienceRecords(first.profile.experiences[0], {
        ...role,
        title: "Operations Coordinator at Cedar Services",
        companyName: "",
      }),
    ).toBe(true);
    expect(
      areEquivalentEducationRecords(education, {
        ...education,
        degree: "Associate of Applied Science in Business Administration",
        fieldOfStudy: null,
      }),
    ).toBe(true);
  });
  test("the complete fallback pipeline keeps the same source items", async () => {
    const imported = apply(reconcile(await fallbackCandidates()));
    expect(imported.profile.experiences).toHaveLength(1);
    expect(imported.profile.education).toHaveLength(1);
    expect(imported.profile.certifications).toHaveLength(2);
    expect(imported.profile.projects).toHaveLength(2);
    expect(
      imported.profile.spokenLanguages.map((entry) => entry.language),
    ).toEqual(["English", "Spanish"]);
    expect(imported.profile.skills).toEqual([
      "Microsoft Excel",
      "Customer service",
    ]);
  });
  test.each(["plain_text", "textutil_docx", "pdfjs_text"] as const)(
    "stored import and replacement retain records with %s text",
    async (parser) => {
      const { profileWork } = createProfileServiceHarness({
        seed: { ...seed, profile: profile() },
      });
      const documentBundle = createTestBundle({
        fullText: text,
        primaryParserKind: parser,
      });
      const baseResume = {
        ...seed.profile.baseResume,
        id: "synthetic-usability",
        textContent: text,
        fileName: "synthetic-usability.txt",
      };
      const first = await profileWork.runResumeImport({
        baseResume,
        documentBundle,
      });
      const second = await profileWork.runResumeImport({
        baseResume,
        documentBundle,
      });
      for (const snapshot of [first, second]) {
        expect(snapshot.profile.experiences).toHaveLength(1);
        expect(snapshot.profile.education).toHaveLength(1);
        expect(snapshot.profile.certifications).toHaveLength(2);
        expect(snapshot.profile.projects).toHaveLength(2);
        expect(snapshot.profile.currentCity).toBe("Columbus");
        expect(snapshot.searchPreferences.employmentTypes).toEqual([
          "Full-time",
        ]);
        expect(snapshot.searchPreferences.compensation.minimum).toBe(70000);
      }
    },
  );
});

describe("resume import review regressions", () => {
  test.each([
    ["Microsoft Excel", "Excel", "rejected"],
    ["React (Hooks", "React", "auto_applied"],
    ["Python 3.11", "Python", "auto_applied"],
    ["AWS (EC2", "AWS", "auto_applied"],
  ])(
    "validates %s without rejecting valid skill %s",
    (sourceSkill, skill, resolution) => {
      const source = createTestBundle({ fullText: `Skills\n${sourceSkill}` });
      expect(
        reconcile([candidate("skill", "record", skill)], source)[0]?.resolution,
      ).toBe(resolution);
    },
  );

  test.each(["Part-time", null])(
    "keeps saved employment type %s and reviews a conflict",
    (saved) => {
      const preferences = {
        ...seed.searchPreferences,
        employmentTypes: saved ? [saved] : [],
      };
      const resolved = reconcileCandidates(
        profile(),
        preferences,
        extractLiteralCandidates("review", bundle, createdAt),
        bundle,
      );
      const hours = resolved.find(
        (entry) => entry.target.key === "employmentTypes",
      );
      expect(hours?.value).toEqual(["Full-time"]);
      expect(hours?.resolution).toBe(saved ? "needs_review" : "auto_applied");
      if (saved)
        expect(hours?.resolutionReason).toBe(
          "conflicts_with_existing_profile_value",
        );
      const imported = applyResolvedResumeImportCandidatesToWorkspace({
        profile: profile(),
        searchPreferences: preferences,
        candidates: resolved,
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      });
      expect(imported.searchPreferences.employmentTypes).toEqual([
        saved ?? "Full-time",
      ]);
      // The merge itself also protects saved choices from an already-resolved selection.
      const forced = applyResolvedResumeImportCandidatesToWorkspace({
        profile: profile(),
        searchPreferences: preferences,
        candidates: resolved.map((entry) => ({
          ...entry,
          resolution: "auto_applied",
        })),
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      });
      expect(forced.searchPreferences.employmentTypes).toEqual([
        saved ?? "Full-time",
      ]);
    },
  );

  test.each([
    { minimum: 90000, currency: "EUR", currencyStatus: "explicit" as const },
    {
      minimum: 90000,
      currency: null,
      currencyStatus: "needs_clarification" as const,
    },
    { minimum: null, currency: "EUR", currencyStatus: "explicit" as const },
  ])("preserves saved compensation $minimum / $currency", (saved) => {
    const preferences = {
      ...seed.searchPreferences,
      compensation: { ...seed.searchPreferences.compensation, ...saved },
    };
    const resolved = reconcileCandidates(
      profile(),
      preferences,
      extractLiteralCandidates("review", bundle, createdAt),
      bundle,
    );
    const pay = resolved.find((entry) => entry.target.key === "compensation");
    expect(pay?.resolution).toBe("needs_review");
    expect(pay?.resolutionReason).toBe("conflicts_with_existing_profile_value");
    const imported = applyResolvedResumeImportCandidatesToWorkspace({
      profile: profile(),
      searchPreferences: preferences,
      candidates: resolved,
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    });
    expect(imported.searchPreferences.compensation).toEqual(
      preferences.compensation,
    );
    const forced = applyResolvedResumeImportCandidatesToWorkspace({
      profile: profile(),
      searchPreferences: preferences,
      candidates: resolved.map((entry) => ({
        ...entry,
        resolution: "auto_applied",
      })),
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Test",
      analysisWarnings: [],
    });
    expect(forced.searchPreferences.compensation).toEqual(
      preferences.compensation,
    );
  });

  test.each([
    ["USD70,000 minimum", "USD"],
    ["USD 70,000 minimum", "USD"],
    ["Minimum salary: USD 70,000", "USD"],
    ["Minimum: 70,000 EUR", "EUR"],
    ["$70,000 minimum", null],
  ])(
    "extracts minimum pay from %s without guessing currency",
    (line, currency) => {
      const source = createTestBundle({
        fullText: `Work preferences\n${line}`,
      });
      const literals = extractLiteralCandidates("review", source, createdAt);
      const expected = {
        minimum: 70000,
        maximum: null,
        interval: "year",
        currency,
        currencyStatus: currency ? "explicit" : "needs_clarification",
      };
      expect(
        literals.find((entry) => entry.target.key === "compensation")?.value,
      ).toEqual(expected);
      const currencies = literals.filter(
        (entry) => entry.target.key === "salaryCurrency",
      );
      expect(currencies.map((entry) => entry.value)).toEqual(
        currency ? [currency] : [],
      );
      expect(
        apply(reconcile(literals, source)).searchPreferences.compensation,
      ).toEqual(expected);
    },
  );

  test.each(["Full-time", "Part-time"])(
    "uses the UI employment type value %s",
    (hours) => {
      const source = createTestBundle({
        fullText: `Work preferences\n${hours.toLowerCase()}`,
      });
      const literals = extractLiteralCandidates("review", source, createdAt);
      expect(
        apply(reconcile(literals, source)).searchPreferences.employmentTypes,
      ).toEqual([hours]);
    },
  );

  test.each([
    ["Senior Engineer, Acme Corp", "Senior Engineer", "Acme Corp"],
    [
      "Engineering Manager, Platform\nAcme Corp",
      "Engineering Manager, Platform",
      "Acme Corp",
    ],
    ["Senior Engineer at Acme", "Senior Engineer", "Acme"],
  ])(
    "splits model role %s using the separate company line",
    (header, title, companyName) => {
      const source = createTestBundle({
        fullText: `Experience\n${header}\n2021 - 2025\n- Delivered a fictional platform.`,
      });
      const rawTitle = header.split("\n")[0] ?? "";
      for (const modelCompany of ["", companyName]) {
        const imported = apply(
          reconcile(
            [
              candidate("experience", "record", {
                ...role,
                title: rawTitle,
                companyName: modelCompany,
              }),
              candidate("identity", "headline", rawTitle),
              candidate("search_preferences", "targetRoles", [rawTitle]),
            ],
            source,
          ),
        );
        expect(imported.profile.experiences[0]).toMatchObject({
          title,
          companyName: modelCompany || companyName,
        });
        expect(imported.searchPreferences.targetRoles).toEqual([title]);
        expect(imported.profile.headline).toBe(title);
      }
    },
  );
});

describe("live import education and headline regressions", () => {
  test("keeps partial BSc and MBA readings from different source entries separate", () => {
    const source = createTestBundle({
      fullText:
        "Education\nSynthetic University\nBachelor of Science in Computer Science, 2018\nSynthetic University\nMaster of Business Administration, 2024",
    });
    const bachelor = candidate(
      "education",
      "record",
      {
        schoolName: "Synthetic University",
        degree: "Bachelor of Science",
      },
      "bachelor",
    );
    bachelor.evidenceText = "Bachelor of Science in Computer Science, 2018";
    bachelor.sourceBlockIds = ["bachelor-entry"];
    const master = candidate(
      "education",
      "record",
      {
        schoolName: "Synthetic University",
        fieldOfStudy: "Business Administration",
      },
      "master",
    );
    master.evidenceText = "Master of Business Administration, 2024";
    master.sourceBlockIds = ["master-entry"];
    const imported = apply(reconcile([bachelor, master], source));
    expect(imported.profile.education).toHaveLength(2);
    expect(imported.profile.education).not.toContainEqual(
      expect.objectContaining({
        degree: "Bachelor of Science",
        fieldOfStudy: "Business Administration",
      }),
    );
  });

  test("fresh workspace imports the exact Taylor resume with observed model and deterministic candidates", async () => {
    const resumeText = readFileSync(
      new URL("../test-fixtures/resume-import-taylor.txt", import.meta.url),
      "utf8",
    );
    const documentBundle = createTestBundle({ fullText: resumeText });
    const fallback = createAiClient();
    const injected = (
      section: ResumeImportFieldCandidate["target"]["section"],
      key: string,
      value: ResumeImportFieldCandidate["value"],
      evidenceText = section === "education"
        ? "Columbus State Community College Associate of Applied Science in Supply Chain Management, 2018"
        : "Customer Service Representative, Contoso Retail",
    ) => ({
      ...createStageCandidate({
        target: { section, key, recordId: null },
        value,
        label: key,
        confidence: 0.99,
        overall: 0.99,
        sourceBlockIds: documentBundle.blocks
          .filter(
            (block) =>
              evidenceText.includes(block.text) ||
              block.text.includes(evidenceText),
          )
          .map((block) => block.id),
      }),
      evidenceText,
    });
    const { profileWork } = createProfileServiceHarness({
      seed: { ...seed, profile: profile() },
      aiClient: {
        ...fallback,
        extractResumeImportStage: async (input) => {
          const result = await fallback.extractResumeImportStage(input);
          const modelCandidates =
            input.stage === "background"
              ? [
                  injected(
                    "skill",
                    "skills",
                    [
                      "Microsoft Excel",
                      "Google Sheets",
                      "Scheduling",
                      "Inventory Control",
                      "Health and Safety",
                      "Customer Service",
                    ],
                    "Microsoft Excel, Google Sheets, Scheduling, Inventory Control, Health and Safety, Customer Service",
                  ),
                  injected("education", "record", {
                    schoolName: "Columbus State Community College",
                    degree: null,
                    fieldOfStudy: null,
                    endDate: "2018",
                  }),
                  injected("education", "record", {
                    schoolName: "Columbus State Community College",
                    degree: "Associate of Applied Science",
                    fieldOfStudy: "Supply Chain Management, 2018",
                    endDate: null,
                  }),
                ]
              : input.stage === "identity_summary"
                ? [
                    injected(
                      "identity",
                      "headline",
                      "Customer Service Representative",
                    ),
                  ]
                : input.stage === "experience"
                  ? [
                      injected(
                        "experience",
                        "record",
                        {
                          title: "Operations Assistant",
                          companyName: "Northwind Freight",
                          startDate: "2021-03",
                          endDate: null,
                          isCurrent: true,
                          achievements: [
                            "Scheduled weekly carrier pickups for 40 regional customers.",
                            "Reconciled shipping invoices in Microsoft Excel each month.",
                          ],
                        },
                        "Operations Assistant at Northwind Freight",
                      ),
                      injected("experience", "record", {
                        title: "Customer Service Representative",
                        companyName: "Contoso Retail",
                        startDate: "2018-06",
                        endDate: "2021-02",
                        isCurrent: false,
                        achievements: [
                          "Resolved order questions by phone and email.",
                          "Trained four new team members on the returns process.",
                        ],
                      }),
                    ]
                  : [];
          return {
            ...result,
            analysisProviderKind: "openai_compatible",
            candidates: [...modelCandidates, ...result.candidates],
          };
        },
      },
    });
    const result = await profileWork.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "synthetic-live-regression",
        textContent: resumeText,
        fileName: "synthetic-taylor.txt",
      },
      documentBundle,
    });
    const snapshot = result;
    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(snapshot.profile.education).toHaveLength(1);
    expect(snapshot.profile.education[0]).toMatchObject({
      schoolName: "Columbus State Community College",
      degree: "Associate of Applied Science",
      fieldOfStudy: "Supply Chain Management",
      endDate: "2018",
    });
    // The stated goal takes precedence when there is no header title.
    expect(snapshot.profile.headline).toBe("Operations Coordinator");
    expect(snapshot.profile.fullName).toBe("Taylor Example");
    expect(snapshot.profile.currentLocation).toBe(
      "Columbus, OH, United States",
    );
    expect(
      snapshot.profile.experiences.map((entry) => [
        entry.title,
        entry.companyName,
      ]),
    ).toEqual([
      ["Operations Assistant", "Northwind Freight"],
      ["Customer Service Representative", "Contoso Retail"],
    ]);
    expect(snapshot.profile.skills).toEqual([
      "Microsoft Excel",
      "Google Sheets",
      "Scheduling",
      "Inventory Control",
      "Health and Safety",
      "Customer Service",
    ]);
    expect(
      snapshot.profile.spokenLanguages.map((entry) => entry.language),
    ).toEqual(["English", "Spanish"]);
    expect(snapshot.searchPreferences.targetRoles).toEqual([
      "Operations Coordinator",
    ]);
    expect(snapshot.searchPreferences.employmentTypes).toEqual(["Full-time"]);
    expect(snapshot.searchPreferences.compensation).toMatchObject({
      minimum: 70000,
      currency: "USD",
      currencyStatus: "explicit",
    });
  });

  test.each([
    ["degree", "BSc Computer Science 2016", "BSc Computer Science"],
    [
      "fieldOfStudy",
      "Supply Chain Management, 2018",
      "Supply Chain Management",
    ],
  ])("moves a trailing year out of %s", (key, value, cleaned) => {
    const result = apply(
      reconcile([
        candidate("education", "record", {
          schoolName: "Synthetic College",
          [key]: value,
        }),
      ]),
    );
    expect(result.profile.education[0]).toMatchObject({
      [key]: cleaned,
      endDate: key === "degree" ? "2016" : "2018",
    });
  });

  test("merges complementary education candidates without overlapping dates or degree fields", () => {
    const yearOnly = candidate(
      "education",
      "record",
      { schoolName: "Synthetic College", endDate: "2018" },
      "year-only",
    );
    yearOnly.confidence = 0.99;
    if (yearOnly.confidenceBreakdown)
      yearOnly.confidenceBreakdown.overall = 0.99;
    yearOnly.evidenceText = "Synthetic College, 2018";
    const result = apply(
      reconcile([
        yearOnly,
        candidate(
          "education",
          "record",
          {
            schoolName: "Synthetic College",
            degree: "Associate of Applied Science",
            fieldOfStudy: "Supply Chain Management",
          },
          "qualification-only",
        ),
      ]),
    );
    expect(result.profile.education).toHaveLength(1);
    expect(result.profile.education[0]).toMatchObject({
      degree: "Associate of Applied Science",
      fieldOfStudy: "Supply Chain Management",
      endDate: "2018",
    });
  });
});

describe("source-derived headlines", () => {
  test("does not choose a rejected location record as the latest headline", () => {
    const source = createTestBundle({
      fullText:
        "Taylor Example\nExperience\nSoftware Engineer at Synthetic Systems\nLondon, UK\n2021 - Present\n- Built fictional workflow tools.",
    });
    const resolved = reconcile(
      [
        candidate(
          "experience",
          "record",
          {
            title: "London, UK",
            companyName: "Synthetic Systems",
            startDate: "2021",
            isCurrent: true,
          },
          "phantom",
        ),
        candidate(
          "experience",
          "record",
          {
            title: "Software Engineer",
            companyName: "Synthetic Systems",
            startDate: "2021",
            isCurrent: true,
          },
          "engineer",
        ),
        candidate("identity", "headline", "Software Engineer", "headline"),
      ],
      source,
    );
    expect(resolved.find((entry) => entry.id === "phantom")?.resolution).toBe(
      "rejected",
    );
    expect(apply(resolved).profile.headline).toBe("Software Engineer");
  });

  test.each([true, false])(
    "replaces an older model headline with the latest role (current: %s)",
    (current) => {
      const source = createTestBundle({
        fullText: `Experience\nCustomer Service Representative at Contoso Retail\n2018 - 2021\nOperations Assistant at Northwind Freight\n${current ? "2021" : "2000"} - ${current ? "Present" : "2025"}`,
      });
      const imported = apply(
        reconcile(
          [
            candidate(
              "identity",
              "headline",
              "Customer Service Representative",
            ),
            candidate(
              "experience",
              "record",
              {
                title: "Customer Service Representative",
                companyName: "Contoso Retail",
                startDate: "2018",
                endDate: "2021",
              },
              "old",
            ),
            candidate(
              "experience",
              "record",
              {
                title: "Operations Assistant",
                companyName: "Northwind Freight",
                startDate: current ? "2021" : "2000",
                endDate: current ? null : "2025",
                isCurrent: current,
              },
              "latest",
            ),
          ],
          source,
        ),
      );
      expect(imported.profile.headline).toBe("Operations Assistant");
    },
  );
});

test("an incomplete education reading does not bridge two different qualifications", () => {
  const result = apply(
    reconcile([
      candidate(
        "education",
        "record",
        { schoolName: "Synthetic College", endDate: "2018" },
        "partial",
      ),
      candidate(
        "education",
        "record",
        {
          schoolName: "Synthetic College",
          degree: "Associate of Applied Science",
          fieldOfStudy: "Supply Chain Management",
        },
        "first-degree",
      ),
      candidate(
        "education",
        "record",
        {
          schoolName: "Synthetic College",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
        },
        "second-degree",
      ),
    ]),
  );
  expect(result.profile.education).toHaveLength(2);
  expect(result.profile.education.map((entry) => entry.degree)).toEqual(
    expect.arrayContaining([
      "Associate of Applied Science",
      "Bachelor of Science",
    ]),
  );
});

describe("location-shaped role titles", () => {
  test("keeps a dated Registered Nurse specialty with an employer", () => {
    const source = createTestBundle({
      fullText:
        "Experience\nRegistered Nurse, Pediatrics\nCedar Clinic\n2021 - 2025\n- Provided care for synthetic patients.",
    });
    const role = candidate("experience", "record", {
      title: "Registered Nurse, Pediatrics",
      companyName: "Cedar Clinic",
      startDate: "2021",
      endDate: "2025",
    });
    const checked = validateResumeImportSourceCandidate(role, source);
    expect(checked.reject).toBe(false);
    expect(checked.candidate.value).toMatchObject({
      title: "Registered Nurse, Pediatrics",
    });
    expect(apply(reconcile([role], source)).profile.experiences).toHaveLength(
      1,
    );
  });
  test("keeps an ambiguous undated specialty with an employer available for review", () => {
    const source = createTestBundle({
      fullText: "Experience\nRegistered Nurse, Pediatrics\nCedar Clinic",
    });
    const checked = validateResumeImportSourceCandidate(
      candidate("experience", "record", {
        title: "Registered Nurse, Pediatrics",
        companyName: "Cedar Clinic",
      }),
      source,
    );
    expect(checked.reject).toBe(false);
    expect(checked.review).toBe(true);
  });
  test("rejects a bare location with the next job's bullets", () => {
    const source = createTestBundle({
      fullText:
        "Experience\nColumbus, OH\nOperations Assistant at Northwind Freight\n2021 - Present\n- Scheduled fictional shipments.",
    });
    expect(
      validateResumeImportSourceCandidate(
        candidate("experience", "record", {
          title: "Columbus, OH",
          companyName: null,
          startDate: null,
          endDate: null,
          achievements: ["Scheduled fictional shipments."],
        }),
        source,
      ).reject,
    ).toBe(true);
  });
  test("rejects a location directly under a role even if it borrowed the employer and dates", () => {
    const source = createTestBundle({
      fullText:
        "Experience\nRegistered Nurse at Cedar Clinic\nColumbus, OH\n2021 - 2025\n- Provided care for synthetic patients.",
    });
    expect(
      validateResumeImportSourceCandidate(
        candidate("experience", "record", {
          title: "Columbus, OH",
          companyName: "Cedar Clinic",
          startDate: "2021",
          endDate: "2025",
        }),
        source,
      ).reject,
    ).toBe(true);
  });
});

test("a specialty headline in the header is not contact location evidence", () => {
  const source = createTestBundle({
    fullText:
      "Taylor Example\nRegistered Nurse, Pediatrics\nColumbus, OH\nExperience\nRegistered Nurse, Pediatrics\nCedar Clinic\n2021 - 2025",
  });
  const location = candidate("location", "currentLocation", "Columbus, OH");
  const role = candidate("experience", "record", {
    title: "Registered Nurse, Pediatrics",
    companyName: "Cedar Clinic",
    startDate: "2021",
    endDate: "2025",
  });
  expect(
    validateResumeImportSourceCandidate(role, source, [location, role]).reject,
  ).toBe(false);
  expect(
    validateResumeImportSourceCandidate(
      candidate("experience", "record", {
        title: "Columbus, OH",
        companyName: "Cedar Clinic",
        startDate: "2021",
        endDate: "2025",
      }),
      source,
      [location, role],
    ).reject,
  ).toBe(true);
});

test("a bullet mentioning a manager is not a role header above a specialty", () => {
  const source = createTestBundle({
    fullText:
      "Experience\n- Reported progress to the manager.\nRegistered Nurse, Pediatrics\nCedar Clinic\n2021 - 2025",
  });
  const role = candidate("experience", "record", {
    title: "Registered Nurse, Pediatrics",
    companyName: "Cedar Clinic",
    startDate: "2021",
    endDate: "2025",
  });
  expect(validateResumeImportSourceCandidate(role, source).reject).toBe(false);
});
