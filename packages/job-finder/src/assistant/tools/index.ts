import type { AssistantScreen } from "@nestor/contracts";
import { z } from "zod";
import type { AssistantToolDefinition, AssistantToolGroup } from "../tool-kit";
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
  "action_write_clipboard_text",
  "read_result",
  "ask_person",
  "list_needs_you",
  "undo_change",
  "list_jobs",
];
// Keep orientation and the current screen's small actions available. Large
// edit schemas load by exact name once the person's request needs them.
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
  applications: [
    "list_applications",
    "list_application_work",
    "applications_for_jobs",
    "send_application",
  ],
  actions: ["get_need"],
  settings: ["get_settings"],
  browser: ["browser_observe"],
};

function toolLoadResult(
  names: readonly string[],
  menu: readonly AssistantToolDefinition[],
  unknownNames: readonly string[] = [],
) {
  return {
    summary:
      (names.length
        ? `Loaded schemas: ${names.join(", ")}.`
        : "No schemas loaded. Call already offered tools directly, or choose exact names from the menu.") +
      (unknownNames.length
        ? ` Unavailable names: ${unknownNames.join(", ")}. Use the matching names below; valid names in this request were still loaded.`
        : ""),
    data: {
      names: [...names],
      unknownNames: [...unknownNames],
      availableTools: menu.map(({ name, description }) => ({
        name,
        description: description.slice(0, 100),
      })),
    },
  };
}

export const loadToolsTool = defineTool({
  name: "load_tools",
  group: "workspace",
  description:
    "Call tools already offered directly. Load schemas with names. Groups load small catalogs directly; large groups return a menu for choosing exact names. Unknown names return matching names without discarding valid requests. Domains: profile (profile/preferences edits, Undo, setup), files (library, import, exports), resume (write, edit, approve, history, PDF), jobs (find, shortlist, hide, sources), applications (queues, prepare, send with grants, forms, letters), tracking (Applications statuses, notes, replies, reminders, interviews, tags, saved views, CSV export and Undo), settings (applying policy, AI behavior, theme, zoom, reset), browser (read and work in a lent tab), workspace (summary, questions, navigation, copy text to clipboard). Loaded schemas stay available this turn.",
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
    return Promise.resolve(
      toolLoadResult(
        input.names ?? [],
        input.groups.flatMap((group) => ASSISTANT_TOOL_GROUPS[group]),
      ),
    );
  },
});

export function buildAssistantToolCatalog(options: {
  commands?: readonly AssistantToolDefinition[];
  mode: AssistantCatalogMode;
  browserAvailable: boolean;
  screen?: AssistantScreen | null;
  loadedGroups?: readonly AssistantToolGroup[];
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
      execute(input: z.infer<typeof loadToolsTool.input>) {
        const all = assistantToolGroupValues
          .filter(include)
          .flatMap(groupTools);
        const available = new Set(all.map((tool) => tool.name));
        const unknown = (input.names ?? []).filter(
          (name) => !available.has(name),
        );
        const discovered = input.groups.filter(include).flatMap(groupTools);
        const smallGroups = input.groups.filter(include).flatMap((group) => {
          const catalog = groupTools(group);
          // Bound schema expansion, including the large complete-draft schema.
          const bytes = JSON.stringify(
            catalog.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          ).length;
          return bytes <= 12_000 ? catalog.map((tool) => tool.name) : [];
        });
        const names = [
          ...new Set([
            ...(input.names ?? []).filter((name) => available.has(name)),
            ...smallGroups,
          ]),
        ];
        options.onLoadToolNames?.(names);
        const matches = unknown.flatMap((query) => {
          const words = query
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean);
          return all
            .map((tool) => ({
              tool,
              score: words.filter((word) => tool.name.includes(word)).length,
            }))
            .filter(({ score }) => score > 0)
            .sort(
              (a, b) =>
                b.score - a.score || a.tool.name.localeCompare(b.tool.name),
            )
            .slice(0, 5)
            .map(({ tool }) => tool);
        });
        const menu = [
          ...new Map(
            [...discovered, ...matches].map((tool) => [tool.name, tool]),
          ).values(),
        ];
        return Promise.resolve(toolLoadResult(names, menu, unknown));
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
