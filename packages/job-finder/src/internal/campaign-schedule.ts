import {
  CampaignRunFactsSchema,
  IsoDateTimeSchema,
  type CampaignPauseWindow,
  type CampaignRunFacts,
  type DiscoveryRunRecord,
  type JobSearchCampaignSchedule,
} from "@nestor/contracts";

/**
 * Pure campaign schedule math.
 *
 * Time-zone aware scheduling uses only the built-in `Intl` API (no external
 * dependencies) and is fully deterministic for a given input. DST
 * disambiguation follows the standard "compatible" convention:
 *
 * - Spring-forward gap (the wall time does not exist): the run is shifted
 *   forward by the gap, i.e. it fires at the first valid wall-clock time that
 *   is at-or-after the configured start time.
 * - Fall-back overlap (the wall time occurs twice): the run fires once at the
 *   first occurrence (the earlier instant).
 *
 * `computeNextScheduledRunAt` never fabricates a due time: it returns `null`
 * whenever the schedule is disabled, is in `manual` mode, or is missing the
 * time zone, local start time, or selected days.
 */

export type CampaignRunOutcome = "success" | "partial" | "failed" | "skipped";

const HOUR_MS = 60 * 60 * 1_000;
/** Days scanned for `selected_days` schedules: today plus the next 7 days. */
const MAX_SELECTED_DAY_SCAN = 8;
/** How far in each direction to scan for offset regimes around a DST transition. */
const OFFSET_SCAN_HOURS = 36;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function isValidTimeZone(timeZone: string): boolean {
  return getFormatter(timeZone) !== null;
}

function getWallClock(instantMs: number, timeZone: string): WallClock | null {
  if (!Number.isFinite(instantMs)) return null;
  const formatter = getFormatter(timeZone);
  if (formatter === null) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(new Date(instantMs));
  } catch {
    return null;
  }

  const values: Record<string, string> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  let hour = Number(values["hour"]);
  if (hour === 24) hour = 0;
  const year = Number(values["year"]);
  const month = Number(values["month"]);
  const day = Number(values["day"]);
  const minute = Number(values["minute"]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

/** Offset in milliseconds such that `instant = wallAsUtc - offset`. */
function getOffsetMs(instantMs: number, timeZone: string): number {
  const wall = getWallClock(instantMs, timeZone);
  if (wall === null) return Number.NaN;
  const wallAsUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  return wallAsUtcMs - instantMs;
}

function parseLocalStartTime(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { hour, minute };
}

/**
 * Resolves a zone-local wall-clock time to a UTC instant (milliseconds).
 *
 * The wall time is interpreted with every offset regime observed around the
 * nearest DST transition (sampled hourly in both directions), so both the
 * pre- and post-transition offsets are considered. Matching interpretations
 * are collected and the earliest one is returned, so a fall-back overlap
 * resolves to its first occurrence. When no interpretation reproduces the
 * wall time (a spring-forward gap), the wall time is interpreted with the
 * smallest offset, which shifts the instant forward by the gap.
 */
function resolveWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(naiveUtcMs)) return null;

  const normalized = new Date(naiveUtcMs);
  const targetYear = normalized.getUTCFullYear();
  const targetMonth = normalized.getUTCMonth() + 1;
  const targetDay = normalized.getUTCDate();

  const offsets = new Set<number>();
  const initialOffset = getOffsetMs(naiveUtcMs, timeZone);
  if (!Number.isFinite(initialOffset)) return null;
  offsets.add(initialOffset);
  for (let hoursAway = 1; hoursAway <= OFFSET_SCAN_HOURS; hoursAway += 1) {
    const backOffset = getOffsetMs(naiveUtcMs - hoursAway * HOUR_MS, timeZone);
    if (Number.isFinite(backOffset)) offsets.add(backOffset);
    const forwardOffset = getOffsetMs(
      naiveUtcMs + hoursAway * HOUR_MS,
      timeZone,
    );
    if (Number.isFinite(forwardOffset)) offsets.add(forwardOffset);
    if (offsets.size >= 2) break;
  }

  const matching: number[] = [];
  for (const offset of offsets) {
    const instantMs = naiveUtcMs - offset;
    const wall = getWallClock(instantMs, timeZone);
    if (
      wall !== null &&
      wall.year === targetYear &&
      wall.month === targetMonth &&
      wall.day === targetDay &&
      wall.hour === hour &&
      wall.minute === minute
    ) {
      matching.push(instantMs);
    }
  }
  if (matching.length > 0) {
    return Math.min(...matching);
  }
  return naiveUtcMs - Math.min(...offsets);
}

/**
 * Computes the next scheduled run as an ISO-8601 UTC instant, or `null` when
 * the schedule cannot produce a due time (disabled, manual, or missing time
 * zone / start time / selected days) or the inputs are invalid.
 *
 * The result is the earliest scheduled instant strictly after `now`.
 */
export function computeNextScheduledRunAt(input: {
  schedule: JobSearchCampaignSchedule;
  now: string;
}): string | null {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return null;
  const { schedule } = input;

  if (!schedule.enabled) return null;
  if (schedule.mode === "manual") return null;
  if (schedule.timeZone === null || schedule.localStartTime === null) {
    return null;
  }
  if (!isValidTimeZone(schedule.timeZone)) return null;
  if (schedule.mode === "selected_days" && schedule.daysOfWeek.length === 0) {
    return null;
  }

  const startTime = parseLocalStartTime(schedule.localStartTime);
  if (startTime === null) return null;

  const nowWall = getWallClock(nowMs, schedule.timeZone);
  if (nowWall === null) return null;

  const maxDayOffset =
    schedule.mode === "daily" ? 1 : MAX_SELECTED_DAY_SCAN - 1;
  const selectedDays = new Set(
    schedule.mode === "selected_days" ? schedule.daysOfWeek : [],
  );

  for (let dayOffset = 0; dayOffset <= maxDayOffset; dayOffset += 1) {
    if (schedule.mode === "selected_days") {
      const civilDayMs = Date.UTC(
        nowWall.year,
        nowWall.month - 1,
        nowWall.day + dayOffset,
      );
      if (!selectedDays.has(new Date(civilDayMs).getUTCDay())) continue;
    }
    const instantMs = resolveWallClockToInstant(
      nowWall.year,
      nowWall.month,
      nowWall.day + dayOffset,
      startTime.hour,
      startTime.minute,
      schedule.timeZone,
    );
    if (instantMs !== null && instantMs > nowMs) {
      return IsoDateTimeSchema.parse(new Date(instantMs).toISOString());
    }
  }

  return null;
}

