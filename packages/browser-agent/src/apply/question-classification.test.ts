import { describe, expect, test, vi } from "vitest";

import { buildApplyFormObservation } from "./page-hands";
import type { RawApplyPage } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import {
  classifyApplicationQuestions,
  createQuestionClassifier,
} from "./question-classification";

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

  test("returns nothing for a reply without the report", async () => {
    const client = {
      chatWithTools: () => Promise.resolve({ content: "ok", toolCalls: [] }),
    } as unknown as LLMClient;
    const result = await classifyApplicationQuestions({
      client,
      questions: [{ prompt: "Expected salary", kind: "text", options: [] }],
    });
    expect(result.size).toBe(0);
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

test("retries a failed classification rather than caching the failure", async () => {
  const client = clientReplying([
    { index: 0, asksAboutPay: true, declarationKind: null },
  ]);
  vi.mocked(client.chatWithTools).mockRejectedValueOnce(new Error("offline"));
  const classify = createQuestionClassifier({ client });
  await expect(classify(controls())).rejects.toThrow("offline");
  expect((await classify(controls())).get("Pay")?.asksAboutPay).toBe(true);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("does not cache an incomplete reply as a checked page", async () => {
  const client = clientReplying([]);
  const classify = createQuestionClassifier({ client });
  await expect(classify(controls())).rejects.toThrow("every question");
  await expect(classify(controls())).rejects.toThrow("every question");
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
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
  ).toBe(4800);
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
  await expect(
    createQuestionClassifier({ client, cacheScope })(controls()),
  ).rejects.toThrow("every question");
  vi.mocked(client.chatWithTools).mockRejectedValueOnce(new Error("offline"));
  await expect(
    createQuestionClassifier({ client, cacheScope })(controls()),
  ).rejects.toThrow("offline");
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
  expect(client.chatWithTools).toHaveBeenCalledTimes(4);
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
  await expect(classify(controls())).rejects.toThrow("every question");
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

test("typed readings bind page instructions and current sources into their cache", async () => {
  const client = clientReplying([]);
  vi.mocked(client.chatWithTools).mockImplementation(() => Promise.resolve(({
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
  })));
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
  expect(classify.settled(page, context)).toBeUndefined();
  await classify(page, context);
  expect(client.chatWithTools).toHaveBeenCalledTimes(3);
  expect(
    JSON.stringify(vi.mocked(client.chatWithTools).mock.calls[0][0]),
  ).toContain("Write this yourself");
  page[0].groupLabel = "Employment";
  await classify(page, context);
  expect(client.chatWithTools).toHaveBeenCalledTimes(4);
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
