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
  it("offers Apply work reads and Send on Applications, and loads them by name elsewhere", async () => {
    const commands = assistantCommandTools(
      APPLICATION_COMMANDS,
      () => {
        throw new Error("Catalog only");
      },
      { group: "applications" },
    );
    const names = [
      "list_application_work",
      "applications_for_jobs",
      "send_application",
    ];
    const options = {
      commands,
      mode: "grouped" as const,
      browserAvailable: false,
    };
    expect(
      buildAssistantToolCatalog({ ...options, screen: "applications" }).map(
        (tool) => tool.name,
      ),
    ).toEqual(expect.arrayContaining(names));
    const loaded: string[] = [];
    const discovery = buildAssistantToolCatalog({
      ...options,
      screen: "discovery",
      onLoadToolNames: (next) => loaded.push(...next),
    });
    await discovery
      .find((tool) => tool.name === "load_tools")!
      .execute({ groups: [], names }, {} as never);
    expect(loaded).toEqual(expect.arrayContaining(names));
  });
  it("loads valid names beside a near miss and returns matching names without executing them", async () => {
    const commands = assistantCommandTools(
      RESUME_COMMANDS,
      () => Promise.reject(new Error("Catalog only")),
      { group: "resume" },
    );
    const loaded: string[] = [];
    const catalog = buildAssistantToolCatalog({
      commands,
      mode: "grouped",
      browserAvailable: false,
      onLoadToolNames: (names) => loaded.push(...names),
    });
    const result = await catalog
      .find((tool) => tool.name === "load_tools")!
      .execute(
        { groups: [], names: ["get_resume", "write_resume"] },
        {} as never,
      );
    expect(loaded).toEqual(["get_resume"]);
    expect(result.data).toHaveProperty("unknownNames", ["write_resume"]);
    expect(result.data).toHaveProperty(
      "availableTools",
      expect.arrayContaining([
        expect.objectContaining({ name: "rewrite_resume" }),
      ]),
    );
  });

  it("loads the small tracker group directly while keeping it out of the starting catalog", async () => {
    const commands = assistantCommandTools(
      TRACKER_COMMANDS,
      () => Promise.reject(new Error("Catalog only")),
      { group: "tracking" },
    );
    const loaded: string[] = [];
    const options = {
      commands,
      mode: "grouped" as const,
      browserAvailable: false,
      onLoadToolNames: (names: readonly string[]) => loaded.push(...names),
    };
    const initial = buildAssistantToolCatalog(options);
    expect(initial.some((tool) => tool.name === "set_status")).toBe(false);
    await initial
      .find((tool) => tool.name === "load_tools")!
      .execute(
        { groups: ["tracking"], names: ["applications_for_jobs"] },
        {} as never,
      );
    expect(loaded).toEqual(
      expect.arrayContaining(["list_applications", "set_status", "add_event"]),
    );
    expect(
      buildAssistantToolCatalog({ ...options, loadedToolNames: loaded }).map(
        (tool) => tool.name,
      ),
    ).toEqual(expect.arrayContaining(["set_status", "add_event"]));
  });

  it("measures desktop command schemas per screen", () => {
    const reject = () => Promise.reject(new Error("Catalog only"));
    const commands = [
      ...assistantCommandTools(JOB_COMMANDS, reject, {
        group: (name) =>
          name in PROFILE_COMMANDS
            ? "profile"
            : name.includes("settings")
              ? "settings"
              : "jobs",
      }),
      ...assistantCommandTools(RESUME_COMMANDS, reject, { group: "resume" }),
      ...assistantCommandTools(TRACKER_COMMANDS, reject, { group: "tracking" }),
      ...assistantCommandTools(APPLICATION_COMMANDS, reject, {
        group: "applications",
      }),
      ...needsCommands,
    ];
    for (const screen of [
      "home",
      "review_queue",
      "resume_studio",
      "discovery",
      "profile",
      "setup",
      "applications",
      "actions",
      "settings",
      "browser",
    ] as const) {
      const tools = buildAssistantToolCatalog({
        commands,
        mode: "grouped",
        browserAvailable: true,
        screen,
      });
      const tokens = Math.ceil(
        JSON.stringify(
          tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        ).length / 3.6,
      );
      console.log(
        JSON.stringify({
          screen,
          schemaTokens: tokens,
          toolCount: tools.length,
        }),
      );
      expect(tokens, screen).toBeLessThan(3_500);
    }
  });
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
      expect(
        initial.some((tool) => tool.name === name),
        name,
      ).toBe(false);
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
    expect(after.some((tool) => tool.name === "patch_profile_goals")).toBe(
      false,
    );
    expect(after.some((tool) => tool.name === "edit_profile")).toBe(false);
    // Group discovery never brings a broad edit schema into the next step.
    const discovered = await after
      .find((tool) => tool.name === "load_tools")!
      .execute({ groups: ["profile"], names: [] }, {} as never);
    expect(discovered.data).toHaveProperty("names", []);
    expect(discovered.data).toHaveProperty(
      "availableTools",
      expect.arrayContaining([
        expect.objectContaining({ name: "edit_profile" }),
      ]),
    );
    expect(catalog("profile").map((tool) => tool.name)).toEqual(
      after.map((tool) => tool.name),
    );
    await after
      .find((tool) => tool.name === "load_tools")!
      .execute(
        { groups: [], names: commands.map((tool) => tool.name) },
        {} as never,
      );
    const all = catalog("profile");
    for (const command of commands)
      expect(
        all.some((tool) => tool.name === command.name),
        command.name,
      ).toBe(true);
  });

  it("loads exact resume edit and PDF schemas on demand in the editor", async () => {
    const commands = assistantCommandTools<
      typeof RESUME_COMMANDS,
      ResumeCommandOutputs
    >(RESUME_COMMANDS, () => Promise.reject(new Error("Catalog only")), {
      group: "resume",
    });
    const loaded: string[] = [];
    const options = {
      commands,
      mode: "grouped" as const,
      browserAvailable: false,
      screen: "resume_studio" as const,
      onLoadToolNames: (names: readonly string[]) => loaded.push(...names),
    };
    const initial = buildAssistantToolCatalog(options);
    expect(initial.some((tool) => tool.name === "save_resume")).toBe(false);
    expect(initial.some((tool) => tool.name === "export_resume_pdf")).toBe(
      false,
    );
    await initial
      .find((tool) => tool.name === "load_tools")!
      .execute(
        {
          groups: [],
          names: ["save_resume", "approve_resume", "export_resume_pdf"],
        },
        {} as never,
      );
    const names = buildAssistantToolCatalog({
      ...options,
      loadedToolNames: loaded,
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
        expect.arrayContaining(["ask_person", "list_needs_you", "read_result"]),
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

  it("offers every mapped inventory tool and discovers it by group without eval requests", async () => {
    const reject = () => Promise.reject(new Error("Catalog only"));
    const commands = [
      ...assistantCommandTools(JOB_COMMANDS, reject, {
        group: (name) =>
          name === "get_settings" || name === "patch_settings"
            ? "settings"
            : name in PROFILE_COMMANDS
              ? "profile"
              : "jobs",
        replaces: {
          list_jobs: ["query_jobs", "show_jobs", "compare_jobs"],
          move_jobs: [
            "shortlist_jobs",
            "shortlist_result_set",
            "remove_from_shortlist",
            "dismiss_jobs",
            "restore_jobs",
          ],
          start_search: ["search_for_jobs"],
          stop_search: ["cancel_search"],
        },
      }),
      ...assistantCommandTools(RESUME_COMMANDS, reject, {
        group: "resume",
        replaces: {
          get_resume: ["read_resume"],
          save_resume: ["edit_resume", "revise_resume", "set_resume_template"],
          rewrite_resume: ["generate_resumes"],
          approve_resume: ["action_approve_resumes"],
        },
      }),
      ...assistantCommandTools(TRACKER_COMMANDS, reject, { group: "tracking" }),
      ...assistantCommandTools(APPLICATION_COMMANDS, reject, {
        group: "applications",
      }),
      ...needsCommands,
    ];
    const options = { commands, browserAvailable: true };
    const flat = buildAssistantToolCatalog({ ...options, mode: "flat" });
    const initial = buildAssistantToolCatalog({
      ...options,
      mode: "grouped",
      screen: "home",
    });
    const loader = initial.find((tool) => tool.name === "load_tools")!;
    for (const entry of ACTION_INVENTORY) {
      if (entry.coverage.kind !== "tools") continue;
      for (const name of entry.coverage.tools) {
        const tool = flat.find((candidate) => candidate.name === name);
        expect(
          tool,
          `${entry.id}: ${name} is absent from the actual catalog`,
        ).toBeDefined();
        expect(loader.description, tool!.group).toContain(`${tool!.group} (`);
        const result = await loader.execute(
          { groups: [tool!.group], names: [] },
          {} as never,
        );
        expect(
          result.data,
          `${entry.id}: ${name} is absent from its discovery menu`,
        ).toHaveProperty(
          "availableTools",
          expect.arrayContaining([expect.objectContaining({ name })]),
        );
        const loaded: string[] = [];
        const catalog = buildAssistantToolCatalog({
          ...options,
          mode: "grouped",
          onLoadToolNames: (names) => loaded.push(...names),
        });
        await catalog
          .find((candidate) => candidate.name === "load_tools")!
          .execute({ groups: [], names: [name] }, {} as never);
        expect(
          buildAssistantToolCatalog({
            ...options,
            mode: "grouped",
            loadedToolNames: loaded,
          }).map((candidate) => candidate.name),
          `${entry.id}: ${name} cannot be offered after loading`,
        ).toContain(name);
      }
    }
    for (const tool of flat) {
      expect(tool.description.trim().length, tool.name).toBeGreaterThan(15);
      expect(tool.description.trim(), tool.name).not.toMatch(
        /^(?:todo|tool|action|command|undefined|null)[.!]?$/iu,
      );
    }
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
