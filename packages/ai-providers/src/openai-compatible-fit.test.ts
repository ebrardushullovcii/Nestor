import { describe, expect, test } from "vitest";
import { SourceIntelligenceArtifactSchema } from "@nestor/contracts";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";

import {
  buildFitEvidenceInstructions,
  buildJobFitAssessmentPayload,
  buildJobFitJudgingPayload,
  buildJobFitJudgingRequest,
  buildJobFitJudgingPrompt,
  normalizeJobFitJudgments,
} from "./openai-compatible-fit";

import {
  createProfile,
  createPreferences,
  createJobPosting,
  mockCapturingJsonFetch,
} from "./test-fixtures";

describe("batch fit judging", () => {
  test("gives both judges explicit country and office constraints (R3-017)", () => {
    const prompt = buildJobFitJudgingPrompt();
    expect(prompt).toContain(buildFitEvidenceInstructions());
    expect(prompt).toContain("never overrides a country restriction");
    expect(prompt).toContain("actual office city");
    const profile = createProfile();
    profile.answerBank.workAuthorization = "Canada only";
    profile.answerBank.visaSponsorship = "Required outside Canada";
    const payload = buildJobFitJudgingPayload({
      assessmentDate: "2026-10-04",
      profile,
      searchPreferences: createPreferences(),
      jobs: [],
    });
    expect(payload.person.workEligibility).toMatchObject({
      "Countries where you can work":
        profile.workEligibility.authorizedWorkCountries,
      "Need visa sponsorship":
        profile.workEligibility.requiresVisaSponsorship === null
          ? "Not known"
          : profile.workEligibility.requiresVisaSponsorship
            ? "Yes"
            : "No",
    });
    expect(payload.person.savedEligibilityAnswers.workAuthorization).toBe(
      "Canada only",
    );
  });
  test("keeps late requirements and labels sparse evidence provisional (R3-018)", () => {
    const posting = createJobPosting();
    posting.description =
      "About our company. ".repeat(100) + "Java and Dutch C1 are required.";
    const payload = buildJobFitJudgingPayload({
      assessmentDate: "2026-10-04",
      profile: createProfile(),
      searchPreferences: createPreferences(),
      jobs: [{ jobId: "one", posting }],
    });
    expect(payload.jobs[0]?.description).toContain("Java and Dutch C1");
    expect(payload.jobs[0]?.detailQuality).toBe(posting.detailQuality);
    expect(buildFitEvidenceInstructions()).toContain("do not claim strong fit");
  });
  test("includes saved availability and requires comparison of immediate starts (R3-052)", () => {
    const profile = createProfile();
    profile.answerBank.availability = "September";
    const payload = buildJobFitJudgingPayload({
      assessmentDate: "2026-10-04",
      profile,
      searchPreferences: createPreferences(),
      jobs: [],
    });
    expect(payload.person.savedEligibilityAnswers.availability).toBe(
      "September",
    );
    expect(buildFitEvidenceInstructions()).toContain(
      "ambiguous month without a year",
    );
  });
  test("does not infer a junior level from missing seniority (R3-204)", () => {
    expect(buildFitEvidenceInstructions()).toContain(
      "Missing seniority means level not confirmed",
    );
  });
  test("keeps the model's verdict as returned", () => {
    const [judgment] = normalizeJobFitJudgments(
      {
        judgments: [
          {
            jobId: "job_1",
            score: 81.6,
            recommendation: "strong_fit",
            role: "exact",
            roleExplanation:
              "This is the product design work you are looking for.",
            preferences: "aligned",
            locationReach: "in_area",
            reasons: ["Berlin, Germany is one of your places"],
            gaps: ["German C1 is required"],
            summary: "A product design role in Berlin that asks for German C1.",
          },
        ],
      },
      new Set(["job_1"]),
    );

    expect(judgment).toEqual({
      jobId: "job_1",
      score: 82,
      recommendation: "strong_fit",
      role: "exact",
      roleExplanation: "This is the product design work you are looking for.",
      preferences: "aligned",
      preferencesExplanation: null,
      locationReach: "in_area",
      reasons: ["Berlin, Germany is one of your places"],
      gaps: ["German C1 is required"],
      summary: "A product design role in Berlin that asks for German C1.",
      listingClosed: false,
      listingClosedEvidence: null,
    });
  });

  test("reads the job id under the key names models use", () => {
    const judgments = normalizeJobFitJudgments(
      {
        judgments: [
          { job_id: "job_1", score: 70, recommendation: "strong_fit" },
          { id: "job_2", score: 40, recommendation: "skip" },
        ],
      },
      new Set(["job_1", "job_2"]),
    );

    expect(judgments.map((judgment) => judgment.jobId)).toEqual([
      "job_1",
      "job_2",
    ]);
  });

  test("reads a closed listing with the words that say so", () => {
    const [judgment] = normalizeJobFitJudgments(
      {
        judgments: [
          {
            jobId: "job_1",
            score: 5,
            recommendation: "skip",
            listingClosed: true,
            listingClosedEvidence: "This position has been filled.",
          },
        ],
      },
      new Set(["job_1"]),
    );
    expect(judgment).toMatchObject({
      listingClosed: true,
      listingClosedEvidence: "This position has been filled.",
    });
  });

  test("drops entries for jobs it was not asked about or without a verdict", () => {
    const judgments = normalizeJobFitJudgments(
      {
        judgments: [
          { jobId: "job_other", score: 70, recommendation: "skip" },
          { jobId: "job_1", score: 70 },
          { jobId: "job_2", score: "64", recommendation: "skip", role: "x" },
          { jobId: "job_2", score: 99, recommendation: "strong_fit" },
        ],
      },
      new Set(["job_1", "job_2"]),
    );

    expect(judgments).toEqual([
      expect.objectContaining({ jobId: "job_2", score: 64, role: "unknown" }),
    ]);
  });

  test("reads a malformed answer as no verdicts", () => {
    expect(normalizeJobFitJudgments({ jobs: [] }, new Set(["job_1"]))).toEqual(
      [],
    );
    expect(normalizeJobFitJudgments(null, new Set(["job_1"]))).toEqual([]);
  });
});

