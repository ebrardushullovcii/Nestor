import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import type { LLMClient } from "../agent/contracts";
import letterRetry from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/letter-check-retry.json";

test("a slow incomplete letter check leaves time for its grounded retry", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    let calls = 0;
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(
      (_messages, _tools, options) =>
        new Promise((resolve, reject) => {
          const first = calls++ === 0;
          const timer = setTimeout(
            () =>
              first
                ? reject(new Error(letterRetry.firstError))
                : resolve(checkedReply),
            first ? letterRetry.firstAttemptMs : letterRetry.retryMs,
          );
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            },
            { once: true },
          );
        }),
    );
    const pending = checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      answers: [
        {
          question: letterRetry.question,
          answer: letterRetry.answerSentence.repeat(letterRetry.repetitions),
        },
      ],
    });
    const result = expect(pending).resolves.toEqual([
      { supported: true, reason: "Supported" },
    ]);
    await vi.advanceTimersByTimeAsync(
      letterRetry.firstAttemptMs + letterRetry.retryMs,
    );
    await result;
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(
      chatWithTools.mock.calls[0][2]?.maxOutputTokens,
    ).toBeGreaterThanOrEqual(8_000);
    const prompt = JSON.stringify(chatWithTools.mock.calls[0][0]);
    expect(prompt).toContain("shortest verbatim passage");
  } finally {
    timeout.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

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
          checks: [
            {
              index: 0,
              supported: true,
              reason: "Supported",
              evidence: [
                {
                  kind: "role_motivation",
                  claim: "Interest in the work",
                  source: "posting",
                  path: "/description",
                  quote: "Analyst",
                },
              ],
            },
          ],
        }),
      },
    },
  ],
};

test.each([
  { label: "a missing source quote", evidence: [] },
  {
    label: "a fabricated resume quote",
    evidence: [
      {
        kind: "applicant_fact",
        claim: "Four years using Rust",
        source: "resume",
        path: "",
        quote: "Four years using Rust",
      },
    ],
  },
  {
    label: "a posting used as evidence of personal experience",
    evidence: [
      {
        kind: "applicant_fact",
        claim: "Experience as an analyst",
        source: "posting",
        path: "/description",
        quote: "Analyst",
      },
    ],
  },
  {
    label: "an isolated No without its question or fact",
    evidence: [
      {
        kind: "applicant_fact",
        claim: "Never worked for this employer",
        source: "applicant",
        path: "",
        quote: "No",
      },
    ],
  },
])(
  "a positive verdict with $label cannot authorize an answer",
  async ({ evidence }) => {
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValue({
        toolCalls: [
          {
            id: "check",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  { index: 0, supported: true, reason: "Supported", evidence },
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
        {
          question: "Describe your Rust experience",
          answer: "Four years using Rust",
        },
      ],
    });
    expect(result[0]?.supported).toBe(false);
    expect(result[0]?.reason).toContain("could not verify");
    expect(chatWithTools).toHaveBeenCalledOnce();
  },
);

test("the person's exact saved No and numeric zero remain usable evidence", async () => {
  const saved = [
    {
      id: "previous_work",
      kind: "other" as const,
      label: "Previous work",
      question: "Have you worked for Example Workshop?",
      answer: "No",
      roleFamilies: [],
      proofEntryIds: [],
    },
    {
      id: "skill_years",
      kind: "other" as const,
      label: "Rust years",
      question: "Years using Rust",
      answer: "0",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
    toolCalls: [
      {
        id: "check",
        type: "function",
        function: {
          name: "report_answer_checks",
          arguments: JSON.stringify({
            checks: saved.map((answer, index) => ({
              index,
              supported: true,
              reason: "The person answered this question.",
              evidence: [
                {
                  kind: "applicant_fact",
                  claim: answer.answer,
                  source: "applicant",
                  path: `/savedAnswers/${index}/answer`,
                  quote: answer.answer,
                },
              ],
            })),
          }),
        },
      },
    ],
  });
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources: { ...sources, reusableAnswers: saved },
    payDisclosed: false,
    answers: saved.map((answer) => ({
      question: answer.question,
      answer: answer.answer,
    })),
  });
  expect(result.map((value) => value.supported)).toEqual([true, true]);
});

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
