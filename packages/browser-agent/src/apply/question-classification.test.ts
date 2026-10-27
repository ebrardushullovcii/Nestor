import { describe, expect, test, vi } from "vitest";

import { buildApplyFormObservation } from "./page-hands";
import type { RawApplyPage } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import {
  classifyApplicationQuestions,
  createQuestionClassifier,
} from "./question-classification";

const formQuestions = [
  ["First Name", "profile.firstName"],
  ["Last Name", "profile.lastName"],
  ["Email", "profile.email"],
  ["Phone — Country*", "profile.phone"],
  ["Phone", "profile.phone"],
  ["LinkedIn Profile", "profile.linkedinUrl"],
  ["What impressed you about Example Workshop?", "profile.summary"],
  ["How/when did you start coding?", null],
  [
    "Do you have 3+ years of software development experience?",
    "profile.yearsExperience",
  ],
  ["What are your salary expectations?", "answerLibrary.salary"],
  [
    "What timezone do you plan to work from?",
    "profile.currentCountry#timezone",
  ],
] as const;

test("the question reader preserves an additional-conditions reading", async () => {
  const client: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "legal",
            type: "function",
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: [0],
                flagged: [],
                tags: [
                  {
                    index: 0,
                    kind: "work_auth",
                    country: "DE",
                    sourceId: null,
                    hasAdditionalConditions: true,
                  },
                ],
              }),
            },
          },
        ],
      }),
  };
  const readings = await classifyApplicationQuestions({
    client,
    questions: [
      {
        prompt:
          "Dürfen Sie dauerhaft und uneingeschränkt in Deutschland arbeiten?",
        kind: "radio",
        options: ["Ja", "Nein"],
      },
    ],
  });
  expect(
    readings.values().next().value?.answerTags?.hasAdditionalConditions,
  ).toBe(true);
});

function reportFor(prompts: { question: string }[]) {
  return {
    content: "",
    toolCalls: [
      {
        id: "report",
        type: "function" as const,
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            plainIndexes: prompts.map((_, index) => index),
            flagged: [],
            tags: prompts.map((prompt, index) => ({
              index,
              kind: "other",
              country: null,
              sourceId:
                formQuestions.find(
                  ([question]) => question === prompt.question,
                )?.[1] ?? null,
            })),
          }),
        },
      },
    ],
  };
}

test.each([
  "empty arguments",
  "malformed arguments",
  "timeout",
  "provider error",
])(
  "one failed %s page read recovers the known fields in smaller bounded reads",
  async (failure) => {
    const batches: string[][] = [];
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages) => {
        const prompts = JSON.parse(messages[1].content) as {
          question: string;
        }[];
        batches.push(prompts.map((prompt) => prompt.question));
        if (batches.length === 1) {
          if (failure === "timeout" || failure === "provider error")
            return Promise.reject(new Error(failure));
          return Promise.resolve({
            toolCalls: [
              {
                id: "empty",
                type: "function",
                function: {
                  name: "report_question_kinds",
                  arguments: failure === "empty arguments" ? "" : '{"tags":[',
                },
              },
            ],
          });
        }
        if (prompts.length > 4)
          return Promise.resolve({ content: "", toolCalls: [] });
        return Promise.resolve(reportFor(prompts));
      }),
    };
    const result = await classifyApplicationQuestions({
      client,
      sources: [],
      questions: formQuestions.map(([prompt]) => ({
        prompt,
        kind: "text",
        options: [],
      })),
    });
    expect(batches.map((batch) => batch.length)).toEqual([11, 4, 4, 3]);
    expect(batches.slice(1).flat()).toEqual(
      formQuestions.map(([prompt]) => prompt),
    );
    for (const [prompt, sourceId] of formQuestions) {
      expect(result.get(prompt)?.readFailed).toBeUndefined();
      expect(result.get(prompt)?.answerTags?.sourceId).toBe(sourceId);
    }
    // A protocol retry does not supply a missing personal story.
    expect(
      result.get("How/when did you start coding?")?.answerTags?.sourceId,
    ).toBeNull();
    expect(client.chatWithTools).toHaveBeenCalledTimes(4);
  },
);

