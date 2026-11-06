import { observeModel, observeTool, type RuntimeObservers } from "./observers";
import { isAgentRunAborted, runWithAgentRunCancellation } from "./cancellation";
import {
  ModelTurnTimeoutError,
  runModelTurn,
  type ModelTurnStreamEvent,
} from "./model-turn";
import {
  AgentTaskExecutionReceiptSchema,
  AgentTaskProgressSchema,
  AgentTaskToolReceiptSchema,
  type AgentTaskCheckpoint,
  type AgentTaskExecutionReceipt,
  type AgentTaskFailureKind,
  type AgentTaskProgress,
  type AgentTaskStopReason,
  type AgentTaskValidationIssue,
  type AgentToolPermission,
  type Tool,
  type ToolCall,
  type ModelContinuation,
} from "@nestor/contracts";
import type { z } from "zod";
import { reportSelfLimitHit, selfLimitSlice } from "@nestor/core";

import { AgentTaskResultStore } from "./result-store";

export interface AgentTaskMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  continuation?: ModelContinuation;
}

export interface AgentTaskModel {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  chat(input: {
    messages: readonly AgentTaskMessage[];
    tools: readonly Tool[];
    signal?: AbortSignal;
    onStreamEvent?: (event: ModelTurnStreamEvent) => void;
  }): Promise<{
    content?: string;
    toolCalls?: ToolCall[];
    continuation?: ModelContinuation;
  }>;
}

export interface AgentTaskToolContext<TState, TDraft> {
  readonly state: TState;
  draft: TDraft;
  readonly results: AgentTaskResultStore;
  readonly signal?: AbortSignal;
}

export interface AgentTaskTool<TState, TDraft, TInput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly parameters: Record<string, unknown>;
  readonly permission: AgentToolPermission;
  readonly parallelSafe?: boolean;
  execute(
    input: TInput,
    context: AgentTaskToolContext<TState, TDraft>,
  ):
    | Promise<{
        draft?: TDraft;
        value?: unknown;
        summary: string;
        progressMade?: boolean;
        validationIssues?: readonly AgentTaskValidationIssue[];
        finish?: boolean;
      }>
    | {
        draft?: TDraft;
        value?: unknown;
        summary: string;
        progressMade?: boolean;
        validationIssues?: readonly AgentTaskValidationIssue[];
        finish?: boolean;
      };
}

export interface AgentTaskCheckpointStore {
  load(taskId: string): Promise<AgentTaskCheckpoint | null>;
  save(checkpoint: AgentTaskCheckpoint): Promise<void>;
}

export interface AgentTaskRunOptions<TState, TDraft> extends RuntimeObservers {
  readonly taskId: string;
  readonly capability: string;
  readonly systemPrompt: string;
  readonly state: TState;
  readonly initialDraft: TDraft;
  readonly model: AgentTaskModel;
  readonly tools: readonly AgentTaskTool<TState, TDraft, unknown>[];
  readonly validate: (draft: TDraft) => readonly AgentTaskValidationIssue[];
  readonly buildContext: (input: {
    state: TState;
    draft: TDraft;
    validationIssues: readonly AgentTaskValidationIssue[];
  }) => unknown;
  readonly signal?: AbortSignal;
  /** A provider-call ceiling used as the deterministic cost guard. */
  readonly providerCallBudget?: number;
  readonly noProgressLimit?: number;
  readonly emergencyCeiling?: number;
  readonly checkpointStore?: AgentTaskCheckpointStore;
  readonly onProgress?: (progress: AgentTaskProgress) => void;
  /**
   * The context from `buildContext` already carries the draft. Earlier
   * `draft_write` calls are then replayed with a note in place of their
   * arguments, so the model is not sent the same draft twice per turn.
   */
  readonly draftShownInContext?: boolean;
}

const DRAFT_WRITE_REPLAY_NOTE = JSON.stringify({
  replayed:
    "These arguments were applied to the task draft; the task state above shows that draft.",
});

