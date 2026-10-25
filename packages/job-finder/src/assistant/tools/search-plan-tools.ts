import { executeJobFinderAction } from "../action-registry";
import {
  getDefaultCampaignConfiguration,
  isRunnableJobDiscoveryTarget,
  JobSearchCampaignScheduleSchema,
  NonEmptyStringSchema,
  SaveJobSearchCampaignInputSchema,
  type AssistantChangeReceipt,
  type JobSearchCampaign,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { z } from "zod";
import { deepEqual, diffValues, undoChangeEntries } from "../change-diff";
import {
  AssistantToolError,
  defineTool,
  json,
  type AssistantToolContext,
} from "../tool-kit";

const Id = NonEmptyStringSchema.max(200);

/** Runtime schedule facts belong to the scheduler, never to an edit or Undo. */
function configuration(plan: JobSearchCampaign) {
  const schedule = JobSearchCampaignScheduleSchema.omit({
    runFacts: true,
  }).parse(plan.schedule);
  return { ...SaveJobSearchCampaignInputSchema.parse(plan), schedule };
}

function planForModel(plan: JobSearchCampaign) {
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    sourceIds: plan.sourceTargetIds,
    targetRoles: plan.searchPreferences.targetRoles,
    locations: plan.searchPreferences.locations,
    schedule: {
      mode: plan.schedule.mode,
      enabled: plan.schedule.enabled,
      daysOfWeek: plan.schedule.daysOfWeek,
      localStartTime: plan.schedule.localStartTime,
      timeZone: plan.schedule.timeZone,
      nextRunAt: plan.schedule.runFacts.nextRunAt,
    },
  };
}

function scheduleText(plan: JobSearchCampaign): string {
  const schedule = plan.schedule;
  if (!schedule.enabled || schedule.mode === "manual") return "Manual search";
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return `${schedule.mode === "daily" ? "Every day" : schedule.daysOfWeek.map((day) => days[day]).join(", ")}, ${schedule.localStartTime} (${schedule.timeZone})`;
}

function sourceNames(plan: JobSearchCampaign): string {
  return plan.searchPreferences.discovery.targets
    .filter((source) => plan.sourceTargetIds.includes(source.id))
    .map((source) => source.label)
    .join(", ")
    .slice(0, 2000);
}

export const listSearchPlansTool = defineTool({
  name: "list_search_plans",
  group: "settings",
  description:
    "Reads named search plans, their selected sources, goals, days (Sunday 0 to Saturday 6), local time, IANA time zone and next run. Read before editing; never change another plan or applying settings to schedule a search.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Reading search plans",
  effect: "read",
  async execute(_input, { service }) {
    const snapshot = await service.getWorkspaceSnapshot();
    return {
      summary: `${snapshot.campaigns.length} search plans saved.`,
      data: snapshot.campaigns.map(planForModel),
    };
  },
});

