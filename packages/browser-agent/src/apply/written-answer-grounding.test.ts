import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import type { LLMClient } from "../agent/contracts";

test.each([
  {
    location: "Remote, United Kingdom",
    answers: ["Yes", "No"],
    supported: true,
  },
  {
    location: "Remote, United Kingdom or Canada",
    answers: ["Yes", "No"],
    supported: false,
  },
  { location: "Toronto, Canada", answers: ["Yes", "No"], supported: true },
  {
    location: "Boston, United States",
    answers: ["No", "Yes"],
    supported: true,
  },
  { location: "Worldwide remote", answers: ["Yes", "Yes"], supported: false },
  { location: "Berlin, Germany", answers: ["No", "No"], supported: false },
])(
  "sends the country and permit conditions to the independent check: $location",
  async ({ location, answers, supported }) => {
    const profile = CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: "Synthetic Applicant",
      yearsExperience: 2,
      summary:
        "German student permit: working-student work now; sponsorship for full-time after graduation. Canada authorized, US needs sponsorship.",
      proofBank: [
        {
          id: "proof_synthetic",
          title: "Reporting project",
          claim: "Reduced reporting time by 20%",
        },
      ],
      workEligibility: {
        authorizedWorkCountries: ["Lebanon", "Canada", "United Kingdom"],
        limitedWorkPermissions: [
          {
            country: "Germany",
            conditions: "Student work only; 20 hours during term",
            requiresFutureSponsorship: true,
          },
        ],
      },
      baseResume: {
        id: "resume",
        fileName: "resume.txt",
        uploadedAt: "2026-10-01T00:00:00.000Z",
        extractionStatus: "ready",
      },
    });
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(() =>
      Promise.resolve({
        toolCalls: [
          {
            id: "check",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: answers.map((_, index) => ({
                  index,
                  supported,
                  reason: supported
                    ? "Same country and conditions"
                    : "Choose the hiring country or review the student permit",
                })),
              }),
            },
          },
        ],
      }),
    );
    const checks = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources: {
        profile,
        resumeText: null,
        posting: {
          title: "Analyst",
          company: "Synthetic",
          location,
          description: "Full-time analyst",
        },
        reusableAnswers: [],
        documents: [],
      },
      formContext: {
        pageText: "Employer hiring country: " + location,
        fields: [{ question: "Hiring location", value: location }],
      },
      payDisclosed: false,
      answers: answers.map((answer, index) => ({
        question: index ? "Do you need sponsorship?" : "Are you authorized?",
        answer,
      })),
    });
    expect(checks.every((check) => check.supported === supported)).toBe(true);
    const [messages] = chatWithTools.mock.calls[0];
    expect(String(messages[0].content)).toContain(
      "review the wording before it goes on this application's form",
    );
    expect(String(messages[0].content)).not.toContain(
      "reviewed and submitted by the person",
    );
    expect(String(messages[0].content)).toContain(
      "Reject both Yes and No when the country is unresolved",
    );
    expect(String(messages[0].content)).toContain(
      "A single country named in the posting location is the hiring country",
    );
    expect(String(messages[0].content)).toContain(
      "Remote is a work mode and does not erase the named country",
    );
    expect(String(messages[0].content)).toContain(
      "location names no country or several countries",
    );
    expect(String(messages[0].content)).toContain(
      "limit hours, study status, dates or employer",
    );
    expect(String(messages[0].content)).not.toMatch(
      /German|Canada|US sponsorship/u,
    );
    const data: unknown = JSON.parse(String(messages[1].content));
    expect(data).toHaveProperty("postingContextOnly.location", location);
    expect(data).toHaveProperty(
      "applicationFormContext.fields.0.value",
      location,
    );
    expect(data).toHaveProperty("applicant.summary", profile.summary);
    expect(String(messages[1].content)).not.toMatch(
      /authorizedWorkCountries|requiresVisaSponsorship|requiresFutureSponsorship/u,
    );
    expect(String(messages[0].content)).toContain(
      "Never quote camelCase field names, key=value text",
    );
    for (const check of checks)
      expect(check.reason).not.toMatch(/[a-z][A-Z]|=/u);
    expect(data).toHaveProperty(
      "applicant.workEligibility.Limited work permissions",
      [
        {
          Country: "Germany",
          Conditions: "Student work only; 20 hours during term",
          "Will need sponsorship later": "Yes",
        },
      ],
    );
    expect(data).toHaveProperty(
      "applicant.eligibilityInterpretation",
      expect.stringContaining(
        "Will need sponsorship later describes future work",
      ),
    );
    expect(data).toHaveProperty(
      "applicant.proofBank.0.claim",
      "Reduced reporting time by 20%",
    );
  },
);