export interface AgentTaskRunResult<TDraft> {
  readonly draft: TDraft;
  readonly receipt: AgentTaskExecutionReceipt;
}

/** Keep a bounded recent tail without ever starting on an orphaned tool result.
 * Chat-completions providers reject a `tool` message unless the matching
 * assistant `tool_calls` message is still present immediately before its
 * result group. */
function takeProtocolSafeRecentMessages(
  messages: readonly AgentTaskMessage[],
  limit: number,
): AgentTaskMessage[] {
  let start = Math.max(0, messages.length - limit);
  if (messages[start]?.role === "tool") {
    for (let index = start - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === "assistant" && candidate.toolCalls?.length) {
        start = index;
        break;
      }
      if (candidate?.role !== "tool") break;
    }
  }
  return selfLimitSlice(
    messages,
    start,
    undefined,
    "agent-runtime/recent_messages",
  );
}

/** A provider adapter that already owns retries can use this to avoid nesting
 * another three-attempt retry loop while preserving the original message. */
export class AgentTaskNonRetryableProviderError extends Error {
  override readonly name = "AgentTaskNonRetryableProviderError";
}

export function classifyAgentTaskFailure(
  error: unknown,
  signal?: AbortSignal,
): AgentTaskFailureKind {
  if (isAgentRunAborted(signal)) return "cancelled";
  if (error instanceof AgentTaskNonRetryableProviderError) return "permanent";
  if (error instanceof Error && error.name === "AbortError") {
    return "transient_network";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out|429|rate limit|overload|temporar/.test(message)) {
    return "transient_provider";
  }
  if (/fetch failed|network|econn|socket|dns/.test(message)) {
    return "transient_network";
  }
  if (/validation|invalid|schema|parse/.test(message)) return "validation";
  if (/stale|detached|page closed|context destroyed/.test(message)) {
    return "stale_state";
  }
  if (/sign.?in|login|captcha|mfa|credential/.test(message)) {
    return "user_action_required";
  }
  if (/unsafe|forbidden|permission|policy/.test(message)) {
    return "safety_boundary";
  }
  return error instanceof Error ? "permanent" : "unknown";
}

function shouldRetry(kind: AgentTaskFailureKind): boolean {
  return kind === "transient_provider" || kind === "transient_network";
}

async function waitForBackoff(attempt: number, signal?: AbortSignal) {
  const delayMs = Math.min(4_000, 300 * 2 ** attempt) + attempt * 37;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseToolArguments(
  text: string | undefined,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text || "{}") };
  } catch {
    return { ok: false };
  }
}

function issueFromZod(error: z.ZodError): AgentTaskValidationIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
  }));
}

