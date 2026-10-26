import {
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileFieldsSchema,
  ProfileListsSchema,
  GoalFieldsSchema,
  GoalListsSchema,
  type UpsertProfileRecordInputSchema,
  ProfileOverviewSchema,
  type ProfileEditBatch,
  type ProfileRecord,
  type ProfileRecordPage,
  type ProfileRecordQuery,
  type RemoveProfileRecordInput,
  type PatchGoalsInput,
  type JobSearchPreferences,
  type PatchProfileInput,
  type PatchSettingsInput,
  type ProfileOverview,
  type JobFinderSettings,
  type AssistantChangeEntry,
} from "@nestor/contracts";
import { diffValues } from "./change-diff";
import { AssistantToolError, type AssistantToolContext } from "./tool-kit";
import type { z } from "zod";
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
  const plans = new WeakMap<
    AssistantToolContext["session"],
    {
      profile?: ProfileOverview;
      goals?: JobSearchPreferences;
      records: Map<string, ProfileRecord | null>;
    }
  >();
  const plan = ({ session }: AssistantToolContext) => {
    let value = plans.get(session);
    if (!value) {
      value = { records: new Map() };
      plans.set(session, value);
    }
    return value;
  };
  const requireRead = <T>(value: T | undefined, command: string): T => {
    if (value === undefined)
      throw new AssistantToolError(
        "missing_information",
        `Read ${command} before planning this edit, then try again.`,
      );
    return value;
  };
  const picked = (keys: object | undefined, read: (key: string) => unknown) =>
    Object.fromEntries(Object.keys(keys ?? {}).map((key) => [key, read(key)]));
  const recordKey = (collection: string, id: string) => `${collection}:${id}`;
  const prepareProfile = (
    input: PatchProfileInput,
    context: AssistantToolContext,
  ) => {
    const before = requireRead(plan(context).profile, "get_profile");
    input.expected = ProfileFieldsSchema.parse(
      picked(
        input.fields,
        (key) => before.fields[key as keyof typeof before.fields],
      ),
    );
    input.expectedLists = ProfileListsSchema.parse(
      picked(
        input.lists,
        (key) => before.lists[key as keyof typeof before.lists],
      ),
    );
    profiles.set(input, before);
  };
  const prepareGoals = (
    input: PatchGoalsInput,
    context: AssistantToolContext,
  ) => {
    const before = requireRead(plan(context).goals, "get_profile_goals");
    input.expected = GoalFieldsSchema.parse(
      picked(input.fields, (key) => at(before, key.split("."))),
    );
    input.expectedLists = GoalListsSchema.parse(
      picked(input.lists, (key) => at(before, [key])),
    );
  };
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
      patch_profile: prepareProfile,
      patch_profile_goals: prepareGoals,
      commit_profile_edits: (
        input: ProfileEditBatch,
        context: AssistantToolContext,
      ) => {
        if (input.profile) prepareProfile(input.profile, context);
        if (input.goals) prepareGoals(input.goals, context);
        input.expectedRecords = [
          ...input.upsert.map((row) => ({
            collection: row.collection,
            id: row.record.id,
          })),
          ...input.remove,
        ].map(({ collection, id }) => ({
          collection,
          id,
          value: requireRead(
            plan(context).records.get(recordKey(collection, id)),
            "get_profile_record for this id",
          ),
        }));
        if (input.workPermissions)
          input.expectedWorkPermissions = requireRead(
            plan(context).profile,
            "get_profile",
          ).limitedWorkPermissions;
      },
      upsert_profile_record: (
        input: z.infer<typeof UpsertProfileRecordInputSchema>,
        context: AssistantToolContext,
      ) => {
        input.expected = requireRead(
          plan(context).records.get(
            recordKey(input.collection, input.record.id),
          ),
          "get_profile_record for this id",
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
      get_profile: (
        value: ProfileOverview,
        _input: unknown,
        context: AssistantToolContext,
      ) => {
        plan(context).profile = ProfileOverviewSchema.parse(value);
        return { summary: "Read Profile.", data: value };
      },
      get_profile_goals: (
        value: JobSearchPreferences,
        _input: unknown,
        context: AssistantToolContext,
      ) => {
        plan(context).goals = JobSearchPreferencesSchema.parse(value);
        return { summary: "Read Profile goals.", data: value };
      },
      get_profile_record: (
        value: ProfileRecord | null,
        input: RemoveProfileRecordInput,
        context: AssistantToolContext,
      ) => {
        plan(context).records.set(recordKey(input.collection, input.id), value);
        return {
          summary: value
            ? "Read Profile record."
            : "This Profile record does not exist.",
          data: value,
        };
      },
      list_profile_records: (
        value: ProfileRecordPage,
        _input: ProfileRecordQuery,
        context: AssistantToolContext,
      ) => {
        for (const row of value.rows)
          plan(context).records.set(
            recordKey(row.collection, row.record.id),
            row,
          );
        return {
          summary: `Read ${value.rows.length} Profile records.`,
          data: value,
        };
      },
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
