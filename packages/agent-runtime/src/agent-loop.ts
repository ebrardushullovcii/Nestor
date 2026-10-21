/**
 * The one loop every Job Finder agent runs on.
 *
 * The model is told the goal, given tools, and left to decide. This loop does
 * the small set of things that must not depend on a model being right, and
 * nothing else:
 *
 * - it hands each tool's answer back, including a browser failure, as a fact
 *   the model can act on rather than as the end of the run
 * - it warns once when nothing has moved for a while, and only ends the run
 *   if nothing moves after that either
 * - it keeps the run inside a time and step ceiling far above what an honest
 *   run needs, so a broken site cannot hold it forever
 * - it trims a long conversation so a run that takes hundreds of steps keeps
 *   fitting, and says what it trimmed
 * - it shortens old tool answers (mostly page views the model has since moved
 *   past), so each turn sends the current page rather than every page so far
 *
 * Deciding where to go, what to press, when the goal is met, and what to tell
 * the person is the model's. See ADR 0023.
 */

/**
 * Private model state a route needs back on its later tool turns (for
 * example DeepSeek thinking-mode reasoning). Opaque to the loop; providers
 * send it only to the route that produced it.
 */
export interface AgentLoopContinuation {
  kind: "reasoning_content";
  route: string;
  text: string;
}

export type AgentLoopMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: AgentLoopToolCall[];
      continuation?: AgentLoopContinuation;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface AgentLoopToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The shape the model is handed for one tool. */
export interface AgentLoopToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface AgentLoopModel {
  chatWithTools: (
    messages: AgentLoopMessage[],
    tools: AgentLoopToolDefinition[],
    options?: {
      signal?: AbortSignal;
      maxOutputTokens?: number;
      parallelToolCalls?: boolean;
    },
  ) => Promise<{
    content?: string;
    toolCalls?: AgentLoopToolCall[];
  }>;
}

/** What the model said when it finished, in its own words plus typed extras. */
export interface AgentLoopFinish {
  reason: string;
  stuck: boolean;
  needsPerson: boolean;
  data: Record<string, unknown>;
}

export type AgentLoopToolOutcome =
  /** The tool did its work, or refused with a reason. Either way the model reads it. */
  | {
      kind: "ok";
      content: string;
      progress?: boolean;
      /**
       * How the step went, for hosts that show activity: a refusal or a
       * failed attempt still hands its words back to the model.
       */
      status?: "done" | "failed" | "refused";
      /** Remaining calls were proposed against a page or decision that is no longer current. */
      stopBatch?: boolean;
    }
  /** The model finished. */
  | { kind: "finish"; finish: AgentLoopFinish }
  /** A safety rule ended the run. The person reads `reason`. */
  | { kind: "stop"; reason: string; data?: unknown };

export interface AgentLoopToolContext {
  step: number;
  signal?: AbortSignal;
}

export interface AgentLoopTool {
  definition: AgentLoopToolDefinition;
  /** Only page tools count repeated thrown failures as a dead browser. */
  failureKind?: "browser" | "tool";
  /** Converts a page-library exception into safe, plain words for the model. */
  describeError?: (error: unknown) => string;
  /** Receives the raw JSON the model sent; the tool parses and validates it. */
  execute: (
    rawArguments: string,
    context: AgentLoopToolContext,
  ) => Promise<AgentLoopToolOutcome>;
}

export interface AgentLoopCeilings {
  /** Safety only. Far above an honest run. */
  maxSteps?: number;
  timeBudgetMs?: number;
  /** Steps without progress before the one stall warning; the same again ends the run. */
  noProgressStepLimit?: number;
  /** Browser failures in a row that end the run. */
  browserFailureLimit?: number;
  /** One model request may not consume the whole run while the page sits idle. */
  modelTurnTimeoutMs?: number;
  /**
   * Retries a model turn that produced no response or a typed transient HTTP
   * failure and therefore executed no tools. The same messages are reused and
   * the run's existing time budget is never extended.
   */
  modelTurnTimeoutRetries?: number;
  /**
   * Longest one tool call may take before the loop gives up on it and tells
   * the model so. A page read or a save that hangs must never freeze the run
   * or swallow a stop request.
   */
  toolTimeoutMs?: number;
}

