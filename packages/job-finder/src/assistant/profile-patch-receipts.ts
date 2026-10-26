import {
  JobFinderSettingsSchema,
  ProfileOverviewSchema,
  type PatchProfileInput,
  type PatchSettingsInput,
  type ProfileOverview,
  type JobFinderSettings,
  type AssistantChangeEntry,
} from "@nestor/contracts";
import { diffValues } from "./change-diff";
import type { AssistantToolContext } from "./tool-kit";
const at = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

/** Receipts describe only the requested fields and the contacts that followed them. */
export function profilePatchReceipts(
  run: (
    name: "get_profile" | "get_settings",
    input: Record<string, never>,
  ) => Promise<unknown>,
) {
  const profiles = new WeakMap<object, ProfileOverview>(),
    settings = new WeakMap<object, JobFinderSettings>();
  const receipt = async (
    value: unknown,
    entries: AssistantChangeEntry[],
    target: "profile" | "settings",
    context: AssistantToolContext,
  ) => {
    const summary = entries.length
      ? `Updated ${target === "profile" ? "Profile" : "Settings"}.`
      : `${target === "profile" ? "Profile" : "Settings"} already matches.`;
    if (!entries.length) return { summary, data: value };
    const { part } = await context.session.recordChange({
      target,
      targetId: null,
      summary,
      entries,
    });
    return { summary, data: value, parts: [part] };
  };
  return {
    before: {
      patch_profile: async (input: PatchProfileInput) => {
        profiles.set(
          input,
          ProfileOverviewSchema.parse(await run("get_profile", {})),
        );
      },
      patch_settings: async (input: PatchSettingsInput) => {
        settings.set(
          input,
          JobFinderSettingsSchema.parse(await run("get_settings", {})),
        );
      },
    },
    results: {
      patch_profile: (
        value: ProfileOverview,
        input: PatchProfileInput,
        context: AssistantToolContext,
      ) => {
        const before = profiles.get(input);
        profiles.delete(input);
        if (!before) throw Error("The Profile change was not captured.");
        const paths = new Set([
          ...Object.keys(input.fields ?? {}),
          ...Object.keys(input.lists ?? {}),
        ]);
        if (paths.has("email")) paths.add("applicationIdentity.preferredEmail");
        if (paths.has("phone")) paths.add("applicationIdentity.preferredPhone");
        const old: Record<string, unknown> = {
            ...before.fields,
            ...before.lists,
          },
          next: Record<string, unknown> = { ...value.fields, ...value.lists };
        return receipt(
          value,
          [...paths].flatMap((key) =>
            diffValues(old[key], next[key]).map((entry) => ({
              ...entry,
              label: key
                .replaceAll(".", " ")
                .replace(/([a-z])([A-Z])/gu, "$1 $2"),
              path: [
                "profile",
                ...key.split("."),
                ...entry.path.filter((part) => part !== "(root)"),
              ],
            })),
          ),
          "profile",
          context,
        );
      },
      patch_settings: (
        value: JobFinderSettings,
        input: PatchSettingsInput,
        context: AssistantToolContext,
      ) => {
        const before = settings.get(input);
        settings.delete(input);
        if (!before) throw Error("The Settings change was not captured.");
        return receipt(
          value,
          [
            ...new Set([
              ...Object.keys(input.fields ?? {}),
              ...Object.keys(input.lists ?? {}),
            ]),
          ].flatMap((key) => {
            const path = key.split(".");
            return diffValues(at(before, path), at(value, path)).map(
              (entry) => ({
                ...entry,
                label: key
                  .replaceAll(".", " ")
                  .replace(/([a-z])([A-Z])/gu, "$1 $2"),
                path: [
                  "settings",
                  ...path,
                  ...entry.path.filter((part) => part !== "(root)"),
                ],
              }),
            );
          }),
          "settings",
          context,
        );
      },
    },
  };
}
