import { ResumeDraftSchema } from "@nestor/contracts";
import { resumeClaimContentHash } from "@nestor/job-finder/resumes";
import { describe, expect, it } from "vitest";

import { flagsLeft, inventedFacts, levelVerdicts } from "./checks";

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
      company: "Datadog",
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
        company: "Datadog",
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
    const shape = (
      rewrittenShare: number,
      coverage: number,
      headline: string,
    ) => ({
      rewrittenShare,
      truthfulKeywordCoverage: coverage,
      headline,
      unchanged: false,
    });
    expect(
      levelVerdicts(
        {
          original: { ...shape(0, 0, ""), unchanged: true },
          light: shape(0.7, 0.2, "Senior Software Engineer"),
          tailored: shape(0.4, 0.2, "Senior Software Engineer"),
          aggressive: shape(0.8, 0.6, "Staff Software Engineer"),
        },
        "Senior Software Engineer",
        "Staff Software Engineer - Frontend",
      ),
    ).toEqual({
      original: null,
      light: "Light rewrote 70% of lines.",
      tailored: "Tailored did not go further than Light.",
      aggressive: null,
    });
  });
});
