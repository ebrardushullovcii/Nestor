import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { ResumeBatchCheckpointSchema } from "./resume";
import { RESUME_PIPELINE_CAPACITY } from "./resume-batch";

/**
 * The one Job Finder assistant (ADR 0037).
 *
 * Three records are kept apart: the conversation the person sees (never
 * edited by compaction), the task state (result sets, instructions, plans,
 * receipts, grants) and the model input, which is rebuilt for every call and
 * is not a contract at all.
 */

/** The longest message the person can send the assistant, in characters. */
export const ASSISTANT_MESSAGE_MAX_CHARS = 20_000;

const IdSchema = NonEmptyStringSchema.max(200);

// ---------------------------------------------------------------------------
// Context references: what "this" means when a message is sent
// ---------------------------------------------------------------------------

export const assistantScreenValues = [
  "home",
  "profile",
  "setup",
  "discovery",
  "review_queue",
  "resume_studio",
  "applications",
  "actions",
  "settings",
  "browser",
  "other",
] as const;
export const AssistantScreenSchema = z.enum(assistantScreenValues);
export type AssistantScreen = z.infer<typeof AssistantScreenSchema>;

/** Each screen by the name the app shows for it. */
export const ASSISTANT_SCREEN_LABELS: Record<AssistantScreen, string> = {
  home: "Home",
  profile: "Profile",
  setup: "Setup",
  discovery: "Find jobs",
  review_queue: "Shortlisted",
  resume_studio: "Shortlisted › Resume",
  applications: "Applications",
  actions: "Needs you",
  settings: "Settings",
  browser: "Browser",
  other: "Job Finder",
};

