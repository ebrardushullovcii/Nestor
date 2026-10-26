import { ResumeDraftSchema } from "@nestor/contracts";
import { resumeClaimContentHash } from "@nestor/job-finder/resumes";
import { describe, expect, it } from "vitest";

import type { EvalHttpCapture } from "../contracts";
import { flagsLeft, inventedFacts, levelVerdicts } from "./checks";
import { tokensUsed } from "./run";

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
