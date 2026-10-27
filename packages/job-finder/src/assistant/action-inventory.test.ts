import {
  APPLICATION_COMMANDS,
  JOB_COMMANDS,
  NEEDS_YOU_COMMANDS,
  PROFILE_COMMANDS,
  RESUME_COMMANDS,
  TRACKER_COMMANDS,
  type ResumeCommandOutputs,
  type ProfileCommandOutputs,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { needsYouCommandTools } from "./needs-you-commands";
import { assistantCommandTools } from "./command-tools";
const needsCommands = needsYouCommandTools(() =>
  Promise.reject(new Error("No command execution in catalog test")),
);
import { ACTION_INVENTORY } from "./action-inventory";
import { buildAssistantToolCatalog, listAllAssistantToolNames } from "./tools";

describe("assistant action inventory", () => {
  it("loads a requested Profile edit without sending every edit schema on opening Profile", async () => {
    const commands = assistantCommandTools<
      typeof PROFILE_COMMANDS,
      ProfileCommandOutputs
    >(PROFILE_COMMANDS, () => Promise.reject(new Error("Catalog only")), {
      group: "profile",
    });
    const loaded = new Set<string>();
    const catalog = (screen: "profile" | "setup") =>
      buildAssistantToolCatalog({
        commands,
        mode: "grouped",
        browserAvailable: false,
        screen,
        loadedToolNames: [...loaded],
        onLoadToolNames: (names) => names.forEach((name) => loaded.add(name)),
      });
    for (const screen of ["profile", "setup"] as const) {
      const initial = catalog(screen);
      expect(initial.map((tool) => tool.name)).not.toEqual(
        expect.arrayContaining(["edit_profile"]),
      );
      expect(initial.some((tool) => tool.name === "finish_profile_setup")).toBe(
        true,
      );
    }
    const initial = catalog("profile");
    expect(initial.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_profile",
        "list_profile_records",
        "get_profile_record",
        "get_profile_goals",
      ]),
    );
    for (const name of ["patch_profile", "patch_profile_goals", "edit_profile"])
      expect(initial.some((tool) => tool.name === name), name).toBe(false);
    const loader = initial.find((tool) => tool.name === "load_tools")!;
    const loadedResult = await loader.execute(
      { groups: [], names: ["patch_profile"] },
      {} as never,
    );
    expect(loadedResult.data).toMatchObject({ names: ["patch_profile"] });
    const after = catalog("profile");
    expect(after.find((tool) => tool.name === "patch_profile")).toMatchObject({
      name: "patch_profile",
      parameters: commands.find((tool) => tool.name === "patch_profile")!
        .parameters,
    });
    expect(after.some((tool) => tool.name === "patch_profile_goals")).toBe(false);
    expect(after.some((tool) => tool.name === "edit_profile")).toBe(false);
    // Domain loading still reaches the other Profile actions when requested.
    await after.find((tool) => tool.name === "load_tools")!.execute(
      { groups: ["profile"], names: [] },
      {} as never,
    );
    const all = catalog("profile");
    for (const command of commands)
      expect(all.some((tool) => tool.name === command.name), command.name).toBe(
        true,
      );
  });

  it("offers the real resume commands and PDF export in the resume editor", () => {
    const commands = assistantCommandTools<
      typeof RESUME_COMMANDS,
      ResumeCommandOutputs
    >(RESUME_COMMANDS, () => Promise.reject(new Error("Catalog only")), {
      group: "resume",
    });
    const names = buildAssistantToolCatalog({
      commands,
      mode: "grouped",
      browserAvailable: false,
      screen: "resume_studio",
    }).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_resume",
        "save_resume",
        "approve_resume",
        "export_resume_pdf",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["read_resume", "export_resume"]),
    );
  });
  it("keeps initial screen catalogs below half the full schema payload", () => {
    const bytes = (tools: ReturnType<typeof buildAssistantToolCatalog>) =>
      JSON.stringify(
        tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ).length;
    const full = bytes(
      buildAssistantToolCatalog({
        commands: needsCommands,
        mode: "flat",
        browserAvailable: true,
      }),
    );
    for (const screen of ["home", "profile", "discovery"] as const) {
      const catalog = buildAssistantToolCatalog({
        mode: "grouped",
        browserAvailable: true,
        screen,
        commands: needsCommands,
      });
      expect(bytes(catalog), screen).toBeLessThan(full / 2);
      expect(catalog.some((tool) => tool.name === "load_tools")).toBe(true);
      // Background handoffs and off-screen questions use the same small core.
      expect(catalog.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "ask_person",
          "list_needs_you",
          "answer_need",
          "read_result",
        ]),
      );
    }
  });

  it("exposes guided setup Finish through the profile tool in the setup catalog", () => {
    expect(
      ACTION_INVENTORY.find((entry) => entry.id === "profile.setup_state"),
    ).toMatchObject({
      coverage: {
        kind: "tools",
        tools: ["read_profile", "finish_profile_setup"],
      },
    });
    expect(
      buildAssistantToolCatalog({
        mode: "grouped",
        browserAvailable: false,
        screen: "setup",
      }).map((tool) => tool.name),
    ).toContain("finish_profile_setup");
  });
  it("names only tools that exist", () => {
    const known = new Set([
      ...listAllAssistantToolNames(),
      ...Object.keys(NEEDS_YOU_COMMANDS),
      ...Object.keys(TRACKER_COMMANDS),
      ...Object.keys(APPLICATION_COMMANDS),
      ...Object.keys(JOB_COMMANDS),
      ...Object.keys(RESUME_COMMANDS),
    ]);
    const missing = ACTION_INVENTORY.flatMap((entry) =>
      entry.coverage.kind === "tools"
        ? entry.coverage.tools
            .filter((tool) => !known.has(tool))
            .map((tool) => `${entry.id}: ${tool}`)
        : [],
    );
    expect(missing).toEqual([]);
  });

  it("gives every excluded action a reason and every entry a unique id", () => {
    const ids = ACTION_INVENTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ACTION_INVENTORY) {
      if (entry.coverage.kind === "excluded") {
        expect(entry.coverage.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it("reaches every tool in both catalog modes", () => {
    const all = listAllAssistantToolNames();
    expect(new Set(all).size).toBe(all.length);
    const flat = new Set(
      buildAssistantToolCatalog({
        commands: needsCommands,
        mode: "flat",
        browserAvailable: true,
      }).map((tool) => tool.name),
    );
    const grouped = new Set(
      buildAssistantToolCatalog({
        mode: "grouped",
        browserAvailable: true,
        screen: "home",
        loadedGroups: [
          "workspace",
          "profile",
          "files",
          "resume",
          "jobs",
          "applications",
          "tracking",
          "settings",
          "browser",
        ],
      }).map((tool) => tool.name),
    );
    for (const name of all) {
      expect(flat.has(name), name).toBe(true);
      expect(grouped.has(name), name).toBe(true);
    }
    expect(grouped.has("load_tools")).toBe(true);
  });
});