export const saveSearchPlanTool = defineTool({
  name: "save_search_plan",
  group: "settings",
  description:
    "Creates a named search plan, or changes only planId when explicitly named. Saves with a change card and Undo. Use sourceIds from list_sources, targetRoles and locations for this plan only. For recurring searches give daysOfWeek (Sunday 0, weekdays [1,2,3,4,5]), localStartTime (HH:mm) and the IANA timeZone of the place the person named (for example Europe/Berlin). Read back saved days, time, zone and next run. Scheduling searches does not authorize or change applying. Omitted fields preserve an existing plan; new plans use current search preferences. Does not switch the selected plan.",
  parameters: json.object(
    {
      planId: json.string("Only when editing an existing plan."),
      name: json.string(),
      sourceIds: json.ids(
        "Sources for this plan; omit for the current enabled sources.",
      ),
      targetRoles: json.ids(),
      locations: json.ids(),
      schedule: json.object({
        enabled: json.boolean(),
        mode: json.enumOf(["manual", "daily", "selected_days"]),
        daysOfWeek: json.array(json.number("Sunday 0 through Saturday 6.")),
        localStartTime: json.string("HH:mm in the requested zone."),
        timeZone: json.string(
          "An IANA time zone, never the device zone unless requested.",
        ),
      }),
    },
    ["name"],
  ),
  input: z.object({
    planId: Id.optional(),
    name: z.string().trim().min(1).max(200),
    sourceIds: z.array(Id).min(1).max(1_000).optional(),
    targetRoles: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    locations: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    schedule: JobSearchCampaignScheduleSchema.omit({
      pauseWindows: true,
      runFacts: true,
    })
      .partial()
      .optional(),
  }),
  label: () => "Saving the search plan",
  effect: "local_write",
  async execute(input, context) {
    const { service, session, ports } = context;
    const snapshot = await service.getWorkspaceSnapshot();
    const previous = input.planId
      ? snapshot.campaigns.find((plan) => plan.id === input.planId)
      : null;
    if (input.planId && !previous)
      throw new AssistantToolError(
        "not_found",
        "That search plan is no longer saved.",
      );
    const preferences =
      previous?.searchPreferences ?? snapshot.searchPreferences;
    const sourceIds = [
      ...new Set(
        input.sourceIds ??
          previous?.sourceTargetIds ??
          preferences.discovery.targets
            .filter(isRunnableJobDiscoveryTarget)
            .map((source) => source.id),
      ),
    ];
    if (
      !sourceIds.length ||
      sourceIds.some(
        (id) =>
          !preferences.discovery.targets.some(
            (source) =>
              source.id === id &&
              isRunnableJobDiscoveryTarget({ ...source, enabled: true }),
          ),
      )
    ) {
      throw new AssistantToolError(
        "missing_information",
        "Choose at least one valid job source for this plan.",
      );
    }
    const schedule = JobSearchCampaignScheduleSchema.parse({
      ...previous?.schedule,
      ...input.schedule,
      mode:
        input.schedule?.mode ??
        (input.schedule?.daysOfWeek?.length
          ? "selected_days"
          : (previous?.schedule.mode ?? "manual")),
    });
    if (schedule.enabled && schedule.mode !== "manual") {
      if (
        !schedule.localStartTime ||
        !schedule.timeZone ||
        (schedule.mode === "selected_days" && !schedule.daysOfWeek.length)
      ) {
        throw new AssistantToolError(
          "missing_information",
          "A recurring search needs its days, local time and time zone.",
        );
      }
    }
    if (schedule.timeZone) {
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: schedule.timeZone,
        }).format();
      } catch {
        throw new AssistantToolError(
          "invalid_input",
          "Choose a valid IANA time zone for the search, such as America/Toronto.",
        );
      }
    }
    schedule.daysOfWeek = [...new Set(schedule.daysOfWeek)].sort(
      (a, b) => a - b,
    );
    const request = SaveJobSearchCampaignInputSchema.parse({
      ...(previous ?? getDefaultCampaignConfiguration("precision")),
      id: previous?.id ?? null,
      ...(previous ? { expectedUpdatedAt: previous.updatedAt } : {}),
      name: input.name,
      mode: previous?.mode ?? "precision",
      status: previous?.status ?? "active",
      searchPreferences: {
        ...preferences,
        ...(input.targetRoles ? { targetRoles: input.targetRoles } : {}),
        ...(input.locations ? { locations: input.locations } : {}),
      },
      sourceTargetIds: sourceIds,
      ...(input.sourceIds ? { sourceSelectionMode: "selected" as const } : {}),
      schedule,
    });
    session.assertCurrent();
    const after = await executeJobFinderAction("save-campaign", request, { service }) as JobFinderWorkspaceSnapshot;
    const created = after.campaigns.filter(
      (plan) =>
        plan.name === input.name &&
        !snapshot.campaigns.some((old) => old.id === plan.id),
    );
    const saved = previous
      ? after.campaigns.find((plan) => plan.id === previous.id)
      : created.length === 1
        ? created[0]
        : null;
    if (!saved)
      throw new AssistantToolError(
        "transient",
        "The search plan was saved, but its read-back was ambiguous. Read the search plans before making another change.",
      );
    const entries = previous
      ? diffValues(configuration(previous), configuration(saved), {
          labelFor: (path) =>
            path[0] === "schedule"
              ? "Search schedule"
              : path[0] === "sourceTargetIds"
                ? "Job sources"
                : "Search plan",
        })
      : [
          {
            path: ["createdPlan"],
            kind: "insert" as const,
            before: null,
            after: configuration(saved),
            index: null,
            label: "Search plan",
          },
        ];
    const recorded = entries.length
      ? await session.recordChange({
          target: "search_plan",
          targetId: saved.id,
          summary: `Saved search plan ${saved.name}`,
          entries,
        })
      : null;
    ports.publishWorkspaceUpdate();
    return {
      summary: `Saved ${saved.name}. Results go to ${saved.name} in Find jobs and Shortlisted. Profile source switches were kept.`,
      data: {
        ...planForModel(saved),
        resultsPlanName: saved.name,
        profileSources: after.searchPreferences.discovery.targets.map(
          (source) => ({
            id: source.id,
            label: source.label,
            enabled: source.enabled,
            searchedByPlan:
              saved.sourceSelectionMode === "profile"
                ? source.enabled
                : saved.sourceTargetIds.includes(source.id),
          }),
        ),
      },
      parts: recorded
        ? [
            recorded.part.type === "change"
              ? {
                  ...recorded.part,
                  preview: [
                    {
                      label: "Name",
                      before: previous?.name ?? null,
                      after: saved.name,
                    },
                    {
                      label: "Job sources",
                      before: previous ? sourceNames(previous) : null,
                      after: sourceNames(saved),
                    },
                    {
                      label: "Search schedule",
                      before: previous ? scheduleText(previous) : null,
                      after: scheduleText(saved),
                    },
                  ],
                }
              : recorded.part,
          ]
        : [],
    };
  },
});