test("one failed smaller read leaves only its questions unread while the other fields retain their sources", async () => {
  let calls = 0;
  const client: LLMClient = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages) => {
      calls += 1;
      if (calls <= 2) return Promise.resolve({ content: "", toolCalls: [] });
      return Promise.resolve(
        reportFor(JSON.parse(messages[1].content) as { question: string }[]),
      );
    }),
  };
  const result = await classifyApplicationQuestions({
    client,
    sources: [],
    questions: formQuestions.map(([prompt]) => ({
      prompt,
      kind: "text",
      options: [],
    })),
  });
  expect(
    [...result]
      .filter(([, reading]) => reading.readFailed)
      .map(([prompt]) => prompt),
  ).toEqual(formQuestions.slice(0, 4).map(([prompt]) => prompt));
  for (const [prompt, sourceId] of formQuestions.slice(4))
    expect(result.get(prompt)).toMatchObject({ answerTags: { sourceId } });
  expect(client.chatWithTools).toHaveBeenCalledTimes(4);
});

function clientReplying(questions: unknown): LLMClient {
  return {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({ questions }),
            },
          },
        ],
      }),
    ),
  } as unknown as LLMClient;
}

describe("classifyApplicationQuestions", () => {
  test("reads the model's answer for each question by its wording", async () => {
    const result = await classifyApplicationQuestions({
      client: clientReplying([
        { index: 0, asksAboutPay: true, declarationKind: null },
        {
          index: 1,
          asksAboutPay: false,
          declarationKind: "background_check_consent",
        },
        { index: 2, asksAboutPay: false, declarationKind: "not_a_kind" },
      ]),
      questions: [
        { prompt: "Gehaltsvorstellung", kind: "text", options: [] },
        { prompt: "We may verify your history", kind: "checkbox", options: [] },
        { prompt: "Portfolio link", kind: "text", options: [] },
      ],
    });

    expect(result.get("Gehaltsvorstellung")).toEqual({
      asksAboutPay: true,
      declarationKind: null,
    });
    expect(result.get("We may verify your history")).toEqual({
      asksAboutPay: false,
      declarationKind: "background_check_consent",
    });
    expect(result.get("Portfolio link")?.declarationKind).toBeNull();
  });

  test("hands the question over after two replies without the report", async () => {
    const client = {
      chatWithTools: () => Promise.resolve({ content: "ok", toolCalls: [] }),
    } as unknown as LLMClient;
    const result = await classifyApplicationQuestions({
      client,
      questions: [{ prompt: "Expected salary", kind: "text", options: [] }],
    });
    expect(result.get("Expected salary")?.readFailed).toBe(true);
  });
});

function controls(label = "Pay", options = ["Annual"], required = false) {
  return buildApplyFormObservation(
    {
      url: "https://example.test",
      title: "",
      bodyText: "",
      headings: [],
      controls: [
        {
          index: 0,
          tagName: "select",
          inputType: "",
          role: "",
          id: "pay",
          name: "pay",
          label,
          groupLabel: "",
          placeholder: "",
          autocomplete: "",
          required,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: true,
          value: "",
          checked: false,
          multiple: false,
          options,
          selectedOptionLabel: "",
        },
      ],
      actions: [],
      links: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    } satisfies RawApplyPage,
    "2026-10-05T10:00:00Z",
  ).controls;
}

test("shares one classification for concurrent decisions and changed values on the same step", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const classify = createQuestionClassifier({ client });
  const first = classify(controls(), "step1");
  const second = classify(controls(), "step1");
  expect(first).toBe(second);
  const questions = controls();
  questions[0].value = "Annual";
  questions[0].ref = "new-handle";
  expect(await classify(questions, "step1")).toEqual(await first);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("reuses across steps and requirement changes but reads new wording and options", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const classify = createQuestionClassifier({ client });
  await classify(controls(), "step1");
  await classify(controls(), "step2");
  await classify(controls("Rate"), "step2");
  await classify(controls("Rate", ["Hourly"]), "step2");
  await classify(controls("Rate", ["Hourly"], true), "step2");
  expect(client.chatWithTools).toHaveBeenCalledTimes(3);
});

