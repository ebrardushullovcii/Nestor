import type { AssistantScreen } from "@nestor/contracts";
import { z } from "zod";

import {
  assistantToolGroupValues,
  defineTool,
  json,
  type AssistantToolDefinition,
  type AssistantToolGroup,
} from "../tool-kit";
import { applicationTools, trackingTools } from "./application-tools";
import { browserTools } from "./browser-tools";
import { jobsTools } from "./jobs-tools";
import { fileTools, profileTools } from "./profile-tools";
import { resumeTools } from "./resume-tools";
import { settingsTools } from "./settings-tools";
import { searchPlanTools } from "./search-plan-tools";
import { workspaceTools } from "./workspace-tools";

export { undoReceipt } from "./profile-tools";
export { cancelBackgroundBatch, readBackgroundBatch } from "./resume-tools";

/**
 * The tool catalog (plan §6). Every group is present in a fixed order so the
 * prompt prefix and schemas stay cacheable. Group loading exists for routes
 * where the flat catalog proves too costly: common and read tools, the groups
 * the screen suggests, and `load_tools` for the rest.
 */
export const ASSISTANT_TOOL_GROUPS: Record<
  AssistantToolGroup,
  readonly AssistantToolDefinition[]
> = {
  workspace: workspaceTools,
  profile: profileTools,
  files: fileTools,
  resume: resumeTools,
  jobs: jobsTools,
  applications: applicationTools,
  tracking: trackingTools,
  settings: [...settingsTools, ...searchPlanTools],
  browser: browserTools,
};

export type AssistantCatalogMode = "flat" | "grouped";

const SCREEN_GROUPS: Partial<Record<AssistantScreen, AssistantToolGroup[]>> = {
  profile: ["profile", "files"],
  setup: ["profile", "files"],
  resume_studio: ["resume"],
  discovery: ["jobs"],
  review_queue: ["jobs", "resume", "applications"],
  applications: ["applications", "tracking"],
  actions: ["applications"],
  settings: ["settings"],
  campaigns: ["settings", "jobs"],
  companies: ["jobs", "settings"],
  browser: ["browser", "jobs", "applications"],
};

export const loadToolsTool = defineTool({
  name: "load_tools",
  group: "workspace",
  description: `Makes a group of tools available from your next step: ${assistantToolGroupValues.join(", ")}.`,
  parameters: json.object(
    { groups: json.array(json.enumOf(assistantToolGroupValues)) },
    ["groups"],
  ),
  input: z.object({
    groups: z.array(z.enum(assistantToolGroupValues)).min(1).max(9),
  }),
  label: () => "Loading more tools",
  effect: "read",
  execute(input) {
    return Promise.resolve({
      summary: `Loaded: ${input.groups.join(", ")}. They are available from your next step.`,
      data: { groups: input.groups },
    });
  },
});

export function buildAssistantToolCatalog(options: {
  mode: AssistantCatalogMode;
  browserAvailable: boolean;
  screen?: AssistantScreen | null;
  loadedGroups?: readonly AssistantToolGroup[];
}): AssistantToolDefinition[] {
  const include = (group: AssistantToolGroup) =>
    group !== "browser" || options.browserAvailable;
  if (options.mode === "flat") {
    return assistantToolGroupValues
      .filter(include)
      .flatMap((group) => ASSISTANT_TOOL_GROUPS[group]);
  }
  const groups = new Set<AssistantToolGroup>(["workspace"]);
  for (const group of SCREEN_GROUPS[options.screen ?? "other"] ?? []) {
    groups.add(group);
  }
  for (const group of options.loadedGroups ?? []) groups.add(group);
  const tools = assistantToolGroupValues
    .filter((group) => groups.has(group) && include(group))
    .flatMap((group) => ASSISTANT_TOOL_GROUPS[group]);
  // Read tools of every group stay present so questions work anywhere.
  const reads = assistantToolGroupValues
    .filter(
      (group) => !groups.has(group) && include(group) && group !== "browser",
    )
    .flatMap((group) =>
      ASSISTANT_TOOL_GROUPS[group].filter((tool) => tool.effect === "read"),
    );
  return [...tools, ...reads, loadToolsTool];
}

/** Every tool name, for the action inventory check. */
export function listAllAssistantToolNames(): string[] {
  return assistantToolGroupValues.flatMap((group) =>
    ASSISTANT_TOOL_GROUPS[group].map((tool) => tool.name),
  );
}