test("bounds twenty-job batch evidence while keeping eligibility facts", () => {
  const profile = createProfile();
  profile.baseResume.textContent = "Synthetic imported resume. ".repeat(500);
  const posting = createJobPosting();
  posting.description =
    "Build reliable product interfaces. ".repeat(150) +
    "Java and Dutch C1 are required.";
  posting.minimumQualifications = Array.from(
    { length: 30 },
    (_, i) => `Requirement ${i}`,
  );
  posting.responsibilities = Array.from(
    { length: 20 },
    (_, i) => `Responsibility ${i}`,
  );
  posting.preferredQualifications = Array.from(
    { length: 20 },
    (_, i) => `Preferred ${i}`,
  );
  profile.projects = Array.from({ length: 20 }, (_, i) => ({
    id: `project_${i}`,
    name: "Project",
    projectType: null,
    summary: "Project facts ".repeat(200),
    role: "Developer",
    outcome: null,
    skills: ["React"],
    projectUrl: null,
    repositoryUrl: null,
    caseStudyUrl: null,
  }));
  profile.proofBank = Array.from({ length: 20 }, (_, i) => ({
    id: `proof_${i}`,
    title: "Proof",
    claim: "Saved facts ".repeat(100),
    heroMetric: null,
    supportingContext: null,
    roleFamilies: [],
    projectIds: [],
    linkIds: [],
  }));
  const payload = buildJobFitJudgingPayload({
    assessmentDate: "2026-10-04",
    profile,
    searchPreferences: createPreferences(),
    jobs: Array.from({ length: 20 }, (_, i) => ({
      jobId: `job_${i}`,
      posting,
    })),
  });
  expect(payload.jobs).toHaveLength(20);
  expect(payload.jobs[0]?.description.length).toBeLessThanOrEqual(3000);
  expect(payload.jobs[0]?.description).toContain("Java and Dutch C1");
  expect(payload.jobs[0]?.evidenceOmitted).toBe(true);
  expect(payload.jobs[0]?.requirements).toHaveLength(12);
  expect(payload.jobs[0]?.responsibilities).toHaveLength(8);
  expect(payload.jobs[0]?.preferredQualifications).toHaveLength(8);
  expect(payload.person).not.toHaveProperty("importedResumeText");
  expect(payload.person.projects).toHaveLength(8);
  expect(payload.person.proofBank).toHaveLength(8);
  expect(payload.person.workEligibility).toMatchObject({
    "Countries where you can work":
      profile.workEligibility.authorizedWorkCountries,
    "Need visa sponsorship":
      profile.workEligibility.requiresVisaSponsorship === null
        ? "Not known"
        : profile.workEligibility.requiresVisaSponsorship
          ? "Yes"
          : "No",
  });
  expect(buildJobFitJudgingPrompt()).toContain("bounded excerpts");
});