export async function undoSearchPlanChange(
  context: Pick<AssistantToolContext, "service" | "session">,
  receipt: AssistantChangeReceipt,
) {
  const snapshot = await context.service.getWorkspaceSnapshot();
  const plan = snapshot.campaigns.find(
    (saved) => saved.id === receipt.targetId,
  );
  const labels = receipt.entries.map((entry) => entry.label ?? "Search plan");
  if (!plan) return { undoneLabels: [], conflictLabels: labels };
  const created = receipt.entries.find(
    (entry) => entry.path[0] === "createdPlan",
  );
  if (created) {
    // A plan that was used or edited is no longer the untouched creation.
    if (
      !deepEqual(configuration(plan), created.after) ||
      plan.jobIds.length ||
      plan.history.some((entry) => entry.kind !== "created")
    )
      return { undoneLabels: [], conflictLabels: labels };
    context.session.assertCurrent();
    const deleted = await context.service.deleteCampaign({
      campaignId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
    });
    return {
      undoneLabels: deleted ? labels : [],
      conflictLabels: deleted ? [] : labels,
    };
  }
  const result = undoChangeEntries(configuration(plan), receipt.entries);
  if (result.undone.length) {
    context.session.assertCurrent();
    try {
      await context.service.saveCampaign(
        SaveJobSearchCampaignInputSchema.parse({
          ...result.next,
          schedule: {
            ...result.next.schedule,
            runFacts: plan.schedule.runFacts,
          },
          expectedUpdatedAt: plan.updatedAt,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("changed while it was being edited")
      )
        return { undoneLabels: [], conflictLabels: labels };
      throw error;
    }
  }
  return {
    undoneLabels: result.undone.map((entry) => entry.label ?? "Search plan"),
    conflictLabels: result.conflicts.map(
      (entry) => entry.label ?? "Search plan",
    ),
  };
}

export const searchPlanTools = [listSearchPlansTool, saveSearchPlanTool];
