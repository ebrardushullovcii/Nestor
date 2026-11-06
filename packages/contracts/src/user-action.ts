import { z } from "zod";

import {
  IsoDateTimeSchema,
  JobSourceSchema,
  NonEmptyStringSchema,
} from "./base";

const UserActionIdentifierSchema = NonEmptyStringSchema.max(160);
const UserActionFingerprintSchema = NonEmptyStringSchema.max(512);
const UserActionShortTextSchema = NonEmptyStringSchema.max(240);
const UserActionLongTextSchema = NonEmptyStringSchema.max(2_000);

export const DiscoveryAccessBlockerReasonSchema = z.enum([
  "auth_required",
  "site_protection",
  "manual_step_required",
]);
export type DiscoveryAccessBlockerReason = z.infer<
  typeof DiscoveryAccessBlockerReasonSchema
>;

function parseBrowserUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export const UserActionBrowserUrlSchema = z
  .string()
  .trim()
  .url()
  .max(4_096)
  .superRefine((value, context) => {
    const url = parseBrowserUrl(value);

    if (url === null || !["http:", "https:"].includes(url.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "User action URLs must use HTTP or HTTPS.",
      });
      return;
    }

    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "User action URLs must not contain credentials.",
      });
    }
  });
export type UserActionBrowserUrl = z.infer<typeof UserActionBrowserUrlSchema>;

export const ParkedBrowserTabReferenceSchema = z
  .object({
    tabId: UserActionIdentifierSchema.nullable().default(null),
    url: UserActionBrowserUrlSchema,
    title: UserActionShortTextSchema.nullable().default(null),
  })
  .strict();
export type ParkedBrowserTabReference = z.infer<
  typeof ParkedBrowserTabReferenceSchema
>;

export const UserActionBrowserOriginSchema =
  UserActionBrowserUrlSchema.superRefine((value, context) => {
    const url = parseBrowserUrl(value);

    if (
      url !== null &&
      (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A browser origin cannot include a path, query, or fragment.",
      });
    }
  });
export type UserActionBrowserOrigin = z.infer<
  typeof UserActionBrowserOriginSchema
>;

export const browserSourceAccessProbeStateValues = [
  "authenticated",
  "blocked",
  "inconclusive",
] as const;

export const BrowserSourceAccessProbeStateSchema = z.enum(
  browserSourceAccessProbeStateValues,
);
export type BrowserSourceAccessProbeState = z.infer<
  typeof BrowserSourceAccessProbeStateSchema
>;

export const browserSourceAccessProbeSignalValues = [
  "origin_mismatch",
  "auth_route",
  "password_control",
  "login_control",
  "captcha_challenge",
  "mfa_challenge",
  "sign_out_control",
  "account_menu_control",
  "profile_control",
] as const;

export const BrowserSourceAccessProbeSignalSchema = z.enum(
  browserSourceAccessProbeSignalValues,
);
export type BrowserSourceAccessProbeSignal = z.infer<
  typeof BrowserSourceAccessProbeSignalSchema
>;

export const BrowserSourceAccessProbeInputSchema = z
  .object({
    expectedOrigin: UserActionBrowserOriginSchema,
    /**
     * The host's id for the exact tab parked for this request. When given,
     * only that tab is read; another tab on the same origin never stands in
     * for it.
     */
    tabId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type BrowserSourceAccessProbeInput = z.infer<
  typeof BrowserSourceAccessProbeInputSchema
>;

export const BrowserSourceAccessProbeResultSchema = z
  .object({
    state: BrowserSourceAccessProbeStateSchema,
    checkedAt: IsoDateTimeSchema,
    currentOrigin: UserActionBrowserOriginSchema.nullable().default(null),
    signals: z.array(BrowserSourceAccessProbeSignalSchema).max(12).default([]),
  })
  .strict()
  .superRefine((result, context) => {
    const blockingSignals: ReadonlySet<BrowserSourceAccessProbeSignal> =
      new Set([
        "origin_mismatch",
        "auth_route",
        "password_control",
        "captcha_challenge",
        "mfa_challenge",
      ]);
    const authenticatedSignals: ReadonlySet<BrowserSourceAccessProbeSignal> =
      new Set(["sign_out_control", "account_menu_control", "profile_control"]);
    const hasBlockingSignal = result.signals.some((signal) =>
      blockingSignals.has(signal),
    );
    const hasAuthenticatedSignal = result.signals.some((signal) =>
      authenticatedSignals.has(signal),
    );

    if (
      result.state === "authenticated" &&
      (result.currentOrigin === null ||
        hasBlockingSignal ||
        !hasAuthenticatedSignal)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Authenticated source access requires a current origin and a strong account marker without blockers.",
      });
    }

    if (result.state === "blocked" && !hasBlockingSignal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Blocked source access requires an explicit blocker signal.",
      });
    }
  });
