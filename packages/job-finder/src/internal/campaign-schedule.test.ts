import { describe, expect, test } from "vitest";

import {
  CampaignRunFactsSchema,
  DiscoveryTargetExecutionSchema,
  JobSearchCampaignScheduleSchema,
  type CampaignPauseWindow,
  type CampaignRunFacts,
  type DiscoveryTargetExecution,
  type DiscoveryTargetExecutionState,
  type JobSearchCampaignSchedule,
} from "@nestor/contracts";

import {
  classifyCampaignRunOutcome,
  computeNextScheduledRunAt,
  isCampaignPauseWindowActive,
  resolveSavedScheduleRunFacts,
  updateCampaignRunFacts,
} from "./campaign-schedule";

function createSchedule(
  overrides: Partial<JobSearchCampaignSchedule> = {},
): JobSearchCampaignSchedule {
  return JobSearchCampaignScheduleSchema.parse({
    mode: "manual",
    enabled: false,
    daysOfWeek: [],
    localStartTime: null,
    timeZone: null,
    pauseWindows: [],
    runFacts: {},
    ...overrides,
  });
}

function createPauseWindow(
  id: string,
  startsAt: string,
  endsAt: string,
  enabled = true,
): CampaignPauseWindow {
  return {
    id,
    startsAt,
    endsAt,
    reason: null,
    enabled,
  };
}

function createRunFacts(
  overrides: Partial<CampaignRunFacts> = {},
): CampaignRunFacts {
  return {
    nextRunAt: null,
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function createExecution(
  state: DiscoveryTargetExecutionState,
): DiscoveryTargetExecution {
  return DiscoveryTargetExecutionSchema.parse({
    targetId: "target_1",
    adapterKind: "auto",
    state,
  });
}

describe("computeNextScheduledRunAt", () => {
  test("returns null when the schedule is disabled", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: false,
      localStartTime: "09:00",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("returns null for manual mode even when fully configured", () => {
    const schedule = createSchedule({
      mode: "manual",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("returns null when the time zone or local start time is missing", () => {
    expect(
      computeNextScheduledRunAt({
        schedule: createSchedule({
          mode: "daily",
          enabled: true,
          localStartTime: "09:00",
          timeZone: null,
        }),
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();

    expect(
      computeNextScheduledRunAt({
        schedule: createSchedule({
          mode: "daily",
          enabled: true,
          localStartTime: null,
          timeZone: "America/New_York",
        }),
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("returns null when selected_days has no days", () => {
    const schedule = createSchedule({
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [],
      localStartTime: "09:00",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("returns null for an invalid time zone or invalid now", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "Not/AZone",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T13:00:00.000Z",
      }),
    ).toBeNull();

    expect(
      computeNextScheduledRunAt({
        schedule: createSchedule({
          mode: "daily",
          enabled: true,
          localStartTime: "09:00",
          timeZone: "America/New_York",
        }),
        now: "not-a-date",
      }),
    ).toBeNull();
  });

  test("returns the next daily run in a fixed-offset zone (UTC)", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T08:59:59.000Z",
      }),
    ).toBe("2026-03-05T09:00:00.000Z");
  });

  test("returns the next daily run in America/New_York and is strictly after now", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T13:59:59.000Z",
      }),
    ).toBe("2026-03-05T14:00:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-05T14:00:00.000Z",
      }),
    ).toBe("2026-03-06T14:00:00.000Z");
  });

  test("keeps the daily run at 09:00 local across DST changes", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-08T12:59:59.000Z",
      }),
    ).toBe("2026-03-08T13:00:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-11-01T13:59:59.000Z",
      }),
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  test("shifts the run forward across the spring-forward gap", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:30",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-08T06:29:59.000Z",
      }),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  test("uses the first occurrence of an ambiguous fall-back wall time", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "01:30",
      timeZone: "America/New_York",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-11-01T05:29:59.000Z",
      }),
    ).toBe("2026-11-01T05:30:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-11-01T06:29:59.000Z",
      }),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  test("handles the European fall-back overlap and spring-forward gap", () => {
    const fallBack = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:30",
      timeZone: "Europe/Berlin",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: fallBack,
        now: "2026-10-25T00:29:59.000Z",
      }),
    ).toBe("2026-10-25T00:30:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule: fallBack,
        now: "2026-10-25T00:30:00.000Z",
      }),
    ).toBe("2026-10-26T01:30:00.000Z");

    const springForward = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:30",
      timeZone: "Europe/Berlin",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: springForward,
        now: "2026-03-29T01:29:59.000Z",
      }),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  test("handles the southern-hemisphere fall-back overlap", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:30",
      timeZone: "Australia/Sydney",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-04-04T15:29:59.000Z",
      }),
    ).toBe("2026-04-04T15:30:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-04-04T16:30:00.000Z",
      }),
    ).toBe("2026-04-05T16:30:00.000Z");
  });

  test("skips the southern-hemisphere spring-forward day", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:30",
      timeZone: "Australia/Sydney",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-10-03T17:00:00.000Z",
      }),
    ).toBe("2026-10-04T15:30:00.000Z");
  });

  test("handles a 30-minute DST zone (Lord Howe) overlap and gap", () => {
    const fallBack = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "01:45",
      timeZone: "Australia/Lord_Howe",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: fallBack,
        now: "2026-04-04T14:44:59.000Z",
      }),
    ).toBe("2026-04-04T14:45:00.000Z");

    const springForward = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "02:15",
      timeZone: "Australia/Lord_Howe",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: springForward,
        now: "2026-10-03T15:44:59.000Z",
      }),
    ).toBe("2026-10-03T15:45:00.000Z");
  });

  test("schedules only on the selected weekdays", () => {
    const schedule = createSchedule({
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [1, 4],
      localStartTime: "09:00",
      timeZone: "America/Los_Angeles",
    });
    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-02T16:59:59.000Z",
      }),
    ).toBe("2026-03-02T17:00:00.000Z");

    expect(
      computeNextScheduledRunAt({
        schedule,
        now: "2026-03-02T17:00:00.000Z",
      }),
    ).toBe("2026-03-05T17:00:00.000Z");
  });

  test("wraps selected days across the week and DST", () => {
    const sundays = createSchedule({
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [0],
      localStartTime: "09:00",
      timeZone: "America/Los_Angeles",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: sundays,
        now: "2026-03-06T00:00:00.000Z",
      }),
    ).toBe("2026-03-08T16:00:00.000Z");

    const mondays = createSchedule({
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [1],
      localStartTime: "09:00",
      timeZone: "America/Los_Angeles",
    });
    expect(
      computeNextScheduledRunAt({
        schedule: mondays,
        now: "2026-03-06T00:00:00.000Z",
      }),
    ).toBe("2026-03-09T16:00:00.000Z");
  });

  test("is deterministic for identical inputs", () => {
    const schedule = createSchedule({
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [2, 5],
      localStartTime: "18:30",
      timeZone: "Pacific/Auckland",
    });
    const input = {
      schedule,
      now: "2026-04-05T02:00:00.000Z",
    };
    expect(computeNextScheduledRunAt(input)).toBe(
      computeNextScheduledRunAt(input),
    );
  });
});

