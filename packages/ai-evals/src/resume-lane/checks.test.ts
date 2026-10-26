import { ResumeDraftSchema } from "@nestor/contracts";
import { resumeClaimContentHash } from "@nestor/job-finder/resumes";
import { describe, expect, it } from "vitest";

import type { EvalHttpCapture } from "../contracts";
import { assessFacts, flagsLeft, inventedFacts, levelVerdicts } from "./checks";
import { stretchCheckReport, tokensUsed } from "./run";

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
  expect(result.traceAvailable).toBe(true);
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
