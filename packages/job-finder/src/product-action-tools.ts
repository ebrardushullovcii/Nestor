import {
  EmptyProductActionToolInputSchema,
  GetApplyRunDetailsToolInputSchema,
  JobFinderProductActionToolDefinitionSchema,
  JobFinderProductActionToolNameSchema,
  JobIdProductActionToolInputSchema,
  OpenUserActionToolInputSchema,
  ProductActionExecutionResultSchema,
  ProposeProfileChangeToolInputSchema,
  profileCopilotProfileSectionValues,
  profileSetupStepValues,
  type JobFinderProductActionToolDefinition,
  type JobFinderProductActionToolName,
  type JobFinderWorkspaceSnapshot,
  type ProductActionExecutionResult,
  type ProductActionReceipt,
  type StrictObjectJsonSchema,
} from "@nestor/contracts";

import { PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE } from "./internal/workspace-profile-copilot-methods";
import type { JobFinderWorkspaceService } from "./internal/workspace-service-contracts";

type ProductActionCapabilities = Pick<
  JobFinderWorkspaceService,
  | "getApplyRunDetails"
  | "getWorkspaceSnapshot"
  | "performUserAction"
  | "proposeProfileCopilotChange"
  | "queueJobForReview"
>;

interface ProductActionExecutionContext {
  confirmed?: boolean;
}

interface CreateProductActionToolRegistryOptions {
  now?: () => string;
  createReceiptId?: () => string;
}

interface ProductActionToolRuntimeDefinition {
  definition: JobFinderProductActionToolDefinition;
  inputSchema: {
    safeParse(value: unknown): { success: boolean };
  };
}

const emptyJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} satisfies StrictObjectJsonSchema;

const stringIdJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 160,
} as const;

function createDefinition(
  definition: JobFinderProductActionToolDefinition,
  inputSchema: ProductActionToolRuntimeDefinition["inputSchema"],
): ProductActionToolRuntimeDefinition {
  return {
    definition: JobFinderProductActionToolDefinitionSchema.parse(definition),
    inputSchema,
  };
}

const runtimeDefinitions = [
  createDefinition(
    {
      name: "get_workspace_summary",
      description: "Read bounded Job Finder readiness and workflow counts.",
      inputJsonSchema: emptyJsonSchema,
      confirmationPolicy: {
        mode: "not_required",
        reason: "This tool only reads a bounded workspace summary.",
      },
    },
    EmptyProductActionToolInputSchema,
  ),
  createDefinition(
    {
      name: "list_needs_you",
      description:
        "List unresolved user-action requests without resolving them.",
      inputJsonSchema: emptyJsonSchema,
      confirmationPolicy: {
        mode: "not_required",
        reason: "This tool only reads existing user-action requests.",
      },
    },
    EmptyProductActionToolInputSchema,
  ),
  createDefinition(
    {
      name: "get_apply_run_details",
      description: "Read persisted details for one exact apply run and job.",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { runId: stringIdJsonSchema, jobId: stringIdJsonSchema },
        required: ["runId", "jobId"],
      },
      confirmationPolicy: {
        mode: "not_required",
        reason: "This tool only reads an existing run scoped to one job.",
      },
    },
    GetApplyRunDetailsToolInputSchema,
  ),
  createDefinition(
    {
      name: "propose_profile_change",
      description:
        "Create reviewable Profile Copilot patch groups from a normal-language request without applying them.",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: { type: "string", minLength: 1, maxLength: 4_000 },
          context: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: { surface: { const: "general" } },
                required: ["surface"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  surface: { const: "setup" },
                  step: {
                    enum: [...profileSetupStepValues],
                  },
                },
                required: ["surface", "step"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  surface: { const: "profile" },
                  section: {
                    enum: [...profileCopilotProfileSectionValues],
                  },
                },
                required: ["surface", "section"],
              },
            ],
          },
        },
        required: ["request"],
      },
      confirmationPolicy: {
        mode: "not_required",
        reason:
          "This only creates a proposal; every patch remains awaiting review.",
      },
    },
    ProposeProfileChangeToolInputSchema,
  ),
  createDefinition(
    {
      name: "shortlist_job",
      description: "Move one exact discovered job into the review queue.",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { jobId: stringIdJsonSchema },
        required: ["jobId"],
      },
      confirmationPolicy: {
        mode: "required",
        reason: "This changes the user's saved workflow state for one job.",
      },
    },
    JobIdProductActionToolInputSchema,
  ),
  createDefinition(
    {
      name: "open_user_action",
      description:
        "Open the existing safe browser page for one unresolved Needs you request.",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { requestId: stringIdJsonSchema },
        required: ["requestId"],
      },
      confirmationPolicy: {
        mode: "required",
        reason:
          "This opens an external page but grants no credentials, account creation, or submit authority.",
      },
    },
    OpenUserActionToolInputSchema,
  ),
] as const;