describe("isCampaignPauseWindowActive", () => {
  const window = createPauseWindow(
    "pause_1",
    "2026-03-05T10:00:00.000Z",
    "2026-03-05T11:00:00.000Z",
  );

  test("uses inclusive-start and exclusive-end boundaries", () => {
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "2026-03-05T09:59:59.999Z",
      }),
    ).toBe(false);
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "2026-03-05T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "2026-03-05T10:59:59.999Z",
      }),
    ).toBe(true);
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "2026-03-05T11:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "2026-03-05T11:00:00.001Z",
      }),
    ).toBe(false);
  });

  test("ignores disabled windows", () => {
    expect(
      isCampaignPauseWindowActive({
        windows: [
          createPauseWindow(
            "pause_disabled",
            "2026-03-05T10:00:00.000Z",
            "2026-03-05T11:00:00.000Z",
            false,
          ),
        ],
        at: "2026-03-05T10:30:00.000Z",
      }),
    ).toBe(false);
  });

  test("is active when any enabled window covers the instant", () => {
    const windows = [
      createPauseWindow(
        "pause_1",
        "2026-03-05T08:00:00.000Z",
        "2026-03-05T09:00:00.000Z",
      ),
      createPauseWindow(
        "pause_2",
        "2026-03-05T12:00:00.000Z",
        "2026-03-05T13:00:00.000Z",
      ),
    ];
    expect(
      isCampaignPauseWindowActive({
        windows,
        at: "2026-03-05T12:30:00.000Z",
      }),
    ).toBe(true);
    expect(
      isCampaignPauseWindowActive({
        windows,
        at: "2026-03-05T10:30:00.000Z",
      }),
    ).toBe(false);
  });

  test("returns false for invalid instants and skips unparseable windows", () => {
    expect(
      isCampaignPauseWindowActive({
        windows: [window],
        at: "not-a-date",
      }),
    ).toBe(false);

    expect(
      isCampaignPauseWindowActive({
        windows: [
          {
            id: "pause_broken",
            startsAt: "not-a-date",
            endsAt: "2026-03-05T11:00:00.000Z",
            reason: null,
            enabled: true,
          },
        ],
        at: "2026-03-05T10:30:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("classifyCampaignRunOutcome", () => {
  test("classifies a fully completed run as success", () => {
    expect(
      classifyCampaignRunOutcome({
        state: "completed",
        targetExecutions: [
          createExecution("completed"),
          createExecution("completed"),
        ],
      }),
    ).toBe("success");
  });

  test("classifies partially completed runs as partial", () => {
    expect(
      classifyCampaignRunOutcome({
        state: "completed",
        targetExecutions: [
          createExecution("completed"),
          createExecution("failed"),
        ],
      }),
    ).toBe("partial");
  });

  test("classifies runs with no completed targets as failed or skipped", () => {
    expect(
      classifyCampaignRunOutcome({
        state: "completed",
        targetExecutions: [
          createExecution("failed"),
          createExecution("failed"),
        ],
      }),
    ).toBe("failed");

    expect(
      classifyCampaignRunOutcome({
        state: "completed",
        targetExecutions: [
          createExecution("skipped"),
          createExecution("cancelled"),
        ],
      }),
    ).toBe("skipped");

    expect(
      classifyCampaignRunOutcome({
        state: "completed",
        targetExecutions: [],
      }),
    ).toBe("skipped");
  });

  test("classifies failed and cancelled run states", () => {
    expect(
      classifyCampaignRunOutcome({
        state: "failed",
        targetExecutions: [],
      }),
    ).toBe("failed");

    expect(
      classifyCampaignRunOutcome({
        state: "cancelled",
        targetExecutions: [],
      }),
    ).toBe("skipped");
  });

  test("returns null while the run is not finished", () => {
    expect(
      classifyCampaignRunOutcome({
        state: "running",
        targetExecutions: [createExecution("running")],
      }),
    ).toBeNull();

    expect(
      classifyCampaignRunOutcome({
        state: "idle",
        targetExecutions: [],
      }),
    ).toBeNull();
  });
});

describe("updateCampaignRunFacts", () => {
  test("records failed runs and increments consecutive failures", () => {
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "America/New_York",
      runFacts: createRunFacts({ consecutiveFailures: 3 }),
    });
    const facts = updateCampaignRunFacts({
      schedule,
      outcome: "failed",
      completedAt: "2026-03-05T14:30:00.000Z",
      summary: "  Discovery crashed mid-run.  ",
    });

    expect(facts.lastRunAt).toBe("2026-03-05T14:30:00.000Z");
    expect(facts.lastRunOutcome).toBe("failed");
    expect(facts.lastRunSummary).toBe("Discovery crashed mid-run.");
    expect(facts.consecutiveFailures).toBe(4);
    expect(facts.nextRunAt).toBe("2026-03-06T14:00:00.000Z");
    expect(CampaignRunFactsSchema.safeParse(facts).success).toBe(true);
  });

  test("resets consecutive failures on success, partial, and skipped runs", () => {
    const base = createRunFacts({ consecutiveFailures: 5 });
    for (const outcome of ["success", "partial", "skipped"] as const) {
      const facts = updateCampaignRunFacts({
        schedule: createSchedule({
          mode: "daily",
          enabled: true,
          localStartTime: "09:00",
          timeZone: "America/New_York",
          runFacts: base,
        }),
        outcome,
        completedAt: "2026-03-05T14:30:00.000Z",
      });
      expect(facts.consecutiveFailures).toBe(0);
      expect(facts.lastRunOutcome).toBe(outcome);
    }
  });

  test("computes the next run from the completion time", () => {
    const facts = updateCampaignRunFacts({
      schedule: createSchedule({
        mode: "daily",
        enabled: true,
        localStartTime: "09:00",
        timeZone: "America/New_York",
      }),
      outcome: "partial",
      completedAt: "2026-03-05T12:00:00.000Z",
    });
    expect(facts.nextRunAt).toBe("2026-03-05T14:00:00.000Z");
  });

  test("a finished run always leaves the next run after it", () => {
    // The plan card prints both facts side by side, so a stale next run that
    // sits before the run that just finished reads as two different clocks.
    const facts = updateCampaignRunFacts({
      schedule: createSchedule({
        mode: "daily",
        enabled: true,
        localStartTime: "08:00",
        timeZone: "America/Chicago",
        runFacts: createRunFacts({
          nextRunAt: "2026-09-11T13:00:00.000Z",
        }),
      }),
      outcome: "success",
      completedAt: "2026-09-12T13:01:00.000Z",
    });

    expect(facts.lastRunAt).toBe("2026-09-12T13:01:00.000Z");
    expect(Date.parse(facts.nextRunAt ?? "")).toBeGreaterThan(
      Date.parse(facts.lastRunAt ?? ""),
    );
    // 08:00 Chicago the next morning, not the stale instant.
    expect(facts.nextRunAt).toBe("2026-09-13T13:00:00.000Z");
  });

  test("does not fabricate a next run for disabled or manual schedules", () => {
    const disabled = updateCampaignRunFacts({
      schedule: createSchedule({
        mode: "daily",
        enabled: false,
        localStartTime: "09:00",
        timeZone: "America/New_York",
      }),
      outcome: "failed",
      completedAt: "2026-03-05T14:30:00.000Z",
    });
    expect(disabled.nextRunAt).toBeNull();

    const manual = updateCampaignRunFacts({
      schedule: createSchedule({
        mode: "manual",
        enabled: true,
        localStartTime: "09:00",
        timeZone: "America/New_York",
      }),
      outcome: "success",
      completedAt: "2026-03-05T14:30:00.000Z",
    });
    expect(manual.nextRunAt).toBeNull();
  });

  test("normalizes empty summaries to null and preserves non-empty ones", () => {
    const empty = updateCampaignRunFacts({
      schedule: createSchedule({}),
      outcome: "success",
      completedAt: "2026-03-05T14:30:00.000Z",
      summary: "   ",
    });
    expect(empty.lastRunSummary).toBeNull();

    const omitted = updateCampaignRunFacts({
      schedule: createSchedule({}),
      outcome: "success",
      completedAt: "2026-03-05T14:30:00.000Z",
    });
    expect(omitted.lastRunSummary).toBeNull();
  });

  test("is immutable and leaves the input schedule untouched", () => {
    const runFacts = createRunFacts({ consecutiveFailures: 2 });
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "America/New_York",
      runFacts,
    });
    const snapshot = structuredClone(schedule);

    updateCampaignRunFacts({
      schedule,
      outcome: "failed",
      completedAt: "2026-03-05T14:30:00.000Z",
    });

    expect(schedule).toEqual(snapshot);
    expect(schedule.runFacts.consecutiveFailures).toBe(2);
  });
});