test("retries a failed classification once before returning the reading", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  vi.mocked(client.chatWithTools).mockRejectedValueOnce(new Error("offline"));
  const classify = createQuestionClassifier({ client });
  expect((await classify(controls())).get("Pay")?.asksAboutPay).toBe(true);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("caches an incomplete page as a handover after exactly one retry", async () => {
  const client = clientReplying([]);
  const classify = createQuestionClassifier({ client });
  expect((await classify(controls())).get("Pay")?.readFailed).toBe(true);
  expect((await classify(controls())).get("Pay")?.answerTags).toBeNull();
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("a truncated report can recover on its single larger retry", async () => {
  const client = clientReplyingSparse({
    plainIndexes: [0],
    flagged: [],
    tags: [
      { index: 0, kind: "other", country: null, sourceId: "profile.fullName" },
    ],
  });
  vi.mocked(client.chatWithTools).mockResolvedValueOnce({
    toolCalls: [
      {
        id: "cut-off",
        type: "function",
        function: { name: "report_question_kinds", arguments: '{"tags":[' },
      },
    ],
  });
  const classify = createQuestionClassifier({ client, sources: () => [] });
  const result = await classify(controls("Full name", []));
  expect(result.get("Full name")?.answerTags?.sourceId).toBe(
    "profile.fullName",
  );
  expect(result.get("Full name")?.readFailed).toBeUndefined();
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  expect(
    vi
      .mocked(client.chatWithTools)
      .mock.calls.map((call) => call[2]?.maxOutputTokens),
  ).toEqual([4000, 8000]);
  await classify(controls("Full name", []));
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("retries only unread questions and retains complete readings", async () => {
  const client = clientReplyingSparse({
    plainIndexes: [0],
    flagged: [],
    tags: [
      { index: 0, kind: "other", country: null, sourceId: "profile.email" },
    ],
  });
  vi.mocked(client.chatWithTools).mockResolvedValueOnce({
    toolCalls: [
      {
        id: "partial",
        type: "function",
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            plainIndexes: [0],
            flagged: [],
            tags: [
              {
                index: 0,
                kind: "other",
                country: null,
                sourceId: "profile.fullName",
              },
            ],
          }),
        },
      },
    ],
  });
  const result = await classifyApplicationQuestions({
    client,
    sources: [],
    questions: ["Full name", "Email"].map((prompt) => ({
      prompt,
      kind: "text",
      options: [],
    })),
  });
  expect(result.get("Full name")?.answerTags?.sourceId).toBe(
    "profile.fullName",
  );
  expect(result.get("Email")?.answerTags?.sourceId).toBe("profile.email");
  expect(
    JSON.parse(vi.mocked(client.chatWithTools).mock.calls[1][0][1].content),
  ).toEqual([expect.objectContaining({ index: 0, question: "Email" })]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("an unread remainder is handed over without discarding a read question", async () => {
  const client = clientReplyingSparse({
    plainIndexes: [],
    flagged: [],
    tags: [],
  });
  vi.mocked(client.chatWithTools).mockResolvedValueOnce({
    toolCalls: [
      {
        id: "partial",
        type: "function",
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            plainIndexes: [0],
            flagged: [],
            tags: [
              {
                index: 0,
                kind: "other",
                country: null,
                sourceId: "profile.fullName",
              },
            ],
          }),
        },
      },
    ],
  });
  const result = await classifyApplicationQuestions({
    client,
    sources: [],
    questions: ["Full name", "Passport country"].map((prompt) => ({
      prompt,
      kind: "text",
      options: [],
    })),
  });
  expect(result.get("Full name")?.answerTags?.sourceId).toBe(
    "profile.fullName",
  );
  expect(result.get("Passport country")).toMatchObject({
    readFailed: true,
    answerTags: null,
  });
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("filled data and chosen options do not reread the page, but new instructions do", async () => {
  const client = clientReplyingSparse({
    plainIndexes: [0],
    flagged: [],
    tags: [],
  });
  const page = controls("Country of residence", ["Germany", "France"]);
  const classify = createQuestionClassifier({ client });
  const context = (text: string) => JSON.stringify({ instructions: text });
  await classify(page, context("Application\nCountry of residence"));
  page[0].value = "Germany";
  page[0].selectedOptionLabel = "Germany";
  const filled = context("Application\nCountry of residence\nGermany\nFrance");
  expect(classify.settled(page, filled)).toBeDefined();
  await classify(page, filled);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  page[0].value = "France";
  await classify(page, context("Application\nCountry of residence\nFrance"));
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  await classify(
    page,
    context("Application\nCountry of residence\nFrance\nWrite this yourself"),
  );
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  // Instructions are retained even if an entered value repeats them.
  page[0].value = "Write this yourself";
  await classify(
    page,
    context("Application\nCountry of residence\nWrite this yourself"),
  );
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  page[0].hint = "Only answer if you are a resident";
  await classify(page, filled);
  expect(client.chatWithTools).toHaveBeenCalledTimes(3);
  // Matching a value inside a larger sentence cannot erase a site condition.
  await classify(
    page,
    context(
      "Application\nCountry of residence\nFrance is required for this role",
    ),
  );
  expect(client.chatWithTools).toHaveBeenCalledTimes(4);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[3][0]),
  ).toContain("France is required for this role");
});

test("gives a large page enough output budget to classify every question", async () => {
  const client = clientReplying([]);
  await classifyApplicationQuestions({
    client,
    questions: Array.from({ length: 30 }, (_, index) => ({
      prompt: `Question ${index}`,
      kind: "text",
      options: [],
    })),
  });
  expect(
    vi.mocked(client.chatWithTools).mock.calls[0]?.[2]?.maxOutputTokens,
  ).toBe(7000);
});

test("returning to any step reuses each earlier question classification", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const classify = createQuestionClassifier({ client });
  await classify(controls(), "step1");
  await classify(controls(), "step2");
  await classify(controls(), "step1");
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  await classify(controls("Rate", ["Hourly"]), "step1");
  await classify(controls(), "step1");
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("keeps the model's hiring-country classification", async () => {
  const result = await classifyApplicationQuestions({
    client: clientReplying([
      {
        index: 0,
        asksAboutPay: false,
        asksHiringCountry: true,
        declarationKind: null,
      },
    ]),
    questions: [
      {
        prompt: "Which country would employ you for this role?",
        kind: "select",
        options: ["United States", "United Kingdom"],
      },
    ],
  });
  expect(
    result.get("Which country would employ you for this role?")
      ?.asksHiringCountry,
  ).toBe(true);
});

test("reads only the new question when a conditional field appears and keeps earlier pay permissions", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const classify = createQuestionClassifier({ client });
  const first = controls();
  await classify(first, "step1");
  const extra = {
    ...controls("Why this role?", [])[0],
    ref: "conditional",
    kind: "long_text" as const,
  };
  vi.mocked(client.chatWithTools).mockResolvedValueOnce({
    toolCalls: [
      {
        id: "next",
        type: "function",
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            questions: [
              { index: 0, asksAboutPay: false, declarationKind: null },
            ],
          }),
        },
      },
    ],
  });
  const result = await classify([...first, extra], "step1");
  expect(result.get("Pay")?.asksAboutPay).toBe(true);
  expect(result.get("Why this role?")?.asksAboutPay).toBe(false);
  const data = JSON.parse(
    String(vi.mocked(client.chatWithTools).mock.calls[1][0][1].content),
  ) as Array<{ question: string }>;
  expect(data.map((entry) => entry.question)).toEqual(["Why this role?"]);
  await classify(first, "step1");
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

function clientReplyingSparse(args: unknown): LLMClient {
  return {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify(args),
            },
          },
        ],
      }),
    ),
  } as unknown as LLMClient;
}

