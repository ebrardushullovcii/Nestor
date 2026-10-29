import { expect, test } from "vitest";
import {
  APPLICATION_COMMANDS,
  JOB_COMMANDS,
  PROFILE_COMMANDS,
  RESUME_COMMANDS,
  TRACKER_COMMANDS,
} from "@nestor/contracts";
import {
  assistantCommandTools,
  buildAssistantToolCatalog,
  needsYouCommandTools,
} from "@nestor/job-finder";
import { ACTION_INVENTORY } from "./inventory";

test("every detailed action mapping names a tool the assistant can discover", async () => {
  const reject = () => Promise.reject(new Error("Catalog only"));
  const commands = [
    ...assistantCommandTools(JOB_COMMANDS, reject, {
      group: (name) =>
        name === "get_settings" || name === "patch_settings"
          ? "settings"
          : name in PROFILE_COMMANDS
            ? "profile"
            : "jobs",
    }),
    ...assistantCommandTools(RESUME_COMMANDS, reject, { group: "resume" }),
    ...assistantCommandTools(TRACKER_COMMANDS, reject, { group: "tracking" }),
    ...assistantCommandTools(APPLICATION_COMMANDS, reject, {
      group: "applications",
    }),
    ...needsYouCommandTools(reject),
  ];
  const options = { commands, browserAvailable: true };
  const flat = buildAssistantToolCatalog({ ...options, mode: "flat" });
  const loader = buildAssistantToolCatalog({
    ...options,
    mode: "grouped",
  }).find((tool) => tool.name === "load_tools")!;
  const discovered = new Set<string>();
  for (const group of new Set(flat.map((tool) => tool.group))) {
    expect(loader.description).toContain(`${group} (`);
    const menu = await loader.execute(
      { groups: [group], names: [] },
      {} as never,
    );
    // The menu is what the model sees before asking for an exact schema.
    const data = menu.data as {
      availableTools: { name: string; description: string }[];
    };
    for (const tool of data.availableTools) {
      expect(tool.description.trim().length, tool.name).toBeGreaterThan(15);
      discovered.add(tool.name);
    }
  }
  const missing = new Set<string>();
  for (const entry of ACTION_INVENTORY) {
    if (entry.coverage.kind === "excluded") {
      expect(entry.coverage.reason.length, entry.id).toBeGreaterThan(10);
      continue;
    }
    expect(entry.coverage.tools.length, entry.id).toBeGreaterThan(0);
    for (const name of entry.coverage.tools) {
      if (!flat.some((tool) => tool.name === name)) missing.add(name);
      else
        expect(
          discovered.has(name),
          `${entry.id}: ${name} cannot be discovered`,
        ).toBe(true);
    }
  }
  expect([...missing].sort()).toEqual([]);
});