/** A tool's local bounds must be present in the schema the model receives. */
function reportUnadvertisedBounds(
  error: z.ZodError,
  parameters: Record<string, unknown>,
  toolName: string,
  input: unknown,
): void {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const resolve = (value: unknown): Record<string, unknown> => {
    let schema = record(value);
    const visited = new Set<unknown>();
    while (
      typeof schema.$ref === "string" &&
      schema.$ref.startsWith("#/") &&
      !visited.has(schema)
    ) {
      visited.add(schema);
      schema = record(
        schema.$ref
          .slice(2)
          .split("/")
          .reduce<unknown>(
            (node, key) =>
              record(node)[key.replace(/~1/gu, "/").replace(/~0/gu, "~")],
            parameters,
          ),
      );
    }
    return schema;
  };
  const patternAccepts = (pattern: string, value: unknown): boolean => {
    if (typeof value !== "string") return false;
    try {
      return new RegExp(pattern, "u").test(value);
    } catch {
      return false;
    }
  };
  for (const issue of error.issues) {
    let schema: Record<string, unknown> = resolve(parameters);
    let received: unknown = input;
    for (const part of issue.path) {
      received =
        typeof part === "number"
          ? Array.isArray(received)
            ? received[part]
            : undefined
          : record(received)[part];
      schema = resolve(
        typeof part === "number"
          ? schema.items
          : record(schema.properties)[part],
      );
    }
    if (issue.code === "too_big") {
      const key =
        issue.type === "string"
          ? "maxLength"
          : issue.type === "array"
            ? "maxItems"
            : "maximum";
      if (
        typeof schema[key] !== "number" ||
        schema[key] > Number(issue.maximum)
      )
        reportSelfLimitHit({
          limit: "unadvertised_validator_bound",
          kind: "validator",
          value: Number(issue.maximum),
          where: `agent-runtime/tool/${toolName}`,
        });
    }
    if (issue.code === "too_small") {
      const key =
        issue.type === "string"
          ? "minLength"
          : issue.type === "array"
            ? "minItems"
            : "minimum";
      if (
        typeof schema[key] !== "number" ||
        schema[key] < Number(issue.minimum)
      )
        reportSelfLimitHit({
          limit: "unadvertised_validator_minimum",
          kind: "validator",
          value: Number(issue.minimum),
          where: `agent-runtime/tool/${toolName}`,
        });
    }
    if (
      issue.code === "invalid_enum_value" &&
      (!Array.isArray(schema.enum) || schema.enum.includes(issue.received))
    )
      reportSelfLimitHit({
        limit: "unadvertised_validator_enum",
        kind: "validator",
        value: "enum",
        where: `agent-runtime/tool/${toolName}`,
      });
    if (
      issue.code === "invalid_string" &&
      issue.validation === "regex" &&
      (typeof schema.pattern !== "string" ||
        patternAccepts(schema.pattern, received))
    )
      reportSelfLimitHit({
        limit: "unadvertised_validator_pattern",
        kind: "validator",
        value: "regex",
        where: `agent-runtime/tool/${toolName}`,
      });
    if (
      issue.code === "unrecognized_keys" &&
      schema.additionalProperties !== false
    )
      reportSelfLimitHit({
        limit: "unadvertised_validator_keys",
        kind: "validator",
        value: "additionalProperties",
        where: `agent-runtime/tool/${toolName}`,
      });
  }
}

