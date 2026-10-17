import { sortApplicationCrmRecords } from "./applications-crm-model";
import { describe, expect, test } from "vitest";
import { ApplicationRecordSchema } from "@nestor/contracts";

import {
  APPLICATION_CRM_STAGE_LABELS,
  applicationCrmStageLabelForView,
  applicationCrmStageProvenanceForView,
  applicationCrmDataForView,
  buildApplicationCrmCalendarForView,
  groupApplicationRecordsByStage,
  inferApplicationCrmStageForView,
  nextTrackerStepLabel,
  trackedHiringStageBadge,
} from "./applications-crm-model";

function record(overrides: Record<string, unknown> = {}) {
  return ApplicationRecordSchema.parse({
    id: "application_1",
    jobId: "job_1",
    title: "Engineer",
    company: "Example",
    status: "submitted",
    lastActionLabel: "Applied manually",
    nextActionLabel: null,
    lastUpdatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  });
}

describe("application CRM renderer model", () => {
  test("metadata-only CRM payloads follow activity in every view and keep truthful provenance", () => {
    const progressing = record({
      status: "interview",
      crm: {
        stage: "preparing",
        stageSource: "activity",
        stageChangedAt: "2026-08-01T10:00:00.000Z",
        tags: ["Priority"],
      },
    });
    expect(inferApplicationCrmStageForView(progressing)).toBe("interview");
    expect(applicationCrmDataForView(progressing)).toMatchObject({
      stage: "interview",
      tags: ["Priority"],
      stageSource: "activity",
    });
    expect(applicationCrmStageProvenanceForView(progressing)).toBe(
      "From your activity",
    );
    expect(
      groupApplicationRecordsByStage([progressing]).get("interview"),
    ).toHaveLength(1);
    const chosen = record({
      ...progressing,
      crm: { ...progressing.crm, stageSource: "user" },
    });
    expect(inferApplicationCrmStageForView(chosen)).toBe("preparing");
    expect(applicationCrmStageProvenanceForView(chosen)).toBe(
      "You recorded this",
    );
  });

  test("distinguishes compatibility-inferred stages from CRM stages", () => {
    const legacyRecord = record();
    const explicitRecord = record({
      crm: {
        stage: "applied",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
    });

    expect(inferApplicationCrmStageForView(legacyRecord)).toBe("applied");
    // Implementation vocabulary stays out of the cell; provenance keeps its
    // own plain-language badge.
    expect(applicationCrmStageLabelForView(legacyRecord)).toBe("Applied");
    expect(applicationCrmStageProvenanceForView(legacyRecord)).toBe(
      "From your activity",
    );
    // Same stage name either way; provenance is its own badge.
    expect(applicationCrmStageLabelForView(explicitRecord)).toBe("Applied");
    expect(applicationCrmStageProvenanceForView(explicitRecord)).toBe(
      "You recorded this",
    );
    expect(APPLICATION_CRM_STAGE_LABELS.applied).toBe("Applied");
    expect(APPLICATION_CRM_STAGE_LABELS.interview).toBe("Interview");
    expect(legacyRecord.crm).toBeNull();
  });

  test("never reports a paused, blocked application as ready for approval", () => {
    // The Stages tab said "Ready for approval" while the Preparation tab said
    // Needs you about the very same application.
    const pausedRecord = record({
      status: "approved",
      lastAttemptState: "paused",
      latestBlocker: {
        code: "requires_manual_review",
        summary: "The application page could not safely save a prepared field.",
      },
    });

    expect(inferApplicationCrmStageForView(pausedRecord)).toBe("needs_you");
    expect(applicationCrmStageLabelForView(pausedRecord)).toBe("Needs you");
  });

  test("groups records into all lifecycle columns", () => {
    const grouped = groupApplicationRecordsByStage([
      record(),
      record({ id: "application_2", jobId: "job_2", status: "interview" }),
    ]);
    expect(grouped.get("applied")).toHaveLength(1);
    expect(grouped.get("interview")).toHaveLength(1);
    expect(grouped.has("no_response")).toBe(true);
  });

  test.each([
    "submitted",
    "interview",
    "offer",
    "rejected",
    "withdrawn",
  ] as const)("keeps %s ahead of a stale preparation blocker", (status) => {
    expect(
      inferApplicationCrmStageForView(
        record({
          status,
          lastAttemptState: "paused",
          latestBlocker: {
            code: "requires_manual_review",
            summary: "Old preparation handoff.",
          },
        }),
      ),
    ).toBe(status === "submitted" ? "applied" : status);
  });

  test("projects reminders, interviews, and offer deadlines", () => {
    const entries = buildApplicationCrmCalendarForView([
      record({
        crm: {
          stage: "offer",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
          reminders: [
            {
              id: "reminder_1",
              title: "Follow up",
              dueAt: "2026-08-16T10:00:00.000Z",
              createdAt: "2026-08-15T10:00:00.000Z",
              updatedAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          interviews: [
            {
              id: "interview_1",
              title: "Technical interview",
              startsAt: "2026-08-17T10:00:00.000Z",
              createdAt: "2026-08-15T10:00:00.000Z",
              updatedAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          compensation: {
            offerDeadlineAt: "2026-08-18T10:00:00.000Z",
            offerStatus: "active",
          },
        },
      }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "reminder",
      "interview",
      "offer_deadline",
    ]);
  });

  test("leaves out the deadline of an offer already settled", () => {
    const entries = buildApplicationCrmCalendarForView([
      record({
        crm: {
          stage: "offer",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
          compensation: {
            offerDeadlineAt: "2026-08-18T10:00:00.000Z",
            offerStatus: "accepted",
          },
        },
      }),
    ]);
    expect(entries).toEqual([]);
  });
});

describe("an application the person moved on in the tracker", () => {
  const NOW = Date.parse("2026-08-15T12:00:00.000Z");
  const tracked = (overrides: Record<string, unknown> = {}) =>
    record({
      crm: {
        stage: "interview",
        stageSource: "user",
        customStageId: "stage_panel",
        stageChangedAt: "2026-08-14T10:00:00.000Z",
        ...overrides,
      },
    });

  test("leads with the stage they named", () => {
    expect(
      trackedHiringStageBadge(tracked(), [
        {
          id: "stage_panel",
          label: "Panel interview",
          baseStage: "interview",
          color: "violet",
          position: 0,
          isTerminal: false,
        },
      ]),
    ).toEqual({ label: "Panel interview", tone: "positive" });
    expect(
      applicationCrmStageLabelForView(tracked(), [
        {
          id: "stage_panel",
          label: "Technical interview",
          baseStage: "interview",
          color: "violet",
          position: 0,
          isTerminal: false,
        },
      ]),
    ).toBe("Technical interview");
    expect(trackedHiringStageBadge(tracked({ customStageId: null }))).toEqual({
      label: APPLICATION_CRM_STAGE_LABELS.interview,
      tone: "positive",
    });
    expect(
      trackedHiringStageBadge(
        tracked({ stage: "preparing", customStageId: null }),
      ),
    ).toBeNull();
  });

  test("names an overdue follow-up before the next interview", () => {
    const reminders = [
      {
        id: "reminder_1",
        title: "Send a thank-you note",
        dueAt: "2026-08-14T09:00:00.000Z",
        createdAt: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-13T10:00:00.000Z",
      },
    ];
    const interviews = [
      {
        id: "interview_1",
        title: "Panel interview",
        startsAt: "2026-08-16T09:00:00.000Z",
        createdAt: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-13T10:00:00.000Z",
      },
    ];
    expect(nextTrackerStepLabel(tracked({ reminders, interviews }), NOW)).toBe(
      "Send a thank-you note (overdue)",
    );
    expect(nextTrackerStepLabel(tracked({ interviews }), NOW)).toMatch(
      /^Panel interview, /u,
    );
    expect(nextTrackerStepLabel(tracked(), NOW)).toBeNull();
  });
});

describe("terminal preparation activity", () => {
  test.each(["failed", "cancelled"] as const)(
    "keeps %s out of preparation and approval stages",
    (lastAttemptState) => {
      const stopped = record({
        status: "approved",
        lastAttemptState,
        crm: {
          stage: "ready_for_approval",
          stageSource: "activity",
          stageChangedAt: "2026-10-02T09:00:00.000Z",
        },
      });
      expect(applicationCrmDataForView(stopped).stage).toBe(lastAttemptState);
      const manual = record({
        ...stopped,
        crm: {
          stage: "interview",
          stageSource: "user",
          stageChangedAt: "2026-10-02T09:00:00.000Z",
        },
      });
      expect(applicationCrmDataForView(manual).stage).toBe("interview");
    },
  );
});

test("automatic stages follow filling, answers and prepared forms while keeping manual overrides", () => {
  for (const [state, expected] of [
    ["in_progress", "preparing"],
    ["paused", "needs_you"],
    ["ready", "ready_to_send"],
  ]) {
    const current = record({
      status: "approved",
      lastAttemptState: state,
      crm: {
        stage: "preparing",
        stageSource: "activity",
        stageChangedAt: "2026-08-15T10:00:00Z",
      },
    });
    expect(inferApplicationCrmStageForView(current)).toBe(expected);
    expect(
      inferApplicationCrmStageForView({
        ...current,
        crm: { ...current.crm!, stageSource: "user", stage: "reviewing" },
      }),
    ).toBe("reviewing");
  }
});

test("sorts the whole tracker by company or applied date before paging", () => {
  const entries = [
    record({
      id: "b",
      company: "Zeta",
      crm: {
        stage: "applied",
        stageChangedAt: "2026-08-01T10:00:00Z",
        appliedAt: "2026-08-02T10:00:00Z",
      },
    }),
    record({
      id: "a",
      company: "Acorn",
      crm: {
        stage: "applied",
        stageChangedAt: "2026-08-01T10:00:00Z",
        appliedAt: "2026-08-01T10:00:00Z",
      },
    }),
  ];
  expect(
    sortApplicationCrmRecords(entries, "company").map((entry) => entry.id),
  ).toEqual(["a", "b"]);
  expect(
    sortApplicationCrmRecords(entries, "applied_oldest").map(
      (entry) => entry.id,
    ),
  ).toEqual(["a", "b"]);
  expect(
    sortApplicationCrmRecords(entries, "applied_newest").map(
      (entry) => entry.id,
    ),
  ).toEqual(["b", "a"]);
});

test("uses the same state vocabulary as the preparation list", () => {
  expect(APPLICATION_CRM_STAGE_LABELS.failed).toBe("Could not apply");
  expect(APPLICATION_CRM_STAGE_LABELS.preparing).toBe("Preparing");
});