test("measures the twenty-job request against the previous uncapped shape", () => {
  const profile = createProfile();
  profile.baseResume.textContent =
    "Synthetic experience building accessible React interfaces and improving frontend delivery. ".repeat(
      120,
    );
  const posting = createJobPosting();
  posting.description =
    "Build product interfaces for customer workflows. Own the React component library, partner with design on accessibility, instrument usage analytics, and lead migration away from the legacy checkout surface. ".repeat(
      24,
    );
  const payload = buildJobFitJudgingPayload({
    assessmentDate: "2026-10-04",
    profile,
    searchPreferences: createPreferences(),
    jobs: Array.from({ length: 20 }, (_, i) => ({
      jobId: `job_${i}`,
      posting,
    })),
  });
  const previous = {
    ...payload,
    person: {
      ...payload.person,
      projects: profile.projects,
      proofBank: profile.proofBank,
      importedResumeText: profile.baseResume.textContent,
    },
    jobs: payload.jobs.map(({ evidenceOmitted, ...job }) => {
      expect(evidenceOmitted).toBe(true);
      return {
        ...job,
        description: posting.description,
        responsibilities: posting.responsibilities,
        requirements: posting.minimumQualifications,
        preferredQualifications: posting.preferredQualifications,
      };
    }),
  };
  const before = new TextEncoder().encode(JSON.stringify(previous)).length;
  const after = new TextEncoder().encode(JSON.stringify(payload)).length;
  console.info(
    `20-job synthetic batch JSON bytes: before=${before}, after=${after}`,
  );
  expect(after).toBeLessThan(before);
});

test("R3-065, R3-105 and R3-138 give the judge permit, schedule and OTE facts", () => {
  const profile = createProfile();
  profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "Student work, 20 hours during term",
      requiresFutureSponsorship: true,
    },
  ];
  const preferences = createPreferences();
  preferences.shiftPreference = "day";
  preferences.weeklyHours = { minimum: 20, maximum: 30 };
  preferences.compensation = {
    ...preferences.compensation,
    basis: "total_ote",
    minimum: 160000,
  };
  const posting = createJobPosting();
  posting.salaryText = "$80,000 base; $160,000 OTE";
  const payload = buildJobFitJudgingPayload({
    assessmentDate: "2026-10-05",
    profile,
    searchPreferences: preferences,
    jobs: [{ jobId: "ote", posting }],
  });
  expect(payload.person.workEligibility["Limited work permissions"]).toEqual([
    {
      Country: "Germany",
      Conditions: profile.workEligibility.limitedWorkPermissions[0]!.conditions,
      "Will need sponsorship later": "Yes",
    },
  ]);
  expect(payload.goals).toMatchObject({
    "Shift preference": "day",
    "Weekly hours": { Minimum: 20, Maximum: 30 },
    "Pay preference": {
      "Pay basis": "Total on-target earnings",
      Minimum: 160000,
    },
  });
  expect(payload.jobs[0]?.salaryText).toBe(posting.salaryText);
  const instructions = buildFitEvidenceInstructions();
  expect(instructions).toContain("Will need sponsorship later");
  expect(instructions).toContain("Explain conflicting shifts or weekly hours");
  expect(instructions).toContain(
    "meets a 160,000 total on-target earnings floor, but not a 160,000 base salary floor",
  );
});

