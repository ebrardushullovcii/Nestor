import type {
  AssistantNavigationDisplay,
  AssistantChangeEntry,
  AssistantChangeReceipt,
  AssistantChangeTarget,
  AssistantContextReference,
  AssistantEntityRef,
  AssistantInstructionGrant,
  AssistantMessage,
  AssistantMessagePart,
  AssistantProposal,
  AssistantResultSet,
  AssistantRunRef,
  AssistantTaskPlan,
} from "@nestor/contracts";
import type { ConversationTool } from "@nestor/agent-runtime";
import { JobPostingSchema } from "@nestor/contracts";
import type { z, ZodTypeAny } from "zod";

import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";
import type { AssistantBrowserLease, AssistantHostPorts } from "./ports";

/**
 * How the assistant's tools are built (ADR 0037).
 *
 * Each tool has a host-owned label, a JSON schema the model sees, a zod
 * schema that validates what it sent, and an executor over the workspace
 * service and host ports. Results are short: a one-line summary, the real
 * status, affected ids and the next useful fact. Errors say which kind they
 * are (a stale revision, invalid input, missing information, a transient
 * failure, an uncertain external outcome) with enough state to recover.
 */

export const assistantToolGroupValues = [
  "workspace",
  "profile",
  "files",
  "resume",
  "jobs",
  "applications",
  "tracking",
  "settings",
  "browser",
] as const;
export type AssistantToolGroup = (typeof assistantToolGroupValues)[number];

export type AssistantToolErrorKind =
  | "stale_revision"
  | "invalid_input"
  | "missing_information"
  | "not_found"
  | "transient"
  | "uncertain_outcome"
  | "refused"
  | "conflict";

export class AssistantToolError extends Error {
  constructor(
    readonly kind: AssistantToolErrorKind,
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
    this.name = "AssistantToolError";
  }
}

export interface AssistantToolResult {
  /** A complete, verified action can use its receipt as the reply. */
  canFinish?: boolean;
  /** One plain line: what happened. */
  summary: string;
  /** Compact facts for the model (ids, revisions, changed fields). */
  data?: unknown;
  status?: "done" | "refused" | "failed";
  /** Parts attached to the reply the person sees (change summaries, rows). */
  parts?: AssistantMessagePart[];
  /** Ends the turn after this tool (a question for the person). */
  endTurn?: { reason: string };
}

export interface AssistantHandleStore {
  put(
    summary: string,
    items: readonly unknown[],
  ): {
    handle: string;
    total: number;
  };
  read(
    handle: string,
    cursor: number,
    limit: number,
  ): {
    summary: string;
    items: unknown[];
    total: number;
    next: number | null;
  } | null;
}