export interface AgentLoopOptions {
  /** System prompt, opening messages, and anything a resumed run already had. */
  messages: AgentLoopMessage[];
  model: AgentLoopModel;
  tools: AgentLoopTool[];
  /** What the run is on, in the person's words: "the careers site". */
  subjectLabel: string;
  ceilings?: AgentLoopCeilings;
  /** Called after every step with the loop's own one-line note. */
  onStep?: (info: {
    step: number;
    note: string;
    progressSteps: number;
    elapsedMs: number;
  }) => void | Promise<void>;
  /** Extra lines for the stall warning, such as where the run is. */
  describeStall?: () => string | null;
  /** Rough size at which older turns are trimmed. */
  compactionMaxChars?: number;
  /**
   * Tool answers older than the most recent few are cut to this many
   * characters. A page view is out of date once the model has acted again;
   * it can always look at the page anew. Null keeps every answer whole.
   */
  staleToolResultChars?: number | null;
  /**
   * How many of the newest tool answers stay whole. Defaults to four; a host
   * whose answers are long page views can keep fewer.
   */
  staleToolResultKeepRecent?: number;
  /** Output cap for one model turn. Omit to use the provider default. */
  modelMaxOutputTokens?: number;
  parallelToolCalls?: boolean;
  /** Host supplies a fresh observation after a response batch, if needed. */
  afterToolBatch?: () => Promise<string | null>;
  /**
   * A reply with words and no tool call. The host may take it as a step of
   * its own (most often the model reporting that it is done) instead of the
   * loop spending a turn asking for a tool. Null keeps the default reminder.
   */
  onReplyWithoutTool?: (
    content: string,
  ) => Promise<AgentLoopToolOutcome | null>;
  onHistoryCompacted?: () => string | null;
  /** Called for every attempted tool, including failures. */
  onToolTiming?: (step: { toolName: string; durationMs: number }) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export type AgentLoopEnding =
  | "finished"
  | "stopped"
  | "stalled"
  | "timed_out"
  | "ceiling"
  | "aborted"
  | "browser_failed";

export interface AgentLoopResult {
  ending: AgentLoopEnding;
  /** One plain sentence about how the run ended. Shown to the person as-is. */
  reason: string;
  finish: AgentLoopFinish | null;
  stop: { reason: string; data?: unknown } | null;
  steps: number;
  progressSteps: number;
  /** One line per turn: what the model asked for and what came of it. */
  turnNotes: string[];
  messages: AgentLoopMessage[];
  timing: {
    totalMs: number;
    modelMs: number;
    toolMs: number;
    modelTurns: number;
  };
}

const DEFAULT_MAX_STEPS = 300;
const DEFAULT_TIME_BUDGET_MS = 20 * 60_000;
const DEFAULT_NO_PROGRESS_STEP_LIMIT = 12;
const DEFAULT_BROWSER_FAILURE_LIMIT = 3;
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 240_000;
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;
const DEFAULT_COMPACTION_MAX_CHARS = 360_000;
const COMPACTION_KEEP_RECENT = 14;
const DEFAULT_STALE_TOOL_RESULT_CHARS = 700;
/** Tool answers kept whole, counted from the newest. */
const STALE_TOOL_RESULT_KEEP_RECENT = 4;
/**
 * Old answers are shortened a few at a time, so the conversation's start
 * stays the same for several turns and the provider's prompt cache holds.
 */
const STALE_TOOL_RESULT_BATCH = 4;
const STALE_TOOL_RESULT_NOTE =
  "[Older answer shortened to save room. Look again for the page as it is now.]";

const RETRYABLE_MODEL_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableModelHttpError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "ModelRequestHttpError") {
    return false;
  }
  const status: unknown = Reflect.get(error, "status");
  return (
    typeof status === "number" && RETRYABLE_MODEL_HTTP_STATUSES.has(status)
  );
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function messageChars(message: AgentLoopMessage): number {
  const base = message.content.length;
  return message.role === "assistant" && message.toolCalls
    ? base + JSON.stringify(message.toolCalls).length
    : base;
}

/**
 * Trims the middle of a long conversation.
 *
 * The opening (system prompt and the goal) and the most recent turns stay
 * word for word. Everything between is replaced by the loop's own turn notes,
 * so the model still knows what it did and what came of it.
 */
