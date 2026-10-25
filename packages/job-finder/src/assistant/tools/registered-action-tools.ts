import { JobFinderRegisteredActionInputSchema } from "@nestor/contracts";

import {
  JOB_FINDER_ACTIONS,
  jobFinderActionToolName,
} from "../action-registry";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AssistantToolError,
  defineTool,
  type AssistantToolContext,
  type AssistantToolDefinition,
} from "../tool-kit";

function compactResult(value: unknown, input: unknown): unknown {
  if (!value || typeof value !== "object" || !("discoveryJobs" in value))
    return value;
  const snapshot = value as Awaited<
    ReturnType<AssistantToolContext["service"]["getWorkspaceSnapshot"]>
  >;
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    activeCampaignId: snapshot.activeCampaignId,
    activityControl: snapshot.activityControl,
    applyQueue: snapshot.applyQueue,
    ...(record.campaignId
      ? {
          campaign: snapshot.campaigns.find(
            (campaign) => campaign.id === record.campaignId,
          ),
        }
      : {}),
    ...(record.applicationRecordId
      ? {
          application: snapshot.applicationRecords.find(
            (application) => application.id === record.applicationRecordId,
          ),
        }
      : {}),
    counts: {
      found: snapshot.discoveryJobs.length,
      shortlisted: snapshot.reviewQueue.length,
      applications: snapshot.applicationRecords.length,
    },
  };
}

export async function executeRegisteredAssistantAction(
  raw: unknown,
  context: AssistantToolContext,
  confirmed = false,
) {
  const { actionId, input } = JobFinderRegisteredActionInputSchema.parse(raw);
  const action = Object.hasOwn(JOB_FINDER_ACTIONS, actionId)
    ? JOB_FINDER_ACTIONS[actionId as keyof typeof JOB_FINDER_ACTIONS]
    : null;
  if (!action || action.tool?.custom || action.safety === "application") {
    throw new AssistantToolError(
      "refused",
      "Use the named assistant tool for that action; its grants and edit safeguards are required.",
    );
  }
  const parsed: unknown = action.input.parse(input);
  context.session.assertCurrent();
  if (action.safety === "confirm" && !confirmed) {
    const { part } = await context.session.createProposal({
      kind: "job_finder_action",
      targetId: null,
      summary: action.description,
      baseRevision: null,
      items: [
        {
          id: context.session.createId("action"),
          label: action.description,
          detail: JSON.stringify(parsed, null, 2),
          payload: { actionId, input: parsed },
        },
      ],
    });
    return {
      summary: "Proposed for your confirmation. Nothing changed yet.",
      parts: [part],
    };
  }
  const result = await action.run(parsed, {
    service: context.service,
    ...(context.ports.executeAction
      ? {
          host: (id: string, value: unknown) =>
            context.ports.executeAction!(id, value),
        }
      : {}),
  });
  if (action.safety !== "read") context.ports.publishWorkspaceUpdate();
  const data = compactResult(result, parsed);
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    ["cancelled", "stale", "refused"].includes(String(result.status))
  )
    return {
      summary: "Nothing changed: the action was cancelled, stale or refused.",
      status: "refused" as const,
      data,
    };
  if (result === false)
    return {
      summary:
        "Nothing changed; the action was refused or the item no longer exists.",
      status: "refused" as const,
      data,
    };
  // Large read results remain available by handle instead of being cut off.
  if (data !== undefined && JSON.stringify(data).length > 9_000) {
    const items = JSON.stringify(data, null, 2).match(/[\s\S]{1,3000}/gu) ?? [];
    return {
      summary: action.description,
      data: context.session.handles.put(action.description, items),
    };
  }
  return { summary: `Completed: ${action.description}`, data };
}

export const registeredActionTools: AssistantToolDefinition[] = Object.entries(
  JOB_FINDER_ACTIONS,
)
  .filter(
    ([, action]) => !action.tool?.custom && action.safety !== "application",
  )
  .map(([actionId, action]) => {
    let parameters: AssistantToolDefinition["parameters"] | undefined;
    return defineTool({
      name: action.tool?.name ?? jobFinderActionToolName(actionId),
      group: action.group,
      description: `${action.description}${action.safety === "confirm" ? " Proposes a confirmation card; only the person's Apply press executes it." : ""}`,
      input: action.input,
      get parameters() {
        if (!parameters) {
          const derived = zodToJsonSchema(action.input, {
            $refStrategy: "none",
          }) as Record<string, unknown>;
          parameters = {
            ...derived,
            type: "object",
            properties: (derived.properties ?? {}) as Record<string, unknown>,
          };
        }
        return parameters;
      },
      effect: action.safety === "read" ? "read" : "local_write",
      label: () => action.description,
      execute: (input, context) =>
        executeRegisteredAssistantAction({ actionId, input }, context),
    });
  });
