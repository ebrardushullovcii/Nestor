import { describe, expect, test } from "vitest";

import { createSeed } from "../test-fixtures";
import { buildApplyLetterDependencies } from "./agent-application-preparation";

// These tests stub semantic judgment to inspect the letter boundary. The source
// quote is the supplied synthetic context; answer-grounding tests check verdicts.
function supportedEvidence(messages: readonly { content?: string }[]) {
  const data = JSON.parse(String(messages[1]?.content ?? "{}")) as {
    applicant: { summary: string; name: { full: string } };
  };
  return [
    {
      kind: "applicant_fact",
      claim: "Scripted supported letter",
      source: "applicant",
      path: "/summary",
      quote: data.applicant.summary,
    },
  ];
}

describe("application document writer context", () => {
  test("passes grounded context, preferences, and prior text to the actual model boundary", async () => {
    const seed = createSeed();
    const messagesSeen: Array<{ role: string; content: string }> = [];
    const dependencies = buildApplyLetterDependencies({
      aiClient: {
        chatWithTools(messages, tools) {
          messagesSeen.push(...messages);
          return Promise.resolve(
            tools.length
              ? {
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
                              supported: true,
                              evidence: supportedEvidence(messages),
                              reason: "Matches the current profile",
                            },
                          ],
                        }),
                      },
                    },
                  ],
                }
              : { content: seed.profile.summary ?? "" },
          );
        },
      },
      documentManager: {},
      job: seed.savedJobs[0]!,
      profile: seed.profile,
      settings: seed.settings,
      searchPreferences: {
        ...seed.searchPreferences,
        employmentTypes: ["Part-time"],
        locations: ["London"],
      },
    });

    expect(dependencies).toBeDefined();
    await dependencies!.writeLetter({
      purpose: "motivation_letter",
      prompt: "Make the second paragraph shorter.",
      groundedIn: [
        "Profile: Alex Vanguard, platform designer",
        "Resume: Built workflow tools at Acme",
        "Job: Senior Product Designer at Northstar",
      ],
      language: "English",
      preference: {
        tone: "direct",
        length: "short",
        language: "English",
        sample: null,
      },
      priorText: "Earlier document text.",
    });

    const userMessage = messagesSeen.find((message) => message.role === "user");
    expect(userMessage?.content).toContain(
      "Document purpose: motivation letter",
    );
    expect(userMessage?.content).toContain("Saved tone: direct");
    expect(userMessage?.content).toContain("Saved length: short");
    expect(userMessage?.content).toContain("Profile: Alex Vanguard");
    expect(userMessage?.content).toContain(
      "Resume: Built workflow tools at Acme",
    );
    expect(userMessage?.content).toContain(
      "Job: Senior Product Designer at Northstar",
    );
    expect(userMessage?.content).toContain(
      "Prior version to revise:\nEarlier document text.",
    );
  });
});

test("writer input contains all applicant facts, pay answers and the complete resume", async () => {
  const seed = createSeed();
  seed.profile.baseResume.textContent =
    "A".repeat(8_000) + "RESUME_TAIL_SENTINEL";
  const calls: string[] = [];
  const dependencies = buildApplyLetterDependencies({
    aiClient: {
      chatWithTools(messages, tools) {
        calls.push(JSON.stringify(messages));
        return Promise.resolve(
          tools.length
            ? {
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
                            supported: true,
                            reason: "Supported",
                            evidence: supportedEvidence(messages),
                          },
                        ],
                      }),
                    },
                  },
                ],
              }
            : { content: seed.profile.summary ?? "" },
        );
      },
    },
    documentManager: {},
    job: seed.savedJobs[0]!,
    profile: seed.profile,
    reusableAnswers: [
      {
        id: "pay",
        kind: "salary_expectation",
        label: "Expected pay",
        question: "Expected pay",
        answer: "PRIVATE_PAY_SENTINEL",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ],
    settings: seed.settings,
  })!;
  await dependencies.writeLetter({
    purpose: "cover_letter",
    prompt: "Write a letter",
    groundedIn: [],
    language: null,
    preference: dependencies.preference,
    priorText: null,
  });
  expect(calls.join(" ")).toContain("PRIVATE_PAY_SENTINEL");
  expect(calls.join(" ")).toContain("RESUME_TAIL_SENTINEL");
  expect(calls[0]).not.toContain("extractionStatus");
  expect(calls[0]).toContain("Current applicant facts");
});