/** What one turn offers its tools. Implemented by the session host. */
export interface AssistantTurnSession {
  conversationId: string;
  turnId: string;
  /** The person's sidebar message this turn serves; null for continuations. */
  sourceMessage: AssistantMessage | null;
  /** Bound when the message was accepted; switching screens does not change it. */
  context: AssistantContextReference | null;
  signal: AbortSignal;
  /** Throws when the turn was stopped or superseded; call right before a commit. */
  assertCurrent(): void;
  now(): string;
  createId(prefix: string): string;
  handles: AssistantHandleStore;
  createResultSet(input: {
    kind: AssistantResultSet["kind"];
    label: string;
    itemIds: readonly string[];
    source: AssistantResultSet["source"];
    coverage?: string | null;
    pageItems?: readonly unknown[];
    pageUrl?: string | null;
  }): Promise<AssistantResultSet>;
  /** Replaces a result set's items (collection across pages grows one set). */
  saveResultSet(resultSet: AssistantResultSet): Promise<void>;
  /** The tab lent for this turn, leased on first use (ADR 0038). */
  browserLease(options?: {
    openUrl?: string | null;
    newTab?: boolean;
    tabId?: string;
    applicationResultId?: string;
  }): Promise<AssistantBrowserLease>;
  releaseBrowserLease?(): Promise<void>;
  getResultSet(id: string): Promise<AssistantResultSet | null>;
  listResultSets(): Promise<AssistantResultSet[]>;
  recordChange(input: {
    target: AssistantChangeTarget;
    targetId: string | null;
    summary: string;
    entries: readonly AssistantChangeEntry[];
    undoCommand?: AssistantChangeReceipt["undoCommand"];
  }): Promise<{ receipt: AssistantChangeReceipt; part: AssistantMessagePart }>;
  getReceipt(id: string): Promise<AssistantChangeReceipt | null>;
  listReceipts(): Promise<AssistantChangeReceipt[]>;
  saveReceipt(receipt: AssistantChangeReceipt): Promise<void>;
  createProposal(
    input: Omit<
      AssistantProposal,
      | "id"
      | "conversationId"
      | "messageId"
      | "status"
      | "createdAt"
      | "resolvedAt"
    >,
  ): Promise<{ proposal: AssistantProposal; part: AssistantMessagePart }>;
  grants: {
    list(): Promise<AssistantInstructionGrant[]>;
    save(grant: AssistantInstructionGrant): Promise<void>;
  };
  plans: {
    active(): Promise<AssistantTaskPlan | null>;
    save(plan: AssistantTaskPlan): Promise<void>;
  };
  /** Registers a background run whose end continues this conversation. */
  /**
   * Continues the conversation when the run ends. `resumed` is for a run that
   * paused and is carrying on again (a Needs you step was answered): its end
   * is taken only after it has been seen working again, or after a grace
   * period, so the paused state it is leaving does not count as the end.
   */
  watchRun(
    run: AssistantRunRef,
    note: string,
    options?: { resumed?: boolean },
  ): Promise<void>;
  askQuestion(
    prompt: string,
    options: readonly string[],
    needsYouRequestId?: string | null,
  ): Promise<string>;
  reportProgress(text: string): Promise<void>;
  reportGap(text: string): Promise<void>;
  searchConversation(
    query: string,
    limit: number,
  ): Promise<
    { messageId: string; createdAt: string; role: string; excerpt: string }[]
  >;
  /** True the first time this conversation reads the profile. */
  /** Checks conversation evidence before an assistant value is filed as the person's answer. */
  assertPersonAnswerAuthority?(input: {
    answers: readonly { question: string; answer: string }[];
    saveForFuture: boolean;
  }): Promise<void>;
  firstProfileRead(): Promise<boolean>;
  openInApp(route: string): Promise<AssistantNavigationDisplay | void> | void;
  /** The route can see images (screenshots are useful). */
  visionAvailable: boolean;
}

export interface AssistantToolContext {
  service: JobFinderWorkspaceService;
  ports: AssistantHostPorts;
  session: AssistantTurnSession;
}

/** Display reads borrow the service's view; canonical writes remain service-owned. */
export function readAssistantWorkspace(service: JobFinderWorkspaceService) {
  return service.getWorkspaceProjection?.() ?? service.getWorkspaceSnapshot();
}

export interface AssistantToolDefinition<
  TSchema extends ZodTypeAny = ZodTypeAny,
> {
  name: string;
  /** Earlier Assistant executors replaced by this screen command. */
  replaces?: readonly string[];
  group: AssistantToolGroup;
  description: string;
  /** JSON schema the model sees; the zod schema is the truth. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  input: TSchema;
  label(input: Record<string, unknown>): string;
  /** `external` reaches beyond the app (a site, an employer). */
  effect: "read" | "local_write" | "external";
  // Method syntax keeps definitions with different input schemas assignable
  // to one catalog list; the zod schema is what actually guards the input.
  execute(
    input: z.infer<TSchema>,
    context: AssistantToolContext,
  ): Promise<AssistantToolResult>;
}

export function defineTool<TSchema extends ZodTypeAny>(
  definition: AssistantToolDefinition<TSchema>,
): AssistantToolDefinition<TSchema> {
  return definition;
}

const receiptReplyTools = new Set([
  "edit_profile",
  "move_jobs",
  "shortlist_jobs",
  "remove_from_shortlist",
  "dismiss_jobs",
  "restore_jobs",
  "set_appearance",
]);
const modelDefinitionCache = new WeakMap<
  AssistantToolDefinition,
  ConversationTool["definition"]
>();

export function assistantModelToolDefinition(
  definition: AssistantToolDefinition,
): ConversationTool["definition"] {
  const cached = modelDefinitionCache.get(definition);
  if (cached) return cached;
  const result: ConversationTool["definition"] = {
    type: "function" as const,
    function: {
      name: definition.name,
      description: definition.description,
      get parameters() {
        return receiptReplyTools.has(definition.name) &&
          !("complete" in definition.parameters.properties)
          ? {
              ...definition.parameters,
              properties: {
                ...definition.parameters.properties,
                complete: {
                  type: "boolean",
                  description:
                    "True only when this single action completes the person's entire request. Its verified receipt becomes the reply. Leave false for advice, multiple steps or a requested explanation.",
                },
              },
            }
          : definition.parameters;
      },
    },
  };
  modelDefinitionCache.set(definition, result);
  return result;
}