test("reuses a complete identical model read across applications, without sharing mutable results", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const cacheScope = {};
  const first = await createQuestionClassifier({ client, cacheScope })(
    controls(),
  );
  first.get("Pay")!.asksAboutPay = false;
  const nextControls = controls();
  nextControls[0].ref = "another-application";
  nextControls[0].value = "Annual";
  const next = await createQuestionClassifier({ client, cacheScope })(
    nextControls,
  );
  expect(next.get("Pay")?.asksAboutPay).toBe(true);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("shared reads require the full same request and AI-client scope", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  const cacheScope = {};
  for (const questions of [
    controls(),
    controls("Pay", ["Annual"], true),
    controls("Pay", ["Hourly"]),
    controls("Rate"),
  ]) {
    await createQuestionClassifier({ client, cacheScope })(questions);
  }
  await createQuestionClassifier({ client, cacheScope: {} })(controls());
  expect(client.chatWithTools).toHaveBeenCalledTimes(5);
});

test("incomplete, failed and cancelled reads never become reusable model decisions", async () => {
  const cacheScope = {};
  const client = clientReplying([]);
  expect(
    (await createQuestionClassifier({ client, cacheScope })(controls())).get(
      "Pay",
    )?.readFailed,
  ).toBe(true);
  vi.mocked(client.chatWithTools).mockRejectedValueOnce(new Error("offline"));
  expect(
    (await createQuestionClassifier({ client, cacheScope })(controls())).get(
      "Pay",
    )?.readFailed,
  ).toBe(true);
  vi.mocked(client.chatWithTools).mockResolvedValue({
    toolCalls: [
      {
        id: "complete",
        type: "function",
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({ plainIndexes: [0], flagged: [] }),
        },
      },
    ],
  });
  const abort = new AbortController();
  vi.mocked(client.chatWithTools).mockImplementationOnce(() => {
    abort.abort(new Error("Stopped"));
    return Promise.resolve({
      toolCalls: [
        {
          id: "cancelled",
          type: "function",
          function: {
            name: "report_question_kinds",
            arguments: JSON.stringify({ plainIndexes: [0], flagged: [] }),
          },
        },
      ],
    });
  });
  await expect(
    createQuestionClassifier({ client, cacheScope, signal: abort.signal })(
      controls(),
    ),
  ).rejects.toThrow("Stopped");
  await createQuestionClassifier({ client, cacheScope })(controls());
  await expect(
    createQuestionClassifier({ client, cacheScope, signal: abort.signal })(
      controls(),
    ),
  ).rejects.toThrow("Stopped");
  expect(client.chatWithTools).toHaveBeenCalledTimes(6);
});