const sources = {
  resumeText: null,
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: 2,
    baseResume: {
      id: "resume",
      fileName: "resume.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      extractionStatus: "ready",
    },
  }),
  posting: {
    title: "Analyst",
    company: "Synthetic",
    location: "Remote",
    description: "Analyst",
  },
  reusableAnswers: [],
  documents: [],
};
const checkedReply = {
  toolCalls: [
    {
      id: "check",
      type: "function" as const,
      function: {
        name: "report_answer_checks",
        arguments: JSON.stringify({
          checks: [{ index: 0, supported: true, reason: "Supported" }],
        }),
      },
    },
  ],
};

test("budgets letters by text length and retries incomplete output once with more room", async () => {
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockRejectedValueOnce(new Error("incomplete: max_output_tokens"))
    .mockResolvedValueOnce(checkedReply);
  await expect(
    checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      answers: [
        { question: "Letter", answer: "Supported long letter. ".repeat(250) },
      ],
    }),
  ).resolves.toEqual([{ supported: true, reason: "Supported" }]);
  expect(chatWithTools).toHaveBeenCalledTimes(2);
  const initial = chatWithTools.mock.calls[0][2]!.maxOutputTokens!;
  expect(initial).toBeGreaterThan(6_000);
  expect(chatWithTools.mock.calls[1][2]!.maxOutputTokens).toBeGreaterThan(
    initial,
  );
});

test("a repeated incomplete check reports plain copy without provider errors", async () => {
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockRejectedValue(new Error("incomplete: max_output_tokens"));
  await expect(
    checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      answers: [{ question: "Authorization?", answer: "Yes" }],
    }),
  ).rejects.toThrow("could not check the facts");
  expect(chatWithTools).toHaveBeenCalledTimes(2);
});

test("conflicts propose wording for person review and omission cannot hide a work limit", async () => {
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
    toolCalls: [
      {
        id: "review",
        type: "function",
        function: {
          name: "report_answer_checks",
          arguments: JSON.stringify({
            checks: [
              {
                index: 0,
                supported: false,
                reason: "Your hours differ from this role.",
                reviewWording: "I enjoy this work. I can work 20 hours a week.",
              },
            ],
          }),
        },
      },
    ],
  });
  const checks = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: false,
    answers: [{ question: "Why this role?", answer: "I enjoy this work." }],
  });
  expect(checks[0]).toMatchObject({
    supported: false,
    reviewWording: "I enjoy this work. I can work 20 hours a week.",
  });
  const prompt = JSON.stringify(chatWithTools.mock.calls[0][0]);
  expect(prompt).toContain("even if the draft merely omits the limit");
  expect(prompt).toContain(
    "keep the supported motivation from the proposed answer",
  );
  expect(prompt).toContain("Do not reduce it to limits alone");
  expect(prompt).toContain("one first-person sentence");
  expect(prompt).toContain(
    "never advice, commentary, requests for review or notes addressed to the person",
  );
  expect(prompt).toContain("only in reason, never in reviewWording");
  expect(prompt).toContain("Do not end with a question or a question mark");
  expect(prompt).toContain("I enjoy this work.");
  expect(prompt).toContain(
    "review the wording before it goes on this application's form",
  );
});
