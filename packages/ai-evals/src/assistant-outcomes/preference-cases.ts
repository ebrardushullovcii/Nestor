import { z } from "zod";
import {
  GoalFieldsSchema,
  GoalListsSchema,
  SettingsFieldsSchema,
  SettingsListsSchema,
  PatchGoalsInputSchema,
  PatchSettingsInputSchema,
  type DesktopJobsBridge,
} from "@nestor/contracts";
import { currentUndoReceipt, type BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

type AppWindow = { nestor: { jobs: DesktopJobsBridge } };
function leaf(value: unknown, key: string): unknown {
  for (const part of key.split("."))
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[part]
        : undefined;
  return value ?? null;
}
function unwrap(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return unwrap(schema.unwrap() as z.ZodType<unknown>);
  if (schema instanceof z.ZodDefault)
    return unwrap(schema.removeDefault() as z.ZodType<unknown>);
  return schema;
}
function pair(
  schema: z.ZodType<unknown>,
  key: string,
): readonly [unknown, unknown] {
  const type = unwrap(schema);
  const values: unknown[] =
    type instanceof z.ZodEnum
      ? (type.options as unknown[])
      : type instanceof z.ZodBoolean
        ? [false, true]
        : type instanceof z.ZodNumber
          ? [7, 14, 0, 1]
          : type instanceof z.ZodArray
            ? [[], ["Synthetic preference"]]
            : /currency/i.test(key)
              ? ["USD", "EUR"]
              : /language/i.test(key)
                ? ["English", "Hungarian"]
                : [
                    "Synthetic preference",
                    "Before synthetic preference",
                    "https://example.test/one",
                    "https://example.test/two",
                  ];
  const accepted = values.flatMap((value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  if (accepted.length < 2)
    throw Error(`Need two valid preference fixtures for ${key}`);
  return [accepted[0], accepted[1]];
}

const goalExpected = PatchGoalsInputSchema.parse({
  fields: {
    searchSelectivity: "best_matches",
    shiftPreference: "night",
    minimumSalaryUsd: 50000,
    targetSalaryUsd: 90000,
    salaryCurrency: "USD",
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    "compensation.basis": "base",
    "compensation.minimum": 50000,
    "compensation.maximum": 90000,
    "compensation.interval": "year",
    "compensation.currency": "USD",
    "compensation.currencyStatus": "explicit",
    "weeklyHours.minimum": 32,
    "weeklyHours.maximum": 40,
  },
  lists: {
    targetRoles: ["Operations Analyst"],
    jobFamilies: ["Analysis"],
    locations: ["Budapest"],
    excludedLocations: ["Paris"],
    workModes: ["remote"],
    seniorityLevels: ["Senior"],
    targetIndustries: ["Education"],
    targetCompanyStages: ["Growth"],
    employmentTypes: ["Full-time"],
    companyBlacklist: ["Synthetic Excluded"],
    companyWhitelist: ["Synthetic Preferred"],
  },
});
const goalBefore = PatchGoalsInputSchema.parse({
  fields: {
    searchSelectivity: "wide_net",
    shiftPreference: "day",
    minimumSalaryUsd: null,
    targetSalaryUsd: null,
    salaryCurrency: "EUR",
    approvalMode: "draft_only",
    tailoringMode: "conservative",
    "compensation.basis": "total_ote",
    "compensation.minimum": 20000,
    "compensation.maximum": 30000,
    "compensation.interval": "month",
    "compensation.currency": "EUR",
    "compensation.currencyStatus": "inherited",
    "weeklyHours.minimum": 20,
    "weeklyHours.maximum": 28,
  },
  lists: {
    targetRoles: [],
    jobFamilies: [],
    locations: [],
    excludedLocations: [],
    workModes: ["hybrid"],
    seniorityLevels: [],
    targetIndustries: [],
    targetCompanyStages: [],
    employmentTypes: [],
    companyBlacklist: [],
    companyWhitelist: [],
  },
});

export function preferenceOutcomeCases(): BuiltAppBatch[] {
  const settingsFields = Object.fromEntries(
    Object.entries(SettingsFieldsSchema.shape).map(([key, schema]) => [
      key,
      pair(schema, key)[0],
    ]),
  );
  const beforeFields = Object.fromEntries(
    Object.entries(SettingsFieldsSchema.shape).map(([key, schema]) => [
      key,
      pair(schema, key)[1],
    ]),
  );
  Object.assign(settingsFields, {
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    applicationAutomationMode: "confirm_before_submit",
    collapseSideMenuWithAssistant: false,
  });
  Object.assign(beforeFields, {
    humanReviewRequired: false,
    allowAutoSubmitOverride: true,
    applicationAutomationMode: "autonomous_submit",
    collapseSideMenuWithAssistant: true,
  });
  const settingsExpected = PatchSettingsInputSchema.parse({
    fields: settingsFields,
    lists: {
      "aiBehavior.applying.preApprovedDeclarations": [
        "truthfulness_certification",
        "privacy_notice_acknowledgement",
      ],
    },
  });
  const settingsBefore = PatchSettingsInputSchema.parse({
    fields: beforeFields,
    lists: { "aiBehavior.applying.preApprovedDeclarations": [] },
  });
  const groups = [
    {
      id: "goals",
      expected: goalExpected,
      before: goalBefore,
      write: "patch_profile_goals",
      read: "get_profile_goals",
      fieldPrefix: "profile.goal.field",
      listPrefix: "profile.goal.list",
    },
    {
      id: "settings",
      expected: settingsExpected,
      before: settingsBefore,
      write: "patch_settings",
      read: "get_settings",
      fieldPrefix: "settings.field",
      listPrefix: "settings.list",
    },
  ] as const;
  return groups.flatMap((group): BuiltAppBatch[] => {
    let savedBefore: unknown;
    let receiptId: string | undefined;
    return [
      {
        id: `edit-${group.id}`,
        prepare: async (page) => {
          if (group.write === "patch_profile_goals")
            savedBefore = await page.evaluate(
              (input) =>
                (window as unknown as AppWindow).nestor.jobs.run(
                  "patch_profile_goals",
                  input,
                ),
              PatchGoalsInputSchema.parse(group.before),
            );
          else
            savedBefore = await page.evaluate(
              (input) =>
                (window as unknown as AppWindow).nestor.jobs.run(
                  "patch_settings",
                  input,
                ),
              PatchSettingsInputSchema.parse(group.before),
            );
        },
        request: `For this synthetic evaluation, read my current ${group.id} and save these exact supplied choices. Preserve every other value and do not start any applications. ${JSON.stringify(group.expected)}`,
        actions: (["fields", "lists"] as const).flatMap((kind) =>
          Object.entries(group.expected[kind]).map(([key, expected]) => ({
            actionId: `${kind === "fields" ? group.fieldPrefix : group.listPrefix}.${key}`,
            observe: async (page, reply, evidence) => {
              receiptId = currentUndoReceipt(
                reply,
                evidence,
                group.id === "goals" ? "profile" : "settings",
              )?.id;
              const value: unknown =
                group.read === "get_profile_goals"
                  ? await page.evaluate(() =>
                      (window as unknown as AppWindow).nestor.jobs.run(
                        "get_profile_goals",
                        {},
                      ),
                    )
                  : await page.evaluate(() =>
                      (window as unknown as AppWindow).nestor.jobs.run(
                        "get_settings",
                        {},
                      ),
                    );
              return [
                equalOutcome(
                  "data",
                  "This preference write has its own Undo receipt",
                  "Current Assistant reply change card",
                  Boolean(
                    currentUndoReceipt(
                      reply,
                      evidence,
                      group.id === "goals" ? "profile" : "settings",
                    ),
                  ),
                  true,
                ),
                equalOutcome(
                  "data",
                  `Saved ${key}`,
                  `${group.read}.${key}`,
                  leaf(value, key),
                  expected,
                ),
              ];
            },
          })),
        ),
      },
      {
        id: `undo-${group.id}`,
        requires: [`edit-${group.id}`],
        request: `Undo the ${group.id} changes from your previous reply, restoring every supplied preference exactly.`,
        actions: [
          {
            actionId: group.id === "goals" ? "profile.undo" : "settings.undo",
            observe: async (page, _reply, evidence) => [
              equalOutcome(
                "data",
                "Previous preferences restored exactly",
                `jobs.${group.read} before the write versus after Undo`,
                group.read === "get_profile_goals"
                  ? await page.evaluate(() =>
                      (window as unknown as AppWindow).nestor.jobs.run(
                        "get_profile_goals",
                        {},
                      ),
                    )
                  : await page.evaluate(() =>
                      (window as unknown as AppWindow).nestor.jobs.run(
                        "get_settings",
                        {},
                      ),
                    ),
                savedBefore,
              ),
              equalOutcome(
                "data",
                "Original preference receipt was undone",
                "Persisted Assistant receipt status",
                evidence.receipts.find((receipt) => receipt.id === receiptId)
                  ?.status,
                "undone",
              ),
            ],
          },
        ],
      },
    ];
  });
}

// Fail at --list, before any app starts, when a new contract leaf lacks a fixture.
export function checkPreferenceFixtures(): void {
  for (const [shape, values] of [
    [GoalFieldsSchema.shape, goalExpected.fields],
    [GoalListsSchema.shape, goalExpected.lists],
  ] as const)
    for (const key of Object.keys(shape))
      if (!(key in values)) throw Error(`Missing goal control fixture ${key}`);
  for (const key of Object.keys(SettingsListsSchema.shape))
    if (key !== "aiBehavior.applying.preApprovedDeclarations")
      throw Error(`Missing Settings list fixture ${key}`);
}
