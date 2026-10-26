import { describe, expect, test } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
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
              : { content: seed.profile.summary },
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

test.each([true, false])(
  "checks contact details and all letter claims before returning a draft (supported=%s)",
  async (supported) => {
    const seed = createSeed();
    seed.profile.email = "accepted@example.test";
    seed.profile.applicationIdentity.preferredEmail = "accepted@example.test";
    seed.profile.baseResume.textContent =
      "Discarded contact rejected@example.test";
    const reusableAnswers = [
      {
        id: "availability",
        kind: "availability" as const,
        label: "Availability",
        question: "When are you available?",
        answer: "20–30 hours, London only",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const calls: Array<
      Parameters<
        NonNullable<
          Parameters<
            typeof buildApplyLetterDependencies
          >[0]["aiClient"]["chatWithTools"]
        >
      >
    > = [];
    const dependencies = buildApplyLetterDependencies({
      aiClient: {
        chatWithTools: (...args) => {
          calls.push(args);
          return Promise.resolve(
            args[1].length
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
                              supported,
                              evidence: supportedEvidence(args[0]),
                              reason: supported
                                ? "Uses saved contact and supported facts"
                                : "The rejected email and claimed editorial results are unsupported",
                            },
                          ],
                        }),
                      },
                    },
                  ],
                }
              : { content: seed.profile.summary },
          );
        },
      },
      documentManager: {},
      job: seed.savedJobs[0]!,
      profile: seed.profile,
      reusableAnswers,
      settings: seed.settings,
      searchPreferences: {
        ...seed.searchPreferences,
        employmentTypes: ["Part-time"],
        locations: ["London"],
      },
    })!;
    const writing = dependencies.writeLetter({
      prompt: "Write a French letter.",
      purpose: "cover_letter",
      groundedIn: ["your profile"],
      language: "French",
      preference: dependencies.preference,
      priorText: null,
    });
    if (supported) await expect(writing).resolves.toBe(seed.profile.summary);
    else
      await expect(writing).rejects.toThrow(
        "The rejected email and claimed editorial results are unsupported",
      );
    expect(calls).toHaveLength(2);
    const checked = JSON.parse(String(calls[1]![0][1]!.content)) as {
      applicant: {
        email: string;
        preferences: { employmentTypes: string[]; locations: string[] };
        savedAnswers: Array<{ id: string; answer: string }>;
      };
    };
    expect(checked.applicant.email).toBe("accepted@example.test");
    expect(checked.applicant.preferences.employmentTypes).toEqual([
      "Part-time",
    ]);
    expect(checked.applicant.preferences.locations).toEqual(["London"]);
    expect(checked.applicant.savedAnswers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "availability",
          answer: "20–30 hours, London only",
        }),
      ]),
    );
    expect(String(calls[1]![0][0]!.content)).toContain(
      "Current saved profile contact details take precedence",
    );
    expect(String(calls[1]![0][0]!.content)).toContain(
      "contradict the person’s saved goals",
    );
  },
);

test("writer input uses application facts, excludes pay answers and trims the resume", async () => {
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
            : { content: seed.profile.summary },
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
  expect(calls.join(" ")).not.toMatch(
    /PRIVATE_PAY_SENTINEL|RESUME_TAIL_SENTINEL/,
  );
  expect(calls[0]).not.toContain("extractionStatus");
  expect(calls[0]).toContain("Current applicant facts");
});

test("an unavailable fact check keeps draft text and a plain review reason", async () => {
  const seed = createSeed();
  const dependencies = buildApplyLetterDependencies({
    aiClient: {
      chatWithTools(_messages, tools) {
        return tools.length
          ? Promise.reject(new Error("incomplete: max_output_tokens"))
          : Promise.resolve({ content: "Supported draft to review." });
      },
    },
    documentManager: {},
    job: seed.savedJobs[0]!,
    profile: seed.profile,
    settings: seed.settings,
  })!;
  const result = dependencies.writeLetter({
    purpose: "cover_letter",
    prompt: "Write",
    groundedIn: [],
    language: null,
    preference: dependencies.preference,
    priorText: null,
  });
  await expect(result).rejects.toMatchObject({
    draftText: "Supported draft to review.",
  });
  await expect(result).rejects.toThrow("could not check this draft right now");
});

test.each([
  [
    "The letter offers full-time hours; review the wording before it goes on this application.",
    "The letter offers full-time hours; review the wording before it goes on this application.",
  ],
  [
    "The letter offers full-time hours.",
    "The letter offers full-time hours. Review and agree the wording for this application before approving it.",
  ],
])("a letter check reason asks for review once (%s)", async (reason, shown) => {
  const seed = createSeed();
  const dependencies = buildApplyLetterDependencies({
    aiClient: {
      chatWithTools: (...args) =>
        Promise.resolve(
          args[1].length
            ? {
                toolCalls: [
                  {
                    id: "check",
                    type: "function",
                    function: {
                      name: "report_answer_checks",
                      arguments: JSON.stringify({
                        checks: [{ index: 0, supported: false, reason }],
                      }),
                    },
                  },
                ],
              }
            : { content: "A proposed letter." },
        ),
    },
    documentManager: {},
    job: seed.savedJobs[0]!,
    profile: seed.profile,
    settings: seed.settings,
    searchPreferences: seed.searchPreferences,
  })!;
  const error: unknown = await dependencies
    .writeLetter({
      prompt: "Write a letter.",
      purpose: "cover_letter",
      groundedIn: ["your profile"],
      language: "English",
      preference: dependencies.preference,
      priorText: null,
    })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.endsWith(`: ${shown}`)).toBe(true);
});
