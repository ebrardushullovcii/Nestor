import type { AssistantScreen } from "@nestor/contracts";
import { z } from "zod";
import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolGroup,
} from "../tool-kit";
import { assistantToolGroupValues, defineTool, json } from "../tool-kit";
import { applicationTools, trackingTools } from "./application-tools";
import { browserTools } from "./browser-tools";
import { jobsTools } from "./jobs-tools";
import { fileTools, profileTools } from "./profile-tools";
import { registeredActionTools } from "./registered-action-tools";
import { resumeTools } from "./resume-tools";
import { settingsTools } from "./settings-tools";
import { workspaceTools } from "./workspace-tools";

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
  settings: settingsTools,
  browser: browserTools,
};

for (const tool of registeredActionTools) {
  ASSISTANT_TOOL_GROUPS[tool.group] = [
    ...ASSISTANT_TOOL_GROUPS[tool.group],
    tool,
  ];
}

export type AssistantCatalogMode = "flat" | "grouped";

const COMMON_TOOLS = [
  "open_in_app", "read_result", "ask_person", "list_needs_you", "undo_change",
  "get_application", "answer_application_question", "read_profile", "get_job",
  "list_jobs", "set_default_resume_level",
];
const SCREEN_TOOLS: Partial<Record<AssistantScreen, string[]>> = {
  home: ["get_workspace_summary", "list_needs_you", "list_tracker_agenda"],
  profile: ["edit_profile", "finish_profile_setup", "list_documents", "import_resume", "resolve_import_suggestion",
  ],
  setup: ["edit_profile", "finish_profile_setup", "list_documents", "import_resume", "resolve_import_suggestion",
  ],
  discovery: ["list_sites", "start_search", "stop_search", "search_status", "move_jobs", "undo_move",
  ],
  review_queue: ["list_shortlisted", "get_resume", "save_resume", "set_resume_level", "undo_resume_level", "rewrite_resume", "approve_resume", "record_instruction", "apply_to_jobs",
  ],
  resume_studio: [
    "read_resume",
    "edit_resume",
    "revise_resume",
    "preview_resume",
    "export_resume",
    "set_resume_template",
    "restore_resume_version",
  ],
  applications: [
    "list_applications",
    "get_application",
    "record_instruction",
    "apply_to_jobs",
    "send_applications",
    "continue_application",
    "answer_application_question",
    "cancel_applications",
    "action_return_application_to_shortlist",
    "action_control_apply_queue",
  ],
  actions: ["list_needs_you", "resolve_needs_you"],
  settings: [
    "read_settings",
    "update_apply_settings",
    "update_ai_behavior",
    "update_workspace_behavior",
    "set_appearance",
    "pause_activity",
    "action_zoom",
  ],
};

export const loadToolsTool = defineTool({
  name: "load_tools",
  group: "workspace",
  description:
    "Load tools for any task, regardless of the current screen: profile (profile/preferences edits, Undo, setup), files (library, import, exports), resume (write, edit, approve, history, PDF), jobs (find, shortlist, hide, sources), applications (queues, prepare, send with grants, forms, letters), tracking (stages, notes, reminders, interviews, companies, outcomes), settings (applying policy, AI behavior, theme, zoom, reset), browser (read and work in a lent tab), workspace (summary, questions, navigation). Loaded groups stay available this turn.",
  parameters: json.object({
    groups: json.array(json.enumOf(assistantToolGroupValues)),
    names: json.ids(
      "Load exact tool names when known, to keep the prompt small.",
    ),
  }),
  input: z.object({
    groups: z.array(z.enum(assistantToolGroupValues)).max(9).default([]),
    names: z.array(z.string().min(1)).max(30).optional(),
  }),
  label: () => "Loading more tools",
  effect: "read",
  execute(input) {
    return Promise.resolve({
      summary: `Loaded: ${[...input.groups, ...(input.names ?? [])].join(", ")}. They are available from your next step.`,
      data: {
        groups: input.groups,
        names: [
          ...new Set([
            ...input.groups.flatMap((group) =>
              ASSISTANT_TOOL_GROUPS[group].map((tool) => tool.name),
            ),
            ...(input.names ?? []),
          ]),
        ],
      },
    });
  },
});

export function buildAssistantToolCatalog(options: {
  commands?: readonly AssistantToolDefinition[];
  mode: AssistantCatalogMode;
  browserAvailable: boolean;
  screen?: AssistantScreen | null;
  loadedGroups?: readonly AssistantToolGroup[];
  onLoadGroups?: (groups: readonly AssistantToolGroup[]) => void;
  loadedToolNames?: readonly string[];
  onLoadToolNames?: (names: readonly string[]) => void;
}): AssistantToolDefinition[] {
  const commands = options.commands ?? [];
  const commandNames = new Set(commands.flatMap((tool) => [tool.name, ...(tool.replaces ?? [])]));
  const groupTools = (group: AssistantToolGroup) => [
    ...ASSISTANT_TOOL_GROUPS[group].filter((tool) => !commandNames.has(tool.name)),
    ...commands.filter((tool) => tool.group === group),
  ];
  const include = (group: AssistantToolGroup) =>
    group !== "browser" || options.browserAvailable;
  if (options.mode === "flat") {
    return assistantToolGroupValues
      .filter(include)
      .flatMap(groupTools);
  }
  const groups = new Set(options.loadedGroups ?? []);
  if (options.screen === "browser") groups.add("browser");
  const initialNames = new Set([
    ...COMMON_TOOLS,
    ...(SCREEN_TOOLS[options.screen ?? "other"] ?? []),
    ...(options.loadedToolNames ?? []),
  ]);
  const tools = assistantToolGroupValues
    .filter(include)
    .flatMap((group) =>
      groupTools(group).filter(
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
        const available = new Set(assistantToolGroupValues.filter(include).flatMap(groupTools).map((tool) => tool.name));
        const unknown = (input.names ?? []).filter((name) => !available.has(name));
        if (unknown.length)
          throw new Error(`Unknown tools: ${unknown.join(", ")}`);
        const names = [...new Set([
          ...(input.names ?? []),
          ...input.groups.flatMap((group) => groupTools(group).map((tool) => tool.name)),
        ])];
        options.onLoadGroups?.(input.groups);
        options.onLoadToolNames?.(names);
        return loadToolsTool.execute({ groups: [], names }, context);
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
