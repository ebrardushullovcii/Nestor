import { ResumeDraftSchema } from "@nestor/contracts";
import { resumeClaimContentHash } from "@nestor/job-finder/resumes";
import { describe, expect, it } from "vitest";

import {
  RESUME_LANE_CASES,
  readPersonaResume,
  readRecordedListings,
} from "./cases";

import type { EvalHttpCapture } from "../contracts";
import {
  assessFacts,
  flagsLeft,
  inventedFacts,
  levelVerdicts,
  levelShape,
  workHistoryProblem,
  writingProblems,
} from "./checks";
import {
  formatResumeLaneReport,
  rescoreResumeLane,
  scoreCase,
  stretchCheckReport,
  tokensUsed,
} from "./run";

const AT = "2026-10-26T00:00:00.000Z";
const SOURCE = `CASEY ROWAN
Senior Software Engineer
casey.rowan@example.test | Portland, Oregon

EXPERIENCE
Principal Frontend Engineer - Northstar Parcel Software
March 2021-Present
- Led architecture for a React and TypeScript platform used by 18 product teams.

SKILLS
React, TypeScript, accessibility`;
const LISTING =
  "You will build dashboards in React. Experience with Kubernetes and Go is a plus. Datadog monitors everything.";

it.each(["original", "light", "tailored", "aggressive"] as const)(
  "%s fails when every work-history entry or its section is hidden",
  (level) => {
    for (const hideSection of [false, true]) {
      const value = draft([]);
      value.sections[0]!.included = !hideSection;
      value.sections[0]!.entries[0]!.included = hideSection;
      const result = scoreCase(RESUME_LANE_CASES[0]!, [
        {
          level,
          draft: value,
          error: null,
          seconds: 0,
          modelCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
        },
      ])[0]!;
      expect(result.shape.workHistory?.expected).toBeGreaterThan(0);
      expect(result.shape.workHistory?.visible).toBe(0);
      expect(result.levelProblem).toMatch(/Dropped all work history/);
    }
  },
);

it("does not invent a work-history requirement for a person without roles", () => {
  const shape = levelShape({
    draft: draft([]),
    source: SOURCE,
    listing: LISTING,
    title: "Engineer",
    expectedExperienceIds: [],
  });
  expect(workHistoryProblem(shape)).toBeNull();
});

function draft(bullets: string[], headline = "Senior Software Engineer") {
  const bullet = (text: string, index: number) => ({
    id: `b${index}`,
    text,
    origin: "ai_generated",
    updatedAt: AT,
  });
  return ResumeDraftSchema.parse({
    id: "draft",
    jobId: "1",
    status: "draft",
    templateId: "classic_ats",
    identity: { headline },
    sections: [
      {
        id: "experience",
        kind: "experience",
        label: "Experience",
        origin: "ai_generated",
        sortOrder: 0,
        updatedAt: AT,
        entries: [
          {
            id: "e1",
            entryType: "experience",
            title: "Principal Frontend Engineer",
            subtitle: "Northstar Parcel Software",
            dateRange: "Mar 2021 – Present",
            origin: "ai_generated",
            sortOrder: 0,
            updatedAt: AT,
            bullets: bullets.map(bullet),
          },
        ],
      },
    ],
    createdAt: AT,
    updatedAt: AT,
  });
}

