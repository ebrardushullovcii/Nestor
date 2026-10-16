import { describe, expect, test, vi } from "vitest";
import { createJobFinderAiClientFromEnvironment } from "./openai-compatible";
import { createEnvironment } from "./test-fixtures";

import {
  buildResumeClaimCheckPayload,
  buildResumeClaimCheckPrompt,
  normalizeResumeClaimChecks,
} from "./openai-compatible-resume-claims";

const input = {
  tailoringStrength: "balanced",
  job: { title: "Data Analyst", company: "Northwind", description: "SQL." },
  evidence: [
    { id: "experience:1", text: "Built SQL dashboards for the sales team." },
  ],
  resumeText: null,
  claims: [
    { id: "a", section: "Experience", text: "Built SQL dashboards." },
    { id: "b", section: "Skills", text: "Kubernetes" },
  ],
};

describe("resume claim checks", () => {
  test("keeps Aggressive validation on its dedicated provider and other levels on primary", async () => {
    const models: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { model: string };
        models.push(body.model);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: JSON.stringify({ checks: [] }) },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      });
    try {
      const client = createJobFinderAiClientFromEnvironment(
        createEnvironment({
          NORDRI_AI_MODEL: "primary-model",
          NORDRI_AI_AGGRESSIVE_MODEL: "aggressive-model",
          NORDRI_AI_AGGRESSIVE_API_MODE: "chat_completions",
        }),
      );
      await client.checkResumeClaims?.({
        ...input,
        tailoringStrength: "aggressive",
        timeoutMs: 500,
      });
      await client.checkResumeClaims?.({
        ...input,
        tailoringStrength: "balanced",
      });
      expect(models).toEqual(["aggressive-model", "primary-model"]);
    } finally {
      fetchMock.mockRestore();
    }
  });
  test("keeps verdicts for asked claims and cited evidence only", () => {
    expect(
      normalizeResumeClaimChecks(
        {
          checks: [
            {
              id: "a",
              verdict: "supported",
              reason: "The dashboards are in the evidence.",
              evidenceIds: ["experience:1", "made-up"],
              fix: "A supported line needs no fix.",
            },
            {
              id: "b",
              verdict: "unsupported",
              reason: "Not in evidence.",
              fix: "",
            },
            { id: "c", verdict: "supported", reason: "Not asked." },
            { id: "a", verdict: "unsupported", reason: "Duplicate." },
            { id: "b", verdict: "maybe" },
          ],
        },
        input,
      ),
    ).toEqual([
      {
        id: "a",
        verdict: "supported",
        reason: "The dashboards are in the evidence.",
        style: null,
        fix: null,
        evidenceIds: ["experience:1"],
      },
      {
        id: "b",
        verdict: "unsupported",
        reason: "Not in evidence.",
        style: null,
        fix: "",
        evidenceIds: [],
      },
    ]);
  });

  test("keeps a style note, and a fix for a supported line that has one", () => {
    expect(
      normalizeResumeClaimChecks(
        {
          checks: [
            {
              id: "a",
              verdict: "supported",
              reason: "In evidence.",
              style: "This reads as a fragment.",
              fix: "Built SQL dashboards for the sales team.",
            },
          ],
        },
        input,
      ).map((check) => [check.style, check.fix]),
    ).toEqual([
      ["This reads as a fragment.", "Built SQL dashboards for the sales team."],
    ]);
  });

  test("reads the claim id under the key names models use", () => {
    expect(
      normalizeResumeClaimChecks(
        {
          checks: [
            { claim_id: "a", verdict: "supported", reason: "In evidence." },
            { claim: "b", verdict: "unsupported", reason: "No.", fix: "" },
          ],
        },
        input,
      ).map((check) => [check.id, check.verdict, check.fix]),
    ).toEqual([
      ["a", "supported", null],
      ["b", "unsupported", ""],
    ]);
  });

  test("an answer without checks leaves every line unchecked", () => {
    expect(normalizeResumeClaimChecks({ verdicts: [] }, input)).toEqual([]);
    expect(normalizeResumeClaimChecks(null, input)).toEqual([]);
  });

  test("sends the claims, the evidence and the job as context", () => {
    const payload = buildResumeClaimCheckPayload(input);
    expect(payload.claims).toEqual(input.claims);
    expect(payload.evidence).toEqual(input.evidence);
    expect(payload.job.title).toBe("Data Analyst");
  });
});

test("checks mixed claims and role-specific details without dropping qualifiers", () => {
  const prompt = buildResumeClaimCheckPrompt();
  for (const detail of [
    "every factual part",
    "particular implementation detail",
    "basic or still learning",
    "seasonal or partial dates",
    "credential years and renewal dates",
    "quantified results",
    "no word limit",
  ]) {
    expect(prompt).toContain(detail);
  }
});

test("fact-check instructions contain general rules without tester facts", () => {
  const prompt = buildResumeClaimCheckPrompt();
  for (const fact of [
    "Workday",
    "Excel (advanced)",
    "Articulate Rise",
    "settlement offsets",
    "Dallas",
    "IFRS",
    "CFO",
  ])
    expect(prompt).not.toContain(fact);
});

test("late qualifications and full metrics reach the checker without silent truncation", () => {
  const longEvidence = Array.from({ length: 30 }, (_, index) => ({
    id: `source_${index}`,
    text: "Evidence ".repeat(160),
  }));
  longEvidence.push({
    id: "renewal",
    text: "ILS renewed 2025; clinical training 2019.",
  });
  const source =
    "Earlier source text ".repeat(500) + "Certification issued 2017.";
  const resumeLines = [
    { section: "Education", text: "MSc Business" },
    { section: "Summary", text: "MSc Business" },
  ];
  const payload = buildResumeClaimCheckPayload({
    ...input,
    evidence: longEvidence,
    resumeText: source,
    resumeLines,
  });
  expect(payload.evidence).toEqual(longEvidence);
  expect(payload.importedResume).toBe(source);
  expect(payload.resumeLines).toEqual(resumeLines);
  expect(buildResumeClaimCheckPrompt()).toContain("lines outside this batch");
});
