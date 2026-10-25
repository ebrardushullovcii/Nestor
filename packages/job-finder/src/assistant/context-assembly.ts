import {
  availablePromptTokens,
  elideOldToolOutputs,
  estimateTokens,
  type AgentLoopMessage,
  type TokenCalibrator,
} from "@nestor/agent-runtime";
import {
  AssistantCheckpointSchema,
  type AssistantCheckpoint,
} from "@nestor/contracts";
import type { AssistantRepository, AssistantTranscriptItem } from "@nestor/db";
import { z } from "zod";

/**
 * Bounded context and layered compaction (plan §11).
 *
 * 1. Old tool output becomes short receipts, in one batch, written back to
 *    the stored tail so the cached prefix is not rewritten every call.
 * 2. The input is rebuilt from canonical state (the context block) plus the
 *    recent tail; no stale copies of the profile or resumes are carried.
 * 3. When it still does not fit, the oldest exchanges are summarized in a
 *    separate call with tools off into a structured checkpoint.
 * 4. The checkpoint is validated against what it summarizes and saved as a
 *    new version; the visible conversation is never edited.
 * 5. If summarizing fails, bounded pruning keeps the turn going once; if it
 *    still cannot fit, the turn stops in a recoverable state.
 */

export class AssistantContextOverflowError extends Error {
  constructor() {
    super(
      "This conversation grew too long for the model even after it was summarized. Start a new chat with the New chat button at the top of this panel and ask again; nothing was lost.",
    );
    this.name = "AssistantContextOverflowError";
  }
}

const StoredMessageSchema = z.union([
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("function"),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
    continuation: z
      .object({
        kind: z.literal("reasoning_content"),
        route: z.string(),
        text: z.string(),
      })
      .optional(),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    content: z.string(),
  }),
]);

export function toModelMessage(
  item: AssistantTranscriptItem,
): AgentLoopMessage | null {
  const parsed = StoredMessageSchema.safeParse(item.message);
  return parsed.success ? (parsed.data as AgentLoopMessage) : null;
}

export function renderCheckpoint(checkpoint: AssistantCheckpoint): string {
  const section = (title: string, items: readonly string[]) =>
    items.length > 0 ? [`${title}:`, ...items.map((item) => `- ${item}`)] : [];
  return [
    "[Summary of the earlier part of this conversation. search_conversation finds the exact older messages.]",
    ...(checkpoint.goal ? [`Goal: ${checkpoint.goal}`] : []),
    ...section(
      "What the person asked for and corrected",
      checkpoint.activeInstructions.map((entry) => entry.text),
    ),
    ...section("Constraints", checkpoint.constraints),
    ...section(
      "Records involved",
      checkpoint.entities.map(
        (entity) =>
          `${entity.kind} ${entity.id}${entity.label ? ` (${entity.label})` : ""}`,
      ),
    ),
    ...section("Findings", checkpoint.findings),
    ...section("Unfinished", checkpoint.unfinishedSteps),
    ...section("Open questions", checkpoint.pendingQuestions),
  ].join("\n");
}

const SummaryDraftSchema = z.object({
  goal: z.string().max(2000).nullable().optional(),
  activeInstructions: z
    .array(
      z.object({
        text: z.string().min(1).max(1000),
        ref: z.string().optional(),
      }),
    )
    .max(30)
    .default([]),
  constraints: z.array(z.string().min(1).max(600)).max(30).default([]),
  entities: z
    .array(
      z.object({
        kind: z.string(),
        id: z.string().min(1).max(200),
        label: z.string().max(300).nullable().optional(),
      }),
    )
    .max(60)
    .default([]),
  findings: z.array(z.string().min(1).max(800)).max(40).default([]),
  unfinishedSteps: z.array(z.string().min(1).max(600)).max(30).default([]),
  pendingQuestions: z.array(z.string().min(1).max(600)).max(20).default([]),
});
export type SummaryDraft = z.infer<typeof SummaryDraftSchema>;

export const SUMMARY_INSTRUCTIONS = [
  "Summarize the conversation below as a handoff for yourself, as one JSON object with keys:",
  "goal (string), activeInstructions (array of {text, ref}: every instruction and correction the person gave that still applies, in their words, with ref the [#n] label of the message), constraints (strings), entities (array of {kind, id, label}: jobs, applications, result sets and receipts by their exact ids), findings (strings), unfinishedSteps (strings), pendingQuestions (strings).",
  "Copy ids exactly as they appear. Leave out anything already done unless it matters later. Return only the JSON.",
].join(" ");

