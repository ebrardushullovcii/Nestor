import { z } from "zod";

import { ApplyRunDetailsSchema } from "./apply";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { DiscoveryFeedbackReasonSchema } from "./discovery";
import {
  ProfileCopilotContextSchema,
  ProfileCopilotPatchGroupSchema,
} from "./profile-copilot";
import { UserActionRequestSchema } from "./user-action";

export const jobFinderProductActionToolNameValues = [
  "get_workspace_summary",
  "list_needs_you",
  "get_apply_run_details",
  "propose_profile_change",
  "shortlist_job",
  "dismiss_job",
  "restore_job",
  "open_user_action",
] as const;
export const JobFinderProductActionToolNameSchema = z.enum(
  jobFinderProductActionToolNameValues,
);
export type JobFinderProductActionToolName = z.infer<
  typeof JobFinderProductActionToolNameSchema
>;

export const EmptyProductActionToolInputSchema = z.object({}).strict();
export const GetApplyRunDetailsToolInputSchema = z
  .object({
    runId: NonEmptyStringSchema.max(160),
    jobId: NonEmptyStringSchema.max(160),
  })
  .strict();
export const ProposeProfileChangeToolInputSchema = z
  .object({
    request: NonEmptyStringSchema.max(4_000),
    context: ProfileCopilotContextSchema.default({ surface: "general" }),
  })
  .strict();
export const JobIdProductActionToolInputSchema = z
  .object({ jobId: NonEmptyStringSchema.max(160) })
  .strict();
export const DismissJobToolInputSchema = z
  .object({
    jobId: NonEmptyStringSchema.max(160),
    reasons: z.array(DiscoveryFeedbackReasonSchema).min(1).max(9),
  })
  .strict();
export const OpenUserActionToolInputSchema = z
  .object({ requestId: NonEmptyStringSchema.max(160) })
  .strict();

export const ProductActionConfirmationPolicySchema = z
  .object({
    mode: z.enum(["not_required", "required"]),
    reason: NonEmptyStringSchema.max(280),
  })
  .strict();
export type ProductActionConfirmationPolicy = z.infer<
  typeof ProductActionConfirmationPolicySchema
>;

export const StrictObjectJsonSchemaSchema = z
  .object({
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    properties: z.record(z.unknown()),
    required: z.array(z.string()),
  })
  .strict();
export type StrictObjectJsonSchema = z.infer<
  typeof StrictObjectJsonSchemaSchema
>;

export const JobFinderProductActionToolDefinitionSchema = z
  .object({
    name: JobFinderProductActionToolNameSchema,
    description: NonEmptyStringSchema.max(500),
    inputJsonSchema: StrictObjectJsonSchemaSchema,
    confirmationPolicy: ProductActionConfirmationPolicySchema,
  })
  .strict();
export type JobFinderProductActionToolDefinition = z.infer<
  typeof JobFinderProductActionToolDefinitionSchema
>;

export const ProductActionAffectedEntitySchema = z
  .object({
    type: z.enum([
      "workspace",
      "job",
      "profile_proposal",
      "user_action",
      "apply_run",
    ]),
    id: NonEmptyStringSchema.max(160),
  })
  .strict();

export const productActionNextRouteValues = [
  "/job-finder/profile",
  "/job-finder/discovery",
  "/job-finder/review-queue",
  "/job-finder/actions",
  "/job-finder/applications",
] as const;
export const ProductActionNextRouteSchema = z.enum(
  productActionNextRouteValues,
);

export const ProductActionReceiptSchema = z
  .object({
    receiptId: NonEmptyStringSchema.max(200),
    tool: JobFinderProductActionToolNameSchema,
    executedAt: IsoDateTimeSchema,
    revision: z
      .object({
        kind: z.literal("snapshot_generated_at"),
        value: IsoDateTimeSchema,
      })
      .strict(),
    affectedEntities: z.array(ProductActionAffectedEntitySchema).max(32),
    nextRoute: ProductActionNextRouteSchema.nullable(),
  })
  .strict();
export type ProductActionReceipt = z.infer<typeof ProductActionReceiptSchema>;

export const ProductActionWorkspaceSummarySchema = z
  .object({
    profileReady: z.boolean(),
    discoveryJobs: z.number().int().nonnegative(),
    shortlistedJobs: z.number().int().nonnegative(),
    applications: z.number().int().nonnegative(),
    unresolvedUserActions: z.number().int().nonnegative(),
    discoveryRunState: NonEmptyStringSchema.max(80),
  })
  .strict();

export const ProductActionProfileProposalSchema = z
  .object({
    messageId: NonEmptyStringSchema.max(160),
    content: NonEmptyStringSchema.max(8_000),
    patchGroups: z.array(ProfileCopilotPatchGroupSchema),
  })
  .strict();

const ProductActionSuccessBaseSchema = z.object({
  ok: z.literal(true),
  receipt: ProductActionReceiptSchema,
});

export const ProductActionSuccessSchema = z.discriminatedUnion("tool", [
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("get_workspace_summary"),
    data: ProductActionWorkspaceSummarySchema,
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("list_needs_you"),
    data: z.object({ requests: z.array(UserActionRequestSchema) }).strict(),
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("get_apply_run_details"),
    data: ApplyRunDetailsSchema,
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("propose_profile_change"),
    data: ProductActionProfileProposalSchema,
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("shortlist_job"),
    data: z.object({ jobId: NonEmptyStringSchema, status: z.literal("shortlisted") }).strict(),
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("dismiss_job"),
    data: z.object({ jobId: NonEmptyStringSchema, status: z.literal("dismissed") }).strict(),
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("restore_job"),
    data: z.object({ jobId: NonEmptyStringSchema, status: z.literal("restored") }).strict(),
  }).strict(),
  ProductActionSuccessBaseSchema.extend({
    tool: z.literal("open_user_action"),
    data: z.object({ requestId: NonEmptyStringSchema, state: NonEmptyStringSchema }).strict(),
  }).strict(),
]);
export type ProductActionSuccess = z.infer<typeof ProductActionSuccessSchema>;

export const ProductActionErrorSchema = z
  .object({
    code: z.enum([
      "unknown_tool",
      "invalid_input",
      "confirmation_required",
      "not_found",
      "conflict",
      "execution_failed",
    ]),
    message: NonEmptyStringSchema.max(500),
    retryable: z.boolean(),
  })
  .strict();

export const ProductActionFailureSchema = z
  .object({
    ok: z.literal(false),
    tool: JobFinderProductActionToolNameSchema.nullable(),
    error: ProductActionErrorSchema,
  })
  .strict();
export type ProductActionFailure = z.infer<typeof ProductActionFailureSchema>;

export const ProductActionExecutionResultSchema = z.union([
  ProductActionSuccessSchema,
  ProductActionFailureSchema,
]);
export type ProductActionExecutionResult = z.infer<
  typeof ProductActionExecutionResultSchema
>;