const runtimeByName = new Map(
  runtimeDefinitions.map((runtime) => [runtime.definition.name, runtime]),
);

function buildReceipt(input: {
  tool: JobFinderProductActionToolName;
  snapshot: JobFinderWorkspaceSnapshot;
  affectedEntities: ProductActionReceipt["affectedEntities"];
  nextRoute: ProductActionReceipt["nextRoute"];
  now: () => string;
  createReceiptId: () => string;
}): ProductActionReceipt {
  return {
    receiptId: input.createReceiptId(),
    tool: input.tool,
    executedAt: input.now(),
    revision: {
      kind: "snapshot_generated_at",
      value: input.snapshot.generatedAt,
    },
    affectedEntities: input.affectedEntities,
    nextRoute: input.nextRoute,
  };
}

function failure(
  tool: JobFinderProductActionToolName | null,
  code:
    | "unknown_tool"
    | "invalid_input"
    | "confirmation_required"
    | "not_found"
    | "conflict"
    | "execution_failed",
  message: string,
  retryable = false,
): ProductActionExecutionResult {
  return ProductActionExecutionResultSchema.parse({
    ok: false,
    tool,
    error: { code, message, retryable },
  });
}

function toSafeFailure(tool: JobFinderProductActionToolName, error: unknown) {
  // The Assistant's outage sentence is written for the person and says the
  // question was kept. Replacing it with the generic failure turned "the AI
  // did not answer" into "something went wrong".
  if (
    error instanceof Error &&
    error.message === PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE
  ) {
    return failure(tool, "execution_failed", error.message, true);
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unknown") || message.includes("not found")) {
    return failure(
      tool,
      "not_found",
      "The requested Job Finder entity was not found.",
    );
  }
  if (message.includes("stale") || message.includes("conflict")) {
    return failure(
      tool,
      "conflict",
      "The workspace changed. Refresh it before retrying.",
      true,
    );
  }
  if (message.includes("closed")) {
    return failure(
      tool,
      "conflict",
      "This listing is explicitly closed and cannot be shortlisted.",
    );
  }
  return failure(
    tool,
    "execution_failed",
    "Job Finder could not complete this product action.",
    true,
  );
}

