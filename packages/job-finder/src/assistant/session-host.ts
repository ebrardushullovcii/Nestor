import { executeRegisteredAssistantAction } from "./tools/registered-action-tools";
import { connectAssistantMcp } from "./mcp";
import { estimateResumeBatchMinutesLeft } from "@nestor/contracts";
import { verifyPersonAnswerAuthority } from "./person-answer-authority";
import { readAssistantWorkState } from "./work-state";
import { buildChangePreview } from "./change-diff";
import { createHash, randomUUID } from "node:crypto";

import {
  createTokenCalibrator,
  estimateJsonTokens,
  estimateTokens,
  runConversationTurn,
  type AgentLoopMessage,
  type ConversationModel,
  type ConversationTurnEvent,
  type TokenCalibrator,
  withStatusArgument,
} from "@nestor/agent-runtime";
import {
  AssistantNavigationAcknowledgmentSchema,
  type AssistantNavigationAcknowledgment,
  type AssistantNavigationDisplay,
  AssistantContextReferenceSchema,
  AssistantSendMessageInputSchema,
  type AssistantActivity,
  type AssistantAnswerQuestionInput,
  type AssistantChangeReceipt,
  type AssistantConversation,
  type AssistantConversationList,
  type AssistantConversationView,
  type AssistantEvent,
  type AssistantEventPayload,
  type AssistantMentionCandidate,
  type AssistantMessage,
  type AssistantMessagePart,
  type AssistantReadConversationInput,
  type AssistantReplayEventsInput,
  type AssistantReplayEventsResult,
  type AssistantResolveProposalInput,
  type AssistantResultSet,
  type AssistantRunRef,
  type AssistantSendMessageInput,
  type AssistantSendMessageResult,
  type AssistantStatus,
  type AssistantTaskPlan,
  type AssistantTurn,
  type AssistantUndoChangeResult,
  type JobFinderWorkspaceSnapshot,
  type ProfileCopilotPatchOperation,
  type ResumeDraftPatch,
} from "@nestor/contracts";
import type { AssistantRepository } from "@nestor/db";

import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";
import {
  assembleModelInput,
  AssistantContextOverflowError,
} from "./context-assembly";
import { createHandleStore } from "./handle-store";
import type { AssistantBrowserLease, AssistantHostPorts } from "./ports";
import { ASSISTANT_SYSTEM_PROMPT, buildContextBlock } from "./prompt";
import { readRunStatus } from "./run-watch";
import { closeStoppedTurn } from "./turn-closure";
import { allJobs, createJobCaveats } from "./tools/format";
import {
  AssistantToolError,
  assistantModelToolDefinition,
  toConversationTool,
  type AssistantHandleStore,
  type AssistantToolOutputs,
  type AssistantTurnSession,
  assistantToolGroupValues,
  type AssistantToolGroup,
} from "./tool-kit";
import {
  buildAssistantToolCatalog,
  cancelBackgroundBatch,
  readBackgroundBatch,
  undoReceipt,
  type AssistantCatalogMode,
} from "./tools";

/**
 * The assistant session host (ADR 0037).
 *
 * The main process owns every conversation: navigating, hiding the sidebar
 * or reloading the renderer never ends a running turn. The renderer sends
 * typed commands and replays events from a sequence cursor. One turn runs
 * per conversation; messages sent meanwhile are read at the next tool
 * boundary. Stop aborts the model call, cancels running tools through their
 * own signals, fences later writes and reaches the runs the turn started.
 */

export interface AssistantModelHandle {
  name: string;
  scripted: boolean;
  capabilities: {
    contextWindowTokens: number;
    maxOutputTokens: number;
    images: boolean;
  };
  createModel(conversationId: string): ConversationModel;
  /** A separate call with tools off, for compaction summaries. */
  summarize:
    | ((conversationId: string, prompt: string) => Promise<string>)
    | null;
}

export type AssistantModelResolution =
  | { kind: "ready"; handle: AssistantModelHandle }
  | { kind: "unavailable"; detail: string };

export interface AssistantSessionHostOptions {
  repository: AssistantRepository;
  service: JobFinderWorkspaceService;
  ports: AssistantHostPorts;
  resolveModel: () => AssistantModelResolution;
  publish: (event: AssistantEvent) => void;
  now?: () => string;
  createId?: (prefix: string) => string;
  catalogMode?: AssistantCatalogMode;
  /** Quiet time before a truthful "still waiting" status appears. */
  stallAfterMs?: number;
  /** Forces a small prompt budget (tests, fault injection). */
  budgetOverrideTokens?: number | null;
  /** How often watched background runs are checked while any exist. */
  watchIntervalMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

interface LiveTurn {
  turn: AssistantTurn;
  controller: AbortController;
  generation: number;
  replyMessageId: string;
  draftText: string;
  attempt: number;
  activity: AssistantActivity | null;
  lastSignalAt: number;
  stallTimer: ReturnType<typeof setInterval> | null;
  stallShown: boolean;
  modelCallInFlight: boolean;
  lease: AssistantBrowserLease | null;
  focusedApplicationResultId?: string | undefined;
  sourceMessage: AssistantMessage | null;
  outputs: AssistantToolOutputs;
  lastPersistedDraftAt: number;
  runsStarted: AssistantRunRef[];
}

interface RunWatch {
  conversationId: string;
  run: AssistantRunRef;
  note: string;
  operationId: string;
  sourceMessageId: string | null;
  /** Set for a run that is resuming after a pause (see watchRun). */
  resumedAt?: number;
  seenWorking?: boolean;
  /** A reported person-owned handoff remains quiet until this run changes. */
  reportedHandoff?: { key: string; resultKey: string | undefined };
}

/** How long a resumed run may look ended before its end is believed. */
const RESUME_GRACE_MS = 30_000;

function runWatchKey(
  conversationId: string,
  run: Pick<AssistantRunRef, "kind" | "id">,
): string {
  const kind =
    run.kind === "apply_batch" || run.kind === "apply_run"
      ? "application"
      : run.kind;
  return `${conversationId}:${kind}:${run.id}`;
}

const OUTAGE_TEXT =
  "The assistant could not reach its AI service just now. Your message is kept; send it again in a moment.";

/**
 * The failure the person reads names what actually happened: a reply cut off
 * for length is not an outage, and a service that went quiet is not the
 * person's internet.
 */
function describeModelFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (
    /\bincomplete\b|finish_reason[^a-z]*length|response:length|max(?:imum)?[\s_-]?(?:output[\s_-]?)?tokens/iu.test(
      message,
    )
  ) {
    return "The AI stopped before finishing its reply because the reply ran too long. Your message is kept; ask again, or ask for a shorter answer.";
  }
  if (/timed?\s?out|silence|idle/iu.test(message)) {
    return "The AI service stopped answering partway through. Your message is kept; send it again in a moment.";
  }
  return OUTAGE_TEXT;
}
const EVENT_KEEP_LAST = 2_000;

/** A change card's title: the first sentence, kept short. */
export function shortChangeTitle(summary: string): string {
  const first = summary.split(/(?<=[.!?])\s/u)[0]?.trim() ?? summary;
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}