describe("resume lane checks", () => {
  it("finds a number and a listing tool the person never claimed, and nothing else", () => {
    const found = inventedFacts({
      draft: draft([
        "Led architecture for a React and TypeScript platform used by 18 product teams.",
        "Ran Kubernetes clusters serving 40 services.",
      ]),
      source: SOURCE,
      listing: LISTING,
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
    });
    expect(found.map((fact) => `${fact.kind}:${fact.value}`)).toEqual([
      "number:40",
      "name:Kubernetes",
    ]);
  });

  it("reports listing technologies as Aggressive stretches, and rejects an absent technology", () => {
    const input = {
      draft: draft([
        "Built services with Kubernetes.",
        "Built services with MongoDB.",
      ]),
      source: SOURCE,
      listing: LISTING,
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
      level: "aggressive" as const,
    };
    const result = assessFacts(input);
    expect(result.stretches.map((fact) => fact.value)).toEqual(["Kubernetes"]);
    expect(result.invented.map((fact) => fact.value)).toEqual(["MongoDB"]);
    expect(
      inventedFacts({ ...input, level: "tailored" }).map((fact) => fact.value),
    ).toContain("Kubernetes");
  });

  it("only rounds evidenced years one higher to a figure the listing asks for, never counts or percentages", () => {
    const input = {
      draft: draft([
        "Engineer with six years of experience serving 6 teams and improving throughput 6%.",
      ]),
      source: SOURCE + "\nFive years of experience.",
      listing: LISTING + " Requires 6 years of experience.",
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
      level: "aggressive" as const,
    };
    expect(assessFacts(input).stretches.map((fact) => fact.value)).toEqual([
      "6",
    ]);
    expect(assessFacts(input).invented.map((fact) => fact.value)).toEqual([
      "6",
      "6%",
    ]);
    expect(assessFacts({ ...input, listing: LISTING }).stretches).toEqual([]);
    expect(
      assessFacts({
        ...input,
        draft: draft(["Engineer with seven years of experience."]),
      }).invented.map((fact) => fact.value),
    ).toEqual(["7"]);
  });

  it("detects changed record identities and unbacked leadership and reviewed hiring-domain transfer", () => {
    const value = draft(["Managed clinical patient systems."]);
    const entry = value.sections[0]!.entries[0]!;
    entry.title = "Engineering Director";
    entry.subtitle = "Invented Employer";
    entry.dateRange = "Apr 2020 � Present";
    const result = assessFacts({
      draft: value,
      source:
        "Individual contributor.\n" +
        SOURCE.replace("Led architecture", "Built architecture"),
      listing: "Build clinical patient systems.",
      title: "Frontend Engineer",
      company: "Health Systems",
      yearsExperience: 5,
      level: "aggressive",
      hiringDomainTerms: ["clinical patient"],
    });
    expect(result.invented.map((fact) => fact.kind)).toContain("entry");
    expect(result.invented.map((fact) => fact.kind)).toContain("leadership");
    expect(result.invented.map((fact) => fact.kind)).toContain("domain");
    expect(result.invented.map((fact) => fact.value)).toContain(
      "engineering director",
    );
    expect(result.invented.map((fact) => fact.value)).toContain(
      "invented employer",
    );
  });

  it("keeps a model-flagged stretch separate and ignores lowercase words that resemble listing names", () => {
    const text = "Built a self-serve workflow.";
    const value = draft([text]);
    value.claimChecks = [
      {
        contentHash: resumeClaimContentHash(text),
        verdict: "stretch",
        reason: "Plausible detail.",
        evidenceIds: [],
        fix: null,
        evidenceKey: null,
        checkedAt: AT,
      },
    ];
    const result = assessFacts({
      draft: value,
      source: SOURCE,
      listing: "Build systems. Serve customers.",
      title: "Frontend Engineer",
      company: "Example",
      yearsExperience: 5,
      level: "aggressive",
    });
    expect(result.invented).toEqual([]);
    expect(result.stretches).toEqual([
      { kind: "model", value: "Plausible detail.", line: text, flagged: true },
    ]);
  });

  it("uses reviewed technology names, keeping UI/UX wording out and listing credentials hard", () => {
    const input = {
      draft: draft([
        "Built shared UI/UX with MongoDB.",
        "Earned RHCE certification.",
      ]),
      source: SOURCE,
      listing: LISTING + " RHCE preferred.",
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
      level: "aggressive" as const,
      technologyNames: ["Kubernetes", "MongoDB"],
      credentialNames: ["RHCE"],
    };
    expect(
      assessFacts(input).invented.map((fact) => `${fact.kind}:${fact.value}`),
    ).toEqual(["name:MongoDB", "credential:RHCE"]);
    expect(
      assessFacts({
        ...input,
        source: SOURCE + " RHCE certification.",
      }).invented.map((fact) => fact.value),
    ).toEqual(["MongoDB"]);
  });

  it("does not turn Marketing or Marketo into the month March, and reads compound/case aliases once", () => {
    const result = assessFacts({
      draft: draft(["Led campaigns with Marketo and CI/CD and DBT."]),
      source: "Marketing manager.",
      listing: "Uses Marketo, CI/CD and DBT.",
      title: "Manager",
      company: "Example",
      yearsExperience: 5,
      level: "aggressive",
      technologyNames: ["Marketo", "CI/CD", "DBT", "dbt"],
    });
    expect(
      result.stretches.map((line) => line.value.toLowerCase()).sort(),
    ).toEqual(["ci/cd", "dbt", "marketo"]);
  });

  it("does not count the role as Aggressive's headline as a claim", () => {
    expect(
      inventedFacts({
        draft: draft(["Led architecture for a React platform."], "Go Engineer"),
        source: SOURCE,
        listing: LISTING,
        title: "Frontend Engineer",
        company: "Datadog",
        yearsExperience: 5,
      }),
    ).toEqual([]);
  });

  it("counts only flagged lines the finished draft still prints", () => {
    const kept = "Ran Kubernetes clusters.";
    const value = {
      ...draft([kept]),
      claimChecks: [kept, "A line that was left off."].map((text) => ({
        contentHash: resumeClaimContentHash(text),
        verdict: "unsupported" as const,
        reason: "",
        evidenceIds: [],
        fix: null,
        evidenceKey: null,
        checkedAt: AT,
      })),
    };
    expect(flagsLeft(value)).toEqual([`unsupported: ${kept}`]);
  });

  it("says when a level does not behave as named", () => {
    const shape = (editSize: number, headline: string, inventedCount = 0) => ({
      editSize,
      truthfulKeywordCoverage: 0.5,
      headline,
      unchanged: false,
      inventedCount,
    });
    expect(
      levelVerdicts(
        {
          original: { ...shape(0, ""), unchanged: true },
          light: shape(0.4, "Senior Software Engineer"),
          tailored: shape(0.3, "Senior Software Engineer"),
          aggressive: shape(0.6, "Staff Software Engineer", 2),
        },
        "Senior Software Engineer",
        "Staff Software Engineer - Frontend",
      ),
    ).toEqual({
      original: null,
      light: "Light edited 40% of words (at most 25%).",
      tailored: "Tailored edited 30%, no more than Light's 40%.",
      aggressive: "2 invented facts.",
    });
  });
});

