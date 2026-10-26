import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssistantConversationView,
  AssistantOperation,
  AssistantChangeReceipt,
  DesktopAssistantBridge,
} from "@nestor/contracts";
import type { Page } from "playwright";
import { ACTION_INVENTORY } from "./inventory";
import {
  buildOutcomeReport,
  judgeAction,
  type ObservedAction,
  type OutcomeAssertion,
} from "./outcome";

type AppWindow = Window & { nestor: { assistant: DesktopAssistantBridge } };
export interface BuiltAppEvidence {
  operations: readonly AssistantOperation[];
  receipts: readonly AssistantChangeReceipt[];
}
export interface BuiltAppAction {
  actionId: string;
  expected?: "completed" | "correctly_blocked";
  blockedReason?: string;
  /** Read resulting app state, never just the tool name or reply wording. */
  observe(
    page: Page,
    reply: AssistantConversationView,
    context: BuiltAppEvidence,
  ): Promise<readonly OutcomeAssertion[]>;
}
export interface BuiltAppBatch {
  id: string;
  request: string;
  /** A multi-action request still has a distinct outcome case per action. */
  actions: readonly BuiltAppAction[];
  /** A dependent action is not credited unless its prerequisites were exercised too. */
  requires?: readonly string[];
  /** Establish a different starting state; never implement the requested action here. */
  prepare?(page: Page): Promise<void>;
}
export interface BuiltAppEnvironment {
  buildCommit: string;
  buildChangesHash: string | null;
  label: string;
  ai: "live";
  net: "replica";
  doctorPassed: true;
}

/** Earlier receipts in the same conversation cannot credit a later write. */
export function currentRequestChanges(
  view: Pick<AssistantConversationView, "messages">,
) {
  const user = view.messages.findLastIndex(
    (message) => message.role === "user" && message.origin === "sidebar",
  );
  if (user < 0) return [];
  return view.messages
    .slice(user + 1)
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "change" ? [part] : [])),
    );
}

export function currentUndoReceipt(
  reply: AssistantConversationView,
  evidence: BuiltAppEvidence,
  target: "profile" | "settings",
) {
  const ids = new Set(
    currentRequestChanges(reply).map((part) => part.receiptId),
  );
  return evidence.receipts.find(
    (receipt) =>
      ids.has(receipt.id) &&
      receipt.status === "applied" &&
      (receipt.target === target ||
        (receipt.target === "app_command" &&
          receipt.undoCommand?.name === "undo_profile_change")),
  );
}

export async function chatInBuiltApp(
  page: Page,
  request: string,
  timeoutMs = 120_000,
): Promise<AssistantConversationView> {
  const conversation = () =>
    page.evaluate(async () => {
      const bridge = (window as unknown as AppWindow).nestor.assistant;
      const list = await bridge.listConversations();
      return list.currentConversationId
        ? bridge.readConversation({
            conversationId: list.currentConversationId,
          })
        : null;
    });
  const prior = new Set(
    (await conversation())?.messages.map((message) => message.id) ?? [],
  );
  const composer = page.locator("[data-assistant-composer]");
  await composer.fill(request);
  await composer.press("Enter");
  const end = Date.now() + timeoutMs;
  do {
    const view = await conversation();
    if (
      view &&
      !view.activeTurn &&
      view.messages.some(
        (message) => message.role === "assistant" && !prior.has(message.id),
      )
    )
      return view;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < end);
  const current = await conversation();
  if (current?.activeTurn)
    await page.evaluate(
      (id) => (window as unknown as AppWindow).nestor.assistant.stop(id),
      current.conversation.id,
    );
  throw new Error("The built-app chat turn timed out.");
}

