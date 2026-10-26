import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/invented-personal-answers.json";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import { applicationFacts, plainAnswerCheckFacts } from "./application-facts";
import type { LLMClient } from "../agent/contracts";
import { evidenceFitsQuestion } from "./answer-evidence";
import ownWords from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/own-words.json";
import k1 from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/answer-evidence-k1.json";
import discovery from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/listing-discovery.json";

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

test.each(["A friend referred me", discovery.label])(
  "listing source is checked deterministically: %s",
  async (answer) => {
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>();
    const result = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources: {
        ...sources,
        listingDiscovery: { label: discovery.label, url: discovery.url },
      },
      payDisclosed: false,
      answers: [{ question: discovery.question, answer }],
    });
    expect(result[0]?.supported).toBe(answer === discovery.label);
    expect(chatWithTools).not.toHaveBeenCalled();
  },
);

test.each(k1.cases)("K1 lying-checker replay: $name", async (entry) => {
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
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
                evidence: entry.evidence.map((evidence) => ({
                  ...evidence,
                  kind:
                    evidence.source === "posting"
                      ? "role_motivation"
                      : "applicant_fact",
                  claim: entry.answer,
                })),
              },
            ],
          }),
        },
      },
    ],
  });
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources: {
      ...sources,
      resumeText: k1.resume,
      profile: CandidateProfileSchema.parse({
        ...sources.profile,
        currentRegion: "Germany",
        experiences: [
          {
            id: "synthetic-employment",
            companyName: "Example Workshop",
            title: "Engineer",
            startDate: "January 2014",
            isCurrent: true,
          },
        ],
        workEligibility: {
          ...sources.profile.workEligibility,
          authorizedWorkCountries: ["Germany", "France"],
        },
      }),
    },
    payDisclosed: false,
    answers: [entry],
  });
  expect(result[0]?.supported).toBe(entry.supported);
  for (const evidence of entry.evidence) {
    if (evidence.source === "resume")
      expect(k1.resume).toContain(evidence.quote);
    if (evidence.path === "/location/region")
      expect("Germany").toBe(evidence.quote);
  }
});

test.each(ownWords.rules)(
  "Apply replay: the site's writing rule requires the person without a checker call: %s",
  async (rule) => {
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValue({
        toolCalls: [
          {
            id: "lying-checker",
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
                        source: "posting",
                        path: "/description",
                        quote: sources.posting.description,
                        claim: ownWords.proposed,
                        kind: "role_motivation",
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
      formContext: { pageText: rule, fields: [] },
      answers: [{ question: ownWords.question, answer: ownWords.proposed }],
    });
    expect(result[0].supported).toBe(false);
    expect(result[0].reason).toContain("your own words");
    expect(chatWithTools).not.toHaveBeenCalled();
  },
);
test("a lying supported checker cannot authorize any pass-11 invention", async () => {
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
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
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
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

test.each([
  ["7 years in TypeScript", true],
  ["7 years of professional experience using TypeScript", true],
  ["7 years of experience, and I use TypeScript", false],
  ["7 years of software engineering with TypeScript", false],
  ["7 years overall. TypeScript is a skill.", false],
])("a skill duration must be stated by the source: %s", (quote, supported) => {
  expect(
    evidenceFitsQuestion({
      question: "How many years of experience do you have in TypeScript?",
      answer: "7",
      applicant: {},
      evidence: [{ source: "resume", path: "", quote }],
    }),
  ).toBe(supported);
});

test("a matching saved opinion is usable, but the same value for a different question is not", () => {
  const evidence = [
    {
      source: "applicant",
      path: "/savedAnswers/0/answer",
      quote: "Playwright",
    },
  ];
  const question = "What is your favourite testing product?";
  expect(
    evidenceFitsQuestion({
      question,
      answer: "Playwright",
      evidence,
      applicant: { savedAnswers: [{ question, answer: "Playwright" }] },
    }),
  ).toBe(true);
  expect(
    evidenceFitsQuestion({
      question,
      answer: "Playwright",
      evidence,
      applicant: {
        savedAnswers: [
          { question: "Which product do you maintain?", answer: "Playwright" },
        ],
      },
    }),
  ).toBe(false);
});