export type BrowserSourceAccessProbeResult = z.infer<
  typeof BrowserSourceAccessProbeResultSchema
>;

export const userActionRequestKindValues = [
  "login",
  "signup",
  "mfa",
  "email_verification",
  "captcha",
  "existing_account_choice",
  "manual_answer",
  "legal_consent",
  "external_redirect",
  "manual_upload",
  "other",
] as const;

export const UserActionRequestKindSchema = z
  .enum(userActionRequestKindValues)
  .default("other");
export type UserActionRequestKind = z.infer<typeof UserActionRequestKindSchema>;

export const userActionRequestStateValues = [
  "pending",
  "page_opened",
  "awaiting_user",
  "verifying",
  "still_blocked",
  "resolved",
  "skipped",
  "cancelled",
  "expired",
  "superseded",
] as const;

export const UserActionRequestStateSchema = z.enum(
  userActionRequestStateValues,
);
export type UserActionRequestState = z.infer<
  typeof UserActionRequestStateSchema
>;

export const userActionRequirementValues = ["required", "recommended"] as const;

export const UserActionRequirementSchema = z.enum(userActionRequirementValues);
export type UserActionRequirement = z.infer<typeof UserActionRequirementSchema>;

const UserActionDiscoverySourceScopeSchema = z
  .object({
    type: z.literal("discovery_source"),
    targetId: UserActionIdentifierSchema,
    source: JobSourceSchema,
    sourceDebugRunId: UserActionIdentifierSchema.nullable().default(null),
    sourceDebugAttemptId: UserActionIdentifierSchema.nullable().default(null),
    discoveryRunId: UserActionIdentifierSchema.nullable().optional(),
    parkedTab: ParkedBrowserTabReferenceSchema.nullable().optional(),
  })
  .strict();

const UserActionApplicationScopeSchema = z
  .object({
    type: z.literal("application"),
    runId: UserActionIdentifierSchema,
    jobId: UserActionIdentifierSchema,
    applicationRecordId: UserActionIdentifierSchema.nullable().default(null),
    resultId: UserActionIdentifierSchema.nullable().default(null),
    replayCheckpointId: UserActionIdentifierSchema.nullable().default(null),
    source: JobSourceSchema,
  })
  .strict();

export const UserActionScopeSchema = z.discriminatedUnion("type", [
  UserActionDiscoverySourceScopeSchema,
  UserActionApplicationScopeSchema,
]);
export type UserActionScope = z.infer<typeof UserActionScopeSchema>;
export type UserActionScopeInput = z.input<typeof UserActionScopeSchema>;

const UserActionSourceAccessVerificationSchema = z
  .object({
    type: z.literal("source_access"),
    targetId: UserActionIdentifierSchema.nullable().default(null),
    blockerFingerprint: UserActionFingerprintSchema,
    expectedOrigin: UserActionBrowserOriginSchema.nullable().default(null),
  })
  .strict();

const UserActionPageBlockerAbsentVerificationSchema = z
  .object({
    type: z.literal("page_blocker_absent"),
    blockerFingerprint: UserActionFingerprintSchema,
    expectedPageFingerprint:
      UserActionFingerprintSchema.nullable().default(null),
  })
  .strict();

export const userActionExpectedControlStateValues = [
  "answered",
  "checked",
  "file_attached",
  "selection_made",
] as const;

export const UserActionExpectedControlStateSchema = z.enum(
  userActionExpectedControlStateValues,
);
export type UserActionExpectedControlState = z.infer<
  typeof UserActionExpectedControlStateSchema
