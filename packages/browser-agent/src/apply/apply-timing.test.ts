import { expect, test } from "vitest";
import { ApplyAgentTimingSchema } from "@nestor/contracts";
import type { RawApplyPage } from "@nestor/contracts";
import type { ApplyPageHands } from "./types";
import { buildApplyFormObservation } from "./page-hands";
import recordedPage from "./synthetic-page.snapshot.json";
import { createApplyTiming } from "./apply-timing";

test("counts provider tokens for filling and checks, and exposes calls without usage", async () => {
  const timing = createApplyTiming(() => new Date(0));
  let call = 0;
  const client = timing.model({
    chatWithTools: (_messages, _tools, options) => {
      expect(options?.includeUsage).toBe(true);
      if (++call === 3) return Promise.resolve({});
      return Promise.resolve({
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 60,
          reasoningTokens: 5,
        },
      });
    },
  });
  await client.chatWithTools([], [], { parallelToolCalls: true });
  const first = timing.snapshot();
  await client.chatWithTools([], []);
  await client.chatWithTools([], []);
  expect(first.tokenUsage?.inputTokens).toBe(100);
  expect(ApplyAgentTimingSchema.parse(timing.snapshot()).tokenUsage).toEqual({
    reportedCalls: 2,
    unreportedCalls: 1,
    inputTokens: 200,
    outputTokens: 40,
    cachedInputTokens: 120,
    reasoningTokens: 10,
  });
});

test("measures decisions, auxiliary checks, reads, writes, uploads and longest steps without storing content", async () => {
  let ms = 0;
  const timing = createApplyTiming(() => new Date(ms));
  timing.setObservationChars(100);
  const model = timing.model({
    chatWithTools: () => {
      ms += 50;
      return Promise.resolve({});
    },
  });
  await model.chatWithTools([{ role: "user", content: "synthetic page" }], [], {
    parallelToolCalls: true,
  });
  await model.chatWithTools(
    [{ role: "user", content: "synthetic fact check" }],
    [],
  );
  timing.onToolTiming({ toolName: "fill_fields", durationMs: 80 });
  const snapshot = ApplyAgentTimingSchema.parse(timing.snapshot());
  expect(snapshot).toMatchObject({
    totalMs: 100,
    modelMs: 50,
    modelTurns: 1,
    auxiliaryModelMs: 50,
    auxiliaryModelCalls: 1,
    toolMs: 80,
  });
  expect(snapshot.requests).toEqual([
    {
      turn: 1,
      historyChars: JSON.stringify([
        { role: "user", content: "synthetic page" },
      ]).length,
      observationChars: 100,
      fieldsAttempted: 0,
      fieldsFilled: 0,
      storedFactFills: 0,
      answersWaited: 0,
      stepsAdvanced: 0,
      uploadsAttached: 0,
    },
  ]);
  expect(snapshot.longestSteps[0]).toEqual({
    toolName: "fill_fields",
    durationMs: 80,
  });
  expect(JSON.stringify(snapshot)).not.toContain("synthetic page");
});

