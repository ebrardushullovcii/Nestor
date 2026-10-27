import type { AssistantMessage } from "@nestor/contracts";

import type { AssistantLaneCase, AssistantLaneObservation } from "./cases";
import {
  createAssistantLaneWorld,
  laneContext,
  lastReply,
  type AssistantLaneModel,
  type AssistantLaneWorld,
} from "./world";

export interface AssistantLaneCaseResult {
  id: string;
  title: string;
  passed: boolean;
  /** The assistant asked the person a question during the case. */
  asked: boolean;
  failures: string[];
  replyText: string;
  toolRuns: { toolName: string; outcome: string; detail: string | null }[];
  durationMs: number;
  inputs: AssistantLaneWorld["recorder"]["inputs"];
  error: string | null;
}

async function waitForIdle(
  world: AssistantLaneWorld,
  conversationId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const view = await world.host.readConversation({ conversationId });
    if (view.activeTurn === null) return;
    if (Date.now() - started > timeoutMs) {
      await world.host.stop(conversationId, "The eval lane timed out.");
      throw new Error(`Turn did not finish within ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function observe(
  messages: readonly AssistantMessage[],
): Pick<
  AssistantLaneObservation,
  "replyText" | "toolRuns" | "changes" | "questions"
> {
  const reply = lastReply(messages);
  const replyText = (reply?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const toolRuns = messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "activity"
        ? part.entries.map((entry) => ({
            toolName: entry.toolName,
            outcome: entry.outcome,
            detail: entry.detail,
          }))
        : [],
    ),
  );
  const changes = messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "change"
        ? [{ summary: part.summary, fields: part.fields, status: part.status }]
        : [],
    ),
  );
  const questions = messages.reduce(
    (count, message) =>
      count + message.parts.filter((part) => part.type === "question").length,
    0,
  );
  return { replyText, toolRuns, changes, questions };
}

export async function runAssistantLaneCase(
  evalCase: AssistantLaneCase,
  model: AssistantLaneModel,
  options: { turnTimeoutMs?: number } = {},
): Promise<AssistantLaneCaseResult> {
  const started = Date.now();
  const world = await createAssistantLaneWorld(model, evalCase.scenario);
  try {
    let conversationId: string | null = null;
    for (const [index, turn] of evalCase.turns.entries()) {
      const result = await world.host.sendMessage({
        conversationId,
        clientMessageId: `lane_${evalCase.id}_${index}`.replace(
          /[^a-zA-Z0-9_]/gu,
          "_",
        ),
        text: turn.text,
        context: turn.context ?? laneContext(),
      });
      conversationId = result.conversationId;
      await waitForIdle(
        world,
        conversationId,
        options.turnTimeoutMs ?? 180_000,
      );
    }
    const view = await world.host.readConversation({
      conversationId: conversationId!,
    });
    const observation: AssistantLaneObservation = {
      snapshot: await world.snapshot(),
      recorder: world.recorder,
      stageOf: world.stageOf,
      messages: view.messages,
      ...observe(view.messages),
    };
    const failures = evalCase.check(observation);
    if (!world.recorder.inputs.length)
      failures.push("No assistant input measurements were recorded.");
    const inputTokens = world.recorder.inputs.reduce(
      (sum, step) =>
        sum +
        Math.max(
          step.messageTokens + step.schemaTokens,
          model === "live" ? (step.reportedInputTokens ?? 0) : 0,
        ),
      0,
    );
    const budget = evalCase.inputTokenBudget ?? 160_000;
    if (inputTokens > budget)
      failures.push(
        `Input token budget exceeded: ${inputTokens} > ${budget} (message/schema estimates or larger live-provider counts).`,
      );
    return {
      id: evalCase.id,
      title: evalCase.title,
      passed: failures.length === 0,
      asked: observation.questions > 0,
      failures,
      replyText: observation.replyText.slice(0, 600),
      toolRuns: [...observation.toolRuns],
      durationMs: Date.now() - started,
      inputs: world.recorder.inputs,
      error: null,
    };
  } catch (error) {
    return {
      id: evalCase.id,
      title: evalCase.title,
      passed: false,
      asked: false,
      failures: [],
      replyText: "",
      toolRuns: [],
      durationMs: Date.now() - started,
      inputs: world.recorder.inputs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await world.shutdown();
  }
}

/** Runs cases one after another; live models are never run in parallel. */
export async function runAssistantLane(
  cases: readonly AssistantLaneCase[],
  model: AssistantLaneModel,
  onResult?: (result: AssistantLaneCaseResult) => void,
): Promise<AssistantLaneCaseResult[]> {
  const results: AssistantLaneCaseResult[] = [];
  for (const evalCase of cases) {
    const result = await runAssistantLaneCase(evalCase, model);
    results.push(result);
    onResult?.(result);
  }
  return results;
}

/** Plain counts and every failure, no percentiles on small samples. */
export function formatAssistantLaneReport(
  model: string,
  results: readonly AssistantLaneCaseResult[],
): string {
  const passed = results.filter((result) => result.passed).length;
  const asked = results.filter(
    (result) => result.passed && result.asked,
  ).length;
  const lines = [
    `# Assistant eval lane (${model})`,
    "",
    `${passed} of ${results.length} cases passed; ${asked} of those passed by asking the person a question.`,
    "",
  ];
  for (const result of results) {
    lines.push(
      `- ${result.passed ? (result.asked ? "PASS (asked)" : "PASS") : "FAIL"} ${result.id} (${Math.round(result.durationMs / 100) / 10}s): ${result.title}`,
    );
    lines.push(
      `  - input steps (message/schema estimates; provider total): ${result.inputs.map((step) => `${step.messageTokens}/${step.schemaTokens}; ${step.reportedInputTokens ?? "unreported"}`).join(" | ")}`,
    );
    for (const failure of result.failures) lines.push(`  - ${failure}`);
    if (result.error) lines.push(`  - error: ${result.error}`);
    if (!result.passed) {
      lines.push(
        `  - tools: ${result.toolRuns.map((run) => `${run.toolName}:${run.outcome}`).join(", ") || "none"}`,
      );
      lines.push(
        `  - reply: ${JSON.stringify(result.replyText.slice(0, 300))}`,
      );
    }
  }
  return lines.join("\n");
}