>;

const UserActionFormControlStateVerificationSchema = z
  .object({
    type: z.literal("form_control_state"),
    controlFingerprint: UserActionFingerprintSchema,
    expectedState: UserActionExpectedControlStateSchema,
    expectedPageFingerprint:
      UserActionFingerprintSchema.nullable().default(null),
  })
  .strict();

const UserActionDestinationReachedVerificationSchema = z
  .object({
    type: z.literal("destination_reached"),
    expectedOrigin: UserActionBrowserOriginSchema,
    expectedPathPrefix: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .startsWith("/")
      .refine(
        (value) => !value.includes("?") && !value.includes("#"),
        "A destination path prefix cannot include a query or fragment.",
      )
      .default("/"),
  })
  .strict();

export const UserActionVerificationStrategySchema = z.discriminatedUnion(
  "type",
  [
    UserActionSourceAccessVerificationSchema,
    UserActionPageBlockerAbsentVerificationSchema,
    UserActionFormControlStateVerificationSchema,
    UserActionDestinationReachedVerificationSchema,
  ],
);
export type UserActionVerificationStrategy = z.infer<
  typeof UserActionVerificationStrategySchema
>;
export type UserActionVerificationStrategyInput = z.input<
  typeof UserActionVerificationStrategySchema
>;

const UserActionSafetyFields = {
  credentialsPolicy: z.literal("browser_only").default("browser_only"),
  submitAuthorized: z.literal(false).default(false),
  accountCreationAuthorized: z.literal(false).default(false),
} as const;

export const UserActionAnswerDraftSchema = z
  .object({
    answers: z.record(
      z.string(),
      z.union([z.string().max(4_000), z.array(z.string().max(4_000)).max(50)]),
    ),
    saveForFuture: z.boolean(),
    hiringCountry: z.string().max(120).optional(),
  })
  .strict();
export type UserActionAnswerDraft = z.infer<typeof UserActionAnswerDraftSchema>;
export const SaveUserActionAnswerDraftInputSchema = z
  .object({
    requestId: UserActionIdentifierSchema,
    expectedRevision: z.number().int().positive(),
    draft: UserActionAnswerDraftSchema.partial().nullable(),
    editedAt: z.number().int().positive().optional(),
  })
  .strict();
export type SaveUserActionAnswerDraftInput = z.infer<
  typeof SaveUserActionAnswerDraftInputSchema
>;

export const UserActionRequestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    id: UserActionIdentifierSchema,
    dedupeKey: UserActionIdentifierSchema,
    revision: z.number().int().positive(),
    kind: UserActionRequestKindSchema,
    state: UserActionRequestStateSchema,
    requirement: UserActionRequirementSchema.default("required"),
    scope: UserActionScopeSchema,
    verification: UserActionVerificationStrategySchema,
    title: UserActionShortTextSchema,
    summary: UserActionLongTextSchema,
    answerDraft: UserActionAnswerDraftSchema.nullable().optional(),
    answerDraftFieldUpdatedAt: z.record(z.string(), z.number()).optional(),
    instructions: z.array(UserActionLongTextSchema).max(12).default([]),
    actionUrl: UserActionBrowserUrlSchema.nullable().default(null),
    displayOrigin: UserActionBrowserOriginSchema.nullable().default(null),
    ...UserActionSafetyFields,
    attemptCount: z.number().int().nonnegative().default(0),
    maxAttempts: z.number().int().positive().default(3),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    openedAt: IsoDateTimeSchema.nullable().default(null),
    resolvedAt: IsoDateTimeSchema.nullable().default(null),
    expiresAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.state === "resolved" && request.resolvedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "Resolved user actions require a resolved timestamp.",
      });
    }

    if (
      request.scope.type === "discovery_source" &&
      request.verification.type === "source_access" &&
      request.scope.targetId !== request.verification.targetId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification", "targetId"],
        message:
          "Source access verification must target the scoped discovery source.",
      });
    }
  });
export type UserActionRequest = z.infer<typeof UserActionRequestSchema>;
export type UserActionRequestInput = z.input<typeof UserActionRequestSchema>;

