import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/invented-personal-answers.json";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import { applicationFacts, plainAnswerCheckFacts } from "./application-facts";
import type { LLMClient } from "../agent/contracts";

const sources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: replay.applicant.yearsExperience,
    skills: replay.applicant.skills,
    workEligibility: { requiresVisaSponsorship: false },
    baseResume: {
      id: "synthetic-resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      textContent:
        "Seven years overall in software engineering. Skills include JavaScript and TypeScript.",
    },
  }),
  resumeText: null,
  reusableAnswers: [],
  documents: [],
  posting: {
    title: "Engineer",
    company: "Example Workshop",
    location: "Remote",
    description: "Engineering workflow tools",
  },
};
test("a lying supported checker cannot authorize any pass-11 invention", async () => {
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({
      toolCalls: [
        {
          id: "lie",
          type: "function",
          function: {
            name: "report_answer_checks",
            arguments: JSON.stringify({
              checks: replay.cases.map((entry, index) => ({
                index,
                supported: true,
                reason: "Supported",
                evidence: entry.evidence.map((evidence) => ({
                  ...evidence,
                  claim: entry.answer,
                  kind: "applicant_fact",
                })),
              })),
            }),
          },
        },
      ],
    });
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: false,
    answers: replay.cases,
  });
  expect(result.map((check) => check.supported)).toEqual([false, false, false]);
  expect(chatWithTools).toHaveBeenCalledOnce();
});

test("the whole applicant object cannot serve as a quote even with a lying checker", async () => {
  const applicant = plainAnswerCheckFacts(
    applicationFacts(sources, { payDisclosed: false }),
  );
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({
      toolCalls: [
        {
          id: "lie",
          type: "function",
          function: {
            name: "report_answer_checks",
            arguments: JSON.stringify({
              checks: [
                {
                  index: 0,
                  supported: true,
                  reason: "Supported",
                  evidence: [
                    {
                      source: "applicant",
                      path: "",
                      quote: JSON.stringify(applicant),
                      claim: "A personal claim",
                      kind: "applicant_fact",
                    },
                  ],
                },
              ],
            }),
          },
        },
      ],
    });
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: false,
    answers: [
      { question: "Describe your work", answer: "I built a space station." },
    ],
  });
  expect(result[0]?.supported).toBe(false);
});