it("counts tokens from chat completions and from the Responses API's completed event", () => {
  const capture = (responseBody: string) =>
    ({ responseBody }) as unknown as EvalHttpCapture;
  expect(
    tokensUsed([
      capture('{"usage":{"prompt_tokens":10,"completion_tokens":2}}'),
      capture(
        'data: {"type":"response.output_text.delta","delta":"x"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":4}}}\n\ndata: [DONE]\n',
      ),
    ]),
  ).toEqual({ prompt: 40, completion: 6 });
});

it("measures inferred listing and years stretches removed or flagged by the unchanged checker", () => {
  const tech = "Built services with Kubernetes.";
  const years = "Engineer with six years of experience.";
  const unflagged = "Built services with Go.";
  const finalDraft = draft([tech]);
  const ordinaryStretch = "Reliable collaborator.";
  finalDraft.claimChecks = [
    {
      contentHash: resumeClaimContentHash(ordinaryStretch),
      verdict: "stretch",
      reason:
        "Plausible detail, not a sanctioned technology or years rounding.",
      evidenceIds: [],
      fix: null,
      evidenceKey: null,
      checkedAt: AT,
    },
  ];
  const capture = (request: unknown, responseBody: string) =>
    ({ requestBody: JSON.stringify(request), responseBody }) as EvalHttpCapture;
  const writer = capture(
    {},
    "data: " +
      JSON.stringify({
        type: "response.completed",
        response: {
          output: [
            {
              type: "function_call",
              name: "compose_resume_proposal",
              arguments: JSON.stringify({
                proposal: {
                  experienceEntries: [
                    {
                      bullets: [
                        { text: tech, inferred: true },
                        { text: years, inferred: true },
                        { text: ordinaryStretch, inferred: true },
                      ],
                    },
                  ],
                },
              }),
            },
          ],
        },
      }) +
      "\n\n",
  );
  const checker = capture(
    {
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            claims: [
              { id: "line_1", text: tech },
              { id: "line_2", text: years },
              { id: "line_3", text: unflagged },
              { id: "line_4", text: ordinaryStretch },
            ],
          }),
        },
      ],
    },
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              checks: [
                { id: "line_1", verdict: "stretch", reason: "Listing tool." },
                {
                  id: "line_4",
                  verdict: "stretch",
                  reason: "Plausible detail.",
                },
                {
                  id: "line_2",
                  verdict: "unsupported",
                  reason: "Rounded year.",
                },
                {
                  id: "line_3",
                  verdict: "unsupported",
                  reason: "Unbacked tool.",
                },
              ],
            }),
          },
        },
      ],
    }),
  );
  const result = stretchCheckReport({
    draft: finalDraft,
    captures: [writer, checker],
    source: SOURCE + " Five years of experience.",
    listing: LISTING + " Requires 6 years of experience.",
    title: "Frontend Engineer",
    company: "Datadog",
    yearsExperience: 5,
  });
  // Released Aggressive intentionally never calls the model checker. Its
  // inferred lines still count as stretches, not missed checker requests.
  const writerOnly = stretchCheckReport({
    draft: finalDraft,
    captures: [writer],
    source: SOURCE + " Five years of experience.",
    listing: LISTING + " Requires 6 years of experience.",
    title: "Frontend Engineer",
    company: "Datadog",
    yearsExperience: 5,
  });
  expect(writerOnly.traceAvailable).toBe(true);
  expect(writerOnly.checkerInvoked).toBe(false);
  expect(writerOnly.sanctioned).toHaveLength(2);
  expect(
    writerOnly.sanctioned.every(
      (line) =>
        !line.checked &&
        !line.flagged &&
        !line.missingBeforeCheck &&
        !line.unanswered,
    ),
  ).toBe(true);
  // Duplicate events/retries must not duplicate findings or reuse another request's line ids.
  expect(
    stretchCheckReport({
      draft: finalDraft,
      captures: [writer, checker, checker],
      source: SOURCE + " Five years of experience.",
      listing: LISTING + " Requires 6 years of experience.",
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
    }).sanctioned,
  ).toHaveLength(2);
  const noAnswer = { ...checker, responseBody: null };
  const partial = stretchCheckReport({
    draft: finalDraft,
    captures: [writer, noAnswer],
    source: SOURCE + " Five years of experience.",
    listing: LISTING + " Requires 6 years of experience.",
    title: "Frontend Engineer",
    company: "Datadog",
    yearsExperience: 5,
  });
  expect(
    partial.sanctioned.every(
      (line) => line.unanswered && !line.missingBeforeCheck,
    ),
  ).toBe(true);
  const retried = stretchCheckReport({
    draft: finalDraft,
    captures: [writer, noAnswer, checker],
    source: SOURCE + " Five years of experience.",
    listing: LISTING + " Requires 6 years of experience.",
    title: "Frontend Engineer",
    company: "Datadog",
    yearsExperience: 5,
  });
  expect(retried.sanctioned.every((line) => !line.unanswered)).toBe(true);
  expect(result.traceAvailable).toBe(true);
  expect(result.checkerInvoked).toBe(true);
  expect(
    result.sanctioned.map((line) => ({
      text: line.text,
      flagged: line.flagged,
      removed: line.removed,
    })),
  ).toEqual([
    { text: tech, flagged: true, removed: false },
    { text: years, flagged: true, removed: true },
  ]);
  expect(result.unflaggedListingLines).toEqual([unflagged]);
  expect(
    stretchCheckReport({
      draft: finalDraft,
      source: SOURCE,
      listing: LISTING,
      title: "Frontend Engineer",
      company: "Datadog",
      yearsExperience: 5,
    }).traceAvailable,
  ).toBe(false);
});

