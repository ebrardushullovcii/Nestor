import type { AssistantScreen } from "@nestor/contracts";
import { z } from "zod";

import {
  assistantToolGroupValues,
  defineTool,
  json,
  type AssistantToolDefinition,
  type AssistantToolGroup,
  type AssistantToolContext,
} from "../tool-kit";
import { applicationTools, trackingTools } from "./application-tools";
import { browserTools } from "./browser-tools";
import { jobsTools } from "./jobs-tools";
import { fileTools, profileTools } from "./profile-tools";
import { resumeTools } from "./resume-tools";
import { settingsTools } from "./settings-tools";
import { searchPlanTools } from "./search-plan-tools";
import { workspaceTools } from "./workspace-tools";
import { registeredActionTools } from "./registered-action-tools";

export { undoReceipt } from "./profile-tools";
export { cancelBackgroundBatch, readBackgroundBatch } from "./resume-tools";

/**
 * The tool catalog (plan §6). Every group is present in a fixed order so the
 * prompt prefix and schemas stay cacheable. Group loading exists for routes
 * where the flat catalog proves too costly: common tools, the groups
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

for (const tool of registeredActionTools) {
  ASSISTANT_TOOL_GROUPS[tool.group] = [...ASSISTANT_TOOL_GROUPS[tool.group], tool];
}

export type AssistantCatalogMode = "flat" | "grouped";

const COMMON_TOOLS = [
  "read_profile", "edit_profile", "get_job", "query_jobs", "shortlist_jobs",
  "remove_from_shortlist", "list_sources", "update_sources", "undo_change",
];
const SCREEN_TOOLS: Partial<Record<AssistantScreen, string[]>> = {
  home: ["get_workspace_summary", "list_needs_you", "list_tracker_agenda"],
  profile: ["finish_profile_setup", "list_documents", "import_resume", "resolve_import_suggestion"],
  setup: ["finish_profile_setup", "list_documents", "import_resume", "resolve_import_suggestion"],
  discovery: ["search_for_jobs", "cancel_search", "dismiss_jobs", "restore_jobs", "show_jobs"],
  rapid_review: ["dismiss_jobs", "restore_jobs", "show_jobs"],
  review_queue: ["read_resume", "generate_resumes", "set_resume_level", "record_instruction", "apply_to_jobs", "action_clear_resume_approval", "action_approve_resumes"],
  resume_studio: ["read_resume", "edit_resume", "revise_resume", "preview_resume", "export_resume", "set_resume_template", "restore_resume_version"],
  applications: ["list_applications", "get_application", "record_instruction", "apply_to_jobs", "send_applications", "continue_application", "answer_application_question", "cancel_applications", "action_return_application_to_shortlist", "action_control_apply_queue"],
  actions: ["list_needs_you", "resolve_needs_you"],
  settings: ["read_settings", "update_apply_settings", "update_ai_behavior", "update_workspace_behavior", "set_appearance", "pause_activity", "action_zoom"],
  campaigns: ["list_search_plans", "save_search_plan", "select_search_plan", "search_for_jobs"],
  companies: ["action_read_action_state", "set_company_preference", "action_mutate_company_intelligence"],
  analytics: ["action_read_action_state", "record_outcome"],
  safeguards: ["action_get_safeguards", "action_mutate_safeguards"],
};

export const loadToolsTool = defineTool({
  name: "load_tools",
  group: "workspace",
  description:
    "Load tools for any task, regardless of the current screen: profile (edit profile and search preferences, Undo, setup), files (documents and resume import), resume (write, edit, approve and export), jobs (find, shortlist, hide, sources), applications (prepare, send with grants, documents), tracking (stages, reminders, interviews), settings (AI behavior, applying policy, search plans), browser (read and work in a lent tab), workspace (summary, questions, navigation). Loaded groups stay available this turn.",
  parameters: json.object(
    { groups: json.array(json.enumOf(assistantToolGroupValues)), names: json.ids("Load exact tool names when known, to keep the prompt small.") },
  ),
  input: z.object({
    groups: z.array(z.enum(assistantToolGroupValues)).max(9).default([]),
    names: z.array(z.string().min(1)).max(30).optional(),
  }),
  label: () => "Loading more tools",
  effect: "read",
  execute(input) {
    return Promise.resolve({
      summary: `Loaded: ${[...input.groups, ...(input.names ?? [])].join(", ")}. They are available from your next step.`,
      data: { groups: input.groups, names: input.names ?? [] },
    });
  },
});

export function buildAssistantToolCatalog(options: {
  mode: AssistantCatalogMode;
  browserAvailable: boolean;
  screen?: AssistantScreen | null;
  loadedGroups?: readonly AssistantToolGroup[];
  onLoadGroups?: (groups: readonly AssistantToolGroup[]) => void;
  loadedToolNames?: readonly string[];
  onLoadToolNames?: (names: readonly string[]) => void;
}): AssistantToolDefinition[] {
  const include = (group: AssistantToolGroup) =>
    group !== "browser" || options.browserAvailable;
  if (options.mode === "flat") {
    return assistantToolGroupValues
      .filter(include)
      .flatMap((group) => ASSISTANT_TOOL_GROUPS[group]);
  }
  const groups = new Set(options.loadedGroups ?? []);
  if (options.screen === "browser") groups.add("browser");
  const initialNames = new Set([...COMMON_TOOLS, ...(SCREEN_TOOLS[options.screen ?? "other"] ?? []), ...(options.loadedToolNames ?? [])]);
  const tools = assistantToolGroupValues
    .filter(include)
    .flatMap((group) =>
      ASSISTANT_TOOL_GROUPS[group].filter(
        (tool) => groups.has(group) || initialNames.has(tool.name),
      ),
    );
  return [
    ...tools,
    {
      ...loadToolsTool,
      execute(
        input: z.infer<typeof loadToolsTool.input>,
        context: AssistantToolContext,
      ) {
        const unknown = (input.names ?? []).filter((name) => !listAllAssistantToolNames().includes(name));
        if (unknown.length) throw new Error(`Unknown tools: ${unknown.join(", ")}`);
        options.onLoadGroups?.(input.groups);
        options.onLoadToolNames?.(input.names ?? []);
        return loadToolsTool.execute(input, context);
      },
    },
  ];
}

/** Every tool name, for the action inventory check. */
export function listAllAssistantToolNames(): string[] {
  return assistantToolGroupValues.flatMap((group) =>
    ASSISTANT_TOOL_GROUPS[group].map((tool) => tool.name),
  );
}