/** True when two schedules would fire at exactly the same instants. */
function hasSameScheduleTiming(
  left: JobSearchCampaignSchedule,
  right: JobSearchCampaignSchedule,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.mode === right.mode &&
    left.localStartTime === right.localStartTime &&
    left.timeZone === right.timeZone &&
    [...left.daysOfWeek].sort().join(",") ===
      [...right.daysOfWeek].sort().join(",")
  );
}

/**
 * Resolves the run facts to persist when a schedule is saved, so the saved
 * plan states its concrete next run straight away instead of reading "not
 * scheduled yet" until the next app start rebuilds the schedule.
 *
 * A next run is filled in when the save carries none, and a due instant the
 * save merely echoes back from storage is recomputed once the plan starts
 * firing at different times. A caller that states a new instant keeps it, so
 * an unrelated edit never moves a claimed slot. A schedule that cannot produce
 * a due time — disabled, manual, or a plan that is not running — reports no
 * next run at all.
 */
export function resolveSavedScheduleRunFacts(input: {
  schedule: JobSearchCampaignSchedule;
  /** The schedule as it was persisted, or `null` for a new plan. */
  previousSchedule: JobSearchCampaignSchedule | null;
  /** False while the plan is paused, completed, or archived. */
  isScheduledPlan: boolean;
  now: string;
}): CampaignRunFacts {
  const { schedule } = input;
  if (
    !input.isScheduledPlan ||
    !schedule.enabled ||
    schedule.mode === "manual"
  ) {
    return CampaignRunFactsSchema.parse({
      ...schedule.runFacts,
      nextRunAt: null,
    });
  }

  const previous = input.previousSchedule;
  const carried = schedule.runFacts.nextRunAt;
  const echoesStoredInstant =
    carried !== null && carried === (previous?.runFacts.nextRunAt ?? null);
  const firesAtTheSameTimes =
    previous === null || hasSameScheduleTiming(previous, schedule);
  if (carried !== null && (firesAtTheSameTimes || !echoesStoredInstant)) {
    return CampaignRunFactsSchema.parse(schedule.runFacts);
  }

  return CampaignRunFactsSchema.parse({
    ...schedule.runFacts,
    nextRunAt: computeNextScheduledRunAt({ schedule, now: input.now }),
  });
}

/**
 * Returns `true` when `at` falls inside any enabled pause window, using
 * inclusive-start and exclusive-end boundaries:
 * `startsAt <= at < endsAt`.
 */
export function isCampaignPauseWindowActive(input: {
  windows: readonly CampaignPauseWindow[];
  at: string;
}): boolean {
  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs)) return false;

  for (const window of input.windows) {
    if (!window.enabled) continue;
    const startsAtMs = Date.parse(window.startsAt);
    const endsAtMs = Date.parse(window.endsAt);
    if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) {
      continue;
    }
    if (startsAtMs <= atMs && atMs < endsAtMs) return true;
  }
  return false;
}

/**
 * Classifies a finished discovery run from its run state and target
 * executions. Returns `null` while the run is still in progress.
 */
export function classifyCampaignRunOutcome(input: {
  state: DiscoveryRunRecord["state"];
  targetExecutions: DiscoveryRunRecord["targetExecutions"];
}): CampaignRunOutcome | null {
  const { state, targetExecutions } = input;

  if (state === "running" || state === "idle") return null;
  if (state === "failed") return "failed";
  if (state === "cancelled") return "skipped";

  if (targetExecutions.length === 0) return "skipped";
  const completedCount = targetExecutions.filter(
    (execution) => execution.state === "completed",
  ).length;
  const failedCount = targetExecutions.filter(
    (execution) => execution.state === "failed",
  ).length;
  if (completedCount === targetExecutions.length) return "success";
  if (completedCount === 0) {
    return failedCount > 0 ? "failed" : "skipped";
  }
  return "partial";
}

/**
 * Records a finished run into the campaign's run facts and recomputes the
 * next scheduled run relative to the completion time. The input schedule is
 * never mutated; the returned facts are validated against
 * `CampaignRunFactsSchema`.
 */
export function updateCampaignRunFacts(input: {
  schedule: JobSearchCampaignSchedule;
  outcome: CampaignRunOutcome;
  completedAt: string;
  summary?: string | null;
}): CampaignRunFacts {
  const previousFacts = input.schedule.runFacts;
  return CampaignRunFactsSchema.parse({
    nextRunAt: computeNextScheduledRunAt({
      schedule: input.schedule,
      now: input.completedAt,
    }),
    lastRunAt: input.completedAt,
    lastRunOutcome: input.outcome,
    lastRunSummary: normalizeSummary(input.summary ?? null),
    consecutiveFailures:
      input.outcome === "failed" ? previousFacts.consecutiveFailures + 1 : 0,
  });
}

function normalizeSummary(summary: string | null): string | null {
  if (summary === null) return null;
  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : null;
}
