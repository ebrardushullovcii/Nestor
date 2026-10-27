import type { AssistantScreen } from "@nestor/contracts";
import { z } from "zod";
import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolGroup,
} from "../tool-kit";
import { assistantToolGroupValues, defineTool, json } from "../tool-kit";
import { applicationTools } from "./application-tools";
import { browserTools } from "./browser-tools";
import { jobsTools } from "./jobs-tools";
import { fileTools, profileTools } from "./profile-tools";
import { registeredActionTools } from "./registered-action-tools";
import { settingsTools } from "./settings-tools";
import { workspaceTools } from "./workspace-tools";

export { undoReceipt } from "./profile-tools";

/**
 * The tool catalog (plan §6). Every group is present in a fixed order so the
 * prompt prefix and schemas stay cacheable. Grouped mode starts with a small
 * read catalog; load_tools adds exact schemas for the requested work.
 */
export const ASSISTANT_TOOL_GROUPS: Record<
  AssistantToolGroup,
  readonly AssistantToolDefinition[]
> = {
  workspace: workspaceTools,
  profile: profileTools,
  files: fileTools,
  resume: [],
  jobs: jobsTools,
  applications: applicationTools,
  tracking: [],
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
  "open_in_app",
  "read_result",
  "ask_person",
  "list_needs_you",
  "undo_change",
  "list_jobs",
];
// Read-only orientation stays small. Edits and large resume schemas load by
// exact name once the person's request needs them; navigation alone is free.
const SCREEN_TOOLS: Partial<Record<AssistantScreen, string[]>> = {
  home: ["get_workspace_summary"],
  profile: [
    "get_profile",
    "list_profile_records",
    "get_profile_record",
    "get_profile_goals",
    "finish_profile_setup",
  ],
  setup: ["finish_profile_setup", "list_documents"],
  discovery: ["list_sites", "search_status"],
  review_queue: ["get_resume"],
  resume_studio: ["get_resume"],
  applications: ["list_applications", "applications_for_jobs"],
  actions: ["get_need"],
  settings: ["get_settings"],
};

export const loadToolsTool = defineTool({
  name: "load_tools",
  group: "workspace",
  description:
    "Load tools for any task, regardless of the current screen: profile (profile/preferences edits, Undo, setup), files (library, import, exports), resume (write, edit, approve, history, PDF), jobs (find, shortlist, hide, sources), applications (queues, prepare, send with grants, forms, letters), tracking (Applications statuses, notes, replies, reminders, interviews, tags, saved views, CSV export and Undo), settings (applying policy, AI behavior, theme, zoom, reset), browser (read and work in a lent tab), workspace (summary, questions, navigation). Loaded groups stay available this turn.",
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
  const commandNames = new Set(
    commands.flatMap((tool) => [tool.name, ...(tool.replaces ?? [])]),
  );
  const groupTools = (group: AssistantToolGroup) => [
    ...ASSISTANT_TOOL_GROUPS[group].filter(
      (tool) => !commandNames.has(tool.name),
    ),
    ...commands.filter((tool) => tool.group === group),
  ];
  const include = (group: AssistantToolGroup) =>
    group !== "browser" || options.browserAvailable;
  if (options.mode === "flat") {
    return assistantToolGroupValues.filter(include).flatMap(groupTools);
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
        const available = new Set(
          assistantToolGroupValues
            .filter(include)
            .flatMap(groupTools)
            .map((tool) => tool.name),
        );
        const unknown = (input.names ?? []).filter(
          (name) => !available.has(name),
        );
        if (unknown.length)
          throw new Error(`Unknown tools: ${unknown.join(", ")}`);
        const names = [
          ...new Set([
            ...(input.names ?? []),
            ...input.groups.flatMap((group) =>
              groupTools(group).map((tool) => tool.name),
            ),
          ]),
        ];
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