export function createJobFinderProductActionToolRegistry(
  capabilities: ProductActionCapabilities,
  options: CreateProductActionToolRegistryOptions = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  const createReceiptId =
    options.createReceiptId ??
    (() =>
      `product_action_receipt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  async function execute(
    rawName: string,
    rawInput: unknown,
    context: ProductActionExecutionContext = {},
  ): Promise<ProductActionExecutionResult> {
    const parsedName = JobFinderProductActionToolNameSchema.safeParse(rawName);
    if (!parsedName.success) {
      return failure(
        null,
        "unknown_tool",
        "This Job Finder product action is not available.",
      );
    }
    const tool = parsedName.data;
    const runtime = runtimeByName.get(tool);
    if (!runtime) {
      return failure(
        null,
        "unknown_tool",
        "This Job Finder product action is not available.",
      );
    }
    const parsedInput = runtime.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return failure(
        tool,
        "invalid_input",
        "The product action input is invalid.",
      );
    }
    if (
      runtime.definition.confirmationPolicy.mode === "required" &&
      context.confirmed !== true
    ) {
      return failure(
        tool,
        "confirmation_required",
        "Confirm this scoped product action before it runs.",
      );
    }

    try {
      switch (tool) {
        case "get_workspace_summary": {
          const snapshot = await capabilities.getWorkspaceSnapshot();
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: [{ type: "workspace", id: "job-finder" }],
              nextRoute: null,
              now,
              createReceiptId,
            }),
            data: {
              profileReady: snapshot.profileSetupState.status === "completed",
              discoveryJobs: snapshot.discoveryJobs.length,
              shortlistedJobs: snapshot.reviewQueue.length,
              applications: snapshot.applicationRecords.length,
              unresolvedUserActions: snapshot.userActionRequests.filter(
                (request) =>
                  !["resolved", "cancelled", "skipped"].includes(request.state),
              ).length,
            },
          });
        }
        case "list_needs_you": {
          const snapshot = await capabilities.getWorkspaceSnapshot();
          const requests = snapshot.userActionRequests.filter(
            (request) =>
              !["resolved", "cancelled", "skipped"].includes(request.state),
          );
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: requests.map((request) => ({
                type: "user_action" as const,
                id: request.id,
              })),
              nextRoute: requests.length > 0 ? "/job-finder/actions" : null,
              now,
              createReceiptId,
            }),
            data: { requests },
          });
        }
        case "get_apply_run_details": {
          const input = GetApplyRunDetailsToolInputSchema.parse(rawInput);
          const [data, snapshot] = await Promise.all([
            capabilities.getApplyRunDetails(input.runId, input.jobId),
            capabilities.getWorkspaceSnapshot(),
          ]);
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: [
                { type: "apply_run", id: input.runId },
                { type: "job", id: input.jobId },
              ],
              nextRoute: "/job-finder/applications",
              now,
              createReceiptId,
            }),
            data,
          });
        }
        case "propose_profile_change": {
          const input = ProposeProfileChangeToolInputSchema.parse(rawInput);
          const snapshot = await capabilities.proposeProfileCopilotChange(
            input.request,
            input.context,
          );
          const message = [...snapshot.profileCopilotMessages]
            .reverse()
            .find((candidate) => candidate.role === "assistant");
          if (!message) throw new Error("Profile proposal was not found.");
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: message.patchGroups.map((patchGroup) => ({
                type: "profile_proposal" as const,
                id: patchGroup.id,
              })),
              nextRoute: "/job-finder/profile",
              now,
              createReceiptId,
            }),
            data: {
              messageId: message.id,
              content: message.content,
              patchGroups: message.patchGroups,
            },
          });
        }
        case "shortlist_job": {
          const input = JobIdProductActionToolInputSchema.parse(rawInput);
          const currentSnapshot = await capabilities.getWorkspaceSnapshot();
          const currentJob = currentSnapshot.discoveryJobs.find(
            (job) => job.id === input.jobId,
          );
          if (currentJob?.listingActivity.status === "closed") {
            throw new Error(
              `Unable to shortlist closed job '${input.jobId}'. The listing has explicit closed evidence.`,
            );
          }
          const snapshot = await capabilities.queueJobForReview(input.jobId);
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: [{ type: "job", id: input.jobId }],
              nextRoute: "/job-finder/review-queue",
              now,
              createReceiptId,
            }),
            data: { jobId: input.jobId, status: "shortlisted" },
          });
        }
        case "open_user_action": {
          const input = OpenUserActionToolInputSchema.parse(rawInput);
          const current = await capabilities.getWorkspaceSnapshot();
          const request = current.userActionRequests.find(
            (candidate) => candidate.id === input.requestId,
          );
          if (!request) throw new Error("User action not found.");
          const snapshot = await capabilities.performUserAction({
            action: "open_page",
            requestId: request.id,
            commandId: `product_action_open_${request.id}_${request.revision}`,
            expectedRevision: request.revision,
            credentialsPolicy: "browser_only",
            submitAuthorized: false,
            accountCreationAuthorized: false,
          });
          const updatedRequest = snapshot.userActionRequests.find(
            (candidate) => candidate.id === request.id,
          );
          return ProductActionExecutionResultSchema.parse({
            ok: true,
            tool,
            receipt: buildReceipt({
              tool,
              snapshot,
              affectedEntities: [{ type: "user_action", id: request.id }],
              nextRoute: "/job-finder/actions",
              now,
              createReceiptId,
            }),
            data: {
              requestId: request.id,
              state: updatedRequest?.state ?? request.state,
            },
          });
        }
      }
    } catch (error) {
      return toSafeFailure(tool, error);
    }
  }

  return {
    definitions: runtimeDefinitions.map((runtime) => runtime.definition),
    execute,
  };
}