/** Called by a verify-nestor journey after its isolated app passes doctor. */
export async function runBuiltAppOutcomes(options: {
  page: Page;
  evidenceDir: string;
  environment: BuiltAppEnvironment;
  batches: readonly BuiltAppBatch[];
  prior?: readonly ObservedAction[];
  shot(name: string): Promise<unknown>;
  note(text: string): Promise<unknown>;
  readEvidence?(
    reply: AssistantConversationView,
    batchId: string,
  ): Promise<BuiltAppEvidence>;
}) {
  const observations: ObservedAction[] = [...(options.prior ?? [])];
  // Validate all IDs before asking chat to change any app state.
  const known = new Map(ACTION_INVENTORY.map((entry) => [entry.id, entry]));
  for (const batch of options.batches)
    for (const action of batch.actions)
      if (known.get(action.actionId)?.coverage.kind !== "tools")
        throw new Error(`Not a mapped app action: ${action.actionId}`);
  const persist = async () => {
    const artifact = {
      version: 1,
      environment: options.environment,
      observations,
    };
    await writeFile(
      path.join(options.evidenceDir, "assistant-observations.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    await writeFile(
      path.join(options.evidenceDir, "assistant-outcomes.json"),
      `${JSON.stringify(buildOutcomeReport(ACTION_INVENTORY, observations), null, 2)}\n`,
    );
  };
  // Keep the full denominator even if the process is interrupted before the
  // first chat completes. Later checkpoints replace these unexercised cases.
  await persist();
  for (const batch of options.batches) {
    let reply: AssistantConversationView | undefined;
    let evidence: BuiltAppEvidence = { operations: [], receipts: [] };
    let turnError: string | undefined;
    let phase: "prepare" | "composer" | "chat" | "evidence" = "prepare";
    let cannotReachChat = false;
    try {
      await options.note(`Starting chat outcome batch: ${batch.id}`);
      await options.page.keyboard.press("Escape");
      await batch.prepare?.(options.page);
      phase = "composer";
      const composer = options.page.locator("[data-assistant-composer]");
      if (!(await composer.isVisible()))
        await options.page
          .getByRole("button", {
            name: /^Open the assistant(?: \(working\))?$/u,
          })
          .click();
      await options.shot(`before-${batch.id}`);
      phase = "chat";
      reply = await chatInBuiltApp(options.page, batch.request);
      await writeFile(
        path.join(options.evidenceDir, `${batch.id}-conversation.json`),
        `${JSON.stringify(reply, null, 2)}\n`,
      );
      phase = "evidence";
      evidence = (await options.readEvidence?.(reply, batch.id)) ?? evidence;
    } catch (error) {
      turnError = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
      cannotReachChat = phase === "composer" || options.page.isClosed();
    }
    for (const action of batch.actions) {
      let assertions: readonly OutcomeAssertion[] = [];
      let error = turnError;
      if (reply) {
        try {
          assertions = await action.observe(options.page, reply, {
            ...evidence,
          });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      const observation: ObservedAction = {
        id: `${batch.id}.${action.actionId}`,
        actionId: action.actionId,
        request: batch.request,
        expected: action.expected ?? "completed",
        assertions,
        ...(action.blockedReason
          ? { blockedReason: action.blockedReason }
          : {}),
        ...(error ? { error } : {}),
      };
      const gap = evidence.operations.find(
        (operation) =>
          operation.toolName === "report_missing_capability" &&
          operation.status === "committed" &&
          operation.resultSummary,
      );
      if (
        gap &&
        !observation.error &&
        observation.assertions.length &&
        !judgeAction(observation).passed
      )
        observation.unsupportedReason = `The requested outcome was absent and the Assistant recorded a missing capability (${gap.id}): ${gap.resultSummary}`;
      observations.push(observation);
      const judged = judgeAction(observation);
      await options.note(
        `${judged.outcome}: ${action.actionId}${judged.failures.length ? ` — ${judged.failures.join("; ")}` : ""}`,
      );
    }
    await options
      .shot(`after-${batch.id}`)
      .catch((error: unknown) =>
        options.note(`Result screenshot unavailable: ${String(error)}`),
      );
    await persist();
    if (cannotReachChat) {
      await options.note(
        "Stopped this run because its chat composer is unreachable; all remaining mapped actions stay unexercised failures.",
      );
      break;
    }
  }
  await persist();
  return buildOutcomeReport(ACTION_INVENTORY, observations);
}
