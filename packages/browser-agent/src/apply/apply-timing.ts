import type { ApplyAgentTiming, ModelTokenUsage } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import type { ApplyPageHands } from "./types";

/** Only sizes, counts and durations are retained, never page or candidate text. */
export function createApplyTiming(now: () => Date) {
  const startedAt = now().getTime();
  const timing: ApplyAgentTiming = {
    totalMs: 0,
    modelMs: 0,
    modelTurns: 0,
    auxiliaryModelMs: 0,
    auxiliaryModelCalls: 0,
    transportCalls: 0,
    transportRetries: 0,
    tokenUsage: {
      reportedCalls: 0,
      unreportedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    questionReadingCalls: 0,
    questionReadingMs: 0,
    answerCheckCalls: 0,
    answerCheckMs: 0,
    toolMs: 0,
    pageReadMs: 0,
    pageReads: 0,
    writeMs: 0,
    uploadMs: 0,
    longestSteps: [],
    requests: [],
  };
  let observationChars = 0;
  const answerSources: Array<{
    storedFactFills: number;
    answersWaited: number;
  }> = [];
  const activeTools = new Map<
    object,
    {
      startedAt: number;
      name: string;
      key: "pageReadMs" | "writeMs" | "uploadMs";
    }
  >();
  const activeModels = new Map<
    object,
    { startedAt: number; loop: boolean; kind: "question" | "answer" | "other" }
  >();
  const step = (toolName: string, durationMs: number) => {
    timing.longestSteps = [...timing.longestSteps, { toolName, durationMs }]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5);
  };
  const measure = async <T>(
    name: string,
    key: "pageReadMs" | "writeMs" | "uploadMs",
    work: () => Promise<T>,
  ): Promise<T> => {
    const start = now().getTime();
    const activeKey = {};
    activeTools.set(activeKey, { startedAt: start, name, key });
    if (key === "pageReadMs") timing.pageReads += 1;
    try {
      return await work();
    } finally {
      const duration = Math.max(0, now().getTime() - start);
      activeTools.delete(activeKey);
      timing[key] += duration;
    }
  };
  return {
    setObservationChars: (chars: number) => {
      observationChars = chars;
    },
    onStepAdvanced: () => {
      const request = timing.requests.at(-1);
      if (request) request.stepsAdvanced = (request.stepsAdvanced ?? 0) + 1;
    },
    onUploadAttached: () => {
      const request = timing.requests.at(-1);
      if (request) request.uploadsAttached = (request.uploadsAttached ?? 0) + 1;
    },
    onStoredFactFilled: () => {
      const counts = answerSources.at(-1);
      if (counts) counts.storedFactFills += 1;
      const request = timing.requests.at(-1);
      if (request) request.storedFactFills = (request.storedFactFills ?? 0) + 1;
    },
    onAnswerWaited: () => {
      const counts = answerSources.at(-1);
      if (counts) counts.answersWaited += 1;
      const request = timing.requests.at(-1);
      if (request) request.answersWaited = (request.answersWaited ?? 0) + 1;
    },
    answerSourcesPerTurn: () => answerSources.map((counts) => ({ ...counts })),
    onFieldAttempt: () => {
      const request = timing.requests.at(-1);
      if (request) request.fieldsAttempted = (request.fieldsAttempted ?? 0) + 1;
    },
    onFieldFilled: () => {
      const request = timing.requests.at(-1);
      if (request) request.fieldsFilled = (request.fieldsFilled ?? 0) + 1;
    },
    onToolTiming: ({
      toolName,
      durationMs,
    }: {
      toolName: string;
      durationMs: number;
    }) => {
      timing.toolMs += durationMs;
      step(toolName, durationMs);
    },
    hands: (hands: ApplyPageHands): ApplyPageHands => ({
      ...hands,
      observe: () => measure("observe", "pageReadMs", hands.observe),
      readText: (ref) =>
        measure("read_text", "pageReadMs", () => hands.readText(ref)),
      ...(hands.checkAction
        ? {
            checkAction: (ref: string) =>
              measure("check_action", "pageReadMs", () =>
                hands.checkAction!(ref),
              ),
          }
        : {}),
      fillText: (ref, value) =>
        measure("type", "writeMs", () => hands.fillText(ref, value)),
      chooseOption: (ref, value) =>
        measure("select", "writeMs", () => hands.chooseOption(ref, value)),
      setToggle: (ref, checked) =>
        measure("set_checkbox", "writeMs", () => hands.setToggle(ref, checked)),
      uploadFile: (ref, file) =>
        measure("upload", "uploadMs", () => hands.uploadFile(ref, file)),
    }),
    model: (client: LLMClient): LLMClient => ({
      chatWithTools: async (messages, tools, options) => {
        const loop = options?.parallelToolCalls === true;
        const kind = tools.some(
          (tool) => tool.function.name === "report_question_kinds",
        )
          ? "question"
          : tools.some((tool) => tool.function.name === "report_answer_checks")
            ? "answer"
            : "other";
        const start = now().getTime();
        const key = {};
        activeModels.set(key, { startedAt: start, loop, kind });
        if (kind === "question") timing.questionReadingCalls! += 1;
        if (kind === "answer") timing.answerCheckCalls! += 1;
        if (loop) {
          timing.modelTurns += 1;
          answerSources.push({ storedFactFills: 0, answersWaited: 0 });
          timing.requests.push({
            turn: timing.modelTurns,
            historyChars: JSON.stringify(messages).length,
            observationChars,
            fieldsAttempted: 0,
            fieldsFilled: 0,
            storedFactFills: 0,
            answersWaited: 0,
            stepsAdvanced: 0,
            uploadsAttached: 0,
          });
        } else timing.auxiliaryModelCalls += 1;
        const usage = timing.tokenUsage!;
        usage.unreportedCalls += 1;
        let usageEvents = 0;
        const recordUsage = (current: ModelTokenUsage) => {
          if (!current.estimated) {
            usage.unreportedCalls -= 1;
            usage.reportedCalls += 1;
          }
          for (const field of [
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "reasoningTokens",
          ] as const)
            usage[field] += current[field];
          if (current.estimated) {
            const before = usage.estimated;
            usage.estimated = {
              ...current.estimated,
              calls: (before?.calls ?? 0) + current.estimated.calls,
              inputTokens:
                (before?.inputTokens ?? 0) + current.estimated.inputTokens,
              outputTokens:
                (before?.outputTokens ?? 0) + current.estimated.outputTokens,
            };
          }
        };
        try {
          const response = await client.chatWithTools(messages, tools, {
            ...options,
            includeUsage: true,
            onRequestUsage: (event) => {
              usageEvents += 1;
              recordUsage(event);
              options?.onRequestUsage?.(event);
            },
            onRequestAttempt: (event) => {
              timing.transportCalls! += 1;
              if (event.attempt > 0) {
                timing.transportRetries! += 1;
                usage.unreportedCalls += 1;
              }
              options?.onRequestAttempt?.(event);
            },
          });
          // Legacy injected clients may only expose usage on their final reply.
          if (!usageEvents && response.usage) recordUsage(response.usage);
          return response;
        } finally {
          const duration = Math.max(0, now().getTime() - start);
          activeModels.delete(key);
          timing[loop ? "modelMs" : "auxiliaryModelMs"] += duration;
          if (kind === "question") timing.questionReadingMs! += duration;
          if (kind === "answer") timing.answerCheckMs! += duration;
        }
      },
    }),
    snapshot: (): ApplyAgentTiming => {
      const current = now().getTime();
      const active = [...activeModels.values()];
      const pendingTools = [...activeTools.values()];
      const pendingMs = (key: "pageReadMs" | "writeMs" | "uploadMs") =>
        pendingTools
          .filter((tool) => tool.key === key)
          .reduce(
            (sum, tool) => sum + Math.max(0, current - tool.startedAt),
            0,
          );
      return {
        ...timing,
        tokenUsage: {
          ...timing.tokenUsage!,
          ...(timing.tokenUsage?.estimated
            ? { estimated: { ...timing.tokenUsage.estimated } }
            : {}),
        },
        totalMs: Math.max(0, current - startedAt),
        modelMs:
          timing.modelMs +
          active
            .filter((call) => call.loop)
            .reduce(
              (sum, call) => sum + Math.max(0, current - call.startedAt),
              0,
            ),
        auxiliaryModelMs:
          timing.auxiliaryModelMs +
          active
            .filter((call) => !call.loop)
            .reduce(
              (sum, call) => sum + Math.max(0, current - call.startedAt),
              0,
            ),
        questionReadingMs:
          timing.questionReadingMs! +
          active
            .filter((call) => call.kind === "question")
            .reduce(
              (sum, call) => sum + Math.max(0, current - call.startedAt),
              0,
            ),
        answerCheckMs:
          timing.answerCheckMs! +
          active
            .filter((call) => call.kind === "answer")
            .reduce(
              (sum, call) => sum + Math.max(0, current - call.startedAt),
              0,
            ),
        pageReadMs: timing.pageReadMs + pendingMs("pageReadMs"),
        writeMs: timing.writeMs + pendingMs("writeMs"),
        uploadMs: timing.uploadMs + pendingMs("uploadMs"),
        // Record owning tool spans once, rather than their nested reads again.
        longestSteps: [...timing.longestSteps],
        requests: timing.requests
          .slice(0, 1000)
          .map((request) => ({ ...request })),
      };
    },
  };
}