it("rescoring an empty or singleton released recording is idempotent", () => {
  expect(rescoreResumeLane([])).toEqual([]);
  const rows = scoreCase(RESUME_LANE_CASES[0]!, [
    {
      level: "original",
      draft: null,
      error: null,
      seconds: 0,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
    },
  ]);
  expect(rescoreResumeLane(rescoreResumeLane(rows))).toEqual(rows);
});

describe("writing problems", () => {
  const roles = [
    { title: "Operations Manager", company: "Atlântico Logística" },
    { title: "Working Student, Data Analytics", company: "Mobilo GmbH" },
  ];
  const section = (
    kind: string,
    label: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: kind,
    kind,
    label,
    origin: "ai_generated",
    sortOrder: 0,
    updatedAt: AT,
    ...extra,
  });
  const bullets = (...texts: string[]) =>
    texts.map((text, index) => ({
      id: `${text}-${index}`,
      text,
      origin: "ai_generated",
      updatedAt: AT,
    }));
  const project = (summary: string, label = "Projects") =>
    section("projects", label, {
      entries: [
        {
          id: "p1",
          entryType: "project",
          title: "Community event",
          summary,
          origin: "ai_generated",
          sortOrder: 0,
          updatedAt: AT,
        },
      ],
    });
  const written = (...sections: ReturnType<typeof section>[]) =>
    ResumeDraftSchema.parse({
      id: "draft",
      jobId: "1",
      status: "draft",
      templateId: "classic_ats",
      sections,
      createdAt: AT,
      updatedAt: AT,
    });
  const problems = (
    draft: ReturnType<typeof written>,
    options: { level?: "light" | "aggressive"; language?: string } = {},
  ) =>
    writingProblems({
      draft,
      level: options.level ?? "light",
      roles,
      language: options.language,
    });

  it("flags a summary that only restates a role, in English or German, but not a real summary", () => {
    for (const label of [
      "Operations Manager at Atlântico Logística.",
      "Working Student, Data Analytics at Mobilo GmbH.",
      "Werkstudent bei Mobilo GmbH.",
      "Operations Manager",
    ])
      expect(
        problems(written(section("summary", "Summary", { text: label }))),
      ).toEqual([`summary is only a role label: ${label}`]);
    for (const text of [
      "Operations manager with ten years of experience leading service teams at Atlântico Logística.",
      "Led a 24-person team. Reduced missed appointments at Atlântico Logística.",
      "Data analytics student who built dashboards for a logistics team.",
    ])
      expect(
        problems(written(section("summary", "Summary", { text }))),
      ).toEqual([]);
  });

  it("flags a project line that starts a sentence with Technologies:, and accepts the neutral label", () => {
    expect(
      problems(
        written(
          project(
            "Organized a community event. Technologies: writing, event timetable.",
          ),
        ),
      ),
    ).toEqual([
      'project line starts with "Technologies:": Organized a community event. Technologies: writing, event timetable.',
    ]);
    expect(
      problems(written(project("Technologies: Microsoft Excel."))),
    ).toHaveLength(1);
    expect(
      problems(
        written(
          project(
            "Organized a community event. Skills used: writing, planning.",
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      problems(
        written(
          section("summary", "Summary", {
            text: "Built tools. Technologies: React.",
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("flags section headings and project labels left in English in a non-English case only", () => {
    const draft = written(
      section("skills", "SKILLS", { bullets: bullets("Power BI") }),
      section("keywords", "KERNKOMPETENZEN", {
        bullets: bullets("Terminplanung"),
      }),
      section("experience", "Work Experience"),
      project(
        "Organisierte eine Veranstaltung. Skills used: Planung.",
        "Projekte",
      ),
    );
    expect(problems(draft, { language: "German" })).toEqual([
      "skills heading left in English: SKILLS",
      "experience heading left in English: Work Experience",
      "project label left in English (skills used): Organisierte eine Veranstaltung. Skills used: Planung.",
    ]);
    expect(problems(draft)).toEqual([]);
    expect(problems(draft, { language: "English" })).toEqual([]);
    expect(
      problems(
        written(
          section("skills", "Kenntnisse", { bullets: bullets("Power BI") }),
          section("experience", "Berufserfahrung"),
        ),
        { language: "German" },
      ),
    ).toEqual([]);
  });

  it("flags a skill item that ends with a full stop, and keeps names like Node.js", () => {
    expect(
      problems(
        written(
          section("skills", "Skills", {
            text: "React, TypeScript.",
            bullets: bullets("Power BI.", "Node.js", "Excel"),
          }),
        ),
      ),
    ).toEqual([
      "skill item ends with a full stop: TypeScript.",
      "skill item ends with a full stop: Power BI.",
    ]);
  });

  it("does not judge Aggressive, a hidden section or an Original that sent the file unchanged", () => {
    const bad = written(
      section("summary", "Summary", { text: "Operations Manager" }),
      section("skills", "SKILLS", { bullets: bullets("Power BI.") }),
    );
    expect(problems(bad, { level: "aggressive", language: "German" })).toEqual(
      [],
    );
    expect(
      problems(
        written(
          section("skills", "SKILLS", {
            included: false,
            bullets: bullets("Power BI."),
          }),
        ),
        { language: "German" },
      ),
    ).toEqual([]);
    expect(writingProblems({ draft: null, level: "original", roles })).toEqual(
      [],
    );
  });

  it("reports findings with the score instead of failing it, Aggressive's stretches untouched", () => {
    const evalCase = RESUME_LANE_CASES.find(
      (candidate) => candidate.id === "claims-german",
    )!;
    const value = written(
      section("summary", "Summary", {
        text: "Healthcare Administrative Assistant",
      }),
      section("skills", "SKILLS", { bullets: bullets("Terminplanung.") }),
    );
    const scored = (levels: readonly ("light" | "aggressive")[]) =>
      scoreCase(
        evalCase,
        levels.map((level) => ({
          level,
          draft: value,
          error: null,
          seconds: 0,
          modelCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
        })),
      );
    const rows = scored(["light", "aggressive"]);
    expect(rows[0]!.writingProblems).toEqual([
      "summary is only a role label: Healthcare Administrative Assistant",
      "summary heading left in English: Summary",
      "skills heading left in English: SKILLS",
      "skill item ends with a full stop: Terminplanung.",
    ]);
    expect(rows[1]!.writingProblems).toEqual([]);
    expect(rows[1]!.stretches).toEqual(scored(["aggressive"])[0]!.stretches);
    expect(rows[1]!.inventedFacts).toEqual(
      scored(["aggressive"])[0]!.inventedFacts,
    );
  });
});

describe("resume lane report", () => {
  const rowsFor = (caseId: string) =>
    scoreCase(RESUME_LANE_CASES.find((candidate) => candidate.id === caseId)!, [
      {
        level: "original",
        draft: null,
        error: null,
        seconds: 0,
        modelCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
      },
    ]);

  it("counts writing problems per level and tells that translated cases are not comparable by words", () => {
    const german = formatResumeLaneReport("model", rowsFor("claims-german"));
    expect(german).toContain("| Flags left | Writing problems |");
    expect(german).toContain("Translated cases (claims-german: German)");
    expect(
      formatResumeLaneReport("model", rowsFor("frontend-staff")),
    ).not.toContain("Translated cases");
  });
});

describe("resume lane cases", () => {
  const normalized = (text: string) =>
    text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  it("pairs every case with a persona and a recorded public posting whose reviewed terms it names", () => {
    const listings = readRecordedListings();
    expect(new Set(RESUME_LANE_CASES.map((evalCase) => evalCase.id)).size).toBe(
      RESUME_LANE_CASES.length,
    );
    for (const evalCase of RESUME_LANE_CASES) {
      const listing = listings.get(evalCase.listingId);
      expect(listing, evalCase.id).toBeDefined();
      expect(readPersonaResume(evalCase.persona), evalCase.id).toContain(
        "EXPERIENCE",
      );
      expect(listing!.url, evalCase.id).toMatch(/^https:\/\//u);
      expect(listing!.recordedAt, evalCase.id).toMatch(/^2026-\d\d-\d\dT/u);
      const posting = normalized(`${listing!.title} ${listing!.description}`);
      const terms = [
        ...(listing!.technologies ?? []),
        // Credentials of a translated posting are spelled out in each form.
        ...(evalCase.language ? [] : (listing!.credentials ?? [])),
      ];
      for (const term of terms)
        expect(posting, `${evalCase.id}: ${term}`).toContain(normalized(term));
    }
  });

  it("covers a keyword-heavy posting, two non-software fields, a long career and a German posting", () => {
    expect(RESUME_LANE_CASES.map((evalCase) => evalCase.id)).toEqual(
      expect.arrayContaining([
        "support-tool-list",
        "hotel-to-support",
        "payroll-specialist",
        "retail-to-customer-care",
        "claims-german",
      ]),
    );
    expect(
      readRecordedListings().get("brex-developer-support")!.technologies!
        .length,
    ).toBeGreaterThanOrEqual(20);
    expect(
      RESUME_LANE_CASES.filter((evalCase) => evalCase.language).map(
        (evalCase) => [evalCase.id, evalCase.language],
      ),
    ).toEqual([["claims-german", "German"]]);
  });
});