export const assistantEntityKindValues = [
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
export const AssistantEntityKindSchema = z.enum(assistantEntityKindValues);
export type AssistantEntityKind = z.infer<typeof AssistantEntityKindSchema>;

export const AssistantEntityRefSchema = z
  .object({
    kind: AssistantEntityKindSchema,
    id: IdSchema,
    label: z.string().trim().max(300).nullable().default(null),
  })
  .strict();
export type AssistantEntityRef = z.infer<typeof AssistantEntityRefSchema>;

/**
 * A list on screen. Selected rows, displayed rows and the whole filtered set
 * stay distinct: "all these jobs" means the filtered set, not the virtualized
 * rows that happen to be painted.
 */
export const AssistantListReferenceSchema = z
  .object({
    listKind: z.enum(["jobs", "shortlist", "applications", "companies"]),
    selectedIds: z.array(IdSchema).max(500).default([]),
    displayedIds: z.array(IdSchema).max(300).default([]),
    filteredIds: z.array(IdSchema).max(3000).default([]),
    totalFilteredCount: z.number().int().nonnegative().default(0),
    filterSummary: z.string().trim().max(4000).nullable().default(null),
    campaignId: IdSchema.nullable().default(null),
  })
  .strict();
export type AssistantListReference = z.infer<
  typeof AssistantListReferenceSchema
>;

const EditorFieldNameSchema = NonEmptyStringSchema.max(160);

/**
 * The Profile editor as the person sees it: the saved revision, a local
 * version that counts edits, the fields with unsaved edits and their values.
 */
export const AssistantProfileEditorSnapshotSchema = z
  .object({
    editor: z.literal("profile"),
    savedRevision: z.string().trim().max(200).nullable().default(null),
    draftVersion: z.number().int().nonnegative().default(0),
    dirtyFields: z.array(EditorFieldNameSchema).max(80).default([]),
    unsavedValues: z.record(EditorFieldNameSchema, z.unknown()).default({}),
    section: z.string().trim().max(80).nullable().default(null),
    selection: z
      .object({
        recordId: IdSchema.nullable().default(null),
        field: EditorFieldNameSchema.nullable().default(null),
        text: z.string().max(4000).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type AssistantProfileEditorSnapshot = z.infer<
  typeof AssistantProfileEditorSnapshotSchema
>;

export const AssistantResumeEditorSnapshotSchema = z
  .object({
    editor: z.literal("resume"),
    jobId: IdSchema,
    draftId: IdSchema.nullable().default(null),
    /** The saved draft's `updatedAt`: the expected revision for edits. */
    savedRevision: z.string().trim().max(200).nullable().default(null),
    draftVersion: z.number().int().nonnegative().default(0),
    hasUnsavedEdits: z.boolean().default(false),
    mode: z.enum(["original", "editable"]).default("editable"),
    selection: z
      .object({
        sectionId: IdSchema.nullable().default(null),
        entryId: IdSchema.nullable().default(null),
        bulletIds: z.array(IdSchema).max(40).default([]),
        text: z.string().max(4000).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type AssistantResumeEditorSnapshot = z.infer<
  typeof AssistantResumeEditorSnapshotSchema
>;

export const AssistantEditorSnapshotSchema = z.discriminatedUnion("editor", [
  AssistantProfileEditorSnapshotSchema,
  AssistantResumeEditorSnapshotSchema,
]);
export type AssistantEditorSnapshot = z.infer<
  typeof AssistantEditorSnapshotSchema
>;

export const AssistantBrowserContextSchema = z
  .object({
    tabId: IdSchema,
    url: z.string().max(2000),
    title: z.string().max(300).nullable().default(null),
    visible: z.boolean().default(true),
  })
  .strict();
export type AssistantBrowserContext = z.infer<
  typeof AssistantBrowserContextSchema
>;

export const AssistantAttachmentSchema = z
  .object({
    documentId: IdSchema,
    fileName: NonEmptyStringSchema.max(300),
    kind: z.string().trim().max(60).nullable().default(null),
  })
  .strict();
export type AssistantAttachment = z.infer<typeof AssistantAttachmentSchema>;

export const AssistantContextReferenceSchema = z
  .object({
    screen: AssistantScreenSchema.catch("other"),
    route: z.string().trim().max(4000).default(""),
    sectionLabel: z.string().trim().max(160).nullable().default(null),
    focus: AssistantEntityRefSchema.nullable().default(null),
    list: AssistantListReferenceSchema.nullable().default(null),
    editor: AssistantEditorSnapshotSchema.nullable().default(null),
    browser: AssistantBrowserContextSchema.nullable().default(null),
    selectedText: z.string().max(4000).nullable().default(null),
    mentions: z.array(AssistantEntityRefSchema).max(20).default([]),
    attachments: z.array(AssistantAttachmentSchema).max(5).default([]),
    capturedAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantContextReference = z.infer<
  typeof AssistantContextReferenceSchema
>;

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const assistantConversationSourceValues = [
  "assistant",
  "profile_copilot_archive",
  "resume_assistant_archive",
] as const;
export const AssistantConversationSourceSchema = z.enum(
  assistantConversationSourceValues,
);
export type AssistantConversationSource = z.infer<
  typeof AssistantConversationSourceSchema
>;

export const AssistantConversationSchema = z
  .object({
    id: IdSchema,
    title: NonEmptyStringSchema.max(160),
    status: z.enum(["active", "archived"]).default("active"),
    source: AssistantConversationSourceSchema.default("assistant"),
    jobId: IdSchema.nullable().default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    lastMessageAt: IsoDateTimeSchema.nullable().default(null),
    messageCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type AssistantConversation = z.infer<typeof AssistantConversationSchema>;

export const assistantChangeTargetValues = [
  "profile",
  "search_preferences",
  "settings",
  "resume_draft",
  "job_triage",
  "app_command",
] as const;
export const AssistantChangeTargetSchema = z.enum(assistantChangeTargetValues);
export type AssistantChangeTarget = z.infer<typeof AssistantChangeTargetSchema>;

const DiffPreviewSchema = z
  .object({
    label: NonEmptyStringSchema.max(200),
    // A removed or added record lists every field, one per line, so it can
    // be longer than a single changed value.
    before: z.string().max(2000).nullable().default(null),
    after: z.string().max(2000).nullable().default(null),
  })
  .strict();

export const AssistantMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(40_000) }).strict(),
  z
    .object({
      type: z.literal("change"),
      receiptId: IdSchema,
      target: AssistantChangeTargetSchema,
      targetId: IdSchema.nullable().default(null),
      summary: NonEmptyStringSchema.max(400),
      fields: z.array(NonEmptyStringSchema.max(160)).max(40).default([]),
      preview: z.array(DiffPreviewSchema).max(24).default([]),
      status: z
        .enum(["applied", "undone", "partially_undone"])
        .default("applied"),
      /** The editor still holds this change unsaved (see editor integrations). */
      unsaved: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("proposal"),
      proposalId: IdSchema,
      kind: z.enum([
        "profile_operations",
        "resume_patches",
        "job_finder_action",
      ]),
      summary: NonEmptyStringSchema.max(400),
      status: z.enum(["pending", "applied", "rejected"]).default("pending"),
      targetId: IdSchema.nullable().default(null),
      items: z
        .array(
          z
            .object({
              id: IdSchema,
              label: NonEmptyStringSchema.max(400),
              detail: z.string().max(100_000).nullable().default(null),
            })
            .strict(),
        )
        .max(30)
        .default([]),
      /** Where the authoritative proposal lives (legacy stores keep theirs). */
      source: z
        .object({
          store: z.enum(["assistant", "profile_copilot", "resume_assistant"]),
          legacyMessageId: IdSchema.nullable().default(null),
          patchGroupIds: z.array(IdSchema).max(30).default([]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("records"),
      kind: z.enum(["jobs", "applications", "companies"]),
      title: z.string().trim().max(200).nullable().default(null),
      resultSetId: IdSchema.nullable().default(null),
      totalCount: z.number().int().nonnegative().default(0),
      rows: z
        .array(
          z
            .object({
              id: IdSchema,
              title: NonEmptyStringSchema.max(300),
              subtitle: z.string().max(300).nullable().default(null),
              status: z.string().max(80).nullable().default(null),
              route: z.string().max(300).nullable().default(null),
            })
            .strict(),
        )
        .max(25)
        .default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("activity"),
      entries: z
        .array(
          z
            .object({
              toolName: NonEmptyStringSchema.max(80),
              label: NonEmptyStringSchema.max(200),
              outcome: z.enum(["done", "failed", "cancelled", "refused"]),
              detail: z.string().max(400).nullable().default(null),
              at: IsoDateTimeSchema,
            })
            .strict(),
        )
        .max(80)
        .default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("question"),
      questionId: IdSchema,
      prompt: NonEmptyStringSchema.max(1000),
      options: z.array(NonEmptyStringSchema.max(200)).max(8).default([]),
      status: z.enum(["open", "answered", "cancelled"]).default("open"),
      answer: z.string().max(2000).nullable().default(null),
      /** The Needs you step this asks about; answering it there closes this. */
      needsYouRequestId: IdSchema.nullable().default(null),
    })
    .strict(),
  z
    .object({
      type: z.literal("plan"),
      planId: IdSchema,
      title: NonEmptyStringSchema.max(200),
      steps: z
        .array(
          z
            .object({
              id: IdSchema,
              label: NonEmptyStringSchema.max(300),
              status: z.string().max(40),
            })
            .strict(),
        )
        .max(20)
        .default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("notice"),
      kind: z.enum([
        "compacted",
        "stopped",
        "error",
        "outage",
        "archived",
        "interrupted",
        "continued",
      ]),
      text: NonEmptyStringSchema.max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("attachment"),
      attachment: AssistantAttachmentSchema,
    })
    .strict(),
]);
export type AssistantMessagePart = z.infer<typeof AssistantMessagePartSchema>;

export const AssistantMessageSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    clientMessageId: IdSchema.nullable().default(null),
    role: z.enum(["user", "assistant"]),
    /**
     * `sidebar`: typed by the person in the sidebar (the only source that can
     * authorize work). `host`: written by Job Finder itself (a background run
     * finished). `migrated`: copied from an old chat; never re-executed.
     */
    origin: z.enum(["sidebar", "host", "migrated"]),
    parts: z.array(AssistantMessagePartSchema).max(60).default([]),
    turnId: IdSchema.nullable().default(null),
    context: AssistantContextReferenceSchema.nullable().default(null),
    /**
     * Result sets frozen from the screen when the message was accepted
     * (selected, displayed and filtered rows), so "these" keeps its meaning.
     */
    contextResultSetIds: z.array(IdSchema).max(4).default([]),
    migratedFrom: z
      .object({
        source: z.enum(["profile_copilot", "resume_assistant"]),
        legacyId: IdSchema,
      })
      .strict()
      .nullable()
      .default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

// ---------------------------------------------------------------------------
// Turns, operations, receipts
// ---------------------------------------------------------------------------

export const assistantTurnStatusValues = [
  "queued",
  "running",
  "waiting_for_person",
  "interrupted",
  "completed",
  "failed",
  "stopped",
] as const;
export const AssistantTurnStatusSchema = z.enum(assistantTurnStatusValues);
export type AssistantTurnStatus = z.infer<typeof AssistantTurnStatusSchema>;

export const AssistantUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().default(0),
    modelCalls: z.number().int().nonnegative().default(0),
  })
  .strict();
export type AssistantUsage = z.infer<typeof AssistantUsageSchema>;

export const AssistantTurnSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    trigger: z.enum(["message", "continuation", "recovery"]),
    sourceMessageId: IdSchema.nullable().default(null),
    status: AssistantTurnStatusSchema,
    /** Execution generation: a stopped turn's late writes are fenced by it. */
    generation: z.number().int().nonnegative(),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.nullable().default(null),
    model: z.string().max(200).nullable().default(null),
    usage: AssistantUsageSchema.nullable().default(null),
    error: z.string().max(1000).nullable().default(null),
    planId: IdSchema.nullable().default(null),
  })
  .strict();
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

export const assistantOperationStatusValues = [
  "started",
  "committed",
  "failed",
  "cancelled",
  "uncertain",
] as const;

export const AssistantOperationSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    turnId: IdSchema,
    toolName: NonEmptyStringSchema.max(80),
    /** Stable hash of the validated arguments; a retry with the same hash returns the receipt. */
    argumentsHash: NonEmptyStringSchema.max(200),
    status: z.enum(assistantOperationStatusValues),
    resultSummary: z.string().max(2000).nullable().default(null),
    receiptId: IdSchema.nullable().default(null),
    run: z
      .object({
        kind: z.enum([
          "discovery",
          "apply_batch",
          "apply_queue",
          "apply_run",
          "resume_generation",
          "source_check",
        ]),
        id: IdSchema,
      })
      .strict()
      .nullable()
      .default(null),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type AssistantOperation = z.infer<typeof AssistantOperationSchema>;

/**
 * One changed value inside an assistant edit. `path` addresses objects by key
 * and id-keyed records by `#id:<id>`, so an undo finds the same record after
 * the list was reordered or grew.
 */
export const AssistantChangeEntrySchema = z
  .object({
    path: z.array(z.string().max(200)).min(1).max(12),
    kind: z.enum(["set", "insert", "remove"]),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    /** Position of an inserted or removed record, for putting it back. */
    index: z.number().int().nonnegative().nullable().default(null),
    label: z.string().max(200).nullable().default(null),
  })
  .strict();
export type AssistantChangeEntry = z.infer<typeof AssistantChangeEntrySchema>;

export const AssistantChangeReceiptSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    messageId: IdSchema.nullable().default(null),
    operationId: IdSchema.nullable().default(null),
    target: AssistantChangeTargetSchema,
    targetId: IdSchema.nullable().default(null),
    summary: NonEmptyStringSchema.max(400),
    fieldLabels: z.array(NonEmptyStringSchema.max(160)).max(60).default([]),
    entries: z.array(AssistantChangeEntrySchema).max(600),
    undoCommand: z.object({
      name: NonEmptyStringSchema.max(100),
      input: z.record(z.unknown()),
      expectedCount: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    createdAt: IsoDateTimeSchema,
    status: z
      .enum(["applied", "undone", "partially_undone"])
      .default("applied"),
    undoneAt: IsoDateTimeSchema.nullable().default(null),
    /** Fields that could not be undone because they changed again since. */
    undoConflicts: z.array(NonEmptyStringSchema.max(200)).max(60).default([]),
  })
  .strict();
export type AssistantChangeReceipt = z.infer<
  typeof AssistantChangeReceiptSchema
>;

/**
 * A suggestion the person has not accepted yet ("suggest improvements").
 * The payload is the typed change it would make; accepting it runs the same
 * assistant-edit operation as a requested edit.
 */
export const AssistantProposalSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    messageId: IdSchema.nullable().default(null),
    kind: z.enum(["profile_operations", "resume_patches", "job_finder_action"]),
    targetId: IdSchema.nullable().default(null),
    summary: NonEmptyStringSchema.max(400),
    items: z
      .array(
        z
          .object({
            id: IdSchema,
            label: NonEmptyStringSchema.max(400),
            detail: z.string().max(100_000).nullable().optional(),
            payload: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    baseRevision: z.string().max(200).nullable().default(null),
    status: z.enum(["pending", "applied", "rejected"]).default("pending"),
    createdAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type AssistantProposal = z.infer<typeof AssistantProposalSchema>;

// ---------------------------------------------------------------------------
// Written instructions (ADR 0039)
// ---------------------------------------------------------------------------

/**
 * `prepare`: fill in and stop before sending ("prepare these; I'll send
 * them"); it also blocks sending those jobs. `prepare_and_send`: the person
 * wrote that the applications should be sent. `apply_saved_mode`: "apply to
 * these" with nothing said about sending, so the saved apply mode decides.
 */
export const assistantGrantActionValues = [
  "prepare",
  "prepare_and_send",
  "apply_saved_mode",
] as const;
export const AssistantGrantActionSchema = z.enum(assistantGrantActionValues);
export type AssistantGrantAction = z.infer<typeof AssistantGrantActionSchema>;

export const AssistantInstructionGrantSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    /** A message the person typed in the sidebar. Nothing else can be a source. */
    sourceMessageId: IdSchema,
    action: AssistantGrantActionSchema,
    /** Resolved and frozen when the grant was recorded. */
    jobIds: z.array(IdSchema).min(1).max(2000),
    resumePolicy: z.string().max(400).nullable().default(null),
    answerPolicy: z.string().max(1000).nullable().default(null),
    constraints: z.array(NonEmptyStringSchema.max(400)).max(12).default([]),
    status: z.enum(["active", "narrowed", "revoked", "completed"]),
    history: z
      .array(
        z
          .object({
            at: IsoDateTimeSchema,
            messageId: IdSchema,
            change: NonEmptyStringSchema.max(400),
          })
          .strict(),
      )
      .max(40)
      .default([]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantInstructionGrant = z.infer<
  typeof AssistantInstructionGrantSchema
>;

// ---------------------------------------------------------------------------
// Task plans and result sets
// ---------------------------------------------------------------------------

export const assistantPlanStepStatusValues = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;
export const AssistantPlanStepStatusSchema = z.enum(
  assistantPlanStepStatusValues,
);
export type AssistantPlanStepStatus = z.infer<
  typeof AssistantPlanStepStatusSchema
>;

export const AssistantRunRefSchema = z
  .object({
    kind: z.enum([
      "discovery",
      "apply_batch",
      "apply_queue",
      "apply_run",
      "resume_generation",
      "source_check",
    ]),
    id: IdSchema,
    /** Jobs the run covers, when known (apply batches, resume batches). */
    jobIds: z.array(IdSchema).max(2000).default([]),
  })
  .strict();
export type AssistantRunRef = z.infer<typeof AssistantRunRefSchema>;

export const AssistantTaskPlanStepSchema = z
  .object({
    id: IdSchema,
    label: NonEmptyStringSchema.max(300),
    status: AssistantPlanStepStatusSchema.default("pending"),
    dependsOn: z.array(IdSchema).max(20).default([]),
    operationId: IdSchema.nullable().default(null),
    run: AssistantRunRefSchema.nullable().default(null),
    note: z.string().max(600).nullable().default(null),
  })
  .strict();
export type AssistantTaskPlanStep = z.infer<typeof AssistantTaskPlanStepSchema>;

export const AssistantTaskPlanSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    title: NonEmptyStringSchema.max(200),
    steps: z.array(AssistantTaskPlanStepSchema).max(20),
    grantId: IdSchema.nullable().default(null),
    sourceMessageId: IdSchema.nullable().default(null),
    status: z.enum(["active", "completed", "cancelled"]).default("active"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantTaskPlan = z.infer<typeof AssistantTaskPlanSchema>;

export const AssistantResultSetSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    kind: z.enum(["jobs", "applications", "companies", "page_jobs"]),
    label: NonEmptyStringSchema.max(200),
    /** Stable order: "the second one" means `itemIds[1]` forever. */
    itemIds: z.array(IdSchema).max(3000),
    source: z.enum([
      "screen_selection",
      "screen_filter",
      "screen_displayed",
      "tool_query",
      "page_collection",
    ]),
    coverage: z.string().max(600).nullable().default(null),
    /**
     * For `page_jobs`: the postings read off the page, in `itemIds` order,
     * until the person saves some (then they become saved jobs).
     */
    pageItems: z.array(z.unknown()).max(500).default([]),
    pageUrl: z.string().max(2000).nullable().default(null),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantResultSet = z.infer<typeof AssistantResultSetSchema>;

// ---------------------------------------------------------------------------
// Compaction checkpoints
// ---------------------------------------------------------------------------

export const AssistantCheckpointSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    version: z.number().int().positive(),
    /** The last message whose content the summary replaces. */
    coversThroughMessageId: IdSchema,
    /** The last stored model-tail item the summary replaces. */
    coversThroughTranscriptSeq: z.number().int().nonnegative(),
    goal: z.string().max(2000).nullable().default(null),
    activeInstructions: z
      .array(
        z
          .object({ text: NonEmptyStringSchema.max(1000), messageId: IdSchema })
          .strict(),
      )
      .max(30)
      .default([]),
    constraints: z.array(NonEmptyStringSchema.max(600)).max(30).default([]),
    entities: z.array(AssistantEntityRefSchema).max(60).default([]),
    findings: z.array(NonEmptyStringSchema.max(800)).max(40).default([]),
    unfinishedSteps: z.array(NonEmptyStringSchema.max(600)).max(30).default([]),
    pendingQuestions: z
      .array(NonEmptyStringSchema.max(600))
      .max(20)
      .default([]),
    evidenceRefs: z.array(NonEmptyStringSchema.max(200)).max(60).default([]),
    estimatedTokensBefore: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    estimatedTokensAfter: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantCheckpoint = z.infer<typeof AssistantCheckpointSchema>;

// ---------------------------------------------------------------------------
// Browser tab leases (ADR 0038)
// ---------------------------------------------------------------------------

export const AssistantTabLeaseSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    turnId: IdSchema,
    tabId: IdSchema,
    generation: z.number().int().nonnegative(),
    documentUrl: z.string().max(2000),
    childTabIds: z.array(IdSchema).max(8).default([]),
    status: z.enum(["active", "revoked", "released"]),
    revokedReason: z.string().max(400).nullable().default(null),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantTabLease = z.infer<typeof AssistantTabLeaseSchema>;

// ---------------------------------------------------------------------------
// Events: the renderer converges by replaying from a sequence cursor
// ---------------------------------------------------------------------------

export const AssistantActivitySchema = z
  .object({
    label: NonEmptyStringSchema.max(200),
    toolName: z.string().max(80).nullable().default(null),
    startedAt: IsoDateTimeSchema,
  })
  .strict();
export type AssistantActivity = z.infer<typeof AssistantActivitySchema>;

export const AssistantEventPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message_added"),
      message: AssistantMessageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("message_updated"),
      message: AssistantMessageSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("turn_updated"), turn: AssistantTurnSchema })
    .strict(),
  z
    .object({
      type: z.literal("text_delta"),
      /** Replaces the whole draft reply of this attempt; never appended across attempts. */
      attempt: z.number().int().nonnegative(),
      text: z.string().max(40_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("activity"),
      activity: AssistantActivitySchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      text: NonEmptyStringSchema.max(1000),
    })
    .strict(),
  z
    .object({ type: z.literal("plan_updated"), plan: AssistantTaskPlanSchema })
    .strict(),
  z
    .object({
      type: z.literal("conversation_updated"),
      conversation: AssistantConversationSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("stall"), text: NonEmptyStringSchema.max(400) })
    .strict(),
  /** The person asked to see something; a live renderer opens the route. */
  z
    .object({
      type: z.literal("open_route"),
      navigationRequestId: IdSchema.nullable().default(null),
      route: NonEmptyStringSchema.max(4000),
    })
    .strict(),
  z.object({ type: z.literal("conversation_deleted") }).strict(),
]);
export type AssistantEventPayload = z.infer<typeof AssistantEventPayloadSchema>;

export const AssistantEventSchema = z
  .object({
    conversationId: IdSchema,
    /**
     * Position in the conversation's event log. Zero marks a live-only event
     * (streamed text between persisted batches) that replay never returns.
     */
    sequence: z.number().int().nonnegative(),
    turnId: IdSchema.nullable().default(null),
    at: IsoDateTimeSchema,
    payload: AssistantEventPayloadSchema,
  })
  .strict();
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const AssistantStatusSchema = z
  .object({
    available: z.boolean(),
    /** Plain outage wording when the model is unreachable; never a setup task. */
    detail: z.string().max(400).nullable().default(null),
    model: z.string().max(200).nullable().default(null),
    scripted: z.boolean().default(false),
  })
  .strict();
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;

export const AssistantConversationListSchema = z
  .object({
    conversations: z.array(AssistantConversationSchema),
    currentConversationId: IdSchema.nullable().default(null),
  })
  .strict();
export type AssistantConversationList = z.infer<
  typeof AssistantConversationListSchema
>;

export const AssistantConversationViewSchema = z
  .object({
    conversation: AssistantConversationSchema,
    messages: z.array(AssistantMessageSchema),
    hasOlderMessages: z.boolean().default(false),
    activeTurn: AssistantTurnSchema.nullable().default(null),
    activity: AssistantActivitySchema.nullable().default(null),
    draftText: z.string().max(40_000).nullable().default(null),
    plans: z.array(AssistantTaskPlanSchema).default([]),
    lastSequence: z.number().int().nonnegative(),
    /** Messages accepted while a turn runs and not yet read by the model. */
    pendingMessageIds: z.array(IdSchema).default([]),
  })
  .strict();
export type AssistantConversationView = z.infer<
  typeof AssistantConversationViewSchema
>;

export const AssistantNavigationDisplaySchema = z
  .object({
    displayedRoute: z.string().max(4000).nullable(),
    section: z.string().max(80).nullable(),
    overlay: z.enum(["none", "browser", "dialog", "chat"]),
    status: z.enum(["displayed", "blocked"]),
    reason: z.string().max(400).nullable(),
  })
  .strict();
export type AssistantNavigationDisplay = z.infer<
  typeof AssistantNavigationDisplaySchema
>;
export const AssistantNavigationAcknowledgmentSchema =
  AssistantNavigationDisplaySchema.extend({
    conversationId: IdSchema,
    navigationRequestId: IdSchema,
  }).strict();
export type AssistantNavigationAcknowledgment = z.infer<
  typeof AssistantNavigationAcknowledgmentSchema
>;

export const AssistantConversationIdInputSchema = z
  .object({ conversationId: IdSchema })
  .strict();
export type AssistantConversationIdInput = z.infer<
  typeof AssistantConversationIdInputSchema
>;

export const AssistantReadConversationInputSchema = z
  .object({
    conversationId: IdSchema,
    beforeMessageId: IdSchema.nullable().default(null),
    limit: z.number().int().min(1).max(400).default(200),
  })
  .strict();
export type AssistantReadConversationInput = z.input<
  typeof AssistantReadConversationInputSchema
>;

export const AssistantSendMessageInputSchema = z
  .object({
    /** Null sends to the current conversation, creating one when needed. */
    conversationId: IdSchema.nullable().default(null),
    clientMessageId: IdSchema,
    text: NonEmptyStringSchema.max(ASSISTANT_MESSAGE_MAX_CHARS),
    context: AssistantContextReferenceSchema,
  })
  .strict();
export type AssistantSendMessageInput = z.input<
  typeof AssistantSendMessageInputSchema
>;

export const AssistantSendMessageResultSchema = z
  .object({
    conversationId: IdSchema,
    message: AssistantMessageSchema,
    /** True when the message was stored as steering for a running turn. */
    steering: z.boolean(),
    turnId: IdSchema.nullable().default(null),
  })
  .strict();
export type AssistantSendMessageResult = z.infer<
  typeof AssistantSendMessageResultSchema
>;

export const AssistantAnswerQuestionInputSchema = z
  .object({
    conversationId: IdSchema,
    questionId: IdSchema,
    answer: NonEmptyStringSchema.max(2000),
    clientMessageId: IdSchema,
    context: AssistantContextReferenceSchema,
  })
  .strict();
export type AssistantAnswerQuestionInput = z.input<
  typeof AssistantAnswerQuestionInputSchema
>;

export const AssistantResolveProposalInputSchema = z
  .object({
    conversationId: IdSchema,
    messageId: IdSchema,
    proposalId: IdSchema,
    action: z.enum(["accept", "reject"]),
    itemIds: z.array(IdSchema).max(30).default([]),
  })
  .strict();
export type AssistantResolveProposalInput = z.input<
  typeof AssistantResolveProposalInputSchema
>;

export const AssistantUndoChangeInputSchema = z
  .object({ conversationId: IdSchema, receiptId: IdSchema })
  .strict();
export type AssistantUndoChangeInput = z.infer<
  typeof AssistantUndoChangeInputSchema
>;

export const AssistantUndoChangeResultSchema = z
  .object({
    receipt: AssistantChangeReceiptSchema,
    /** Plain sentence: what was undone and what could not be. */
    message: NonEmptyStringSchema.max(800),
  })
  .strict();
export type AssistantUndoChangeResult = z.infer<
  typeof AssistantUndoChangeResultSchema
>;

export const AssistantReplayEventsInputSchema = z
  .object({
    conversationId: IdSchema,
    afterSequence: z.number().int().nonnegative(),
  })
  .strict();
export type AssistantReplayEventsInput = z.infer<
  typeof AssistantReplayEventsInputSchema
>;

export const AssistantReplayEventsResultSchema = z
  .object({
    events: z.array(AssistantEventSchema),
    lastSequence: z.number().int().nonnegative(),
    /** True when the gap was too large to replay; read the conversation instead. */
    reset: z.boolean().default(false),
  })
  .strict();
export type AssistantReplayEventsResult = z.infer<
  typeof AssistantReplayEventsResultSchema
>;

export const AssistantAttachFileInputSchema = z
  .object({
    /**
     * A path from a file the person dropped on the sidebar (resolved by the
     * preload from the dropped File). Null opens the native picker.
     */
    filePath: z.string().max(4000).nullable().default(null),
  })
  .strict();
export type AssistantAttachFileInput = z.input<
  typeof AssistantAttachFileInputSchema
>;

export const AssistantAttachFileResultSchema = z
  .object({
    attachment: AssistantAttachmentSchema.nullable(),
    /** Every file attached by this call (the picker allows several). */
    attachments: z.array(AssistantAttachmentSchema).max(5).default([]),
    message: z.string().max(400).nullable().default(null),
  })
  .strict();
export type AssistantAttachFileResult = z.infer<
  typeof AssistantAttachFileResultSchema
>;

export const AssistantMentionCandidateSchema = z
  .object({
    kind: AssistantEntityKindSchema,
    id: IdSchema,
    label: NonEmptyStringSchema.max(300),
    detail: z.string().max(300).nullable().default(null),
  })
  .strict();
export type AssistantMentionCandidate = z.infer<
  typeof AssistantMentionCandidateSchema
>;

export const AssistantMentionSearchInputSchema = z
  .object({ query: z.string().max(200).default("") })
  .strict();
export type AssistantMentionSearchInput = z.input<
  typeof AssistantMentionSearchInputSchema
>;

export const AssistantMentionSearchResultSchema = z
  .object({ candidates: z.array(AssistantMentionCandidateSchema).max(30) })
  .strict();
export type AssistantMentionSearchResult = z.infer<
  typeof AssistantMentionSearchResultSchema
>;

/** Transient resume work owned by the UI; never resumed after restart. */
export const AssistantResumeBatchStateSchema =
  ResumeBatchCheckpointSchema.extend({
    id: IdSchema,
    jobIds: z.array(IdSchema),
    completedJobIds: z.array(IdSchema),
    activeJobIds: z.array(IdSchema).max(RESUME_PIPELINE_CAPACITY),
  })
    .strict()
    .refine(
      (batch) => {
        const queued = new Set(batch.jobIds);
        return batch.activeJobIds.every((jobId) => queued.has(jobId));
      },
      {
        message: "Active resumes must belong to the batch queue.",
        path: ["activeJobIds"],
      },
    );
export type AssistantResumeBatchState = z.infer<
  typeof AssistantResumeBatchStateSchema
>;

/** The typed preload bridge the sidebar uses (`window.nestor.assistant`). */
export interface DesktopAssistantBridge {
  acknowledgeNavigation(
    input: AssistantNavigationAcknowledgment,
  ): Promise<void>;
  stopResumeBatch(): Promise<void>;
  syncResumeBatch(
    state: AssistantResumeBatchState,
  ): Promise<AssistantResumeBatchState>;
  onResumeBatchStop(listener: (batchId: string) => void): () => void;
  getStatus(): Promise<AssistantStatus>;
  listConversations(): Promise<AssistantConversationList>;
  createConversation(): Promise<AssistantConversation>;
  selectConversation(conversationId: string): Promise<void>;
  readConversation(
    input: AssistantReadConversationInput,
  ): Promise<AssistantConversationView>;
  sendMessage(
    input: AssistantSendMessageInput,
  ): Promise<AssistantSendMessageResult>;
  stop(conversationId: string): Promise<void>;
  answerQuestion(
    input: AssistantAnswerQuestionInput,
  ): Promise<AssistantSendMessageResult>;
  resolveProposal(
    input: AssistantResolveProposalInput,
  ): Promise<AssistantMessage>;
  undoChange(
    input: AssistantUndoChangeInput,
  ): Promise<AssistantUndoChangeResult>;
  deleteConversation(conversationId: string): Promise<void>;
  replayEvents(
    input: AssistantReplayEventsInput,
  ): Promise<AssistantReplayEventsResult>;
  searchMentions(query: string): Promise<AssistantMentionSearchResult>;
  /** Attaches a dropped file (resolved to its path in the preload) or opens the picker. */
  attachFile(file?: File | null): Promise<AssistantAttachFileResult>;
  onEvent(listener: (event: AssistantEvent) => void): () => void;
}
