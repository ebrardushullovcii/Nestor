import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";

const sources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    yearsExperience: 2,
    baseResume: {
      id: "resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
    },
  }),
  resumeText: null,
  documents: [],
  reusableAnswers: [],
  posting: {
    title: "Engineer",
    company: "Example",
    location: "United Kingdom",
    description:
      "Engineering workflow tools. Already holding a valid driving licence is required.",
  },
};
const question = "Why do you want to join us?";
const posting = (quote: string) => ({
  kind: "role_motivation",
  source: "posting",
  path: "/description",
  quote,
});

test.each([
  {
    answer: "I am excited about this opportunity.",
    evidence: [],
    supported: true,
  },
  { answer: "I would like to join your team.", evidence: [], supported: true },
  {
    answer: "I’m excited about the opportunity to contribute to your team.",
    evidence: [],
    supported: true,
  },
  {
    answer: "I would welcome the chance to work with your team.",
    evidence: [],
    supported: true,
  },
  {
    answer:
      "I am excited about the Engineer opportunity at Example and would welcome the chance to contribute to your team.",
    evidence: [
      {
        kind: "role_motivation",
        source: "posting",
        path: "/postingContextOnly/title",
        quote: "Engineer",
      },
      {
        kind: "role_motivation",
        source: "posting",
        path: "/postingContextOnly/company",
        quote: "Example",
      },
    ],
    supported: true,
  },
  {
    answer: "The role involves building engineering workflow tools.",
    evidence: [posting("Engineering workflow tools.")],
    supported: true,
  },
  {
    answer: "I am excited about already holding a valid driving licence.",
    evidence: [posting("Already holding a valid driving licence is required.")],
    supported: false,
  },
  { answer: "I have my own company.", evidence: [], supported: false },
  {
    answer: "I led a team of 12 at Example.",
    evidence: [posting("Engineering workflow tools.")],
    supported: false,
  },
])(
  "motivation keeps writing separate from personal facts: $answer",
  async (row) => {
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
                    evidence: row.evidence.map((entry) => ({
                      ...entry,
                      claim: row.answer,
                    })),
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
      answers: [{ question, answer: row.answer }],
    });
    expect(checks[0]?.supported).toBe(row.supported);
    expect(chatWithTools).toHaveBeenCalledTimes(1);
  },
);

test("an employer name cannot erase a qualification assertion, and source roots never cross", async () => {
  const company = "already holding a valid driving licence";
  for (const [source, path, quote, answer] of [
    [
      "posting",
      "/postingContextOnly/company",
      company,
      `I am excited about ${company}.`,
    ],
    [
      "applicant",
      "/postingContextOnly/title",
      "Engineer",
      "I am excited about the Engineer opportunity.",
    ],
  ]) {
    const client = {
      chatWithTools: vi
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
                          kind: "role_motivation",
                          source,
                          path,
                          quote,
                          claim: answer,
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }),
    };
    const checks = await checkWrittenApplicationAnswers({
      client,
      sources: { ...sources, posting: { ...sources.posting, company } },
      payDisclosed: false,
      answers: [{ question, answer }],
    });
    expect(checks[0]?.supported).toBe(false);
  }
});

test.each([
  "Write this yourself",
  "This must be your own work",
  "Answers must be written without AI assistance",
  "Responda com suas próprias palavras",
  "Não use IA",
  "O uso de IA é proibido",
])(
  "preflight checks plain intent and own-words forbids it: %s",
  async (instruction) => {
    const answer = "I am excited about this opportunity.";
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockImplementation((_messages, tools) =>
        Promise.resolve({
          toolCalls: [
            {
              id: "read",
              type: "function",
              function: {
                name: tools[0].function.name,
                arguments: JSON.stringify(
                  tools[0].function.name === "report_question_kinds"
                    ? {
                        plainIndexes: [0],
                        flagged: [],
                        tags: [
                          {
                            index: 0,
                            kind: "motivation",
                            country: null,
                            sourceId: null,
                          },
                        ],
                      }
                    : {
                        checks: [
                          {
                            index: 0,
                            supported: true,
                            reason: "Ordinary intent",
                            evidence: [],
                          },
                        ],
                      },
                ),
              },
            },
          ],
        }),
      );
    const checks = await checkClassifiedApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      answers: [{ question, answer }],
      formContext: { pageText: "", fields: [] },
    });
    expect(checks[0]?.supported).toBe(true);
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    chatWithTools.mockClear();
    const ownWords = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      answers: [{ question, answer }],
      formContext: { pageText: instruction, fields: [] },
    });
    expect(ownWords[0]?.supported).toBe(false);
    expect(chatWithTools).not.toHaveBeenCalled();
  },
);