test("bounds shared question reads and reads an evicted page with the model again", async () => {
  const cacheScope = {};
  const client = clientReplying([
    { index: 0, asksAboutPay: false, declarationKind: null },
  ]);
  for (let page = 0; page < 65; page++)
    await createQuestionClassifier({ client, cacheScope })(
      controls(`Page ${page}`),
    );
  await createQuestionClassifier({ client, cacheScope })(controls("Page 64"));
  expect(client.chatWithTools).toHaveBeenCalledTimes(65);
  await createQuestionClassifier({ client, cacheScope })(controls("Page 0"));
  expect(client.chatWithTools).toHaveBeenCalledTimes(66);
});

test("plain questions are named by index and only flagged ones are spelled out", async () => {
  const client = clientReplyingSparse({
    plainIndexes: [0, 2],
    flagged: [
      {
        index: 1,
        eligibilityKind: null,
        asksAboutPay: true,
        asksCurrentPay: false,
        asksHiringCountry: false,
        required: true,
        declarationKind: null,
      },
    ],
  });
  const result = await classifyApplicationQuestions({
    client,
    questions: [
      { prompt: "Full name", kind: "text", options: [] },
      { prompt: "Gehaltsvorstellung", kind: "text", options: [] },
      { prompt: "Portfolio link", kind: "text", options: [] },
    ],
  });
  expect(result.get("Full name")).toEqual({
    asksAboutPay: false,
    asksCurrentPay: false,
    asksHiringCountry: false,
    declarationKind: null,
  });
  expect(result.get("Gehaltsvorstellung")).toMatchObject({
    asksAboutPay: true,
    required: true,
  });
  expect(result.get("Portfolio link")?.declarationKind).toBeNull();
  const tool = vi.mocked(client.chatWithTools).mock.calls[0]?.[1]?.[0];
  expect(tool?.function.parameters.required).toEqual([
    "plainIndexes",
    "flagged",
    "tags",
  ]);
});