export async function runAgentTask<TState, TDraft>(
  options: AgentTaskRunOptions<TState, TDraft>,
): Promise<AgentTaskRunResult<TDraft>> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const noProgressLimit = Math.max(1, options.noProgressLimit ?? 4);
  const providerCallBudget = Math.max(1, options.providerCallBudget ?? 24);
  const emergencyCeiling = Math.max(4, options.emergencyCeiling ?? 32);
  const results = new AgentTaskResultStore();
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  let draft = options.initialDraft;
  let providerCalls = 0;
  let repairAttempts = 0;
  let revision = 0;
  let consecutiveNoProgress = 0;
  let validationIssues = [...options.validate(draft)];
  let stopReason: AgentTaskStopReason = "emergency_ceiling";
  const toolReceipts: AgentTaskExecutionReceipt["toolReceipts"][number][] = [];
  const recentMessages: AgentTaskMessage[] = [];

  const emitProgress = (phase: string, message: string) => {
    const progress = AgentTaskProgressSchema.parse({
      phase,
      message,
      distinctResults: toolReceipts.filter((receipt) => receipt.progressMade)
        .length,
      validationIssuesRemaining: validationIssues.length,
      elapsedMs: Date.now() - startedAtMs,
      updatedAt: new Date().toISOString(),
    });
    options.onProgress?.(progress);
    return progress;
  };

  const saveCheckpoint = async (progress: AgentTaskProgress) => {
    if (!options.checkpointStore) return;
    await options.checkpointStore.save({
      taskId: options.taskId,
      capability: options.capability,
      revision: ++revision,
      updatedAt: new Date().toISOString(),
      state: options.state,
      draft,
      progress,
      toolReceipts,
    });
  };

  for (let cycle = 0; cycle < emergencyCeiling; cycle += 1) {
    if (options.signal?.aborted) {
      stopReason = "cancelled";
      break;
    }
    if (providerCalls >= providerCallBudget) {
      reportSelfLimitHit({
        limit: "provider_calls",
        kind: "budget",
        value: providerCallBudget,
        where: "agent-runtime/runAgentTask",
      });
      stopReason = "cost_budget";
      break;
    }
    if (consecutiveNoProgress >= noProgressLimit) {
      reportSelfLimitHit({
        limit: "no_progress",
        kind: "turns",
        value: noProgressLimit,
        where: "agent-runtime/runAgentTask",
      });
      stopReason = "no_progress";
      break;
    }

    const context = options.buildContext({
      state: options.state,
      draft,
      validationIssues,
    });
    const taskPayload =
      context && typeof context === "object" && !Array.isArray(context)
        ? {
            ...(context as Record<string, unknown>),
            instruction:
              "Use the available tools to update the task draft. Validate it, repair any reported issues, then call finish_task. The typed task state below is authoritative; chat history is not.",
          }
        : {
            task: context,
            instruction:
              "Use the available tools to update the task draft. Validate it, repair any reported issues, then call finish_task. The typed task state below is authoritative; chat history is not.",
          };
    const recentTail = takeProtocolSafeRecentMessages(recentMessages, 8);
    const messages: AgentTaskMessage[] = [
      { role: "system", content: options.systemPrompt },
      {
        role: "user",
        content: JSON.stringify(taskPayload),
      },
      ...(options.draftShownInContext
        ? recentTail.map((message) =>
            message.role === "assistant" && message.toolCalls?.length
              ? {
                  ...message,
                  toolCalls: message.toolCalls.map((call) =>
                    toolsByName.get(call.function.name)?.permission ===
                    "draft_write"
                      ? {
                          ...call,
                          function: {
                            ...call.function,
                            arguments: DRAFT_WRITE_REPLAY_NOTE,
                          },
                        }
                      : call,
                  ),
                }
              : message,
          )
        : recentTail),
    ];

    emitProgress("thinking", "Working on the next useful change");
    let response: Awaited<ReturnType<AgentTaskModel["chat"]>> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (providerCalls >= providerCallBudget) {
        reportSelfLimitHit({
          limit: "provider_calls",
          kind: "budget",
          value: providerCallBudget,
          where: "agent-runtime/runAgentTask/retry",
        });
        stopReason = "cost_budget";
        break;
      }
      try {
        providerCalls += 1;
        response = await runModelTurn(
          (turnOptions) =>
            observeModel(
              options,
              {
                messages,
                tools: options.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              },
              () =>
                options.model.chat({
                  messages,
                  tools: options.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                  ...turnOptions,
                }),
            ),
          {
            signal: options.signal,
          },
        );
        break;
      } catch (error) {
        if (isAgentRunAborted(options.signal)) {
          stopReason = "cancelled";
          break;
        }
        if (error instanceof ModelTurnTimeoutError && attempt === 0) continue;
        const failureKind = classifyAgentTaskFailure(error, options.signal);
        if (!shouldRetry(failureKind) || attempt === 2) {
          if (shouldRetry(failureKind) && attempt === 2)
            reportSelfLimitHit({
              limit: "provider_retries",
              kind: "retry",
              value: 3,
              where: "agent-runtime/runAgentTask",
            });
          throw error;
        }
        try {
          await waitForBackoff(attempt, options.signal);
        } catch (backoffError) {
          if (!isAgentRunAborted(options.signal)) throw backoffError;
          stopReason = "cancelled";
          break;
        }
      }
    }
    if (!response) {
      if (stopReason !== "cost_budget" && stopReason !== "cancelled") {
        stopReason = "permanent_failure";
      }
      break;
    }
    recentMessages.push({
      role: "assistant",
      content: response.content ?? "",
      ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
      ...(response.continuation ? { continuation: response.continuation } : {}),
    });

    const calls = response.toolCalls ?? [];
    if (calls.length === 0) {
      consecutiveNoProgress += 1;
      recentMessages.push({
        role: "user",
        content:
          "No tool was called. Use the tools to change or validate the draft, or call finish_task only when it is valid.",
      });
      continue;
    }

    const parallelReads = calls.filter(
      (call) => toolsByName.get(call.function.name)?.parallelSafe === true,
    );
    const orderedCalls = calls.filter(
      (call) => toolsByName.get(call.function.name)?.parallelSafe !== true,
    );
    let finishRequested = false;

    const executeCall = async (call: ToolCall) => {
      const started = Date.now();
      const tool = toolsByName.get(call.function.name);
      let outcome: "succeeded" | "rejected" | "failed" = "succeeded";
      let failureKind: AgentTaskFailureKind | null = null;
      let progressMade = false;
      let resultHandle: string | null = null;
      let issues: readonly AgentTaskValidationIssue[] = [];
      let toolContent: unknown;

      if (!tool || tool.permission === "external_action") {
        outcome = "rejected";
        failureKind = "safety_boundary";
        toolContent = {
          ok: false,
          error: tool
            ? "External actions are outside the agent task boundary."
            : "Unknown tool.",
        };
      } else {
        try {
          const rawArgs = parseToolArguments(call.function.arguments);
          const parsed = rawArgs.ok
            ? tool.inputSchema.safeParse(rawArgs.value)
            : null;
          if (!rawArgs.ok) {
            // Arguments that are not JSON are usually a reply cut off in the
            // middle of the call. That is the model's to repair, not a reason
            // to stop the whole run.
            outcome = "rejected";
            failureKind = "validation";
            issues = [
              {
                code: "invalid_tool_arguments",
                message:
                  "The tool arguments were not valid JSON (they may have been cut off). Send the complete call again, shorter if needed.",
                path: [],
              },
            ];
            repairAttempts += 1;
            toolContent = { ok: false, validationIssues: issues };
          } else if (parsed && !parsed.success) {
            reportUnadvertisedBounds(
              parsed.error,
              tool.parameters,
              tool.name,
              rawArgs.value,
            );
            outcome = "rejected";
            failureKind = "validation";
            issues = issueFromZod(parsed.error);
            repairAttempts += 1;
            toolContent = { ok: false, validationIssues: issues };
          } else if (parsed) {
            const execution = await runWithAgentRunCancellation(
              () =>
                tool.execute(parsed.data, {
                  state: options.state,
                  draft,
                  results,
                  ...(options.signal ? { signal: options.signal } : {}),
                }),
              options.signal,
            );
            if (execution.draft !== undefined) draft = execution.draft;
            progressMade = execution.progressMade ?? false;
            issues = execution.validationIssues ?? [];
            finishRequested ||= execution.finish ?? false;
            if (execution.value !== undefined) {
              const stored = results.put({
                summary: execution.summary,
                value: execution.value,
              });
              resultHandle = stored.reference.handle;
              toolContent = {
                ok: true,
                result: stored.reference,
                inlineItems: stored.inlineItems,
                validationIssues: issues,
              };
            } else {
              toolContent = {
                ok: true,
                summary: execution.summary,
                validationIssues: issues,
              };
            }
          }
        } catch (error) {
          outcome = "failed";
          failureKind = classifyAgentTaskFailure(error, options.signal);
          const errorMessage =
            error instanceof Error && error.message.trim()
              ? error.message
              : "Tool failed";
          // The receipt keeps the cause, so a stopped run can say which tool
          // failed and why instead of only "permanent_failure".
          issues = [
            {
              code: "tool_error",
              message: errorMessage.slice(0, 300),
              path: [],
            },
          ];
          toolContent = {
            ok: false,
            failureKind,
            error: errorMessage,
          };
        }
      }

      toolReceipts.push(
        AgentTaskToolReceiptSchema.parse({
          toolCallId: call.id,
          toolName: call.function.name,
          permission: tool?.permission ?? "read",
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          outcome,
          failureKind,
          progressMade,
          resultHandle,
          validationIssues: issues,
        }),
      );
      recentMessages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(toolContent),
      });
      observeTool(options, call, JSON.stringify(toolContent), started);
      return progressMade;
    };

    const receiptStart = toolReceipts.length;
    const readProgress = await Promise.all(parallelReads.map(executeCall));
    const orderedProgress: boolean[] = [];
    for (const call of orderedCalls) {
      if (isAgentRunAborted(options.signal)) break;
      orderedProgress.push(await executeCall(call));
    }
    if (isAgentRunAborted(options.signal)) {
      stopReason = "cancelled";
      await saveCheckpoint(emitProgress("cancelled", "Stopped"));
      break;
    }
    const madeProgress = [...readProgress, ...orderedProgress].some(Boolean);
    validationIssues = [...options.validate(draft)];
    consecutiveNoProgress = madeProgress ? 0 : consecutiveNoProgress + 1;
    const progress = emitProgress(
      validationIssues.length === 0 ? "ready" : "repairing",
      validationIssues.length === 0
        ? "Draft is valid"
        : `${validationIssues.length} validation issue${validationIssues.length === 1 ? "" : "s"} still need repair`,
    );
    await saveCheckpoint(progress);

    const terminalFailure = toolReceipts
      .slice(receiptStart)
      .find((receipt) =>
        [
          "user_action_required",
          "safety_boundary",
          "permanent",
          "cancelled",
        ].includes(receipt.failureKind ?? ""),
      );
    if (terminalFailure) {
      console.warn(
        `[agent-runtime] ${options.capability} stopped: ${terminalFailure.toolName} failed (${terminalFailure.failureKind}): ${
          terminalFailure.validationIssues[0]?.message ?? "no detail"
        }`,
      );
      stopReason =
        terminalFailure.failureKind === "user_action_required"
          ? "user_action_required"
          : terminalFailure.failureKind === "safety_boundary"
            ? "safety_boundary"
            : terminalFailure.failureKind === "cancelled"
              ? "cancelled"
              : "permanent_failure";
      break;
    }

    // A write refused in this same turn left nothing in the draft. Finishing
    // on top of it silently dropped what the model meant to do (a profile
    // split whose proposal was refused finished with no proposal at all), so
    // the model first hears what was refused and gets one turn to repair it.
    const refusedWriteIssues = toolReceipts
      .slice(receiptStart)
      .filter(
        (receipt) =>
          receipt.outcome === "rejected" &&
          receipt.failureKind === "validation" &&
          receipt.permission === "draft_write",
      )
      .flatMap((receipt) => receipt.validationIssues);
    if (finishRequested) {
      if (validationIssues.length === 0 && refusedWriteIssues.length === 0) {
        stopReason = "completed";
        break;
      }
      repairAttempts += 1;
      recentMessages.push({
        role: "user",
        content: JSON.stringify({
          finishRejected: true,
          validationIssues:
            validationIssues.length > 0 ? validationIssues : refusedWriteIssues,
          instruction:
            validationIssues.length > 0
              ? "Repair these issues before finishing."
              : "A change you sent in this turn was refused, so nothing from it was kept. Send it again with these issues repaired, or finish without it if it is not needed.",
        }),
      });
    }
  }

  const completedAtMs = Date.now();
  if (stopReason === "emergency_ceiling")
    reportSelfLimitHit({
      limit: "emergency_ceiling",
      kind: "turns",
      value: emergencyCeiling,
      where: "agent-runtime/runAgentTask",
    });
  return {
    draft,
    receipt: AgentTaskExecutionReceiptSchema.parse({
      taskId: options.taskId,
      capability: options.capability,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      model: options.model.model ?? null,
      reasoningEffort: options.model.reasoningEffort ?? null,
      providerCalls,
      repairAttempts,
      fallbackUsed: false,
      stopReason,
      finalValidationIssues: validationIssues,
      toolReceipts,
    }),
  };
}