describe("resolveSavedScheduleRunFacts", () => {
  const daily = createSchedule({
    mode: "daily",
    enabled: true,
    localStartTime: "05:03",
    timeZone: "America/Los_Angeles",
  });

  test("states the concrete next run the moment a schedule is saved", () => {
    const facts = resolveSavedScheduleRunFacts({
      schedule: daily,
      previousSchedule: null,
      isScheduledPlan: true,
      now: "2026-09-12T18:00:00.000Z",
    });

    expect(facts.nextRunAt).toBe(
      computeNextScheduledRunAt({
        schedule: daily,
        now: "2026-09-12T18:00:00.000Z",
      }),
    );
    expect(facts.nextRunAt).not.toBeNull();
  });

  test("keeps a claimed slot when the plan still fires at the same times", () => {
    const claimed = "2026-09-13T12:03:00.000Z";
    const claimedSchedule = createSchedule({
      ...daily,
      runFacts: CampaignRunFactsSchema.parse({ nextRunAt: claimed }),
    });
    const facts = resolveSavedScheduleRunFacts({
      schedule: claimedSchedule,
      previousSchedule: claimedSchedule,
      isScheduledPlan: true,
      now: "2026-09-12T18:00:00.000Z",
    });

    expect(facts.nextRunAt).toBe(claimed);
  });

  test("recomputes a stored instant once the plan fires at a new time", () => {
    const claimed = "2026-09-13T12:03:00.000Z";
    const facts = resolveSavedScheduleRunFacts({
      schedule: createSchedule({
        ...daily,
        localStartTime: "09:00",
        runFacts: CampaignRunFactsSchema.parse({ nextRunAt: claimed }),
      }),
      previousSchedule: createSchedule({
        ...daily,
        runFacts: CampaignRunFactsSchema.parse({ nextRunAt: claimed }),
      }),
      isScheduledPlan: true,
      now: "2026-09-12T18:00:00.000Z",
    });

    expect(facts.nextRunAt).not.toBe(claimed);
    expect(facts.nextRunAt).not.toBeNull();
  });

  test("promises no run for a manual, disabled, or paused plan", () => {
    const withClaim = createSchedule({
      ...daily,
      runFacts: CampaignRunFactsSchema.parse({
        nextRunAt: "2026-09-13T12:03:00.000Z",
      }),
    });

    for (const input of [
      { schedule: createSchedule({ ...daily, enabled: false }) },
      { schedule: createSchedule({ ...daily, mode: "manual" as const }) },
      { schedule: withClaim, isScheduledPlan: false },
    ]) {
      expect(
        resolveSavedScheduleRunFacts({
          previousSchedule: withClaim,
          isScheduledPlan: true,
          now: "2026-09-12T18:00:00.000Z",
          ...input,
        }).nextRunAt,
      ).toBeNull();
    }
  });
});