test("a question listed as plain and flagged keeps its flagged reading", async () => {
  const result = await classifyApplicationQuestions({
    client: clientReplyingSparse({
      plainIndexes: [0],
      flagged: [
        {
          index: 0,
          eligibilityKind: null,
          asksAboutPay: false,
          asksCurrentPay: false,
          asksHiringCountry: false,
          required: false,
          declarationKind: "terms_acceptance",
        },
      ],
    }),
    questions: [
      { prompt: "I accept the terms", kind: "checkbox", options: [] },
    ],
  });
  expect(result.get("I accept the terms")?.declarationKind).toBe(
    "terms_acceptance",
  );
});

test("a question left out of both lists is not taken as plain", async () => {
  const classify = createQuestionClassifier({
    client: clientReplyingSparse({ plainIndexes: [], flagged: [] }),
  });
  expect((await classify(controls())).get("Pay")?.readFailed).toBe(true);
});

test("settled readings are offered only once every question has come back", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    chatWithTools: vi.fn(async () => {
      await gate;
      return {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({ plainIndexes: [0], flagged: [] }),
            },
          },
        ],
      };
    }),
  } as unknown as LLMClient;
  const classify = createQuestionClassifier({ client });
  const pending = classify(controls());
  expect(classify.settled(controls())).toBeUndefined();
  release();
  await pending;
  expect(classify.settled(controls())?.get("Pay")).toEqual({
    asksAboutPay: false,
    asksCurrentPay: false,
    asksHiringCountry: false,
    declarationKind: null,
  });
  expect(classify.settled(controls("Rate"))).toBeUndefined();
});

test("typed readings bind instructions while keeping meaning across a source refresh", async () => {
  const client = clientReplying([]);
  vi.mocked(client.chatWithTools).mockImplementation(() =>
    Promise.resolve({
      toolCalls: [
        {
          id: "tags",
          type: "function",
          function: {
            name: "report_question_kinds",
            arguments: JSON.stringify({
              plainIndexes: [0],
              flagged: [],
              tags: [
                { index: 0, kind: "own_words", country: null, sourceId: null },
              ],
            }),
          },
        },
      ],
    }),
  );
  let value = "Saved text";
  const classify = createQuestionClassifier({
    client,
    sources: () => [
      { id: "saved", value, purpose: "saved", country: null, question: "Pay" },
    ],
  });
  const page = controls();
  const context = JSON.stringify({ instructions: "Write this yourself" });
  expect((await classify(page, context)).get("Pay")?.answerTags?.kind).toBe(
    "own_words",
  );
  await classify(page, context);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  await classify(
    page,
    JSON.stringify({ instructions: "Responda com suas próprias palavras" }),
  );
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  value = "Edited text";
  expect(classify.settled(page, context)).toBeDefined();
  await classify(page, context);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[0][0]),
  ).toContain("Write this yourself");
  page[0].groupLabel = "Employment";
  await classify(page, context);
  expect(client.chatWithTools).toHaveBeenCalledTimes(3);
});
test("duplicate or malformed tags never become an answer permission", async () => {
  const client = clientReplying([]);
  vi.mocked(client.chatWithTools).mockResolvedValue({
    toolCalls: [
      {
        id: "bad",
        type: "function",
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            plainIndexes: [0, 1],
            flagged: [],
            tags: [
              { index: 0, kind: "other", country: null, sourceId: "saved" },
              { index: 0, kind: "other", country: null, sourceId: "other" },
              {
                index: 1,
                kind: "work_auth",
                country: "ZZ",
                sourceId: "profile",
              },
            ],
          }),
        },
      },
    ],
  });
  const result = await classifyApplicationQuestions({
    client,
    questions: [
      { prompt: "One", kind: "text", options: [] },
      { prompt: "Two", kind: "text", options: [] },
    ],
  });
  expect(result.get("One")?.answerTags).toBeNull();
  expect(result.get("Two")?.answerTags).toBeNull();
});

test("a GitHub help-text change is read again instead of reusing the URL reading", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: false, declarationKind: null },
  ]);
  const page = controls("GitHub");
  page[0].hint = "Please provide your GitHub username";
  const classify = createQuestionClassifier({ client });
  await classify(page);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[0][0]),
  ).toContain(page[0].hint);
  await classify(page);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  page[0].hint = "Please provide your GitHub profile URL";
  await classify(page);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[1][0]),
  ).toContain(page[0].hint);
});
