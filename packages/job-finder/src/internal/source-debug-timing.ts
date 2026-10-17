import {
  SourceDebugRunTimingSummarySchema,
  SourceDebugTimingSummarySchema,
  browserRunWaitReasonValues,
  type SourceDebugProgressEvent,
  type SourceDebugRunRecord,
  type SourceDebugRunTimingSummary,
} from "@nestor/contracts";

import {
  calculateDurationMs,
  computeTimelineSummary,
  serializeOrderedDurationEntries,
} from "./performance-timing";

export function buildSourceDebugTimingSummary(
  events: readonly SourceDebugProgressEvent[],
  startedAt: string,
  completedAt: string,
) {
  const startedAtMs = new Date(startedAt).getTime();
  const completedAtMs = new Date(completedAt).getTime();
  const hasEventWithinWindow = events.some((event) => {
    const eventAtMs = new Date(event.timestamp).getTime();
    return eventAtMs >= startedAtMs && eventAtMs <= completedAtMs;
  });
  const timelineStartedAt =
    hasEventWithinWindow || events.length === 0
      ? startedAt
      : events[0]!.timestamp;
  const timelineCompletedAt =
    hasEventWithinWindow || events.length === 0
      ? completedAt
      : events[events.length - 1]!.timestamp;
  const waitReasonTimeline = computeTimelineSummary({
    startedAt: timelineStartedAt,
    completedAt: timelineCompletedAt,
    events: events.map((event) => ({
      timestamp: event.timestamp,
      key: event.waitReason,
    })),
  });

  return SourceDebugTimingSummarySchema.parse({
    totalDurationMs: calculateDurationMs(startedAt, completedAt),
    firstProgressMs:
      events.length === 0
        ? null
        : hasEventWithinWindow
          ? waitReasonTimeline.firstEventMs
          : 0,
    longestGapMs: waitReasonTimeline.longestGapMs,
    eventCount: events.length,
    waitReasonDurations: serializeOrderedDurationEntries(
      waitReasonTimeline.durationsMsByKey,
      browserRunWaitReasonValues,
      (waitReason, durationMs) => ({
        waitReason,
        durationMs,
      }),
      { includeZero: true },
    ),
  });
}

export function buildSourceDebugRunTimingSummary(input: {
  events: readonly SourceDebugProgressEvent[];
  run: SourceDebugRunRecord;
  completedAt: string;
  browserSetupMs: number | null;
  finalReviewMs: number | null;
  finalizationMs: number | null;
}): SourceDebugRunTimingSummary {
  const baseTiming = buildSourceDebugTimingSummary(
    input.events,
    input.run.startedAt,
    input.completedAt,
  );

  return SourceDebugRunTimingSummarySchema.parse({
    ...baseTiming,
    totalDurationMs: calculateDurationMs(
      input.run.startedAt,
      input.completedAt,
    ),
    browserSetupMs: input.browserSetupMs,
    finalReviewMs: input.finalReviewMs,
    finalizationMs: input.finalizationMs,
  });
}
