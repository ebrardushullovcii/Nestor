import type {
  JobFinderIntelligenceSafeguards,
  JobSearchCampaign,
  PlanSafeguardPause,
} from "@nestor/contracts";

export const AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID =
  "automatic_discovery_failures";
export const AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID =
  "automatic_source_debug_failures";
export const AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID =
  "automatic_application_failures";

export function projectPlanSafeguardPauses(
  safeguards: JobFinderIntelligenceSafeguards | undefined,
  campaigns: readonly Pick<JobSearchCampaign, "id" | "name">[],
): PlanSafeguardPause[] {
  if (!safeguards) return [];
  const plansByPauseId = new Map<
    string,
    Pick<JobSearchCampaign, "id" | "name">
  >(
    campaigns.flatMap((plan) =>
      [
        AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID,
        AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
        AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
      ].map((prefix) => [`${prefix}:${plan.id}`, plan] as const),
    ),
  );
  return safeguards.abnormalFailurePauses.flatMap((pause) => {
    const plan = plansByPauseId.get(pause.id);
    if (
      !plan ||
      !pause.paused ||
      safeguards.safeguardDismissals.some(
        (entry) =>
          entry.kind === "abnormal_failure_pause" &&
          entry.referenceId === pause.id,
      )
    )
      return [];
    return [
      {
        id: pause.id,
        campaignId: plan.id,
        planName: plan.name,
        title: `Paused after repeated failures (${pause.failureRatePercent.toFixed(1)}% failed)`,
        explanation: pause.explanation,
        route: "/job-finder/safeguards" as const,
      },
    ];
  });
}