const UserActionCommandBaseSchema = z
  .object({
    requestId: UserActionIdentifierSchema,
    commandId: UserActionIdentifierSchema,
    expectedRevision: z.number().int().positive(),
    ...UserActionSafetyFields,
  })
  .strict();

export const OpenUserActionPageCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("open_page"),
  });
export type OpenUserActionPageCommand = z.infer<
  typeof OpenUserActionPageCommandSchema
>;

export const ConfirmUserActionDoneCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("confirm_done"),
  });
export type ConfirmUserActionDoneCommand = z.infer<
  typeof ConfirmUserActionDoneCommandSchema
>;

/**
 * One-use credentials the person explicitly supplied for this exact sign-in
 * step. The command crosses the typed bridge, but its secret fields are never
 * copied into a user-action request, event, answer record, or repository.
 */
export const SubmitTaskLocalCredentialsCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("submit_task_local_credentials"),
    identifier: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(4_096),
    taskLocalUseAuthorized: z.literal(true),
  });
export type SubmitTaskLocalCredentialsCommand = z.infer<
  typeof SubmitTaskLocalCredentialsCommandSchema
>;

export const userActionAccountPathValues = [
  "use_existing_account",
  "create_account_in_browser",
] as const;

export const UserActionAccountPathSchema = z.enum(userActionAccountPathValues);
export type UserActionAccountPath = z.infer<typeof UserActionAccountPathSchema>;

export const ChooseUserActionAccountPathCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("choose_account_path"),
    choice: UserActionAccountPathSchema,
  });
export type ChooseUserActionAccountPathCommand = z.infer<
  typeof ChooseUserActionAccountPathCommandSchema
>;

export const SubmitUserActionManualAnswerCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("submit_manual_answer"),
    hiringCountry: z.string().trim().min(1).max(120).optional(),
    answer: z.string().trim().min(1).max(4_000),
    /**
     * Every answer of a multi-question step in one command, each tied to the
     * question it answers. `answer` alone still serves a single-question
     * step. One command means one revision, one rerun, and no answer lost
     * between calls.
     */
    answers: z
      .array(
        z.object({
          questionId: z.string().trim().min(1),
          answer: z.string().trim().min(1).max(4_000),
        }),
      )
      .max(50)
      .optional(),
    saveForFuture: z.boolean().default(false),
  });
export type SubmitUserActionManualAnswerCommand = z.infer<
  typeof SubmitUserActionManualAnswerCommandSchema
>;

export const userActionLegalDecisionValues = ["accept", "decline"] as const;

export const UserActionLegalDecisionSchema = z.enum(
  userActionLegalDecisionValues,
);
export type UserActionLegalDecision = z.infer<
  typeof UserActionLegalDecisionSchema
>;

export const RecordUserActionLegalDecisionCommandSchema =
  UserActionCommandBaseSchema.extend({
    action: z.literal("record_legal_decision"),
    decision: UserActionLegalDecisionSchema,
  });
export type RecordUserActionLegalDecisionCommand = z.infer<
  typeof RecordUserActionLegalDecisionCommandSchema
>;

export const SkipUserActionCommandSchema = UserActionCommandBaseSchema.extend({
  action: z.literal("skip"),
  reason: UserActionLongTextSchema.nullable().default(null),
});
export type SkipUserActionCommand = z.infer<typeof SkipUserActionCommandSchema>;

export const CancelUserActionCommandSchema = UserActionCommandBaseSchema.extend(
  {
    action: z.literal("cancel"),
    reason: UserActionLongTextSchema.nullable().default(null),
  },
);
export type CancelUserActionCommand = z.infer<
  typeof CancelUserActionCommandSchema
>;

export const UserActionCommandSchema = z.discriminatedUnion("action", [
  OpenUserActionPageCommandSchema,
  ConfirmUserActionDoneCommandSchema,
  SubmitTaskLocalCredentialsCommandSchema,
  ChooseUserActionAccountPathCommandSchema,
  SubmitUserActionManualAnswerCommandSchema,
  RecordUserActionLegalDecisionCommandSchema,
  SkipUserActionCommandSchema,
  CancelUserActionCommandSchema,
]);
export type UserActionCommand = z.infer<typeof UserActionCommandSchema>;
export type UserActionCommandInput = z.input<typeof UserActionCommandSchema>;