function compactMessages(
  messages: AgentLoopMessage[],
  openingCount: number,
  turnNotes: readonly string[],
  maxChars: number,
): AgentLoopMessage[] {
  const total = messages.reduce(
    (sum, message) => sum + messageChars(message),
    0,
  );
  if (
    total <= maxChars ||
    messages.length <= openingCount + COMPACTION_KEEP_RECENT
  ) {
    return messages;
  }
  // Cut only at an assistant message, so a tool result never loses the call
  // it answers.
  let cut = messages.length - COMPACTION_KEEP_RECENT;
  while (cut > openingCount && messages[cut]?.role !== "assistant") {
    cut -= 1;
  }
  if (cut <= openingCount) {
    return messages;
  }
  const summary = [
    "Earlier turns were trimmed to save room. What happened in them, in order:",
    ...turnNotes.slice(-80).map((note) => `- ${note}`),
    "The most recent turns follow in full.",
  ].join("\n");
  return [
    ...messages.slice(0, openingCount),
    { role: "user", content: summary },
    ...messages.slice(cut),
  ];
}

/**
 * Cuts tool answers older than the most recent few down to their opening
 * lines, which say what the step did and where it landed. Answers already
 * short enough, and the opening messages, stay as they are.
 */
function shortenStaleToolResults(
  messages: AgentLoopMessage[],
  openingCount: number,
  maxChars: number,
  keepRecent: number,
): AgentLoopMessage[] {
  const stale: number[] = [];
  let seen = 0;
  for (let index = messages.length - 1; index >= openingCount; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") continue;
    seen += 1;
    if (
      seen > keepRecent &&
      message.content.length > maxChars + STALE_TOOL_RESULT_NOTE.length + 2
    ) {
      stale.push(index);
    }
  }
  if (stale.length < STALE_TOOL_RESULT_BATCH) {
    return messages;
  }
  const next = [...messages];
  for (const index of stale) {
    const message = next[index];
    if (message?.role !== "tool") continue;
    const head = message.content.slice(0, maxChars);
    const lineEnd = head.lastIndexOf("\n");
    const cut = lineEnd > maxChars / 2 ? head.slice(0, lineEnd) : head;
    next[index] = {
      ...message,
      content: `${cut.trimEnd()}\n${STALE_TOOL_RESULT_NOTE}`,
    };
  }
  return next;
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const now = options.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const maxSteps = Math.max(1, options.ceilings?.maxSteps ?? DEFAULT_MAX_STEPS);
  const timeBudgetMs = Math.max(
    1,
    options.ceilings?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
  );
  const noProgressStepLimit = Math.max(
    3,
    options.ceilings?.noProgressStepLimit ?? DEFAULT_NO_PROGRESS_STEP_LIMIT,
  );
  const browserFailureLimit = Math.max(
    1,
    options.ceilings?.browserFailureLimit ?? DEFAULT_BROWSER_FAILURE_LIMIT,
  );
  const toolTimeoutMs = Math.max(
    1_000,
    options.ceilings?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  );
  const modelTurnTimeoutMs = Math.max(
    10,
    options.ceilings?.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS,
  );
  const modelTurnTimeoutRetries = Math.max(
    0,
    Math.floor(options.ceilings?.modelTurnTimeoutRetries ?? 0),
  );
  const compactionMaxChars =
    options.compactionMaxChars ?? DEFAULT_COMPACTION_MAX_CHARS;
  const staleToolResultChars =
    options.staleToolResultChars === undefined
      ? DEFAULT_STALE_TOOL_RESULT_CHARS
      : options.staleToolResultChars;
  const staleToolResultKeepRecent = Math.max(
    1,
    Math.floor(
      options.staleToolResultKeepRecent ?? STALE_TOOL_RESULT_KEEP_RECENT,
    ),
  );

  let messages: AgentLoopMessage[] = [...options.messages];
  const openingCount = messages.length;
  const toolsByName = new Map(
    options.tools.map((tool) => [tool.definition.function.name, tool]),
  );
  const definitions = options.tools.map((tool) => tool.definition);
  const turnNotes: string[] = [];

  let steps = 0;
  let progressSteps = 0;
  let lastProgressStep = 0;
  let stallWarningStep: number | null = null;
  let consecutiveBrowserFailures = 0;
  let modelMs = 0;
  let toolMs = 0;
  let modelTurns = 0;

  const elapsed = (): number => now().getTime() - startedAtMs;
  const note = async (text: string): Promise<void> => {
    turnNotes.push(`turn ${steps}: ${text}`);
    await options.onStep?.({
      step: steps,
      note: text,
      progressSteps,
      elapsedMs: elapsed(),
    });
  };
  const result = (
    ending: AgentLoopEnding,
    reason: string,
    extra: {
      finish?: AgentLoopFinish;
      stop?: { reason: string; data?: unknown };
    } = {},
  ): AgentLoopResult => ({
    ending,
    reason,
    finish: extra.finish ?? null,
    stop: extra.stop ?? null,
    steps,
    progressSteps,
    turnNotes,
    messages,
    timing: { totalMs: elapsed(), modelMs, toolMs, modelTurns },
  });
  const markProgress = (): void => {
    progressSteps += 1;
    lastProgressStep = steps;
    stallWarningStep = null;
  };

  while (steps < maxSteps) {
    if (options.signal?.aborted) {
      return result(
        "aborted",
        `Job Finder stopped work on ${options.subjectLabel} before it was finished.`,
      );
    }
    if (elapsed() >= timeBudgetMs) {
      return result(
        "timed_out",
        `Job Finder ran out of time on ${options.subjectLabel} before it was finished. Everything it did so far is kept.`,
      );
    }

    const stepsWithoutProgress = steps - lastProgressStep;
    if (
      stallWarningStep === null &&
      steps > 0 &&
      stepsWithoutProgress >= noProgressStepLimit
    ) {
      stallWarningStep = steps;
      messages.push({
        role: "user",
        content: [
          `Stall check: the last ${stepsWithoutProgress} steps changed nothing.`,
          options.describeStall?.() ?? null,
          "Either try something different now, or call finish and say exactly what is blocking you, in words the person can act on. Do not repeat the same step.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      });
    } else if (
      stallWarningStep !== null &&
      lastProgressStep < stallWarningStep &&
      steps - stallWarningStep >= noProgressStepLimit
    ) {
      return result(
        "stalled",
        `Job Finder stopped on ${options.subjectLabel} because nothing new happened after several tries, even after changing approach.`,
      );
    }

    steps += 1;
    await note("asking the assistant what to do next");
    let response: Awaited<ReturnType<AgentLoopModel["chatWithTools"]>>;
    let modelTurnAttempt = 0;
    while (true) {
      const modelStartedAt = now().getTime();
      const turnTimeout = new AbortController();
      const turnTimeoutMs = Math.max(
        1,
        Math.min(modelTurnTimeoutMs, timeBudgetMs - elapsed()),
      );
      const turnTimer = setTimeout(() => turnTimeout.abort(), turnTimeoutMs);
      const turnSignal = options.signal
        ? AbortSignal.any([options.signal, turnTimeout.signal])
        : turnTimeout.signal;
      try {
        response = await Promise.race([
          options.model.chatWithTools(messages, definitions, {
            signal: turnSignal,
            ...(options.parallelToolCalls === undefined
              ? {}
              : { parallelToolCalls: options.parallelToolCalls }),
            ...(options.modelMaxOutputTokens
              ? { maxOutputTokens: options.modelMaxOutputTokens }
              : {}),
          }),
          // The race must end on a stop request too, not only on the turn
          // timer: a provider that ignores its abort signal would otherwise
          // hold the loop, and the person's Stop, until the model answered.
          new Promise<never>((_resolve, reject) => {
            if (turnSignal.aborted) {
              reject(new DOMException("Timed out", "AbortError"));
              return;
            }
            turnSignal.addEventListener(
              "abort",
              () => reject(new DOMException("Timed out", "AbortError")),
              { once: true },
            );
          }),
        ]);
        break;
      } catch (error) {
        if (options.signal?.aborted) {
          return result(
            "aborted",
            `Job Finder stopped work on ${options.subjectLabel} before it was finished.`,
          );
        }
        if (turnTimeout.signal.aborted) {
          await note(
            "the assistant did not answer before this turn's time limit",
          );
          if (
            modelTurnAttempt < modelTurnTimeoutRetries &&
            elapsed() < timeBudgetMs
          ) {
            modelTurnAttempt += 1;
            await note("retrying the same unanswered assistant turn once");
            continue;
          }
          return result(
            "timed_out",
            `Job Finder stopped on ${options.subjectLabel} because the assistant did not answer in time. The work completed so far is kept.`,
          );
        }
        if (
          isRetryableModelHttpError(error) &&
          modelTurnAttempt < modelTurnTimeoutRetries &&
          elapsed() < timeBudgetMs
        ) {
          modelTurnAttempt += 1;
          await note(
            "retrying the same assistant turn after a temporary service failure",
          );
          continue;
        }
        throw error;
      } finally {
        clearTimeout(turnTimer);
        modelMs += now().getTime() - modelStartedAt;
        modelTurns += 1;
      }
    }

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: response.content ?? "" });
      const hosted = (response.content ?? "").trim()
        ? await options.onReplyWithoutTool?.(response.content ?? "")
        : null;
      if (hosted?.kind === "finish") {
        await note(
          `finished in words${hosted.finish.stuck ? " as stuck" : ""}${hosted.finish.needsPerson ? " (needs the person)" : ""}: ${hosted.finish.reason}`,
        );
        return result("finished", endSentence(hosted.finish.reason), {
          finish: hosted.finish,
        });
      }
      if (hosted?.kind === "stop") {
        await note(`stopped: ${hosted.reason}`);
        return result("stopped", endSentence(hosted.reason), {
          stop: {
            reason: hosted.reason,
            ...(hosted.data !== undefined ? { data: hosted.data } : {}),
          },
        });
      }
      if (hosted?.kind === "ok") {
        if (hosted.progress) markProgress();
        messages.push({ role: "user", content: hosted.content });
        await note("answered without a tool; the host replied");
        continue;
      }
      messages.push({
        role: "user",
        content:
          "Answer with one of the tools. Look at the page again if you need to, or call finish if there is nothing left to do.",
      });
      await note("answered without a tool");
      continue;
    }

    messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls,
    });

    let ended: AgentLoopResult | null = null;
    let batchStopped = false;
    for (const toolCall of toolCalls) {
      if (ended || batchStopped) {
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: ended
            ? "The run ended before this step was reached."
            : "This batch stopped before this call. Decide again from the fresh page observation.",
        });
        continue;
      }
      if (options.signal?.aborted) {
        ended = result(
          "aborted",
          `Job Finder stopped work on ${options.subjectLabel} before it was finished.`,
        );
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: "The run was stopped before this step was reached.",
        });
        continue;
      }
      if (elapsed() >= timeBudgetMs) {
        ended = result(
          "timed_out",
          `Job Finder ran out of time on ${options.subjectLabel} before it was finished. Everything it did so far is kept.`,
        );
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content:
            "The safety time limit was reached before this step was run.",
        });
        continue;
      }
      const tool = toolsByName.get(toolCall.function.name);
      if (!tool) {
        batchStopped = options.afterToolBatch !== undefined;
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: `There is no tool called ${toolCall.function.name}.`,
        });
        await note(`asked for unknown tool ${toolCall.function.name}`);
        continue;
      }

      const toolStartedAt = now().getTime();
      let outcome: AgentLoopToolOutcome;
      try {
        outcome = await withToolDeadline(
          tool.execute(toolCall.function.arguments, {
            step: steps,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
          toolTimeoutMs,
          options.signal,
        );
        if (tool.failureKind === "browser") {
          consecutiveBrowserFailures = 0;
        }
      } catch (error) {
        batchStopped = options.afterToolBatch !== undefined;
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          options.signal?.aborted
        ) {
          ended = result(
            "aborted",
            `Job Finder stopped work on ${options.subjectLabel} before it was finished.`,
          );
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: "The run was stopped during this step.",
          });
          continue;
        }
        if (error instanceof ToolDeadlineError) {
          // A hung step is reported as a fact and counted like a dead page:
          // three in a row end the run in plain words instead of a freeze.
          consecutiveBrowserFailures += 1;
          const failure = `That step took longer than ${Math.round(toolTimeoutMs / 1000)} seconds and was given up.`;
          await note(`${toolCall.function.name} → took too long`);
          if (consecutiveBrowserFailures >= browserFailureLimit) {
            ended = result(
              "browser_failed",
              `Job Finder stopped on ${options.subjectLabel} because the page kept taking too long to answer. Everything it did so far is kept.`,
            );
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: failure,
            });
            continue;
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `${failure} Look at the page again before deciding what to do next; if this keeps happening, finish and say what happened.`,
          });
          continue;
        }
        if (tool.failureKind !== "browser") {
          consecutiveBrowserFailures = 0;
          await note(`${toolCall.function.name} → tool failure`);
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content:
              "That tool could not complete this step. Try a different approach, or finish and explain what remains.",
          });
          continue;
        }
        // Only a page tool can increment the dead-browser counter. Its own
        // descriptor removes library internals before the model or person sees it.
        consecutiveBrowserFailures += 1;
        const failure = endSentence(
          tool.describeError?.(error) ?? "The browser did not respond.",
        );
        await note(`${toolCall.function.name} → browser failure: ${failure}`);
        if (consecutiveBrowserFailures >= browserFailureLimit) {
          ended = result(
            "browser_failed",
            `Job Finder stopped on ${options.subjectLabel} because the browser page stopped responding. ${failure} Everything it did so far is kept.`,
          );
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `That step did not complete: ${failure}`,
          });
          continue;
        }
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: `That step did not complete: ${failure} Look at the page again before deciding what to do next; if this keeps happening, finish and say what happened.`,
        });
        continue;
      } finally {
        const durationMs = Math.max(0, now().getTime() - toolStartedAt);
        toolMs += durationMs;
        options.onToolTiming?.({
          toolName: toolCall.function.name,
          durationMs,
        });
      }

      switch (outcome.kind) {
        case "ok": {
          batchStopped =
            outcome.stopBatch === true ||
            outcome.status === "refused" ||
            outcome.status === "failed";
          if (outcome.progress) {
            markProgress();
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: outcome.content,
          });
          await note(
            `${toolCall.function.name} → ${outcome.content.split("\n")[0]?.slice(0, 160) ?? "ok"}`,
          );
          break;
        }
        case "finish": {
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: "Finished.",
          });
          await note(
            `finished${outcome.finish.stuck ? " as stuck" : ""}${outcome.finish.needsPerson ? " (needs the person)" : ""}: ${outcome.finish.reason}`,
          );
          ended = result("finished", endSentence(outcome.finish.reason), {
            finish: outcome.finish,
          });
          break;
        }
        case "stop": {
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `Job Finder stopped the run: ${outcome.reason}`,
          });
          await note(`stopped: ${outcome.reason}`);
          ended = result("stopped", endSentence(outcome.reason), {
            stop: {
              reason: outcome.reason,
              ...(outcome.data !== undefined ? { data: outcome.data } : {}),
            },
          });
          break;
        }
        default: {
          const exhaustive: never = outcome;
          throw new Error(
            `Unhandled tool outcome: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    }
    if (ended) {
      return ended;
    }
    let observation: string | null = null;
    if (options.afterToolBatch) {
      const start = now().getTime();
      try {
        observation = await withToolDeadline(
          options.afterToolBatch(),
          toolTimeoutMs,
          options.signal,
        );
      } catch {
        if (options.signal?.aborted)
          return result(
            "aborted",
            `Job Finder stopped work on ${options.subjectLabel} before it was finished.`,
          );
        observation =
          "The page could not be read after the batch. Observe again before any write.";
      } finally {
        const durationMs = Math.max(0, now().getTime() - start);
        toolMs += durationMs;
        options.onToolTiming?.({ toolName: "observe_after_batch", durationMs });
      }
    }
    if (observation) messages.push({ role: "user", content: observation });
    if (staleToolResultChars !== null) {
      messages = shortenStaleToolResults(
        messages,
        openingCount,
        staleToolResultChars,
        staleToolResultKeepRecent,
      );
    }
    const beforeCompaction = messages;
    messages = compactMessages(
      messages,
      openingCount,
      turnNotes,
      compactionMaxChars,
    );
    if (messages !== beforeCompaction) {
      const context = options.onHistoryCompacted?.();
      if (context) messages.push({ role: "user", content: context });
    }
  }

  return result(
    "ceiling",
    `Job Finder stopped on ${options.subjectLabel} after a very long run without finishing. Everything it did so far is kept.`,
  );
}

class ToolDeadlineError extends Error {
  constructor() {
    super("Tool call exceeded its deadline.");
    this.name = "ToolDeadlineError";
  }
}

/**
 * Resolves with the tool's outcome, or rejects when the deadline passes or
 * the run is stopped, whichever comes first. The tool's own promise is left
 * to settle on its own; nothing here can cancel a hung page call.
 */
function withToolDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () =>
      finish(() =>
        reject(new DOMException("The run was stopped.", "AbortError")),
      );
    const timer = setTimeout(
      () => finish(() => reject(new ToolDeadlineError())),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    );
  });
}