function describeForSummary(items: readonly AssistantTranscriptItem[]): string {
  return items
    .map((item) => {
      const message = toModelMessage(item);
      if (!message) return "";
      const label = `[#${item.seq}] ${message.role}`;
      if (message.role === "assistant" && message.toolCalls?.length) {
        return `${label}: ${message.content.slice(0, 600)} (called ${message.toolCalls
          .map(
            (call) =>
              `${call.function.name} ${call.function.arguments.slice(0, 300)}`,
          )
          .join("; ")})`;
      }
      return `${label}: ${message.content.slice(0, 1_500)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Keeps only references the summarized text actually contains. */
export function validateSummaryDraft(
  draft: SummaryDraft,
  items: readonly AssistantTranscriptItem[],
): SummaryDraft {
  const text = items.map((item) => JSON.stringify(item.message)).join("\n");
  const seqs = new Set(items.map((item) => String(item.seq)));
  return {
    ...draft,
    activeInstructions: draft.activeInstructions.filter(
      (entry) => !entry.ref || seqs.has(entry.ref.replace(/[^\d]/gu, "")),
    ),
    entities: draft.entities.filter((entity) => text.includes(entity.id)),
  };
}

function fallbackDraft(
  items: readonly AssistantTranscriptItem[],
): SummaryDraft {
  const userMessages = items
    .map((item) => ({ item, message: toModelMessage(item) }))
    .filter(
      (
        entry,
      ): entry is {
        item: AssistantTranscriptItem;
        message: AgentLoopMessage;
      } => entry.message?.role === "user",
    );
  return {
    goal: null,
    activeInstructions: userMessages.slice(-12).map((entry) => ({
      text:
        entry.message.content
          .replace(/<context>[\s\S]*?<\/context>/gu, "")
          .trim()
          .slice(0, 600) || "(message)",
      ref: String(entry.item.seq),
    })),
    constraints: [],
    entities: [],
    findings: [],
    unfinishedSteps: [],
    pendingQuestions: [],
  };
}

export interface AssembleOptions {
  repository: AssistantRepository;
  conversationId: string;
  activeTurnId?: string;
  /** Empty-output recovery omits old tool exchanges, never the current work. */
  recoverEmptyReply?: boolean;
  systemPrompt: string;
  currentContext?: string;
  turnMessages: readonly AgentLoopMessage[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  toolSchemaTokens: number;
  calibrator: TokenCalibrator;
  /** Separate model call with tools off; null when the route cannot. */
  summarize: ((prompt: string) => Promise<string>) | null;
  onCompacted: (checkpoint: AssistantCheckpoint) => Promise<void>;
  now: () => string;
  createId: (prefix: string) => string;
  /** Forces compaction below the real window (tests, fault injection). */
  budgetOverrideTokens?: number | null;
  /**
   * Deterministic facts that must survive compaction word for word, such as
   * the ordered lists shown earlier. Shown after the summary, never
   * summarized.
   */
  pinnedAfterSummary?: () => Promise<string | null>;
}

async function loadTail(
  repository: AssistantRepository,
  conversationId: string,
  checkpoint: AssistantCheckpoint | null,
): Promise<AssistantTranscriptItem[]> {
  return repository.listTranscript(conversationId, {
    afterSeq: checkpoint?.coversThroughTranscriptSeq ?? 0,
  });
}

/** Finished turns need requests and receipts, not private reasoning or old
 * page snapshots. The full transcript remains available to history tools. */
export function completedTurnContext(
  items: readonly AssistantTranscriptItem[],
  activeTurnId: string,
  recover: boolean,
): AssistantTranscriptItem[] {
  const results = new Map<string, { summary: string; changes: string }>();
  for (const item of items) {
    const message = toModelMessage(item);
    if (message?.role === "tool") {
      const lines = message.content.split("\n");
      results.set(message.toolCallId, {
        summary: lines[0] ?? "",
        changes: lines.find((line) => line.startsWith('{"changes":')) ?? "",
      });
    }
  }
  return items.flatMap((item) => {
    if (item.turnId === activeTurnId) return [item];
    const message = toModelMessage(item);
    if (!message) return [];
    if (message.role === "tool") return [];
    if (message.role === "user")
      return [
        {
          ...item,
          message: {
            role: "user",
            content: message.content
              .replace(/<context>[\s\S]*?<\/context>/gu, "")
              .trim(),
          },
        },
      ];
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (recover) {
        const changes = message.toolCalls.flatMap(
          (call) => results.get(call.id)?.changes || [],
        );
        return changes.length
          ? [
              {
                ...item,
                message: {
                  role: "assistant",
                  content: `[Saved change receipts]\n${changes.join("\n")}`,
                },
              },
            ]
          : [];
      }
      const receipts = message.toolCalls.map((call) => {
        const outcome = results.get(call.id);
        return `${call.function.name} ${call.function.arguments.slice(0, 1000)}: ${outcome?.summary ?? "No recorded result; check current state."}${outcome?.changes ? `\n${outcome.changes}` : ""}`;
      });
      return [
        {
          ...item,
          message: {
            role: "assistant",
            content: `[Earlier action receipts]\n${receipts.join("\n")}`,
          },
        },
      ];
    }
    return [
      { ...item, message: { role: "assistant", content: message.content } },
    ];
  });
}

function compose(
  systemPrompt: string,
  checkpoint: AssistantCheckpoint | null,
  tail: readonly AssistantTranscriptItem[],
  turnMessages: readonly AgentLoopMessage[],
  pinned: string | null = null,
  currentContext?: string,
): AgentLoopMessage[] {
  const history = tail
    .map(toModelMessage)
    .filter((message): message is AgentLoopMessage => message !== null);
  // A stored tail must start at a person message so no tool result is orphaned.
  const start = history.findIndex((message) => message.role === "user");
  const messages: AgentLoopMessage[] = [
    { role: "system", content: systemPrompt },
    ...(checkpoint
      ? [
          {
            role: "user" as const,
            content: pinned
              ? `${renderCheckpoint(checkpoint)}\n\n${pinned}`
              : renderCheckpoint(checkpoint),
          },
        ]
      : pinned
        ? [{ role: "user" as const, content: pinned }]
        : []),
    ...(start > 0 ? history.slice(start) : start === 0 ? history : []),
    ...turnMessages,
  ];
  if (currentContext) {
    const at = messages.findLastIndex((message) => message.role === "user");
    const message = messages[at];
    if (message)
      messages[at] = {
        ...message,
        content: `${message.content.replace(/<context>[\s\S]*?<\/context>/gu, "").trim()}\n${currentContext}`,
      };
  }
  return messages;
}

export async function assembleModelInput(
  options: AssembleOptions,
): Promise<AgentLoopMessage[]> {
  let pinnedText: string | null | undefined;
  const pinned = async () => {
    if (pinnedText === undefined) {
      pinnedText =
        (await options.pinnedAfterSummary?.().catch(() => null)) ?? null;
    }
    return pinnedText;
  };
  const budget =
    options.budgetOverrideTokens ??
    availablePromptTokens({
      contextWindowTokens: options.contextWindowTokens,
      reservedOutputTokens: options.maxOutputTokens,
      toolSchemaTokens: options.toolSchemaTokens,
      marginTokens: Math.max(
        4_000,
        Math.round(options.contextWindowTokens * 0.04),
      ),
    });
  let checkpoint = await options.repository.getLatestCheckpoint(
    options.conversationId,
  );
  // Read once up front: measuring stays synchronous.
  const pinnedForMeasure = await pinned();
  let tail = await loadTail(
    options.repository,
    options.conversationId,
    checkpoint,
  );
  if (options.activeTurnId)
    tail = completedTurnContext(
      tail,
      options.activeTurnId,
      options.recoverEmptyReply ?? false,
    );
  let turnMessages = options.turnMessages;
  const measure = () =>
    options.calibrator.adjust(
      estimateTokens(
        compose(
          options.systemPrompt,
          checkpoint,
          tail,
          turnMessages,
          pinnedForMeasure,
          options.currentContext,
        ),
      ),
    );

  // Maintenance starts before the budget would be exceeded.
  if (measure() > budget * 0.8) {
    const tailMessages = tail.map(toModelMessage);
    const present = tailMessages.filter(
      (message): message is AgentLoopMessage => message !== null,
    );
    const { messages: elided, elided: count } = elideOldToolOutputs(present, {
      keepRecent: 6,
    });
    if (count > 0) {
      const replacements: { seq: number; message: unknown }[] = [];
      let cursor = 0;
      tail = tail.map((item, index) => {
        if (tailMessages[index] === null) return item;
        const next = elided[cursor++]!;
        if (JSON.stringify(next) !== JSON.stringify(item.message)) {
          replacements.push({ seq: item.seq, message: next });
          return { ...item, message: next };
        }
        return item;
      });
      await options.repository.replaceTranscriptItems(
        options.conversationId,
        replacements,
      );
    }
  }

  for (let attempt = 0; attempt < 2 && measure() > budget * 0.9; attempt += 1) {
    // Summarize the oldest exchanges, cutting at a person message, and keep
    // a recent tail of about a third of the budget.
    const recentBudget = Math.round(budget * 0.35);
    let keepFrom = tail.length;
    let kept = 0;
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const message = toModelMessage(tail[index]!);
      kept += message ? estimateTokens([message]) : 0;
      if (kept > recentBudget) break;
      keepFrom = index;
    }
    while (
      keepFrom < tail.length &&
      toModelMessage(tail[keepFrom]!)?.role !== "user"
    ) {
      keepFrom += 1;
    }
    if (keepFrom === 0 || keepFrom >= tail.length) {
      // Nothing older to summarize: the tail itself is too long.
      keepFrom = Math.max(
        1,
        tail.findIndex(
          (item, index) => index > 0 && toModelMessage(item)?.role === "user",
        ),
      );
      if (keepFrom <= 0 || keepFrom >= tail.length) break;
    }
    const dropped = tail.slice(0, keepFrom);
    const priorSummary = checkpoint
      ? `${renderCheckpoint(checkpoint)}\n\n`
      : "";
    let draft: SummaryDraft | null = null;
    if (options.summarize && attempt === 0) {
      try {
        const raw = await options.summarize(
          `${SUMMARY_INSTRUCTIONS}\n\n${priorSummary}${describeForSummary(dropped)}`,
        );
        const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
        const parsed = SummaryDraftSchema.safeParse(JSON.parse(json));
        draft = parsed.success
          ? validateSummaryDraft(parsed.data, dropped)
          : null;
      } catch {
        draft = null;
      }
    }
    const merged = draft ?? fallbackDraft(dropped);
    const previousInstructions = checkpoint?.activeInstructions ?? [];
    const next = AssistantCheckpointSchema.parse({
      id: options.createId("assistant_checkpoint"),
      conversationId: options.conversationId,
      version: (checkpoint?.version ?? 0) + 1,
      coversThroughMessageId: `transcript_${dropped.at(-1)!.seq}`,
      coversThroughTranscriptSeq: dropped.at(-1)!.seq,
      goal: merged.goal ?? checkpoint?.goal ?? null,
      activeInstructions: [
        ...previousInstructions,
        ...merged.activeInstructions.map((entry) => ({
          text: entry.text,
          messageId: `transcript_${entry.ref?.replace(/[^\d]/gu, "") || dropped.at(-1)!.seq}`,
        })),
      ].slice(-30),
      constraints: [
        ...new Set([...(checkpoint?.constraints ?? []), ...merged.constraints]),
      ].slice(-30),
      entities: [
        ...(checkpoint?.entities ?? []),
        ...merged.entities.map((entity) => ({
          kind: normalizeEntityKind(entity.kind),
          id: entity.id,
          label: entity.label ?? null,
        })),
      ].slice(-60),
      findings: [...(checkpoint?.findings ?? []), ...merged.findings].slice(
        -40,
      ),
      unfinishedSteps: merged.unfinishedSteps,
      pendingQuestions: merged.pendingQuestions,
      evidenceRefs: [],
      estimatedTokensBefore: measure(),
      estimatedTokensAfter: null,
      createdAt: options.now(),
    });
    checkpoint = next;
    tail = tail.slice(keepFrom);
    const after = measure();
    const saved = { ...next, estimatedTokensAfter: after };
    await options.repository.appendCheckpoint(saved);
    await options.onCompacted(saved);
  }
  // One long request (reading many pages, checking many jobs) fills the
  // context with its own tool results before any earlier exchange exists to
  // summarize. Older results of this turn shrink to their one-line summaries,
  // newest first kept, so the request finishes instead of stopping.
  for (const keepRecent of [6, 2, 0]) {
    if (measure() <= budget) break;
    turnMessages = elideOldToolOutputs(turnMessages, {
      keepRecent,
      minCharsToElide: 300,
    }).messages;
  }
  if (measure() > budget) {
    throw new AssistantContextOverflowError();
  }
  return compose(
    options.systemPrompt,
    checkpoint,
    tail,
    turnMessages,
    await pinned(),
    options.currentContext,
  );
}

function normalizeEntityKind(kind: string) {
  const known = [
    "job",
    "application",
    "company",
    "campaign",
    "resume",
    "file",
    "profile_section",
    "settings_section",
    "user_action",
    "run",
    "result_set",
  ] as const;
  const match = known.find((entry) => entry === kind);
  return match ?? ("run" as const);
}
