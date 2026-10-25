import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import type { LLMClient } from "../agent/contracts";

test("passes current eligibility, No and limited-permit conditions to the independent check", async () => {
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: 2,
    workEligibility: {
      authorizedWorkCountries: ["United States"],
      requiresVisaSponsorship: false,
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
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
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
              checks: [
                {
                  index: 0,
                  supported: false,
                  reason: "The German permit covers student work only.",
                },
              ],
            }),
          },
        },
      ],
    }),
  );
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources: {
      profile,
      resumeText: null,
      reusableAnswers: [],
      documents: [],
      posting: {
        title: "Analyst",
        company: "Synthetic",
        location: "Berlin, Germany",
        description: "Full-time analyst",
      },
    },
    formContext: {
      pageText: "Full-time work in Germany",
      fields: [{ question: "Work country", value: "Germany" }],
    },
    payDisclosed: false,
    answers: [{ question: "Are you authorized to work here?", answer: "Yes" }],
  });
  expect(result).toEqual([
    { supported: false, reason: "The German permit covers student work only." },
  ]);
  const data: unknown = JSON.parse(
    String(chatWithTools.mock.calls[0][0][1].content),
  );
  expect(data).toHaveProperty(
    "applicant.workEligibility.Countries where you can work",
    ["United States"],
  );
  expect(data).toHaveProperty(
    "applicant.workEligibility.Need visa sponsorship",
    "No",
  );
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
  expect(data).toHaveProperty("postingContextOnly.location", "Berlin, Germany");
  expect(data).toHaveProperty(
    "applicationFormContext.fields.0.value",
    "Germany",
  );
});

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