/** JSON schema helpers kept short, since every token of schema is paid on every call. */
export const json = {
  object(
    properties: Record<string, unknown>,
    required: string[] = [],
  ): AssistantToolDefinition["parameters"] {
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
  },
  string(description?: string) {
    return { type: "string", ...(description ? { description } : {}) };
  },
  number(description?: string) {
    return { type: "number", ...(description ? { description } : {}) };
  },
  boolean(description?: string) {
    return { type: "boolean", ...(description ? { description } : {}) };
  },
  enumOf(values: readonly string[], description?: string) {
    return {
      type: "string",
      enum: [...values],
      ...(description ? { description } : {}),
    };
  },
  ids(description?: string) {
    return {
      type: "array",
      items: { type: "string" },
      ...(description ? { description } : {}),
    };
  },
  array(items: unknown, description?: string) {
    return { type: "array", items, ...(description ? { description } : {}) };
  },
  looseObject(description?: string) {
    return {
      type: "object",
      additionalProperties: true,
      ...(description ? { description } : {}),
    };
  },
};

/** Zod issues as short sentences the model can act on. */
export function describeZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

const RESULT_DATA_LIMIT_CHARS = 12_000;

function renderResult(result: AssistantToolResult): string {
  const lines = [result.summary];
  const changes = result.parts?.flatMap((part) =>
    part.type === "change"
      ? [
          {
            receiptId: part.receiptId,
            summary: part.summary,
            status: part.status,
          },
        ]
      : [],
  );
  if (changes?.length) lines.push(JSON.stringify({ changes }));
  if (result.data !== undefined) {
    let data = JSON.stringify(result.data);
    if (data.length > RESULT_DATA_LIMIT_CHARS) {
      data = `${data.slice(0, RESULT_DATA_LIMIT_CHARS)}… (cut; ask for a smaller page)`;
    }
    lines.push(data);
  }
  return lines.join("\n");
}

function renderError(error: AssistantToolError): string {
  const lines = [`Error (${error.kind}): ${error.message}`];
  if (error.current !== undefined) {
    const current = JSON.stringify(error.current);
    lines.push(
      `Current: ${current.length > 4_000 ? `${current.slice(0, 4_000)}…` : current}`,
    );
  }
  return lines.join("\n");
}

/** Everything a turn collects from its tools for the reply. */
export interface AssistantToolOutputs {
  parts: AssistantMessagePart[];
  endTurn: { reason: string } | null;
  activity: {
    toolName: string;
    label: string;
    outcome: "done" | "failed" | "cancelled" | "refused";
    detail: string | null;
    at: string;
  }[];
  touched: AssistantEntityRef[];
}

const PAGE_JOB_ITEM_ID = /^page_job_/u;

/**
 * A job read off a page (identified within its collected set) handed to
 * a tool that works on saved jobs is the person's own pick of that job. It is
 * saved (merged with the saved job when it is the same one) and its saved id
 * used, instead of the step failing as an unknown job until the model finds
 * save_page_jobs on its own.
 */
async function resolvePageJobReferences(
  toolName: string,
  record: Record<string, unknown>,
  context: AssistantToolContext,
): Promise<void> {
  if (toolName === "save_page_jobs" || toolName === "collect_page_jobs") {
    return;
  }
  const isPageItem = (value: unknown): value is string =>
    typeof value === "string" && PAGE_JOB_ITEM_ID.test(value);
  const jobIds: unknown[] = Array.isArray(record.jobIds) ? record.jobIds : [];
  if (!isPageItem(record.jobId) && !jobIds.some(isPageItem)) return;
  const pageSets = (await context.session.listResultSets()).filter(
    (set) => set.kind === "page_jobs",
  );
  const savedIdByItem = new Map<string, string>();
  const resolve = async (itemId: string): Promise<string> => {
    const known = savedIdByItem.get(itemId);
    if (known) return known;
    const matches = pageSets.filter((set) => set.itemIds.includes(itemId));
    // Older conversations may contain duplicate positional ids. Never guess
    // which collection an ambiguous reference meant.
    if (matches.length !== 1) return itemId;
    const set = matches[0]!;
    const posting = JobPostingSchema.safeParse(
      set.pageItems[set.itemIds.indexOf(itemId)],
    );
    if (!posting.success) return itemId;
    context.session.assertCurrent();
    const saved = await context.service.saveJobsFromPage({
      postings: [posting.data],
      pageUrl: set.pageUrl ?? "about:blank",
    });
    const savedId = saved.savedJobIds[0];
    if (!savedId) return itemId;
    // Only ids saved from a verified collected posting become grant targets.
    await context.session.createResultSet({
      kind: "jobs",
      label: "Saved from the page",
      itemIds: [savedId],
      source: "page_collection",
    });
    savedIdByItem.set(itemId, savedId);
    return savedId;
  };
  if (isPageItem(record.jobId)) record.jobId = await resolve(record.jobId);
  if (jobIds.some(isPageItem)) {
    record.jobIds = await Promise.all(
      jobIds.map((value) => (isPageItem(value) ? resolve(value) : value)),
    );
  }
  if (savedIdByItem.size > 0) context.ports.publishWorkspaceUpdate();
}