test("fit inputs label personal facts and preferences in plain words", () => {
  const profile = createProfile();
  profile.workEligibility.willingToRelocate = false;
  profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "Part-time study permit",
      requiresFutureSponsorship: true,
    },
  ];
  const payload = buildJobFitJudgingPayload({
    assessmentDate: "2026-10-05",
    profile,
    searchPreferences: createPreferences(),
    jobs: [],
  });
  expect(payload.person.workEligibility["Willing to relocate"]).toBe("No");
  expect(
    payload.person.workEligibility["Limited work permissions"][0]?.[
      "Will need sponsorship later"
    ],
  ).toBe("Yes");
  expect(JSON.stringify(payload)).not.toMatch(
    /willingToRelocate|requiresFutureSponsorship|remoteCountsAsAnyLocation/,
  );
  expect(buildJobFitJudgingPrompt()).toContain(
    "never field names, key=value text or true/false flags",
  );
});

test("batch dates and jobs follow the reusable person and goals prefix", () => {
  const input = {
    assessmentDate: "2026-10-21",
    profile: createProfile(),
    searchPreferences: createPreferences(),
    jobs: [{ jobId: "first", posting: createJobPosting() }],
  };
  const first = JSON.stringify(buildJobFitJudgingPayload(input));
  const next = JSON.stringify(
    buildJobFitJudgingPayload({
      ...input,
      assessmentDate: "2026-10-22",
      jobs: [{ jobId: "second", posting: createJobPosting() }],
    }),
  );
  const prefix = first.slice(0, first.indexOf(',"assessmentDate"'));
  expect(prefix).toContain('"person"');
  expect(prefix).toContain('"goals"');
  expect(next.startsWith(prefix)).toBe(true);
});

test("columnar batch inputs keep every job field and all supplied evidence", () => {
  const first = createJobPosting();
  first.minimumQualifications = ["Dutch C1", "Java", "Security clearance"];
  first.description =
    "Read this complete listing, including its last condition.";
  const input = {
    assessmentDate: "2026-10-21",
    profile: createProfile(),
    searchPreferences: createPreferences(),
    jobs: Array.from({ length: 20 }, (_, index) => ({
      jobId: String(index),
      posting: {
        ...first,
        title: `Role ${index}`,
        salaryText: index ? null : "$90,000",
      },
    })),
  };
  const { jobs, ...context } = buildJobFitJudgingPayload(input);
  const {
    jobColumns,
    jobs: rows,
    ...wireContext
  } = buildJobFitJudgingRequest(input);
  expect(wireContext).toEqual(context);
  expect(
    rows.map((row) =>
      Object.fromEntries(
        jobColumns.map((column, index) => [column, row[index]]),
      ),
    ),
  ).toEqual(jobs);
  expect(JSON.stringify(buildJobFitJudgingRequest(input)).length).toBeLessThan(
    JSON.stringify(buildJobFitJudgingPayload(input)).length,
  );
  expect(buildJobFitJudgingRequest({ ...input, jobs: [] }).jobs).toEqual([]);
});