function hashArguments(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function textOf(message: AssistantMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean.length > 60
    ? `${clean.slice(0, 57).trimEnd()}…`
    : clean || "New chat";
}

export class AssistantSessionHost {
  private readonly resolvingProposals = new Map<
    string,
    Promise<AssistantMessage>
  >();
  private readonly navigationRequests = new Map<
    string,
    {
      conversationId: string;
      resolve: (display: AssistantNavigationDisplay) => void;
    }
  >();

  acknowledgeNavigation(input: AssistantNavigationAcknowledgment): void {
    const ack = AssistantNavigationAcknowledgmentSchema.parse(input);
    const pending = this.navigationRequests.get(ack.navigationRequestId);
    if (pending?.conversationId === ack.conversationId) pending.resolve(ack);
  }

  private readonly repository: AssistantRepository;
  private readonly service: JobFinderWorkspaceService;
  private readonly ports: AssistantHostPorts;
  private readonly options: AssistantSessionHostOptions;
  private readonly live = new Map<string, LiveTurn>();
  private readonly watches = new Map<string, RunWatch>();
  private watchCheckInFlight: Promise<void> | null = null;
  private readonly backgroundActivityLabels = new Map<string, string | null>();
  private readonly handles = new Map<string, AssistantHandleStore>();
  private readonly calibrators = new Map<string, TokenCalibrator>();
  private readonly profileReadDone = new Set<string>();
  private generationCounter = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchCheckPending = false;
  /** Update-driven watch checks wait until then; see `checkWatches`. */
  private watchCheckRestUntil = 0;
  /** Chat questions tied to a Needs you step, by conversation and question. */
  private readonly linkedQuestions = new Map<
    string,
    { conversationId: string; questionId: string; requestId: string }
  >();
  private questionSyncPending = false;
  /**
   * Restart notices about an unfinished resume batch can only resolve while
   * one may still be open; checking needs a full snapshot, so it is skipped
   * once none is left and runs at most every 10 s otherwise.
   */
  private resumeNoticeCheckDue = true;
  private resumeNoticeCheckPending = false;
  private resumeNoticeCheckedAt = 0;
  /** Notes for the model's next turn about questions settled elsewhere. */
  private readonly answeredElsewhere = new Map<string, string[]>();
  private closed = false;
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(options: AssistantSessionHostOptions) {
    this.options = options;
    this.repository = options.repository;
    this.service = options.service;
    this.ports = options.ports;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      ((prefix) =>
        `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`);
  }

  // ---------------------------------------------------------------------------
  // Status, conversations
  // ---------------------------------------------------------------------------

  getStatus(): AssistantStatus {
    const resolution = this.options.resolveModel();
    return resolution.kind === "ready"
      ? {
          available: true,
          detail: null,
          model: resolution.handle.name,
          scripted: resolution.handle.scripted,
        }
      : {
          available: false,
          detail: resolution.detail,
          model: null,
          scripted: false,
        };
  }

  async listConversations(): Promise<AssistantConversationList> {
    const conversations = await this.repository.listConversations();
    return {
      conversations,
      currentConversationId: await this.repository.getCurrentConversationId(),
    };
  }

  async createConversation(): Promise<AssistantConversation> {
    const now = this.now();
    const conversation: AssistantConversation = {
      id: this.createId("assistant_conversation"),
      title: "New chat",
      status: "active",
      source: "assistant",
      jobId: null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      messageCount: 0,
    };
    await this.repository.upsertConversation(conversation);
    await this.repository.setCurrentConversationId(conversation.id);
    await this.emit(conversation.id, null, {
      type: "conversation_updated",
      conversation,
    });
    return conversation;
  }

  async selectConversation(conversationId: string): Promise<void> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("That conversation no longer exists.");
    await this.repository.setCurrentConversationId(conversationId);
  }

  async readConversation(
    input: AssistantReadConversationInput,
  ): Promise<AssistantConversationView> {
    const conversation = await this.repository.getConversation(
      input.conversationId,
    );
    if (!conversation) throw new Error("That conversation no longer exists.");
    const page = await this.repository.listMessages(input.conversationId, {
      beforeMessageId: input.beforeMessageId ?? null,
      limit: input.limit ?? 200,
    });
    const live = this.live.get(input.conversationId) ?? null;
    return {
      conversation,
      messages: page.messages,
      hasOlderMessages: page.hasOlder,
      activeTurn: live?.turn ?? null,
      activity: live
        ? live.activity
        : this.resumeBatchActivity(input.conversationId),
      draftText: live?.draftText || null,
      plans: await this.repository.listPlans({
        conversationId: input.conversationId,
        status: "active",
      }),
      lastSequence: await this.repository.getLastSequence(input.conversationId),
      pendingMessageIds: await this.repository.listPendingMessageIds(
        input.conversationId,
      ),
    };
  }

  async replayEvents(
    input: AssistantReplayEventsInput,
  ): Promise<AssistantReplayEventsResult> {
    const events = await this.repository.listEvents(
      input.conversationId,
      input.afterSequence,
      1_000,
    );
    const lastSequence = await this.repository.getLastSequence(
      input.conversationId,
    );
    const reset =
      events.length > 0 && events[0]!.sequence > input.afterSequence + 1;
    return { events: reset ? [] : events, lastSequence, reset };
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.stop(conversationId, "The conversation was deleted.");
    for (const [key, watch] of this.watches) {
      if (watch.conversationId === conversationId) {
        await this.cancelRun(watch.run);
        this.watches.delete(key);
      }
    }
    for (const lease of await this.repository.listLeases({
      conversationId,
      status: "active",
    })) {
      await this.repository.upsertLease({
        ...lease,
        status: "revoked",
        revokedReason: "conversation deleted",
      });
    }
    for (const grant of await this.repository.listGrants(conversationId)) {
      await this.repository.upsertGrant({
        ...grant,
        status: "revoked",
        updatedAt: this.now(),
      });
    }
    await this.repository.deleteConversation(conversationId);
    this.handles.delete(conversationId);
    this.options.publish({
      conversationId,
      sequence: Number.MAX_SAFE_INTEGER,
      turnId: null,
      at: this.now(),
      payload: { type: "conversation_deleted" },
    });
  }

  // ---------------------------------------------------------------------------
  // Messages and turns
  // ---------------------------------------------------------------------------

  /**
   * Trusted ingress: only the IPC route for the app window calls this, so a
   * message here is one the person typed in the sidebar.
   */
  async sendMessage(
    rawInput: AssistantSendMessageInput,
  ): Promise<AssistantSendMessageResult> {
    const input = AssistantSendMessageInputSchema.parse(rawInput);
    let conversationId =
      input.conversationId ??
      (await this.repository.getCurrentConversationId());
    let conversation = conversationId
      ? await this.repository.getConversation(conversationId)
      : null;
    const archive = conversation?.status === "archived" ? conversation : null;
    if (!conversation || conversation.status === "archived") {
      conversation = await this.createConversation();
      conversationId = conversation.id;
      if (archive) await this.noteArchiveForNewChat(conversation.id, archive);
    }
    const id = conversation.id;
    const repeated = await this.repository.findMessageByClientId(
      id,
      input.clientMessageId,
    );
    if (repeated) {
      return {
        conversationId: id,
        message: repeated,
        steering: this.live.has(id),
        turnId: this.live.get(id)?.turn.id ?? null,
      };
    }
    const context = AssistantContextReferenceSchema.parse(input.context);
    const resultSetIds = await this.freezeContextLists(id, context);
    const message: AssistantMessage = {
      id: this.createId("assistant_message"),
      conversationId: id,
      clientMessageId: input.clientMessageId,
      role: "user",
      origin: "sidebar",
      parts: [
        { type: "text", text: input.text },
        ...context.attachments.map((attachment) => ({
          type: "attachment" as const,
          attachment,
        })),
      ],
      turnId: null,
      context,
      contextResultSetIds: resultSetIds,
      migratedFrom: null,
      createdAt: this.monotonicNow(conversation.lastMessageAt),
      updatedAt: null,
    };
    await this.repository.upsertMessage(message);
    await this.touchConversation(conversation, message, input.text);
    await this.emit(id, null, { type: "message_added", message });
    await this.repository.setCurrentConversationId(id);

    const live = this.live.get(id);
    if (live) {
      await this.repository.addPendingMessage(id, message.id);
      return {
        conversationId: id,
        message,
        steering: true,
        turnId: live.turn.id,
      };
    }
    const turn = await this.startTurn(id, message, "message");
    return {
      conversationId: id,
      message,
      steering: false,
      turnId: turn?.id ?? null,
    };
  }

  async answerQuestion(
    input: AssistantAnswerQuestionInput,
  ): Promise<AssistantSendMessageResult> {
    const page = await this.repository.listMessages(input.conversationId, {
      limit: 60,
    });
    let prompt: string | null = null;
    for (const message of page.messages) {
      const index = message.parts.findIndex(
        (part) =>
          part.type === "question" && part.questionId === input.questionId,
      );
      if (index < 0) continue;
      const part = message.parts[index]!;
      if (part.type !== "question") continue;
      prompt = part.prompt;
      const parts = [...message.parts];
      parts[index] = { ...part, status: "answered", answer: input.answer };
      const updated = { ...message, parts, updatedAt: this.now() };
      await this.repository.upsertMessage(updated);
      await this.emit(input.conversationId, null, {
        type: "message_updated",
        message: updated,
      });
    }
    return this.sendMessage({
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      text: prompt
        ? `(Answer to "${prompt.slice(0, 200)}") ${input.answer}`
        : input.answer,
      context: input.context,
    });
  }

  async stop(conversationId: string, reason = "Stopped."): Promise<void> {
    const live = this.live.get(conversationId);
    if (!live) {
      // Nothing is thinking, but background work this conversation is
      // following still stops, and stays stopped after a restart.
      await this.stopWatchedRuns(conversationId, []);
      return;
    }
    live.controller.abort(new DOMException(reason, "AbortError"));
    // Fence: nothing this turn dispatches from now on may land.
    live.generation = -1;
    await this.stopWatchedRuns(conversationId, live.runsStarted);
    for (const plan of await this.repository.listPlans({
      conversationId,
      status: "active",
    })) {
      await this.savePlan({
        ...plan,
        status: "cancelled",
        steps: plan.steps.map((step) =>
          ["done", "failed", "skipped"].includes(step.status)
            ? step
            : { ...step, status: "cancelled" },
        ),
        updatedAt: this.now(),
      });
    }
    await this.releaseLease(live, "stopped");
  }

  /**
   * Cancels the runs this conversation follows and closes their watch
   * records, so recovery after a restart does not continue stopped work.
   */
  private async stopWatchedRuns(
    conversationId: string,
    startedThisTurn: readonly AssistantRunRef[],
  ): Promise<void> {
    const runs = new Map<string, AssistantRunRef>();
    for (const run of startedThisTurn)
      runs.set(runWatchKey(conversationId, run), run);
    for (const [key, watch] of this.watches) {
      if (watch.conversationId === conversationId) runs.set(key, watch.run);
    }
    for (const [key, run] of runs) {
      await this.cancelRun(run);
      // Resume Stop lets the active drafts finish. Keep observing them so
      // the sidebar names what is still running, without starting a continuation.
      if (run.kind !== "resume_generation") this.watches.delete(key);
    }
    for (const operation of await this.repository.listOperations(
      conversationId,
      { runOnly: true },
    )) {
      if (operation.status !== "started") continue;
      await this.repository.upsertOperation({
        ...operation,
        status: "cancelled",
        resultSummary: "Stopped by the person.",
        endedAt: this.now(),
      });
    }
    await this.publishResumeBatchActivity(conversationId, true);
  }

  /** Stop dispatching from either batch entry point; active drafts can finish. */
  private readWorkspaceSnapshot(): Promise<JobFinderWorkspaceSnapshot> {
    return (
      this.service.getWorkspaceProjection?.() ??
      this.service.getWorkspaceSnapshot()
    );
  }

  async stopResumeBatches(): Promise<void> {
    this.ports.stopResumeBatch?.();
    const snapshot = await this.readWorkspaceSnapshot();
    const checkpoints =
      snapshot.intelligence.resumeBatchCheckpoints ??
      (snapshot.intelligence.resumeBatchCheckpoint
        ? [snapshot.intelligence.resumeBatchCheckpoint]
        : []);
    for (const batch of checkpoints) {
      if (!batch.running || batch.done) continue;
      cancelBackgroundBatch(batch.id);
      await this.service.saveResumeBatchCheckpoint({
        ...batch,
        stopRequested: true,
      });
    }
    this.ports.publishWorkspaceUpdate();
  }

  private async cancelRun(run: AssistantRunRef): Promise<void> {
    try {
      if (run.kind === "discovery") await this.ports.cancelSearch(run.id);
      else if (run.kind === "apply_batch" || run.kind === "apply_run") {
        await this.service.cancelApplyRun(run.id);
      } else if (run.kind === "apply_queue") {
        await this.ports.executeAction?.("control-apply-queue", {
          action: "stop",
          queueId: run.id,
        });
      } else if (run.kind === "source_check") {
        await this.service.cancelSourceDebug(run.id);
      } else if (run.kind === "resume_generation")
        cancelBackgroundBatch(run.id);
    } catch (error) {
      this.log("Could not cancel a run on stop", error);
    }
  }

  private async startTurn(
    conversationId: string,
    sourceMessage: AssistantMessage | null,
    trigger: AssistantTurn["trigger"],
    hostNote?: string,
  ): Promise<AssistantTurn | null> {
    if (this.closed) return null;
    const generation = ++this.generationCounter;
    const turn: AssistantTurn = {
      id: this.createId("assistant_turn"),
      conversationId,
      trigger,
      sourceMessageId: sourceMessage?.id ?? null,
      status: "running",
      generation,
      startedAt: this.now(),
      endedAt: null,
      model: null,
      usage: null,
      error: null,
      planId: null,
    };
    const live: LiveTurn = {
      turn,
      controller: new AbortController(),
      generation,
      replyMessageId: this.createId("assistant_message"),
      draftText: "",
      attempt: 0,
      activity: null,
      lastSignalAt: Date.now(),
      stallTimer: null,
      stallShown: false,
      modelCallInFlight: false,
      lease: null,
      sourceMessage,
      outputs: { parts: [], endTurn: null, activity: [], touched: [] },
      lastPersistedDraftAt: 0,
      runsStarted: [],
    };
    this.live.set(conversationId, live);
    await this.repository.upsertTurn(turn);
    await this.emit(conversationId, turn.id, { type: "turn_updated", turn });
    void this.executeTurn(live, hostNote).catch((error: unknown) => {
      this.log("Assistant turn crashed", error);
    });
    return turn;
  }

  private async executeTurn(live: LiveTurn, hostNote?: string): Promise<void> {
    const conversationId = live.turn.conversationId;
    const resolution = this.options.resolveModel();
    if (resolution.kind === "unavailable") {
      await this.finishTurn(live, {
        status: "failed",
        error: resolution.detail,
        replyParts: [
          { type: "notice", kind: "outage", text: resolution.detail },
        ],
      });
      return;
    }
    const handle = resolution.handle;
    live.turn = { ...live.turn, model: handle.name };

    // The person's message (or Job Finder's note about a finished run) goes
    // into the stored tail with its context block before the model sees it.
    const opening = await this.buildOpeningMessage(live, hostNote);
    await this.repository.appendTranscript(conversationId, live.turn.id, [
      opening,
    ]);

    const session = this.createTurnSession(live, handle);
    const catalogMode = this.options.catalogMode ?? "grouped";
    const loadedGroups = new Set<AssistantToolGroup>();
    const loadedToolNames = new Set<string>();
    const catalogOptions = {
      commands: this.ports.commands ?? [],
      mode: catalogMode,
      browserAvailable: Boolean(this.ports.browser),
      screen: live.sourceMessage?.context?.screen ?? null,
      onLoadToolNames: (names: readonly string[]) => {
        for (const name of names) loadedToolNames.add(name);
      },
      onLoadGroups: (groups: readonly AssistantToolGroup[]) => {
        for (const group of groups) loadedGroups.add(group);
      },
    };
    const allTools = buildAssistantToolCatalog({
      ...catalogOptions,
      loadedGroups: assistantToolGroupValues,
    });
    const mcp = await connectAssistantMcp(allTools, {
      service: this.service, ports: this.ports, session,
    });
    const tools = mcp.tools.map((definition) =>
      this.withOperationRecord(
        toConversationTool(
          definition,
          { service: this.service, ports: this.ports, session },
          live.outputs,
        ),
        live,
        definition.effect,
      ),
    );
    const calibrator = this.calibratorFor(conversationId);
    const systemPrompt = ASSISTANT_SYSTEM_PROMPT;
    const contextTime = this.now();
    const definitions = () =>
      buildAssistantToolCatalog({
        ...catalogOptions,
        loadedGroups: [...loadedGroups],
        loadedToolNames: [...loadedToolNames],
      }).map(assistantModelToolDefinition);
    let lastEstimate = 0;

    this.startStallWatch(live);
    let result: Awaited<ReturnType<typeof runConversationTurn>>;
    try {
      result = await runConversationTurn({
        model: handle.createModel(conversationId),
        tools,
        getToolDefinitions: definitions,
        signal: live.controller.signal,
        isCurrent: () => live.generation === live.turn.generation,
        ceilings: {
          maxOutputTokens: Math.min(handle.capabilities.maxOutputTokens, 8_000),
        },
        storeOverflow: (toolName, content) => {
          const store = this.handleStoreFor(conversationId);
          const lines = content.split("\n");
          const stored = store.put(`${toolName} output`, lines);
          return Promise.resolve(
            `The full output (${lines.length} lines) is stored as handle ${stored.handle}; read it with read_result.`,
          );
        },
        takeSteering: () => this.takeSteering(live),
        assembleMessages: async (turnMessages) => {
          const current = await this.readWorkspaceSnapshot();
          const currentContext = buildContextBlock({
            storeCommands: Boolean(this.ports.commands?.length),
            context: live.sourceMessage?.context ?? null,
            resultSets: live.sourceMessage
              ? await this.resultSetsFor(live.sourceMessage)
              : [],
            snapshot: current,
            work: readAssistantWorkState(this.ports, current),
            plan: await session.plans.active(),
            grants: await session.grants.list(),
            pendingQuestions: [],
            now: contextTime,
          });
          const messages = await assembleModelInput({
            repository: this.repository,
            conversationId,
            systemPrompt,
            currentContext,
            turnMessages,
            contextWindowTokens: handle.capabilities.contextWindowTokens,
            maxOutputTokens: handle.capabilities.maxOutputTokens,
            toolSchemaTokens: estimateJsonTokens(
              definitions().map(withStatusArgument),
            ),
            calibrator,
            summarize: handle.summarize
              ? (prompt) => handle.summarize!(conversationId, prompt)
              : null,
            onCompacted: async () => {
              await this.appendNotice(
                conversationId,
                live.turn.id,
                "compacted",
                "Earlier messages were summarized to make room.",
              );
            },
            now: this.now,
            createId: this.createId,
            budgetOverrideTokens: this.options.budgetOverrideTokens ?? null,
            pinnedAfterSummary: () => this.describeOrderedLists(conversationId),
          });
          // Provider usage includes tools too; treating that as message-only
          // usage inflated the learned ratio and compacted history too early.
          lastEstimate =
            estimateTokens(messages) +
            estimateJsonTokens(definitions().map(withStatusArgument));
          return messages;
        },
        onEvent: (event) =>
          this.onTurnEvent(live, event, calibrator, () => lastEstimate),
      });
    } catch (error) {
      this.stopStallWatch(live);
      const overflow = error instanceof AssistantContextOverflowError;
      await this.repository
        .appendTranscript(
          conversationId,
          live.turn.id,
          closeStoppedTurn(
            [],
            "This request ended with an error before it was finished. Do not continue it unless the person asks again.",
          ),
        )
        .catch(() => undefined);
      await this.finishTurn(live, {
        status: "failed",
        error: overflow ? error.message : "The assistant stopped unexpectedly.",
        replyParts: [
          {
            type: "notice",
            kind: "error",
            text: overflow
              ? error.message
              : "The assistant stopped unexpectedly. Your message is kept; send it again.",
          },
        ],
      });
      return;
    } finally {
      await mcp.close();
    }
    this.stopStallWatch(live);
    await this.repository.appendTranscript(
      conversationId,
      live.turn.id,
      result.ending === "aborted" || result.ending === "superseded"
        ? [...result.turnMessages, ...closeStoppedTurn(result.turnMessages)]
        : result.turnMessages,
    );

    const usage = {
      ...result.usage,
      modelCalls: result.modelCalls,
    };
    if (result.ending === "replied" || result.ending === "stopped") {
      const waiting =
        result.ending === "stopped" &&
        result.stop?.reason === "waiting_for_person";
      const text =
        result.reply?.trim() ||
        (waiting
          ? ""
          : result.ending === "stopped"
            ? (result.stop?.reason ?? "")
            : "Done.");
      await this.finishTurn(live, {
        status: waiting ? "waiting_for_person" : "completed",
        error: null,
        usage,
        replyParts: text ? [{ type: "text", text }] : [],
      });
      return;
    }
    if (result.ending === "aborted" || result.ending === "superseded") {
      await this.finishTurn(live, {
        status: "stopped",
        error: null,
        usage,
        replyParts: [
          {
            type: "notice",
            kind: "stopped",
            text: "Stopped. Anything already saved stays saved.",
          },
        ],
      });
      return;
    }
    if (result.ending === "model_failed") {
      this.log("Assistant model call failed", result.error);
      const failureText = describeModelFailure(result.error);
      await this.finishTurn(live, {
        status: "failed",
        error: failureText,
        usage,
        replyParts: [{ type: "notice", kind: "outage", text: failureText }],
      });
      return;
    }
    await this.finishTurn(live, {
      status: "completed",
      error: null,
      usage,
      replyParts: [
        {
          type: "notice",
          kind: "error",
          text:
            result.ending === "timed_out"
              ? "This took too long and was stopped. What was done is kept; ask again to carry on."
              : "This ran into the safety limit on steps and was stopped. What was done is kept; ask again to carry on.",
        },
      ],
    });
  }

  private async buildOpeningMessage(
    live: LiveTurn,
    hostNote?: string,
  ): Promise<AgentLoopMessage> {
    const conversationId = live.turn.conversationId;
    const snapshot = await this.readWorkspaceSnapshot();
    const resultSets = live.sourceMessage
      ? await this.resultSetsFor(live.sourceMessage)
      : [];
    const plan =
      (
        await this.repository.listPlans({ conversationId, status: "active" })
      )[0] ?? null;
    await this.closeQuestionsAnsweredElsewhere();
    const settledElsewhere = this.answeredElsewhere.get(conversationId) ?? [];
    this.answeredElsewhere.delete(conversationId);
    const block = [
      buildContextBlock({
        storeCommands: Boolean(this.ports.commands?.length),
        context: live.sourceMessage?.context ?? null,
        resultSets,
        snapshot,
        work: readAssistantWorkState(this.ports, snapshot),
        plan,
        grants: await this.repository.listGrants(conversationId),
        pendingQuestions: [],
        now: this.now(),
      }),
      ...settledElsewhere,
    ].join("\n");
    if (hostNote) {
      return {
        role: "user",
        content: `[Job Finder, not the person] ${hostNote}\n${block}`,
      };
    }
    return {
      role: "user",
      content: `${live.sourceMessage ? textOf(live.sourceMessage) : ""}\n${block}`,
    };
  }

  private async takeSteering(live: LiveTurn): Promise<string[]> {
    const conversationId = live.turn.conversationId;
    const ids = await this.repository.listPendingMessageIds(conversationId);
    if (ids.length === 0) return [];
    const texts: string[] = [];
    const taken: string[] = [];
    for (const id of ids) {
      const message = await this.repository.getMessage(id);
      if (!message) {
        taken.push(id);
        continue;
      }
      taken.push(id);
      if (message.origin === "sidebar") {
        // The newest message the person typed is what authorizes from here on.
        live.sourceMessage = message;
        const resultSets = await this.resultSetsFor(message);
        const snapshot = await this.readWorkspaceSnapshot();
        const block = buildContextBlock({
          storeCommands: Boolean(this.ports.commands?.length),
          context: message.context,
          resultSets,
          snapshot,
          work: readAssistantWorkState(this.ports, snapshot),
          plan: null,
          grants: [],
          pendingQuestions: [],
          now: this.now(),
        });
        texts.push(
          `[New message from the person while you were working] ${textOf(message)}\n${block}`,
        );
      } else {
        texts.push(`[Job Finder, not the person] ${textOf(message)}`);
      }
    }
    await this.repository.removePendingMessages(conversationId, taken);
    return texts;
  }

  private async onTurnEvent(
    live: LiveTurn,
    event: ConversationTurnEvent,
    calibrator: TokenCalibrator,
    lastEstimate: () => number,
  ): Promise<void> {
    const conversationId = live.turn.conversationId;
    live.lastSignalAt = Date.now();
    if (live.stallShown) live.stallShown = false;
    switch (event.type) {
      case "model_call_started": {
        live.modelCallInFlight = true;
        live.draftText = "";
        // The row says what just happened and keeps the turn's own clock,
        // instead of a bare "Thinking" that restarts at 0s on every step.
        if (!live.activity || live.activity.toolName !== null) {
          const last = live.activity?.label ?? null;
          await this.setActivity(live, {
            label: last
              ? `${last.replace(/…$/u, "")}: done. Working out the next step`.slice(
                  0,
                  200,
                )
              : "Reading your message",
            toolName: null,
            startedAt: live.turn.startedAt,
          });
        }
        return;
      }
      case "model_call_finished": {
        live.modelCallInFlight = false;
        if (event.usage)
          calibrator.observe(lastEstimate(), event.usage.inputTokens);
        return;
      }
      case "stream": {
        if (event.event.type === "attempt_started") {
          live.attempt += 1;
          live.draftText = "";
        } else if (event.event.type === "text_delta") {
          live.draftText += event.event.text;
          const now = Date.now();
          // Persist text in batches; the live event carries the whole draft.
          const persist = now - live.lastPersistedDraftAt > 500;
          if (persist) live.lastPersistedDraftAt = now;
          await this.emit(
            conversationId,
            live.turn.id,
            {
              type: "text_delta",
              attempt: live.attempt,
              text: live.draftText.slice(-40_000),
            },
            persist,
          );
        }
        return;
      }
      case "commentary": {
        live.draftText = "";
        await this.emit(conversationId, live.turn.id, {
          type: "text_delta",
          attempt: live.attempt,
          text: "",
        });
        await this.emit(conversationId, live.turn.id, {
          type: "progress",
          text: event.text.slice(0, 1_000),
        });
        return;
      }
      case "tool_started": {
        await this.setActivity(live, {
          label: (event.status ?? event.label).slice(0, 200),
          toolName: event.toolName,
          startedAt: live.turn.startedAt,
        });
        return;
      }
      case "tool_finished":
      case "steering_read":
        return;
    }
  }

  private async setActivity(
    live: LiveTurn,
    activity: AssistantActivity | null,
  ) {
    live.activity = activity;
    await this.emit(live.turn.conversationId, live.turn.id, {
      type: "activity",
      activity,
    });
  }

  private startStallWatch(live: LiveTurn): void {
    const stallAfter = this.options.stallAfterMs ?? 25_000;
    live.stallTimer = setInterval(() => {
      if (live.stallShown || Date.now() - live.lastSignalAt < stallAfter)
        return;
      live.stallShown = true;
      const text = live.modelCallInFlight
        ? "Still waiting for the AI service to answer."
        : live.activity?.toolName?.startsWith("browser_")
          ? "The site has not responded yet."
          : `Still working on: ${live.activity?.label ?? "the last step"}.`;
      void this.emit(live.turn.conversationId, live.turn.id, {
        type: "stall",
        text,
      });
    }, 1_000);
  }

  private stopStallWatch(live: LiveTurn): void {
    if (live.stallTimer) clearInterval(live.stallTimer);
    live.stallTimer = null;
  }

  private async finishTurn(
    live: LiveTurn,
    outcome: {
      status: AssistantTurn["status"];
      error: string | null;
      usage?: AssistantTurn["usage"];
      replyParts: AssistantMessagePart[];
    },
  ): Promise<void> {
    const conversationId = live.turn.conversationId;
    this.stopStallWatch(live);
    await this.releaseLease(live, "turn ended");
    let plan =
      (
        await this.repository.listPlans({ conversationId, status: "active" })
      )[0] ?? null;
    // A turn that failed or was stopped leaves no step "running" unless a
    // background run is still doing it; otherwise the checklist kept showing
    // work in progress after the error.
    if (
      plan &&
      (outcome.status === "failed" || outcome.status === "stopped") &&
      plan.steps.some((step) => step.status === "running" && !step.run)
    ) {
      plan = {
        ...plan,
        steps: plan.steps.map((step) =>
          step.status === "running" && !step.run
            ? {
                ...step,
                status: outcome.status === "failed" ? "failed" : "cancelled",
              }
            : step,
        ),
        updatedAt: this.now(),
      };
      await this.savePlan(plan);
    }
    const parts: AssistantMessagePart[] = [
      ...outcome.replyParts,
      ...live.outputs.parts,
      ...(plan
        ? [
            {
              type: "plan" as const,
              planId: plan.id,
              title: plan.title,
              steps: plan.steps.map((step) => ({
                id: step.id,
                label: step.label,
                status: step.status,
              })),
            },
          ]
        : []),
      ...(live.outputs.activity.length > 0
        ? [
            {
              type: "activity" as const,
              entries: live.outputs.activity.slice(-80),
            },
          ]
        : []),
    ];
    if (parts.length > 0) {
      const conversation =
        await this.repository.getConversation(conversationId);
      const reply: AssistantMessage = {
        id: live.replyMessageId,
        conversationId,
        clientMessageId: null,
        role: "assistant",
        origin: "host",
        parts: parts.slice(0, 60),
        turnId: live.turn.id,
        context: null,
        contextResultSetIds: [],
        migratedFrom: null,
        createdAt: this.monotonicNow(conversation?.lastMessageAt ?? null),
        updatedAt: null,
      };
      await this.repository.upsertMessage(reply);
      if (conversation) await this.touchConversation(conversation, reply, null);
      await this.emit(conversationId, live.turn.id, {
        type: "message_added",
        message: reply,
      });
    }
    live.turn = {
      ...live.turn,
      status: outcome.status,
      endedAt: this.now(),
      error: outcome.error,
      usage: outcome.usage ?? live.turn.usage,
      planId: plan?.id ?? null,
    };
    await this.repository.upsertTurn(live.turn);
    live.draftText = "";
    await this.setActivity(live, null);
    await this.emit(conversationId, live.turn.id, {
      type: "turn_updated",
      turn: live.turn,
    });
    if (this.live.get(conversationId) === live)
      this.live.delete(conversationId);
    await this.publishResumeBatchActivity(conversationId, true);
    await this.repository.pruneEvents(conversationId, EVENT_KEEP_LAST);
    this.ports.publishWorkspaceUpdate();
    // Messages that arrived after the last tool boundary start the next turn.
    if (outcome.status !== "stopped") {
      const pending =
        await this.repository.listPendingMessageIds(conversationId);
      if (pending.length > 0) {
        const first = await this.repository.getMessage(pending[0]!);
        await this.repository.removePendingMessages(conversationId, [
          pending[0]!,
        ]);
        if (first) {
          if (first.origin === "sidebar")
            await this.startTurn(conversationId, first, "message");
          else
            await this.startTurn(
              conversationId,
              null,
              "continuation",
              textOf(first),
            );
        }
      }
    } else {
      // A stop drops messages queued behind the stopped work; they stay visible.
      const pending =
        await this.repository.listPendingMessageIds(conversationId);
      await this.repository.removePendingMessages(conversationId, pending);
    }
  }

  private async appendNotice(
    conversationId: string,
    turnId: string | null,
    kind: "compacted" | "continued" | "interrupted",
    text: string,
  ): Promise<void> {
    const conversation = await this.repository.getConversation(conversationId);
    const message: AssistantMessage = {
      id: this.createId("assistant_message"),
      conversationId,
      clientMessageId: null,
      role: "assistant",
      origin: "host",
      parts: [{ type: "notice", kind, text }],
      turnId,
      context: null,
      contextResultSetIds: [],
      migratedFrom: null,
      createdAt: this.monotonicNow(conversation?.lastMessageAt ?? null),
      updatedAt: null,
    };
    await this.repository.upsertMessage(message);
    if (conversation) await this.touchConversation(conversation, message, null);
    await this.emit(conversationId, turnId, { type: "message_added", message });
  }

  // ---------------------------------------------------------------------------
  // Operations: every tool call has an id and a lifecycle
  // ---------------------------------------------------------------------------

  private withOperationRecord(
    tool: ReturnType<typeof toConversationTool>,
    live: LiveTurn,
    effect: "read" | "local_write" | "external",
  ): ReturnType<typeof toConversationTool> {
    if (effect === "read") return tool;
    const conversationId = live.turn.conversationId;
    return {
      ...tool,
      execute: async (raw, context) => {
        const argumentsHash = hashArguments(raw);
        const toolName = tool.definition.function.name;
        const previous = await this.repository.findOperationByArguments({
          conversationId,
          turnId: live.turn.id,
          toolName,
          argumentsHash,
        });
        if (previous?.status === "committed") {
          return {
            kind: "ok",
            content: `Already done in this turn: ${previous.resultSummary ?? "done"}`,
          };
        }
        const operation = {
          id: this.createId("assistant_operation"),
          conversationId,
          turnId: live.turn.id,
          toolName,
          argumentsHash,
          status: "started" as const,
          resultSummary: null,
          receiptId: null,
          run: null,
          startedAt: this.now(),
          endedAt: null,
        };
        await this.repository.upsertOperation(operation);
        try {
          const outcome = await tool.execute(raw, context);
          const failed =
            outcome.kind === "ok" &&
            (outcome.status === "failed" || outcome.status === "refused");
          await this.repository.upsertOperation({
            ...operation,
            status: failed ? "failed" : "committed",
            resultSummary:
              outcome.kind === "ok"
                ? outcome.content.split("\n")[0]!.slice(0, 2_000)
                : outcome.kind === "finish"
                  ? outcome.finish.reason
                  : null,
            endedAt: this.now(),
          });
          return outcome;
        } catch (error) {
          await this.repository.upsertOperation({
            ...operation,
            status:
              effect === "external" && live.controller.signal.aborted
                ? "uncertain"
                : "cancelled",
            endedAt: this.now(),
          });
          throw error;
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // The per-turn session tools work through
  // ---------------------------------------------------------------------------

  private createTurnSession(
    live: LiveTurn,
    handle: AssistantModelHandle,
  ): AssistantTurnSession {
    const conversationId = live.turn.conversationId;
    const session: AssistantTurnSession = {
      conversationId,
      get turnId() {
        return live.turn.id;
      },
      get sourceMessage() {
        return live.sourceMessage;
      },
      get context() {
        return live.sourceMessage?.context ?? null;
      },
      signal: live.controller.signal,
      assertCurrent: () => {
        if (
          live.controller.signal.aborted ||
          live.generation !== live.turn.generation
        ) {
          throw new AssistantToolError(
            "refused",
            "The turn was stopped; nothing more was done.",
          );
        }
      },
      now: this.now,
      createId: this.createId,
      handles: this.handleStoreFor(conversationId),
      createResultSet: async (input) => {
        const resultSet: AssistantResultSet = {
          id: this.createId("result_set"),
          conversationId,
          kind: input.kind,
          label: input.label.slice(0, 200),
          itemIds: [...input.itemIds].slice(0, 3000),
          source: input.source,
          coverage: input.coverage ?? null,
          pageItems: [...(input.pageItems ?? [])].slice(0, 500),
          pageUrl: input.pageUrl ?? null,
          createdAt: this.now(),
        };
        await this.repository.upsertResultSet(resultSet);
        return resultSet;
      },
      getResultSet: async (id) => {
        const found = await this.repository.getResultSet(id);
        return found && found.conversationId === conversationId ? found : null;
      },
      listResultSets: () => this.repository.listResultSets(conversationId),
      saveResultSet: (resultSet) => this.repository.upsertResultSet(resultSet),
      recordChange: async (input) => {
        const receipt: AssistantChangeReceipt = {
          id: this.createId("assistant_receipt"),
          conversationId,
          messageId: live.replyMessageId,
          operationId: null,
          target: input.target,
          targetId: input.targetId,
          summary: input.summary.slice(0, 400),
          fieldLabels: [
            ...new Set(
              input.entries.map(
                (entry) => entry.label ?? entry.path.at(-1) ?? "value",
              ),
            ),
          ].slice(0, 60),
          entries: [...input.entries].slice(0, 600),
          ...(input.undoCommand ? { undoCommand: input.undoCommand } : {}),
          createdAt: this.now(),
          status: "applied",
          undoneAt: null,
          undoConflicts: [],
        };
        await this.repository.upsertChangeReceipt(receipt);
        const part: AssistantMessagePart = {
          type: "change",
          receiptId: receipt.id,
          target: receipt.target,
          targetId: receipt.targetId,
          summary: shortChangeTitle(receipt.summary),
          // A record added or removed says so on the card; "Changed" is only
          // for values edited in place.
          fields: [
            ...new Set(
              input.entries.map((entry) => {
                const label = entry.label ?? entry.path.at(-1) ?? "value";
                return (
                  entry.kind === "insert"
                    ? `Added ${label}`
                    : entry.kind === "remove"
                      ? `Removed ${label}`
                      : label
                ).slice(0, 160);
              }),
            ),
          ].slice(0, 40),
          preview: buildChangePreview(input.entries),
          status: "applied",
          unsaved: false,
        };
        return { receipt, part };
      },
      getReceipt: async (id) => {
        const receipt = await this.repository.getChangeReceipt(id);
        return receipt && receipt.conversationId === conversationId
          ? receipt
          : null;
      },
      listReceipts: () => this.repository.listChangeReceipts(conversationId),
      saveReceipt: async (receipt) => {
        await this.repository.upsertChangeReceipt(receipt);
        // A card made earlier in this same turn is not stored yet.
        live.outputs.parts = live.outputs.parts.map((part) =>
          part.type === "change" && part.receiptId === receipt.id
            ? { ...part, status: receipt.status }
            : part,
        );
        // The change card follows its receipt, whether the undo came from
        // the card or from the conversation ("undo that").
        await this.syncChangeCard(receipt);
      },
      createProposal: async (input) => {
        const proposal = {
          ...input,
          id: this.createId("assistant_proposal"),
          conversationId,
          messageId: live.replyMessageId,
          status: "pending" as const,
          createdAt: this.now(),
          resolvedAt: null,
        };
        await this.repository.upsertProposal(proposal);
        const part: AssistantMessagePart = {
          type: "proposal",
          proposalId: proposal.id,
          kind: proposal.kind,
          summary: proposal.summary,
          status: "pending",
          targetId: proposal.targetId,
          items: proposal.items.map((item) => ({
            id: item.id,
            label: item.label,
            detail: item.detail ?? null,
          })),
          source: {
            store: "assistant",
            legacyMessageId: null,
            patchGroupIds: [],
          },
        };
        return { proposal, part };
      },
      grants: {
        list: () => this.repository.listGrants(conversationId),
        save: (grant) => this.repository.upsertGrant(grant),
      },
      plans: {
        active: async () =>
          (
            await this.repository.listPlans({
              conversationId,
              status: "active",
            })
          )[0] ?? null,
        save: (plan) => this.savePlan(plan),
      },
      watchRun: async (run, note, options) => {
        live.runsStarted.push(run);
        await this.watch({
          conversationId,
          run,
          note,
          sourceMessageId: live.sourceMessage?.id ?? null,
          turnId: live.turn.id,
          resumed: options?.resumed === true,
        });
      },
      askQuestion: (prompt, options, needsYouRequestId) => {
        const questionId = this.createId("assistant_question");
        live.outputs.parts.push({
          type: "question",
          questionId,
          prompt: prompt.slice(0, 1_000),
          options: options.map((option) => option.slice(0, 200)).slice(0, 8),
          status: "open",
          answer: null,
          needsYouRequestId: needsYouRequestId ?? null,
        });
        if (needsYouRequestId) {
          this.linkedQuestions.set(`${conversationId}:${questionId}`, {
            conversationId,
            questionId,
            requestId: needsYouRequestId,
          });
        }
        return Promise.resolve(questionId);
      },
      reportProgress: async (text) => {
        await this.emit(conversationId, live.turn.id, {
          type: "progress",
          text: text.slice(0, 1_000),
        });
      },
      reportGap: async (text) => {
        this.log(`Assistant capability gap: ${text}`);
        await this.repository.upsertOperation({
          id: this.createId("assistant_gap"),
          conversationId,
          turnId: live.turn.id,
          toolName: "report_missing_capability",
          argumentsHash: hashArguments(text),
          status: "committed",
          resultSummary: text.slice(0, 2_000),
          receiptId: null,
          run: null,
          startedAt: this.now(),
          endedAt: this.now(),
        });
      },
      searchConversation: (query, limit) =>
        this.searchConversation(conversationId, query, limit),
      assertPersonAnswerAuthority: async (input) => {
        const page = await this.repository.listMessages(conversationId, {
          limit: 20,
        });
        await verifyPersonAnswerAuthority({
          ...input,
          messages: page.messages,
          sourceMessage: live.sourceMessage,
          judge: handle.scripted
            ? null
            : async (prompt) => {
                const result = await handle
                  .createModel(conversationId)
                  .chatWithTools(
                    [
                      {
                        role: "system",
                        content:
                          "Check who supplied or approved the proposed answers. Return only the requested JSON, using the person's messages as authority.",
                      },
                      { role: "user", content: prompt },
                    ],
                    [],
                    { signal: live.controller.signal, maxOutputTokens: 3_000 },
                  );
                return result.content ?? "";
              },
        });
        session.assertCurrent();
      },
      firstProfileRead: () => {
        if (this.profileReadDone.has(conversationId))
          return Promise.resolve(false);
        this.profileReadDone.add(conversationId);
        return Promise.resolve(true);
      },
      openInApp: async (route) => {
        session.assertCurrent();
        await this.ports.prepareAppNavigation?.();
        session.assertCurrent();
        const navigationRequestId = randomUUID();
        let resolve!: (display: AssistantNavigationDisplay) => void;
        const displayed = new Promise<AssistantNavigationDisplay>((done) => {
          resolve = done;
        });
        const unverified: AssistantNavigationDisplay = {
          displayedRoute: null,
          section: null,
          overlay: "none",
          status: "blocked",
          reason: "The displayed destination was not acknowledged.",
        };
        const timeout = setTimeout(() => resolve(unverified), 4_000);
        const stopped = () =>
          resolve({
            ...unverified,
            reason: "Navigation stopped before it was acknowledged.",
          });
        session.signal?.addEventListener("abort", stopped, { once: true });
        this.navigationRequests.set(navigationRequestId, {
          conversationId,
          resolve,
        });
        try {
          await this.emit(conversationId, live.turn.id, {
            type: "open_route",
            route,
            navigationRequestId,
          });
          const result = await displayed;
          const expected = new URL(route, "https://nestor.local");
          const actual = result.displayedRoute
            ? new URL(result.displayedRoute, "https://nestor.local")
            : null;
          const matches =
            actual?.pathname === expected.pathname &&
            [...expected.searchParams].every(
              ([key, value]) => actual.searchParams.get(key) === value,
            );
          const section =
            expected.searchParams.get("section") ??
            (expected.searchParams.get("view") === "tracker"
              ? "tracker"
              : null);
          if (
            result.status === "displayed" &&
            (!matches ||
              result.overlay !== "none" ||
              (section && result.section !== section))
          )
            return {
              ...result,
              status: "blocked",
              reason: "The requested destination is not visible.",
            };
          return result;
        } finally {
          clearTimeout(timeout);
          session.signal?.removeEventListener("abort", stopped);
          this.navigationRequests.delete(navigationRequestId);
        }
      },
      visionAvailable: handle.capabilities.images,
      releaseBrowserLease: async () => {
        delete live.focusedApplicationResultId;
        await this.releaseLease(live, "Reviewing your send instruction");
      },
      browserLease: async (options) => {
        const applicationResultId = options?.newTab
          ? undefined
          : (options?.applicationResultId ?? live.focusedApplicationResultId);
        const tabId = options?.newTab
          ? null
          : (options?.tabId ??
            live.sourceMessage?.context?.browser?.tabId ??
            null);
        if (
          live.lease &&
          !live.lease.revoked.aborted &&
          !options?.newTab &&
          (!options?.tabId || live.lease.tabId === options.tabId) &&
          (!applicationResultId ||
            live.lease.applicationResultId === applicationResultId)
        )
          return live.lease;
        // A tab the person took back stays theirs until they send a new
        // message; neither this turn nor its continuations lease it again
        // (ADR 0038).
        const takenBack =
          (live.lease?.revoked.aborted === true &&
            /took this tab back/iu.test(
              String(live.lease.revoked.reason ?? ""),
            )) ||
          this.isTabTakenBack(conversationId, tabId, live.sourceMessage?.id);
        if (takenBack) {
          throw new AssistantToolError(
            "refused",
            "You took this tab back. Stop using the browser for this request. Begin your reply with: You took this tab back, so I stopped there. Then report only what you finished; they can ask again in a new message.",
          );
        }
        if (!this.ports.browser) {
          throw new AssistantToolError(
            "refused",
            "The browser is not available here.",
          );
        }
        await this.releaseLease(live, "Switching browser tabs");
        session.assertCurrent();
        const lease = await this.ports.browser.lease({
          tabId,
          ...(applicationResultId ? { applicationResultId } : {}),
          onApplicationChange: async (recordId, field) => {
            const snapshot = await this.readWorkspaceSnapshot();
            const record = snapshot.applicationRecords.find(
              (record) => record.id === recordId,
            );
            if (!record)
              throw new Error("The application record is no longer available.");
            const at = this.now();
            await this.service.mutateApplicationCrm({
              applicationRecordId: recordId,
              expectedRevision: record.crm?.revision ?? 0,
              actor: "assistant",
              mutation: {
                type: "add_note",
                note: {
                  id: session.createId("assistant_browser_edit"),
                  body: `Assistant changed ${field.slice(0, 160)} in the prepared form. Nothing was sent.`,
                  createdAt: at,
                  updatedAt: at,
                },
              },
            });
            this.ports.publishWorkspaceUpdate();
          },
          conversationId,
          turnId: live.turn.id,
          signal: session.signal,
          openUrl: options?.openUrl ?? null,
        });
        try {
          session.assertCurrent();
        } catch (error) {
          await lease.release("The turn stopped");
          throw error;
        }
        live.lease = lease;
        live.focusedApplicationResultId = lease.applicationResultId;
        await this.repository.upsertLease({
          id: lease.leaseId,
          conversationId,
          turnId: live.turn.id,
          tabId: lease.tabId,
          generation: live.generation,
          documentUrl: lease.currentUrl().slice(0, 2000),
          childTabIds: [],
          status: "active",
          revokedReason: null,
          createdAt: this.now(),
        });
        lease.revoked.addEventListener(
          "abort",
          () => {
            // Only the person's own click or key counts as taking it back.
            if (
              /took this tab back/iu.test(String(lease.revoked.reason ?? ""))
            ) {
              this.recordTabTakenBack(
                conversationId,
                lease.tabId,
                live.sourceMessage?.id ?? null,
              );
            }
            void this.repository.upsertLease({
              id: lease.leaseId,
              conversationId,
              turnId: live.turn.id,
              tabId: lease.tabId,
              generation: live.generation,
              documentUrl: lease.currentUrl().slice(0, 2000),
              childTabIds: lease.childTabIds().slice(0, 8),
              status: "revoked",
              revokedReason: String(lease.revoked.reason ?? "revoked").slice(
                0,
                400,
              ),
              createdAt: this.now(),
            });
          },
          { once: true },
        );
        return lease;
      },
    };
    return session;
  }

  /** Hands the tab back at the end of a turn and records that it was. */
  private async releaseLease(live: LiveTurn, reason: string): Promise<void> {
    const lease = live.lease;
    live.lease = null;
    if (!lease) return;
    await lease.release(reason).catch(() => undefined);
    if (lease.revoked.aborted) return;
    const record = (
      await this.repository.listLeases({
        conversationId: live.turn.conversationId,
        status: "active",
      })
    ).find((entry) => entry.id === lease.leaseId);
    if (record) {
      await this.repository
        .upsertLease({ ...record, status: "released" })
        .catch(() => undefined);
    }
  }

  private async savePlan(plan: AssistantTaskPlan): Promise<void> {
    await this.repository.upsertPlan(plan);
    await this.emit(plan.conversationId, null, { type: "plan_updated", plan });
  }

  // ---------------------------------------------------------------------------
  // Background runs: continue the conversation when they end
  // ---------------------------------------------------------------------------

  private async watch(input: {
    conversationId: string;
    run: AssistantRunRef;
    note: string;
    sourceMessageId: string | null;
    turnId: string;
    resumed?: boolean;
  }): Promise<void> {
    const key = runWatchKey(input.conversationId, input.run);
    const existing = this.watches.get(key);
    if (
      existing &&
      (input.run.kind === "apply_batch" || input.run.kind === "apply_run")
    ) {
      // Answering Needs you follows the original application, even when its
      // tool names the watch differently. Keep its operation and source.
      existing.run = {
        ...existing.run,
        jobIds: [...new Set([...existing.run.jobIds, ...input.run.jobIds])],
      };
      if (input.resumed) {
        existing.resumedAt = Date.now();
        existing.seenWorking = false;
      }
      return;
    }
    const operationId = this.createId("assistant_run_watch");
    await this.repository.upsertOperation({
      id: operationId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      toolName: "watch_run",
      argumentsHash: hashArguments(`${input.run.kind}:${input.run.id}`),
      status: "started",
      resultSummary: input.note.slice(0, 2_000),
      receiptId: input.sourceMessageId,
      run: { kind: input.run.kind, id: input.run.id },
      startedAt: this.now(),
      endedAt: null,
    });
    this.watches.set(key, {
      conversationId: input.conversationId,
      run: input.run,
      note: input.note,
      operationId,
      sourceMessageId: input.sourceMessageId,
      ...(input.resumed ? { resumedAt: Date.now(), seenWorking: false } : {}),
    });
    this.ensureWatchTimer();
  }

  private ensureWatchTimer(): void {
    if (this.watchTimer || this.closed) return;
    this.watchTimer = setInterval(() => {
      void this.checkWatches();
    }, this.options.watchIntervalMs ?? 4_000);
  }

  /** Uses the existing typed activity event; no model turn is fabricated. */
  private resumeBatchActivity(
    conversationId: string,
  ): AssistantActivity | null {
    const batches = [...this.watches.values()]
      .filter(
        (watch) =>
          watch.conversationId === conversationId &&
          watch.run.kind === "resume_generation",
      )
      .flatMap((watch) => {
        const batch = readBackgroundBatch(watch.run.id);
        return batch && !batch.done ? [batch] : [];
      });
    if (batches.length === 0) return null;
    const total = batches.reduce(
      (count, batch) => count + batch.jobIds.length,
      0,
    );
    const settled = batches.reduce(
      (count, batch) =>
        count +
        batch.completedJobIds.length +
        batch.failures.length +
        batch.skipped.length,
      0,
    );
    const active = batches.reduce(
      (count, batch) => count + batch.activeJobIds.length,
      0,
    );
    const failed = batches.reduce(
      (count, batch) => count + batch.failures.length,
      0,
    );
    const minutesLeft = estimateResumeBatchMinutesLeft(
      batches.flatMap((batch) => batch.durationsMs),
      total - settled,
    );
    return {
      label: batches.every((batch) => batch.cancelled)
        ? `Finishing ${active} active resume${active === 1 ? "" : "s"}; queued jobs stopped`
        : `Writing resumes: ${settled} of ${total} finished${failed ? `; ${failed} failed` : ""}${minutesLeft === null ? "" : ` · about ${minutesLeft} min left`}`,
      toolName: "generate_resumes",
      startedAt: batches.map((batch) => batch.startedAt).sort()[0]!,
    };
  }

  private async publishResumeBatchActivity(
    conversationId: string,
    force = false,
  ): Promise<void> {
    if (this.live.has(conversationId) || this.closed) return;
    const activity = this.resumeBatchActivity(conversationId);
    const label = activity?.label ?? null;
    if (!force && this.backgroundActivityLabels.get(conversationId) === label)
      return;
    this.backgroundActivityLabels.set(conversationId, label);
    await this.emit(conversationId, null, { type: "activity", activity });
  }

  /** Called by the host whenever the workspace changed. */
  notifyWorkspaceChanged(): void {
    if (this.linkedQuestions.size > 0 && !this.questionSyncPending) {
      this.questionSyncPending = true;
      setTimeout(() => {
        this.questionSyncPending = false;
        void this.closeQuestionsAnsweredElsewhere();
      }, 300);
    }
    if (
      this.resumeNoticeCheckDue &&
      !this.resumeNoticeCheckPending &&
      Date.now() - this.resumeNoticeCheckedAt >= 10_000
    ) {
      this.resumeNoticeCheckPending = true;
      setTimeout(() => {
        this.resumeNoticeCheckedAt = Date.now();
        void this.refreshFinishedResumeBatchNotices()
          .catch((error: unknown) =>
            this.log("Could not update a resume batch notice", error),
          )
          .finally(() => {
            this.resumeNoticeCheckPending = false;
          });
      }, 300);
    }
    if (this.watches.size === 0 || this.watchCheckPending) return;
    this.watchCheckPending = true;
    setTimeout(
      () => {
        this.watchCheckPending = false;
        void this.checkWatches();
      },
      Math.max(750, this.watchCheckRestUntil - Date.now()),
    );
  }

  /** A queue continued in Shortlisted closes the assistant's restart notice too. */
  async refreshFinishedResumeBatchNotices(): Promise<void> {
    const snapshot = await this.readWorkspaceSnapshot();
    const checkpoints =
      snapshot.intelligence.resumeBatchCheckpoints ??
      (snapshot.intelligence.resumeBatchCheckpoint
        ? [snapshot.intelligence.resumeBatchCheckpoint]
        : []);
    const completedIds = new Set(
      checkpoints
        .filter((batch) => batch.done)
        .flatMap((batch) => [batch.id, ...(batch.resumedBatchIds ?? [])]),
    );
    let unresolved = false;
    for (const conversation of await this.repository.listConversations()) {
      const interrupted = (
        await this.repository.listOperations(conversation.id, { runOnly: true })
      ).filter(
        (operation) =>
          operation.run?.kind === "resume_generation" &&
          operation.resultSummary ===
            "The app closed while writing resumes. Saved drafts are kept; queued jobs were not restarted.",
      );
      if (interrupted.length === 0) continue;
      if (
        interrupted.some((operation) => !completedIds.has(operation.run!.id))
      ) {
        unresolved = true;
        continue;
      }
      const page = await this.repository.listMessages(conversation.id, {
        limit: 100,
      });
      for (const message of page.messages) {
        let changed = false;
        const parts = message.parts.map((part) => {
          if (
            part.type !== "notice" ||
            part.kind !== "interrupted" ||
            part.text !==
              "The app closed while writing resumes. Saved drafts are kept; ask again to write the remaining resumes."
          )
            return part;
          changed = true;
          return {
            ...part,
            kind: "continued" as const,
            text: "Resume batch finished. Review the results in Shortlisted.",
          };
        });
        if (!changed) continue;
        const updated = { ...message, parts, updatedAt: this.now() };
        await this.repository.upsertMessage(updated);
        await this.emit(conversation.id, null, {
          type: "message_updated",
          message: updated,
        });
      }
    }
    this.resumeNoticeCheckDue = unresolved;
  }

  /**
   * A question the chat asked about a Needs you step closes when that step
   * is settled anywhere else (the Needs you screen, the page itself), so
   * the chat never shows as open what the record says is done. The model is
   * told on its next turn.
   */
  async closeQuestionsAnsweredElsewhere(): Promise<void> {
    if (this.linkedQuestions.size === 0) return;
    let snapshot;
    try {
      snapshot = await this.readWorkspaceSnapshot();
    } catch {
      return;
    }
    const states = new Map(
      snapshot.userActionRequests.map((request) => [request.id, request]),
    );
    for (const [key, link] of [...this.linkedQuestions]) {
      const request = states.get(link.requestId);
      const settled =
        !request ||
        ["resolved", "skipped", "cancelled", "expired", "superseded"].includes(
          request.state,
        );
      if (!settled) continue;
      this.linkedQuestions.delete(key);
      const how =
        request?.state === "resolved"
          ? "Answered on the Needs you screen."
          : request
            ? `The Needs you step was ${request.state}.`
            : "The Needs you step is no longer waiting.";
      const page = await this.repository.listMessages(link.conversationId, {
        limit: 60,
      });
      for (const message of page.messages) {
        const index = message.parts.findIndex(
          (part) =>
            part.type === "question" &&
            part.questionId === link.questionId &&
            part.status === "open",
        );
        if (index < 0) continue;
        const part = message.parts[index]!;
        if (part.type !== "question") continue;
        const parts = [...message.parts];
        parts[index] = { ...part, status: "answered", answer: how };
        const updated = { ...message, parts, updatedAt: this.now() };
        await this.repository.upsertMessage(updated);
        await this.emit(link.conversationId, null, {
          type: "message_updated",
          message: updated,
        });
        const notes = this.answeredElsewhere.get(link.conversationId) ?? [];
        notes.push(
          `Your question "${part.prompt.slice(0, 160)}" is closed: ${how} Check the application's current state before saying it waits on anything.`,
        );
        this.answeredElsewhere.set(link.conversationId, notes);
      }
    }
  }

  checkWatches(): Promise<void> {
    if (this.watchCheckInFlight) return this.watchCheckInFlight;
    const startedAt = Date.now();
    const check = this.checkWatchesOnce().finally(() => {
      this.watchCheckInFlight = null;
      // A watched search sends updates several times a second and each check
      // rebuilds the whole workspace; resting twice as long as the check
      // took keeps the watch from rebuilding it nonstop.
      const finishedAt = Date.now();
      this.watchCheckRestUntil =
        finishedAt + Math.min(8_000, 2 * (finishedAt - startedAt));
    });
    this.watchCheckInFlight = check;
    return check;
  }

  private async checkWatchesOnce(): Promise<void> {
    if (this.watches.size === 0) {
      if (this.watchTimer) clearInterval(this.watchTimer);
      this.watchTimer = null;
      return;
    }
    let snapshot;
    try {
      snapshot = await this.readWorkspaceSnapshot();
    } catch {
      return;
    }
    for (const [key, watch] of [...this.watches]) {
      if (this.watches.get(key) !== watch) continue;
      const status = readRunStatus(snapshot, watch.run);
      if (!status.done) {
        if (watch.resumedAt !== undefined || watch.reportedHandoff)
          watch.seenWorking = true;
        await this.publishResumeBatchActivity(watch.conversationId);
        continue;
      }
      if (
        watch.reportedHandoff &&
        !watch.seenWorking &&
        (status.pendingHandoffKey === watch.reportedHandoff.key ||
          (!status.pendingHandoffKey &&
            status.resultKey === watch.reportedHandoff.resultKey))
      ) {
        continue;
      }
      if (
        watch.resumedAt !== undefined &&
        !watch.seenWorking &&
        !watch.reportedHandoff &&
        Date.now() - watch.resumedAt < RESUME_GRACE_MS
      ) {
        continue;
      }
      if (status.pendingHandoffKey) {
        // Report the first handoff, then leave a durable watch on the same
        // application. Its page can resume outside the assistant's turn.
        watch.reportedHandoff = {
          key: status.pendingHandoffKey,
          resultKey: status.resultKey,
        };
        watch.seenWorking = false;
        delete watch.resumedAt;
        await this.continueAfterRun(watch, status.summary, status.details);
        continue;
      }
      this.watches.delete(key);
      const operation = await this.repository.getOperation(watch.operationId);
      const cancelled =
        watch.run.kind === "resume_generation" &&
        readBackgroundBatch(watch.run.id)?.cancelled;
      if (operation) {
        await this.repository.upsertOperation({
          ...operation,
          status: cancelled ? "cancelled" : "committed",
          resultSummary: status.summary.slice(0, 2_000),
          endedAt: this.now(),
        });
      }
      await this.publishResumeBatchActivity(watch.conversationId);
      if (cancelled) continue;
      await this.continueAfterRun(watch, status.summary, status.details);
    }
  }

  private async continueAfterRun(
    watch: RunWatch,
    summary: string,
    details: unknown,
  ): Promise<void> {
    const conversation = await this.repository.getConversation(
      watch.conversationId,
    );
    if (!conversation) return;
    const plans = await this.repository.listPlans({
      conversationId: watch.conversationId,
      status: "active",
    });
    // A live instruction that covers this run's jobs is still the person's
    // standing request: an authorized send carries on without a nudge.
    const runJobs = new Set(watch.run.jobIds);
    const covering = (
      await this.repository.listGrants(watch.conversationId)
    ).filter(
      (grant) =>
        (grant.status === "active" || grant.status === "narrowed") &&
        grant.jobIds.some((jobId) => runJobs.size === 0 || runJobs.has(jobId)),
    );
    const instructionLine =
      covering.length > 0
        ? `The person's recorded instructions still in force: ${covering
            .map(
              (grant) =>
                `${grant.action.replaceAll("_", " ")} for ${grant.jobIds.join(", ")} (grant ${grant.id})`,
            )
            .join(
              "; ",
            )}. Carry on with what they ask for the jobs above (for example, send what is prepared and covered by a send instruction) until it is done or a step needs the person; don't ask again for what they already asked.`
        : null;
    const note = [
      `${watch.note}: ${summary}`,
      details ? `Details: ${JSON.stringify(details).slice(0, 6_000)}` : null,
      instructionLine,
      plans.length > 0
        ? "Carry on with the checklist: do the next steps the person already asked for, then report."
        : instructionLine
          ? "Then tell the person what came of it in a few words, naming the site each application used."
          : "Tell the person what came of it in a few words.",
    ]
      .filter(Boolean)
      .join("\n");
    const message: AssistantMessage = {
      id: this.createId("assistant_message"),
      conversationId: watch.conversationId,
      clientMessageId: null,
      role: "user",
      origin: "host",
      parts: [{ type: "text", text: note.slice(0, 40_000) }],
      turnId: null,
      context: null,
      contextResultSetIds: [],
      migratedFrom: null,
      createdAt: this.monotonicNow(conversation.lastMessageAt),
      updatedAt: null,
    };
    // Kept for the record and for steering, not shown as the person's words.
    await this.repository.upsertMessage(message);
    await this.appendNotice(
      watch.conversationId,
      null,
      "continued",
      `${summary}`,
    );
    if (this.live.has(watch.conversationId)) {
      await this.repository.addPendingMessage(watch.conversationId, message.id);
      return;
    }
    // A continuation acts on the person's earlier instruction, so its grants
    // and context come from that message.
    const sourceMessage = watch.sourceMessageId
      ? await this.repository.getMessage(watch.sourceMessageId)
      : null;
    await this.startTurn(
      watch.conversationId,
      sourceMessage?.origin === "sidebar" ? sourceMessage : null,
      "continuation",
      note,
    );
  }

  // ---------------------------------------------------------------------------
  // Proposals and undo
  // ---------------------------------------------------------------------------

  resolveProposal(
    input: AssistantResolveProposalInput,
  ): Promise<AssistantMessage> {
    const key = `${input.conversationId}:${input.proposalId}`;
    const existing = this.resolvingProposals.get(key);
    if (existing) return existing;
    const work = this.resolveProposalOnce(input);
    this.resolvingProposals.set(key, work);
    void work
      .finally(() => this.resolvingProposals.delete(key))
      .catch(() => undefined);
    return work;
  }

  private async resolveProposalOnce(
    input: AssistantResolveProposalInput,
  ): Promise<AssistantMessage> {
    let afterConfirmation: (() => Promise<unknown>) | null = null;
    const message = await this.repository.getMessage(input.messageId);
    if (!message || message.conversationId !== input.conversationId) {
      throw new Error("That message is gone.");
    }
    const index = message.parts.findIndex(
      (part) =>
        part.type === "proposal" && part.proposalId === input.proposalId,
    );
    const part = message.parts[index];
    if (!part || part.type !== "proposal")
      throw new Error("That proposal is gone.");
    if (part.status !== "pending") return message;
    const extraParts: AssistantMessagePart[] = [];
    if (input.action === "reject") {
      if (part.source.store === "profile_copilot") {
        for (const groupId of part.source.patchGroupIds) {
          await this.service.rejectProfileCopilotPatchGroup(groupId);
        }
      } else if (
        part.source.store === "resume_assistant" &&
        part.targetId &&
        part.source.legacyMessageId
      ) {
        await this.service.resolveResumeAssistantProposal(
          part.targetId,
          part.source.legacyMessageId,
          "reject",
          [],
        );
      } else {
        const proposal = await this.repository.getProposal(part.proposalId);
        if (proposal) {
          await this.repository.upsertProposal({
            ...proposal,
            status: "rejected",
            resolvedAt: this.now(),
          });
        }
      }
    } else if (part.source.store === "profile_copilot") {
      for (const groupId of part.source.patchGroupIds) {
        await this.service.applyProfileCopilotPatchGroup(groupId);
      }
    } else if (
      part.source.store === "resume_assistant" &&
      part.targetId &&
      part.source.legacyMessageId
    ) {
      await this.service.resolveResumeAssistantProposal(
        part.targetId,
        part.source.legacyMessageId,
        "accept",
        input.itemIds ?? part.items.map((item) => item.id),
      );
    } else {
      const proposal = await this.repository.getProposal(part.proposalId);
      if (!proposal) throw new Error("That proposal is gone.");
      const chosen = proposal.items.filter(
        (item) => !input.itemIds?.length || input.itemIds.includes(item.id),
      );
      const session = this.detachedSession(input.conversationId, message.id);
      if (proposal.kind === "job_finder_action") {
        if (proposal.status !== "pending") return message;
        for (const item of chosen) {
          const work = () =>
            executeRegisteredAssistantAction(
              item.payload,
              {
                service: this.service,
                ports: this.ports,
                session,
              },
              true,
            );
          const payload = item.payload as { actionId?: string };
          if (
            payload.actionId === "reset-workspace" ||
            payload.actionId === "confirm-personal-workspace-restore"
          ) {
            afterConfirmation = work;
          } else {
            const result = await work();
            if (result.status === "refused") throw new Error(result.summary);
          }
        }
      } else if (proposal.kind === "profile_operations") {
        const result = await this.service.applyAssistantProfileOperations({
          operations: chosen.map(
            (item) => item.payload as ProfileCopilotPatchOperation,
          ),
          summary: proposal.summary,
          messageId: message.id,
        });
        const entries = result.changes.flatMap((change) =>
          change.entries.map((entry) => ({
            ...entry,
            path: [change.target, ...entry.path],
          })),
        );
        if (entries.length > 0) {
          const recorded = await session.recordChange({
            target: result.changes[0]!.target,
            targetId: null,
            summary: proposal.summary,
            entries,
          });
          extraParts.push(recorded.part);
        }
      } else {
        const result = await this.service.applyAssistantResumePatches({
          jobId: proposal.targetId ?? "",
          patches: chosen.map((item) => {
            const patch = item.payload as Partial<ResumeDraftPatch>;
            return {
              operation: patch.operation!,
              targetSectionId: patch.targetSectionId!,
              targetEntryId: patch.targetEntryId ?? null,
              anchorEntryId: patch.anchorEntryId ?? null,
              targetBulletId: patch.targetBulletId ?? null,
              anchorBulletId: patch.anchorBulletId ?? null,
              position: patch.position ?? null,
              newText: patch.newText ?? null,
              newIncluded: patch.newIncluded ?? null,
              newLocked: patch.newLocked ?? null,
              newBullets: patch.newBullets ?? null,
              conflictReason: null,
            };
          }),
          expectedDraftUpdatedAt: null,
          summary: proposal.summary,
        });
        for (const change of result.changes) {
          const recorded = await session.recordChange({
            target: change.target,
            targetId: change.targetId,
            summary: proposal.summary,
            entries: change.entries,
          });
          extraParts.push(recorded.part);
        }
      }
      await this.repository.upsertProposal({
        ...proposal,
        status: "applied",
        resolvedAt: this.now(),
      });
    }
    const parts = [...message.parts];
    parts[index] = {
      ...part,
      status: input.action === "accept" ? "applied" : "rejected",
    };
    const updated: AssistantMessage = {
      ...message,
      parts: [...parts, ...extraParts].slice(0, 60),
      updatedAt: this.now(),
    };
    await this.repository.upsertMessage(updated);
    await this.emit(input.conversationId, null, {
      type: "message_updated",
      message: updated,
    });
    this.ports.publishWorkspaceUpdate();
    // Reset and restore replace this conversation; finish its confirmation first.
    if (afterConfirmation) {
      try {
        const result = (await afterConfirmation()) as {
          status?: string;
          summary?: string;
        };
        if (result.status === "refused") throw new Error(result.summary);
      } catch (error) {
        // A failed replacement keeps the original conversation and its retry card.
        if (await this.repository.getMessage(message.id)) {
          const proposal = await this.repository.getProposal(part.proposalId);
          if (proposal)
            await this.repository.upsertProposal({
              ...proposal,
              status: "pending",
              resolvedAt: null,
            });
          await this.repository.upsertMessage(message);
          await this.emit(input.conversationId, null, {
            type: "message_updated",
            message,
          });
        }
        throw error;
      }
    }
    return updated;
  }

  async undoChange(
    conversationId: string,
    receiptId: string,
  ): Promise<AssistantUndoChangeResult> {
    const session = this.detachedSession(conversationId, null);
    const result = await undoReceipt(
      { service: this.service, session, ports: this.ports },
      receiptId,
    );
    // The model did not see the card press; tell it, so later turns do not
    // explain the change away or build on the undone text.
    await this.repository.appendTranscript(conversationId, "person_undo", [
      {
        role: "user",
        content: `[Job Finder, not the person] The person pressed Undo on the change "${result.receipt.summary}". Result: ${result.message}`,
      },
    ]);
    return { receipt: result.receipt, message: result.message };
  }

  /**
   * A message typed while an archived chat was open starts a new chat; the
   * model is told what that archive still holds, so it does not deny it.
   */
  private async noteArchiveForNewChat(
    conversationId: string,
    archive: AssistantConversation,
  ): Promise<void> {
    const { messages } = await this.repository.listMessages(archive.id, {
      limit: 200,
    });
    const pending = messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "proposal" && part.status === "pending"
          ? [part.summary]
          : [],
      ),
    );
    await this.repository.appendTranscript(conversationId, "archive_note", [
      {
        role: "user",
        content: `[Job Finder, not the person] The person wrote the next message while looking at the archived chat "${archive.title}". ${
          pending.length > 0
            ? `That archive still has ${pending.length} suggestion(s) waiting for their Apply or Dismiss: ${pending
                .slice(0, 8)
                .map((summary) => `"${summary}"`)
                .join(", ")}. They act on them in the archive.`
            : "It has no suggestions waiting."
        }`,
      },
    ]);
  }

  /** Tabs taken back, per conversation, with the message that leased them. */
  private readonly takenBackTabs = new Map<
    string,
    { tabId: string; sourceMessageId: string | null }[]
  >();

  private recordTabTakenBack(
    conversationId: string,
    tabId: string,
    sourceMessageId: string | null,
  ): void {
    const list = this.takenBackTabs.get(conversationId) ?? [];
    list.push({ tabId, sourceMessageId });
    this.takenBackTabs.set(conversationId, list.slice(-20));
  }

  private isTabTakenBack(
    conversationId: string,
    tabId: string | null,
    sourceMessageId: string | undefined,
  ): boolean {
    return (this.takenBackTabs.get(conversationId) ?? []).some(
      (entry) =>
        (tabId === null || entry.tabId === tabId) &&
        entry.sourceMessageId === (sourceMessageId ?? null),
    );
  }

  private async syncChangeCard(receipt: AssistantChangeReceipt): Promise<void> {
    if (!receipt.messageId) return;
    const message = await this.repository.getMessage(receipt.messageId);
    if (!message) return;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (
        part.type === "change" &&
        part.receiptId === receipt.id &&
        part.status !== receipt.status
      ) {
        changed = true;
        return { ...part, status: receipt.status };
      }
      return part;
    });
    if (!changed) return;
    const updated: AssistantMessage = {
      ...message,
      parts,
      updatedAt: this.now(),
    };
    await this.repository.upsertMessage(updated);
    await this.emit(message.conversationId, null, {
      type: "message_updated",
      message: updated,
    });
  }

  /** A session for actions the person takes from a message (Undo, Accept). */
  private detachedSession(
    conversationId: string,
    messageId: string | null,
  ): AssistantTurnSession {
    const controller = new AbortController();
    const fake: LiveTurn = {
      turn: {
        id: "detached",
        conversationId,
        trigger: "message",
        sourceMessageId: null,
        status: "running",
        generation: 0,
        startedAt: this.now(),
        endedAt: null,
        model: null,
        usage: null,
        error: null,
        planId: null,
      },
      controller,
      generation: 0,
      replyMessageId: messageId ?? "detached",
      draftText: "",
      attempt: 0,
      activity: null,
      lastSignalAt: Date.now(),
      stallTimer: null,
      stallShown: false,
      modelCallInFlight: false,
      lease: null,
      sourceMessage: null,
      outputs: { parts: [], endTurn: null, activity: [], touched: [] },
      lastPersistedDraftAt: 0,
      runsStarted: [],
    };
    return this.createTurnSession(fake, {
      name: "detached",
      scripted: true,
      capabilities: {
        contextWindowTokens: 1,
        maxOutputTokens: 1,
        images: false,
      },
      createModel: () => {
        throw new Error("No model in a detached session.");
      },
      summarize: null,
    });
  }

  // ---------------------------------------------------------------------------
  // Mentions, search
  // ---------------------------------------------------------------------------

  async searchMentions(query: string): Promise<AssistantMentionCandidate[]> {
    const snapshot = await this.readWorkspaceSnapshot();
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hit = (text: string) =>
      words.every((word) => text.toLowerCase().includes(word));
    const candidates: AssistantMentionCandidate[] = [];
    const seen = new Set<string>();
    const caveatsFor = createJobCaveats(snapshot);
    for (const job of [...snapshot.discoveryJobs, ...snapshot.companyJobs]) {
      if (seen.has(job.id) || !hit(`${job.title} ${job.company}`)) continue;
      // Excluded employers stay out of suggestions unless already in play.
      if (job.status === "discovered" && caveatsFor(job).excludedEmployer)
        continue;
      seen.add(job.id);
      candidates.push({
        kind: "job",
        id: job.id,
        label: `${job.title} at ${job.company}`.slice(0, 300),
        detail: job.location.slice(0, 300),
      });
    }
    for (const record of snapshot.applicationRecords) {
      if (!hit(`${record.title} ${record.company} application`)) continue;
      candidates.push({
        kind: "application",
        id: record.id,
        label: `Application: ${record.title} at ${record.company}`.slice(
          0,
          300,
        ),
        detail: record.lastActionLabel.slice(0, 300),
      });
    }
    for (const draft of snapshot.resumeDrafts) {
      const job = snapshot.reviewQueue.find(
        (entry) => entry.jobId === draft.jobId,
      );
      if (!job || !hit(`${job.title} ${job.company} resume`)) continue;
      candidates.push({
        kind: "resume",
        id: draft.jobId,
        label: `Resume for ${job.title} at ${job.company}`.slice(0, 300),
        detail: draft.status,
      });
    }
    try {
      for (const document of await this.ports.listDocuments()) {
        if (!hit(document.originalName)) continue;
        candidates.push({
          kind: "file",
          id: document.id,
          label: document.originalName.slice(0, 300),
          detail: document.kind,
        });
      }
    } catch {
      // Files are optional in mentions.
    }
    return candidates.slice(0, 30);
  }

  private async searchConversation(
    conversationId: string,
    query: string,
    limit: number,
  ): Promise<
    { messageId: string; createdAt: string; role: string; excerpt: string }[]
  > {
    const page = await this.repository.listMessages(conversationId, {
      limit: 400,
    });
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return page.messages
      .filter(
        (message) => message.origin !== "host" || message.role === "assistant",
      )
      .map((message) => ({ message, text: textOf(message) }))
      .filter(
        ({ text }) =>
          text && words.every((word) => text.toLowerCase().includes(word)),
      )
      .slice(-limit)
      .map(({ message, text }) => ({
        messageId: message.id,
        createdAt: message.createdAt,
        role: message.role,
        excerpt: text.slice(0, 800),
      }));
  }

  // ---------------------------------------------------------------------------
  // Recovery, migration, shutdown
  // ---------------------------------------------------------------------------

  /**
   * After a restart: turns that were running are marked interrupted, runs a
   * conversation waited on are watched again, and messages accepted but not
   * yet read start their turn. Nothing uncertain is replayed.
   */
  async recover(): Promise<void> {
    let applicationSnapshot:
      | Awaited<ReturnType<JobFinderWorkspaceService["getWorkspaceSnapshot"]>>
      | undefined;
    for (const turn of await this.repository.listTurnsByStatus([
      "running",
      "queued",
    ])) {
      if (this.live.has(turn.conversationId)) continue;
      await this.repository.upsertTurn({
        ...turn,
        status: "interrupted",
        endedAt: this.now(),
        error: "The app closed while this was running.",
      });
      await this.appendNotice(
        turn.conversationId,
        turn.id,
        "interrupted",
        "The app closed while I was working on this. Anything already saved is kept; ask again to carry on.",
      );
    }
    for (const conversation of await this.repository.listConversations()) {
      const operations = await this.repository.listOperations(conversation.id, {
        runOnly: true,
      });
      for (const operation of [...operations].sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt),
      )) {
        if (operation.status !== "started" || !operation.run) continue;
        if (operation.run.kind === "resume_generation") {
          cancelBackgroundBatch(operation.run.id);
          await this.repository.upsertOperation({
            ...operation,
            status: "cancelled",
            resultSummary:
              "The app closed while writing resumes. Saved drafts are kept; queued jobs were not restarted.",
            endedAt: this.now(),
          });
          await this.appendNotice(
            conversation.id,
            null,
            "interrupted",
            "The app closed while writing resumes. Saved drafts are kept; ask again to write the remaining resumes.",
          );
          this.resumeNoticeCheckDue = true;
          continue;
        }
        const run = { ...operation.run, jobIds: [] };
        const key = runWatchKey(conversation.id, run);
        if (
          this.watches.has(key) &&
          (run.kind === "apply_batch" || run.kind === "apply_run")
        ) {
          await this.repository.upsertOperation({
            ...operation,
            status: "committed",
            resultSummary:
              "The original watch already follows this application in this conversation.",
            endedAt: this.now(),
          });
          continue;
        }
        const applicationStatus =
          operation.run.kind === "apply_batch" ||
          operation.run.kind === "apply_run"
            ? readRunStatus(
                (applicationSnapshot ??= await this.readWorkspaceSnapshot()),
                run,
              )
            : null;
        this.watches.set(key, {
          conversationId: conversation.id,
          run,
          note: operation.resultSummary ?? "A background run",
          operationId: operation.id,
          sourceMessageId: operation.receiptId,
          ...(applicationStatus?.pendingHandoffKey
            ? {
                reportedHandoff: {
                  key: applicationStatus.pendingHandoffKey,
                  resultKey: applicationStatus.resultKey,
                },
                seenWorking: false,
              }
            : {}),
        });
      }
      const pending = await this.repository.listPendingMessageIds(
        conversation.id,
      );
      if (pending.length > 0 && !this.live.has(conversation.id)) {
        const first = await this.repository.getMessage(pending[0]!);
        await this.repository.removePendingMessages(conversation.id, [
          pending[0]!,
        ]);
        if (first?.origin === "sidebar")
          await this.startTurn(conversation.id, first, "recovery");
      }
    }
    if (this.watches.size > 0) this.ensureWatchTimer();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const watch of this.watches.values()) {
      if (watch.run.kind === "resume_generation")
        cancelBackgroundBatch(watch.run.id);
    }
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    for (const [conversationId, live] of this.live) {
      live.controller.abort(
        new DOMException("The app is closing.", "AbortError"),
      );
      this.stopStallWatch(live);
      await this.releaseLease(live, "app closing");
      await this.repository.upsertTurn({
        ...live.turn,
        status: "interrupted",
        endedAt: this.now(),
        error: "The app closed while this was running.",
      });
      this.live.delete(conversationId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async freezeContextLists(
    conversationId: string,
    context: AssistantMessage["context"],
  ): Promise<string[]> {
    const list = context?.list;
    if (!list) return [];
    const kind =
      list.listKind === "applications"
        ? "applications"
        : list.listKind === "companies"
          ? "companies"
          : "jobs";
    const make = async (
      source: AssistantResultSet["source"],
      label: string,
      itemIds: readonly string[],
    ) => {
      if (itemIds.length === 0) return null;
      const resultSet: AssistantResultSet = {
        id: this.createId("result_set"),
        conversationId,
        kind,
        label,
        itemIds: [...itemIds].slice(0, 3000),
        source,
        coverage: list.filterSummary,
        pageItems: [],
        pageUrl: null,
        createdAt: this.now(),
      };
      await this.repository.upsertResultSet(resultSet);
      return resultSet.id;
    };
    const ids = await Promise.all([
      make("screen_selection", "Selected on screen", list.selectedIds),
      make("screen_displayed", "Shown on screen", list.displayedIds),
      make("screen_filter", "All in the current filter", list.filteredIds),
    ]);
    return ids.filter((id): id is string => id !== null);
  }

  /**
   * The lists this conversation showed, in their fixed order, so "the second
   * one" keeps pointing at the same record after older messages are
   * summarized (plan: Long thread).
   */
  private async describeOrderedLists(
    conversationId: string,
  ): Promise<string | null> {
    const sets = (await this.repository.listResultSets(conversationId))
      .filter(
        (entry) =>
          entry.source === "tool_query" ||
          entry.source === "page_collection" ||
          entry.source === "screen_selection",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 6);
    if (sets.length === 0) return null;
    let snapshot: JobFinderWorkspaceSnapshot | null = null;
    try {
      snapshot = await this.readWorkspaceSnapshot();
    } catch {
      snapshot = null;
    }
    const titleOf = (id: string): string | null => {
      if (!snapshot) return null;
      const job = allJobs(snapshot).find((entry) => entry.id === id);
      if (job) return `${job.title} at ${job.company}`;
      const application = snapshot.applicationRecords.find(
        (entry) => entry.id === id,
      );
      return application
        ? `${application.title} at ${application.company}`
        : null;
    };
    const lines = [
      "Lists shown earlier, newest first. Their order is fixed: position n always means the same record.",
    ];
    for (const set of sets) {
      lines.push(`${set.label} (result set ${set.id}, ${set.createdAt}):`);
      set.itemIds.slice(0, 12).forEach((id, index) => {
        const title = titleOf(id);
        lines.push(`  ${index + 1}. ${title ? `${title} ` : ""}[${id}]`);
      });
      if (set.itemIds.length > 12) {
        lines.push(`  … ${set.itemIds.length - 12} more (read_result).`);
      }
    }
    return lines.join("\n").slice(0, 8_000);
  }

  private async resultSetsFor(
    message: AssistantMessage,
  ): Promise<AssistantResultSet[]> {
    const sets: AssistantResultSet[] = [];
    for (const id of message.contextResultSetIds) {
      const resultSet = await this.repository.getResultSet(id);
      if (resultSet) sets.push(resultSet);
    }
    return sets;
  }

  private async touchConversation(
    conversation: AssistantConversation,
    message: AssistantMessage,
    titleSource: string | null,
  ): Promise<void> {
    const current =
      (await this.repository.getConversation(conversation.id)) ?? conversation;
    const next: AssistantConversation = {
      ...current,
      title:
        current.title === "New chat" && titleSource
          ? titleFrom(titleSource)
          : current.title,
      updatedAt: this.now(),
      lastMessageAt: message.createdAt,
      messageCount: await this.repository.countMessages(conversation.id),
    };
    await this.repository.upsertConversation(next);
    await this.emit(conversation.id, null, {
      type: "conversation_updated",
      conversation: next,
    });
  }

  private monotonicNow(previous: string | null): string {
    const now = Date.parse(this.now());
    const floor = previous ? Date.parse(previous) + 1 : 0;
    return new Date(Math.max(now, floor)).toISOString();
  }

  private handleStoreFor(conversationId: string): AssistantHandleStore {
    let store = this.handles.get(conversationId);
    if (!store) {
      store = createHandleStore(conversationId.slice(-8));
      this.handles.set(conversationId, store);
    }
    return store;
  }

  private calibratorFor(conversationId: string): TokenCalibrator {
    let calibrator = this.calibrators.get(conversationId);
    if (!calibrator) {
      calibrator = createTokenCalibrator();
      this.calibrators.set(conversationId, calibrator);
    }
    return calibrator;
  }

  private async emit(
    conversationId: string,
    turnId: string | null,
    payload: AssistantEventPayload,
    persist = true,
  ): Promise<void> {
    if (persist) {
      const event = await this.repository.appendEvent({
        conversationId,
        turnId,
        payload,
        at: this.now(),
      });
      this.options.publish(event);
      return;
    }
    // Unpersisted live text: sequence 0 tells the renderer not to advance
    // its cursor on it.
    this.options.publish({
      conversationId,
      sequence: 0,
      turnId,
      at: this.now(),
      payload,
    });
  }

  private log(message: string, detail?: unknown): void {
    (
      this.options.log ??
      ((text, extra) => console.warn(`[assistant] ${text}`, extra ?? ""))
    )(message, detail);
  }
}