/**
 * Wraps a definition into a conversation tool: validation, error kinds, and
 * the parts it adds to the reply. The executor never sees raw JSON.
 */
export function toConversationTool(
  definition: AssistantToolDefinition,
  context: AssistantToolContext,
  outputs: AssistantToolOutputs,
): ConversationTool {
  return {
    definition: assistantModelToolDefinition(definition),
    failureKind: definition.group === "browser" ? "browser" : "tool",
    label: (args) => {
      try {
        return definition.label(args).slice(0, 200);
      } catch {
        return definition.name.replaceAll("_", " ");
      }
    },
    describeError: (error) =>
      error instanceof AssistantToolError
        ? renderError(error)
        : "That step could not be completed. Try a different approach, or say what remains.",
    async execute(rawArguments) {
      let parsedJson: unknown;
      try {
        parsedJson = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch {
        return {
          kind: "ok",
          status: "failed",
          content:
            "Error (invalid_input): the arguments were not valid JSON. Send them again as one JSON object.",
        };
      }
      const record =
        typeof parsedJson === "object" && parsedJson !== null
          ? { ...(parsedJson as Record<string, unknown>) }
          : {};
      const hasCompletionHint =
        receiptReplyTools.has(definition.name) &&
        !("complete" in definition.parameters.properties);
      const complete = hasCompletionHint && record.complete === true;
      if (hasCompletionHint) delete record.complete;
      try {
        await resolvePageJobReferences(definition.name, record, context);
      } catch {
        // An unsaved page job stays as it was; the tool reports it plainly.
      }
      const parsed = definition.input.safeParse(record);
      if (!parsed.success) {
        return {
          kind: "ok",
          status: "failed",
          content: `Error (invalid_input): ${describeZodIssues(parsed.error)}`,
        };
      }
      const at = context.session.now();
      const label = (() => {
        try {
          return definition.label(record);
        } catch {
          return definition.name;
        }
      })();
      try {
        const result = await definition.execute(parsed.data, context);
        if (result.parts) outputs.parts.push(...result.parts);
        if (result.endTurn) outputs.endTurn = result.endTurn;
        outputs.activity.push({
          toolName: definition.name,
          label,
          outcome:
            result.status === "refused"
              ? "refused"
              : result.status === "failed"
                ? "failed"
                : "done",
          detail: result.summary.slice(0, 400),
          at,
        });
        if (result.endTurn) {
          // A question for the person ends the turn; their answer starts the next.
          return {
            kind: "stop",
            reason: result.endTurn.reason,
            data: result.data,
          };
        }
        if (
          complete &&
          result.canFinish &&
          (!result.status || result.status === "done")
        ) {
          return {
            kind: "finish",
            finish: {
              reason: result.summary,
              output: renderResult(result),
              stuck: false,
              needsPerson: false,
              data: {},
            },
          };
        }
        return {
          kind: "ok",
          content: renderResult(result),
          progress: definition.effect !== "read",
          status: result.status ?? "done",
        };
      } catch (error) {
        if (context.session.signal.aborted) throw error;
        const toolError =
          error instanceof AssistantToolError
            ? error
            : new AssistantToolError(
                /stale|changed since|conflict/iu.test(
                  error instanceof Error ? error.message : "",
                )
                  ? "stale_revision"
                  : /not found|unknown/iu.test(
                        error instanceof Error ? error.message : "",
                      )
                    ? "not_found"
                    : "transient",
                error instanceof Error
                  ? error.message.slice(0, 600)
                  : "The step failed.",
              );
        outputs.activity.push({
          toolName: definition.name,
          label,
          outcome: toolError.kind === "refused" ? "refused" : "failed",
          detail: toolError.message.slice(0, 400),
          at,
        });
        return {
          kind: "ok",
          status: toolError.kind === "refused" ? "refused" : "failed",
          content: renderError(toolError),
        };
      }
    },
  };
}

/** Text from a raw argument, for labels shown before the input is validated. */
export function argText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