test("short batch ids map only to this request's jobs without changing verdicts", async () => {
  const verdict = {
    jobId: "1",
    score: 43,
    recommendation: "skip",
    role: "adjacent",
    roleExplanation: "You have related experience.",
    preferences: "conflict",
    preferencesExplanation: "You cannot work from this country.",
    locationReach: "outside_area",
    reasons: ["You know the required tools."],
    gaps: ["You lack permission to work there."],
    summary: "Your work permission does not cover this country.",
    listingClosed: true,
    listingClosedEvidence: "This listing is closed.",
  };
  const mock = mockCapturingJsonFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            judgments: [
              verdict,
              { ...verdict, score: 99 }, // Duplicate, first answer stands.
              { ...verdict, jobId: "2" }, // Outside this batch.
              { ...verdict, jobId: "workspace_id_one" }, // No id aliasing.
            ],
          }),
        },
      },
    ],
  });
  try {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "synthetic-key",
      baseUrl: "https://example.com/v1",
      model: "synthetic-model",
      streaming: false,
      maxAttempts: 1,
    });
    const input = {
      assessmentDate: "2026-10-21",
      profile: createProfile(),
      searchPreferences: createPreferences(),
      jobs: [
        { jobId: "workspace_id_one", posting: createJobPosting() },
        { jobId: "workspace_id_two", posting: createJobPosting() },
      ],
    };
    const result = await client.judgeJobFits!(input);
    const body = JSON.parse(mock.getCapturedBody()) as {
      messages: Array<{ role: string; content: string }>;
    };
    const sent = JSON.parse(
      body.messages.find((message) => message.role === "user")!.content,
    ) as ReturnType<typeof buildJobFitJudgingRequest>;
    expect(sent).toEqual(
      buildJobFitJudgingRequest({
        ...input,
        jobs: input.jobs.map((job, index) => ({
          ...job,
          jobId: String(index),
        })),
      }),
    );
    expect(result).toEqual([{ ...verdict, jobId: "workspace_id_two" }]);
    const next = await client.judgeJobFits!({
      ...input,
      jobs: input.jobs.map((job) => ({ ...job, jobId: `next_${job.jobId}` })),
    });
    expect(next).toEqual([{ ...verdict, jobId: "next_workspace_id_two" }]);
  } finally {
    mock.restore();
  }
});

test("an oversized batch fails before sending rather than truncating column positions", async () => {
  const mock = mockCapturingJsonFetch({});
  try {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "synthetic-key",
      baseUrl: "https://example.com/v1",
      model: "synthetic-model",
      contextWindowTokens: 16_000,
      streaming: false,
      maxAttempts: 1,
    });
    await expect(
      client.judgeJobFits!({
        assessmentDate: "2026-10-21",
        profile: createProfile(),
        searchPreferences: createPreferences(),
        jobs: Array.from({ length: 20 }, (_, index) => ({
          jobId: `job_${index}`,
          posting: {
            ...createJobPosting(),
            description: "Complete listing evidence. ".repeat(120),
          },
        })),
      }),
    ).rejects.toThrow("no candidate facts or listing details were omitted");
    expect(mock.getCapturedBody()).toBe("");
  } finally {
    mock.restore();
  }
});

test("the full listing judge gets plain preferences and keeps all listing and profile evidence", () => {
  const profile = createProfile();
  profile.workEligibility.willingToRelocate = false;
  profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "20 hours during term",
      requiresFutureSponsorship: true,
    },
  ];
  const preferences = createPreferences();
  preferences.companyBlacklist = ["Synthetic excluded company"];
  const job = createJobPosting();
  const payload = buildJobFitAssessmentPayload({
    assessmentDate: "2026-10-05",
    profile,
    searchPreferences: preferences,
    job,
  });
  expect(payload.profile.workEligibility["Willing to relocate"]).toBe("No");
  expect(
    payload.profile.workEligibility["Limited work permissions"][0]?.[
      "Will need sponsorship later"
    ],
  ).toBe("Yes");
  expect(payload.searchPreferences["Companies to exclude"]).toEqual(
    preferences.companyBlacklist,
  );
  expect(payload).toEqual(JSON.parse(JSON.stringify(payload)));
  expect({
    ...payload.job,
    sourceIntelligence: job.sourceIntelligence,
    listingDetailFetch: job.listingDetailFetch,
  }).toEqual(job);
  const kept = profile.experiences.filter((experience) => !experience.isDraft);
  expect(payload.profile.experiences).toHaveLength(kept.length);
  for (const [index, experience] of kept.entries())
    expect(payload.profile.experiences[index]).toMatchObject({
      id: experience.id,
      title: experience.title,
      achievements: experience.achievements,
      skills: experience.skills,
    });
  expect(payload.profile.resumeText).toBe(profile.baseResume.textContent);
  expect(JSON.stringify(payload)).not.toMatch(
    /willingToRelocate|requiresFutureSponsorship|remoteCountsAsAnyLocation/,
  );
  expect(buildFitEvidenceInstructions()).toContain(
    "never field names, key=value text or true/false flags",
  );
});