export const userActionVerificationOutcomeValues = [
  "verified",
  "still_blocked",
] as const;

export const UserActionVerificationOutcomeSchema = z.enum(
  userActionVerificationOutcomeValues,
);
export type UserActionVerificationOutcome = z.infer<
  typeof UserActionVerificationOutcomeSchema
>;

export const UserActionVerificationResultSchema = z
  .object({
    requestId: UserActionIdentifierSchema,
    verificationId: UserActionIdentifierSchema,
    expectedRevision: z.number().int().positive(),
    outcome: UserActionVerificationOutcomeSchema,
    checkedAt: IsoDateTimeSchema,
    ...UserActionSafetyFields,
  })
  .strict();
export type UserActionVerificationResult = z.infer<
  typeof UserActionVerificationResultSchema
>;
export type UserActionVerificationResultInput = z.input<
  typeof UserActionVerificationResultSchema
>;

export const userActionEventOperationValues = [
  "created",
  "open_page",
  "confirm_done",
  "submit_task_local_credentials",
  "choose_account_path",
  "submit_manual_answer",
  "record_legal_decision",
  "skip",
  "cancel",
  "supersede",
  "verification_succeeded",
  "verification_failed",
] as const;

export const UserActionEventOperationSchema = z.enum(
  userActionEventOperationValues,
);
export type UserActionEventOperation = z.infer<
  typeof UserActionEventOperationSchema
>;

const UserActionEventIdentifierSchema = NonEmptyStringSchema.max(360);

export const UserActionEventSchema = z
  .object({
    id: UserActionEventIdentifierSchema,
    requestId: UserActionIdentifierSchema,
    operation: UserActionEventOperationSchema,
    previousRevision: z.number().int().nonnegative(),
    resultingRevision: z.number().int().positive(),
    previousState: UserActionRequestStateSchema,
    resultingState: UserActionRequestStateSchema,
    occurredAt: IsoDateTimeSchema,
    ...UserActionSafetyFields,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.operation === "created") {
      if (
        event.previousRevision !== 0 ||
        event.resultingRevision !== 1 ||
        event.previousState !== event.resultingState
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Created events must record revision one without changing lifecycle state.",
        });
      }
      return;
    }

    if (event.resultingRevision !== event.previousRevision + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultingRevision"],
        message: "User action events must advance exactly one revision.",
      });
    }
  });
export type UserActionEvent = z.infer<typeof UserActionEventSchema>;
export type UserActionEventInput = z.input<typeof UserActionEventSchema>;

/** Merge only the supplied fields, retaining the newest edit of each field. */
export function mergeUserActionAnswerDraft(
  current: Pick<UserActionRequest, "answerDraft" | "answerDraftFieldUpdatedAt">,
  patch: SaveUserActionAnswerDraftInput["draft"],
  editedAt: number,
): Pick<UserActionRequest, "answerDraft" | "answerDraftFieldUpdatedAt"> {
  if (patch === null)
    return { answerDraft: null, answerDraftFieldUpdatedAt: {} };
  const draft: UserActionAnswerDraft = {
    ...current.answerDraft,
    answers: { ...current.answerDraft?.answers },
    saveForFuture: current.answerDraft?.saveForFuture ?? true,
  };
  const times = { ...current.answerDraftFieldUpdatedAt };
  for (const [key, value] of Object.entries(patch.answers ?? {})) {
    const field = `answer:${key}`;
    if (editedAt <= (times[field] ?? 0)) continue;
    draft.answers[key] = value;
    times[field] = editedAt;
  }
  if (
    patch.saveForFuture !== undefined &&
    editedAt > (times.saveForFuture ?? 0)
  ) {
    draft.saveForFuture = patch.saveForFuture;
    times.saveForFuture = editedAt;
  }
  if (
    patch.hiringCountry !== undefined &&
    editedAt > (times.hiringCountry ?? 0)
  ) {
    draft.hiringCountry = patch.hiringCountry;
    times.hiringCountry = editedAt;
  }
  return { answerDraft: draft, answerDraftFieldUpdatedAt: times };
}