test("a failed model attempt is counted and active calls are included on stop", async () => {
  let ms = 0;
  const timing = createApplyTiming(() => new Date(ms));
  const model = timing.model({
    chatWithTools: () => {
      ms += 20;
      return Promise.reject(new Error("Synthetic failure"));
    },
  });
  await expect(
    model.chatWithTools([], [], { parallelToolCalls: true }),
  ).rejects.toThrow("Synthetic failure");
  expect(timing.snapshot()).toMatchObject({ modelTurns: 1, modelMs: 20 });
  let resolve:
    | ((
        value: Awaited<
          ReturnType<Parameters<typeof timing.model>[0]["chatWithTools"]>
        >,
      ) => void)
    | undefined;
  const slowModel = timing.model({
    chatWithTools: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const work = slowModel.chatWithTools([], [], { parallelToolCalls: true });
  ms += 30;
  expect(timing.snapshot()).toMatchObject({ modelTurns: 2, modelMs: 50 });
  resolve?.({});
  await work;
  expect(timing.snapshot()).toMatchObject({ modelTurns: 2, modelMs: 50 });
});

test("counts every safety read and measures uploads, writes and failed reads", async () => {
  let ms = 0;
  const timing = createApplyTiming(() => new Date(ms));
  const ok = () =>
    Promise.resolve({ ok: true as const, observedValue: "Synthetic" });
  const page = buildApplyFormObservation(
    recordedPage as RawApplyPage,
    "2026-10-05T07:40:00.000Z",
  );
  const base: ApplyPageHands = {
    observe: () => {
      ms += 10;
      return Promise.resolve(page);
    },
    readText: () => {
      ms += 5;
      return Promise.resolve("Synthetic");
    },
    fillText: () => {
      ms += 20;
      return Promise.resolve({ ok: true, observedValue: "Synthetic" });
    },
    uploadFile: () => {
      ms += 30;
      return Promise.resolve({ ok: true, observedValue: "synthetic.pdf" });
    },
    chooseOption: ok,
    setToggle: ok,
    clickElement: ok,
    clickAction: ok,
    scroll: ok,
    navigate: () =>
      Promise.resolve({
        ok: true,
        url: "http://127.0.0.1:47950/clientnest/apply/4",
      }),
    followLink: () =>
      Promise.resolve({
        ok: true,
        url: "http://127.0.0.1:47950/clientnest/apply/4",
      }),
    goBack: () =>
      Promise.resolve({
        ok: true,
        url: "http://127.0.0.1:47950/clientnest/apply/4",
      }),
    wait: () => Promise.resolve(),
  };
  const hands = timing.hands(base);
  await hands.observe();
  await hands.observe();
  await hands.readText();
  await hands.fillText("c0", "Synthetic");
  await hands.uploadFile("c1", {
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    bytes: new Uint8Array(),
  });
  await expect(
    timing
      .hands({
        ...base,
        observe: () => {
          ms += 10;
          return Promise.reject(new Error("Synthetic read failure"));
        },
      })
      .observe(),
  ).rejects.toThrow("Synthetic read failure");
  expect(timing.snapshot()).toMatchObject({
    pageReads: 4,
    pageReadMs: 35,
    writeMs: 20,
    uploadMs: 30,
    totalMs: 85,
  });
});

test("field counts belong to their decision turn and snapshots do not change later", async () => {
  const timing = createApplyTiming(() => new Date(0));
  const model = timing.model({ chatWithTools: () => Promise.resolve({}) });
  await model.chatWithTools([], [], { parallelToolCalls: true });
  timing.onFieldAttempt();
  timing.onFieldFilled();
  timing.onStepAdvanced();
  timing.onUploadAttached();
  const first = timing.snapshot();
  timing.onFieldAttempt(); // refused field
  await model.chatWithTools([], []); // auxiliary check is not a new turn
  timing.onFieldAttempt();
  timing.onFieldFilled();
  await model.chatWithTools([], [], { parallelToolCalls: true });
  const snapshot = ApplyAgentTimingSchema.parse(timing.snapshot());
  expect(first.requests[0]).toMatchObject({
    fieldsAttempted: 1,
    fieldsFilled: 1,
    stepsAdvanced: 1,
    uploadsAttached: 1,
  });
  expect(snapshot.requests).toMatchObject([
    {
      turn: 1,
      fieldsAttempted: 3,
      fieldsFilled: 2,
      stepsAdvanced: 1,
      uploadsAttached: 1,
    },
    {
      turn: 2,
      fieldsAttempted: 0,
      fieldsFilled: 0,
      storedFactFills: 0,
      answersWaited: 0,
      stepsAdvanced: 0,
      uploadsAttached: 0,
    },
  ]);
});

test("records question reading separately from answer checks and persists stored fills per turn", async () => {
  let ms = 0;
  const timing = createApplyTiming(() => new Date(ms));
  const client = timing.model({
    chatWithTools: () => {
      ms += 25;
      return Promise.resolve({});
    },
  });
  await client.chatWithTools([], [], { parallelToolCalls: true });
  timing.onStoredFactFilled();
  timing.onStoredFactFilled();
  timing.onAnswerWaited();
  const tool = (name: string) => [
    {
      type: "function" as const,
      function: {
        name,
        description: "Synthetic check",
        parameters: { type: "object" as const, properties: {} },
      },
    },
  ];
  await client.chatWithTools([], tool("report_question_kinds"));
  await client.chatWithTools([], tool("report_question_kinds"));
  await client.chatWithTools([], tool("report_answer_checks"));
  const recorded = ApplyAgentTimingSchema.parse(timing.snapshot());
  expect(recorded).toMatchObject({
    auxiliaryModelCalls: 3,
    questionReadingCalls: 2,
    questionReadingMs: 50,
    answerCheckCalls: 1,
    answerCheckMs: 25,
  });
  expect(recorded.requests[0]).toMatchObject({
    storedFactFills: 2,
    answersWaited: 1,
  });
});