test("a full fit request keeps current evidence and goals while excluding saved sightings and source diagnostics", async () => {
  const profile = createProfile();
  profile.summary = "Full saved candidate fact. ".repeat(100);
  profile.baseResume.textContent = "Full imported resume fact. ".repeat(300);
  const preferences = createPreferences();
  const source = preferences.discovery.targets[0]!;
  preferences.discovery.targets = Array.from({ length: 897 }, (_, index) => ({
    ...source,
    id: `source_${index}`,
    customInstructions: `SEARCH_CATALOG_ONLY_${index}`,
  }));
  preferences.discovery.remoteCountsAsAnyLocation = false;
  preferences.locations = ["Kosovo"];
  const job = {
    ...createJobPosting(),
    description:
      "Complete current listing. ".repeat(500) + "Required: Dutch C1.",
    minimumQualifications: Array.from(
      { length: 25 },
      (_, index) => `Current qualification ${index}`,
    ),
    sourceIntelligence: SourceIntelligenceArtifactSchema.parse({
      reliability: {
        failureFingerprints: ["SOURCE_DIAGNOSTICS_ONLY".repeat(100)],
      },
    }),
    id: "saved_job",
    campaignIds: ["campaign_one"],
    matchAssessment: { summary: "OLD_ASSESSMENT_ONLY", score: 99 },
    provenance: Array.from({ length: 12 }, (_, index) => ({
      targetId: `source_${index}`,
      adapterKind: "auto",
      startingUrl: `https://example.com/${index}`,
      discoveredAt: "2026-10-13T10:00:00.000Z",
      listingFacts: {
        title: "Old title",
        company: "Old company",
        location: "Old place",
        salaryText: null,
        seniority: null,
        summary: null,
        description: "OLD_SOURCE_HISTORY_ONLY".repeat(1_000),
      },
    })),
  };
  const mock = mockCapturingJsonFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            score: 81,
            reasons: ["Current model verdict"],
            gaps: [],
          }),
        },
      },
    ],
  });
  try {
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "synthetic-key",
      baseUrl: "https://example.com/v1",
      model: "synthetic-model",
      apiMode: "chat_completions",
      streaming: false,
      maxAttempts: 1,
    });
    const result = await client.assessJobFit({
      assessmentDate: "2026-10-13",
      profile,
      searchPreferences: preferences,
      job,
    });
    const body = JSON.parse(mock.getCapturedBody()) as {
      messages: Array<{ role: string; content: string }>;
    };
    const payload = JSON.parse(
      body.messages.find((message) => message.role === "user")!.content,
    ) as {
      profile: { summary: string; resumeText: string | null };
      job: typeof job;
      searchPreferences: Record<string, unknown>;
    };
    expect(payload.profile.summary).toBe(profile.summary);
    expect(payload.profile.resumeText).toBe(profile.baseResume.textContent);
    expect(payload.job.description).toBe(job.description);
    expect(payload.job.minimumQualifications).toEqual(
      job.minimumQualifications,
    );
    expect(payload.searchPreferences["Preferred places"]).toEqual(["Kosovo"]);
    expect(
      payload.searchPreferences["Remote work can be outside preferred places"],
    ).toBe("No");
    expect(JSON.stringify(payload)).not.toMatch(
      /SEARCH_CATALOG_ONLY|SOURCE_DIAGNOSTICS_ONLY|OLD_ASSESSMENT_ONLY|OLD_SOURCE_HISTORY_ONLY/,
    );
    expect(payload.job).not.toHaveProperty("provenance");
    expect(payload.job).not.toHaveProperty("sourceIntelligence");
    expect(payload.job).not.toHaveProperty("listingDetailFetch");
    expect(result?.score).toBe(81);
  } finally {
    mock.restore();
  }
});
