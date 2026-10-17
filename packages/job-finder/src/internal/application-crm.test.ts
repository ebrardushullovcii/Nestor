import { ApplyJobResultSchema } from "@nestor/contracts";
import { OutcomeEventSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import { ApplicationRecordSchema } from "@nestor/contracts";
import type {
  ApplicationCrmAttachment,
  ApplicationCrmInterview,
  ApplicationCrmMutation,
  ApplicationCrmReminder,
  ApplicationRecord,
} from "@nestor/contracts";
import type { ApplicationRecordBatchCommitResult } from "@nestor/db";

import {
  ApplicationCrmBulkStageRevisionConflictError,
  ApplicationCrmBulkStageValidationError,
  ApplicationCrmRevisionConflictError,
  buildApplicationCrmCalendar,
  exportApplicationCrm,
  findApplicationCrmDuplicateHints,
  getApplicationCrmData,
  mutateApplicationCrm,
  mutateApplicationCrmBulkStage,
  projectApplicationCrmDashboard,
  recommendApplicationCrmAction,
  resolveApplicationRecordForJob,
  runApplicationNoResponseAutomation,
  withApplicationRecordTransition,
} from "./application-crm";

function record(overrides: Record<string, unknown> = {}) {
  return ApplicationRecordSchema.parse({
    id: "application_1",
    jobId: "job_1",
    title: "Software Engineer",
    company: "Example Inc",
    status: "submitted",
    lastActionLabel: "Prepared",
    nextActionLabel: null,
    lastUpdatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

function repository(initial = [record()]) {
  let records = [...initial];
  return {
    listApplicationRecords: () => Promise.resolve(records),
    upsertApplicationRecord: (next: (typeof records)[number]) => {
      records = records.some((current) => current.id === next.id)
        ? records.map((current) => (current.id === next.id ? next : current))
        : [...records, next];
      return Promise.resolve();
    },
    commitApplicationRecordBatch: ({
      expectedRevisions,
      records: next,
    }: {
      expectedRevisions: readonly {
        applicationRecordId: string;
        expectedRevision: number;
      }[];
      records: readonly ApplicationRecord[];
    }): Promise<ApplicationRecordBatchCommitResult> => {
      const currentById = new Map(
        records.map((current) => [current.id, current]),
      );
      const staleRecordIds = expectedRevisions
        .filter(
          ({ applicationRecordId, expectedRevision }) =>
            (currentById.get(applicationRecordId)?.crm?.revision ?? 0) !==
            expectedRevision,
        )
        .map(({ applicationRecordId }) => applicationRecordId);
      if (staleRecordIds.length > 0) {
        return Promise.resolve({
          status: "stale" as const,
          recordIds: staleRecordIds,
        });
      }
      const committedRecords = next.map((proposed) =>
        ApplicationRecordSchema.parse({
          ...currentById.get(proposed.id)!,
          crm: proposed.crm,
        }),
      );
      records = records.map(
        (current) =>
          committedRecords.find((candidate) => candidate.id === current.id) ??
          current,
      );
      return Promise.resolve({
        status: "applied" as const,
        committedRecords,
      });
    },
    read: () => records,
  };
}

function reminder(
  overrides: Partial<ApplicationCrmReminder> = {},
): ApplicationCrmReminder {
  return {
    id: "reminder_1",
    title: "Follow up",
    dueAt: "2026-08-20T09:00:00.000Z",
    status: "pending",
    note: null,
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function interview(
  overrides: Partial<ApplicationCrmInterview> = {},
): ApplicationCrmInterview {
  return {
    id: "interview_1",
    title: "Panel interview",
    startsAt: "2026-08-21T15:00:00.000Z",
    endsAt: null,
    timeZone: null,
    location: null,
    meetingUrl: null,
    contactIds: [],
    status: "scheduled",
    notes: null,
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

function attachment(
  overrides: Partial<ApplicationCrmAttachment> = {},
): ApplicationCrmAttachment {
  return {
    id: "attachment_1",
    candidateAssetId: "asset_1",
    label: "Resume v2",
    kind: "resume",
    addedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

let crmEventSequence = 0;

async function mutateCrm(
  repo: ReturnType<typeof repository>,
  expectedRevision: number,
  mutation: ApplicationCrmMutation,
  validateCandidateAsset?: (candidateAssetId: string) => Promise<{
    id: string;
    originalName: string;
    consentScope: string;
    deletedAt: string | null;
  } | null>,
) {
  return mutateApplicationCrm({
    repository: repo,
    command: {
      applicationRecordId: "application_1",
      expectedRevision,
      mutation,
    },
    now: () => "2026-08-15T12:00:00.000Z",
    createId: () => {
      crmEventSequence += 1;
      return `crm_event_${crmEventSequence}`;
    },
    ...(validateCandidateAsset ? { validateCandidateAsset } : {}),
  });
}

describe("application CRM service", () => {
  test("resolves exact application lineage without guessing among siblings", async () => {
    const job = {
      id: "job_shared",
      title: "Engineer",
      company: "Example",
      status: "shortlisted" as const,
    };
    const emptyRepository = repository([]);
    const created = await resolveApplicationRecordForJob({
      repository: emptyRepository,
      job,
      now: "2026-08-01T10:00:00.000Z",
    });
    expect(created.id).toBe("application_job_shared");
    expect(emptyRepository.read()).toEqual([created]);

    const selectedRepository = repository([
      record({ id: "application_a", jobId: job.id }),
      record({ id: "application_b", jobId: job.id }),
    ]);
    await expect(
      resolveApplicationRecordForJob({
        repository: selectedRepository,
        job,
      }),
    ).rejects.toThrow(/explicit application selection is required/iu);
    await expect(
      resolveApplicationRecordForJob({
        repository: selectedRepository,
        job,
        applicationRecordId: "application_b",
      }),
    ).resolves.toMatchObject({ id: "application_b", jobId: job.id });
    await expect(
      resolveApplicationRecordForJob({
        repository: selectedRepository,
        job: { ...job, id: "job_other" },
        applicationRecordId: "application_b",
      }),
    ).rejects.toThrow(/does not belong to job/iu);
  });

  test("maps legacy records into truthful CRM stages", () => {
    expect(getApplicationCrmData(record()).stage).toBe("applied");
    expect(
      getApplicationCrmData(
        record({ status: "ready_for_review", lastAttemptState: "paused" }),
      ).stage,
    ).toBe("needs_you");
  });

  test("saving tracking details preserves the stage of an application waiting on the person", async () => {
    const repo = repository([
      record({
        status: "ready_for_review",
        lastAttemptState: "paused",
        latestBlocker: {
          code: "missing_candidate_answer",
          summary: "Answer the required certification question.",
        },
      }),
    ]);

    const updated = await mutateCrm(repo, 0, {
      type: "set_tags",
      tags: ["Follow up"],
    });

    expect(updated.crm).toMatchObject({
      stage: "needs_you",
      tags: ["Follow up"],
    });
    expect(updated.lastAttemptState).toBe("paused");
    expect(updated.latestBlocker?.code).toBe("missing_candidate_answer");
    expect(getApplicationCrmData(repo.read()[0]!).stage).toBe("needs_you");
    expect(
      exportApplicationCrm({
        records: repo.read(),
        request: { format: "csv", applicationRecordIds: [] },
      }).content,
    ).toContain(",Needs you,");
  });

  test.each([
    "submitted",
    "interview",
    "offer",
    "rejected",
    "withdrawn",
  ] as const)(
    "tracking details preserve %s despite an older preparation blocker",
    async (status) => {
      const repo = repository([
        record({
          status,
          lastAttemptState: "paused",
          latestBlocker: {
            code: "requires_manual_review",
            summary: "Old preparation handoff.",
          },
        }),
      ]);
      const updated = await mutateCrm(repo, 0, {
        type: "set_tags",
        tags: ["Follow up"],
      });
      expect(updated.crm?.stage).toBe(
        status === "submitted" ? "applied" : status,
      );
    },
  );

  test("persists manual stage changes without granting submit authority", async () => {
    const repo = repository();
    const updated = await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 0,
        mutation: {
          type: "set_stage",
          stage: "recruiter_contact",
          customStageId: null,
          note: "Recruiter emailed me.",
        },
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });

    expect(updated.crm).toMatchObject({
      revision: 1,
      stage: "recruiter_contact",
      lastEmployerActivityAt: "2026-08-15T10:00:00.000Z",
    });
    expect(updated.status).toBe("submitted");
    expect(updated).not.toHaveProperty("submitAuthorized");
    expect(updated.lastAttemptState).toBeNull();
    expect(repo.read()[0]?.crm?.events[0]?.source).toBe("user");
  });

  test("records the assistant as the source of changes it made", async () => {
    const repo = repository();
    await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 0,
        actor: "assistant",
        mutation: {
          type: "set_stage",
          stage: "interview",
          customStageId: null,
          note: "First call on Monday.",
        },
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });
    expect(repo.read()[0]?.crm?.events[0]?.source).toBe("assistant");
  });

  test("tags and notes keep following later application progress", async () => {
    const repo = repository([
      record({ status: "ready_for_review", lastAttemptState: "paused" }),
    ]);
    const tagged = await mutateCrm(repo, 0, {
      type: "set_tags",
      tags: ["Priority"],
    });
    expect(tagged.crm).toMatchObject({
      stage: "needs_you",
      stageSource: "activity",
    });
    await repo.upsertApplicationRecord(
      record({
        ...tagged,
        status: "submitted",
        personSendReceipt: {
          observedAt: "2026-08-15T10:00:00.000Z",
          origin: "https://example.test",
          safePath: "/confirmation",
          summary: "The site confirmed receipt of the application.",
        },
        lastAttemptState: "submitted",
        latestBlocker: null,
      }),
    );
    expect(getApplicationCrmData(repo.read()[0]!).stage).toBe("applied");
    const noted = await mutateCrm(repo, 1, {
      type: "add_note",
      note: {
        id: "note_progress",
        body: "Waiting for a reply.",
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
      },
    });
    expect(noted.crm).toMatchObject({
      stage: "applied",
      stageSource: "activity",
    });
    const interviewing = record({ ...noted, status: "interview" });
    await repo.upsertApplicationRecord(interviewing);
    expect(getApplicationCrmData(interviewing).stage).toBe("interview");
    const removed = await mutateCrm(repo, 2, {
      type: "remove_note",
      noteId: "note_progress",
    });
    expect(removed.crm).toMatchObject({
      stage: "interview",
      stageSource: "activity",
    });
    expect(
      exportApplicationCrm({
        records: repo.read(),
        request: { format: "csv", applicationRecordIds: [] },
      }).content,
    ).toContain(",Interview,,Recorded by Nestor,");
  });

  test("explicitly choosing the inferred stage prevents future automatic stage changes", async () => {
    const repo = repository([record()]);
    const selected = await mutateCrm(repo, 0, {
      type: "set_stage",
      stage: "applied",
      customStageId: null,
      note: null,
    });
    expect(selected.crm).toMatchObject({
      stage: "applied",
      stageSource: "user",
      revision: 1,
    });
    expect(selected.crm?.events[0]).toMatchObject({
      kind: "stage_changed",
      fromStage: "applied",
      toStage: "applied",
      source: "user",
    });
    const interviewing = record({ ...selected, status: "interview" });
    expect(getApplicationCrmData(interviewing).stage).toBe("applied");
    await repo.upsertApplicationRecord(interviewing);
    const tagged = await mutateCrm(repo, 1, {
      type: "set_tags",
      tags: ["Keep stage"],
    });
    expect(getApplicationCrmData(tagged)).toMatchObject({
      stage: "applied",
      stageSource: "user",
    });
  });

  test("migrates complete metadata-only histories on write while keeping ambiguous legacy stages", async () => {
    const legacy = record({
      status: "interview",
      crm: {
        stage: "preparing",
        revision: 1,
        stageChangedAt: "2026-08-01T10:00:00.000Z",
        events: [
          {
            id: "tag_legacy",
            at: "2026-08-01T10:00:00.000Z",
            kind: "tags_changed",
            source: "user",
            title: "Tags saved",
          },
        ],
      },
    });
    const repo = repository([legacy]);
    expect(getApplicationCrmData(legacy)).toMatchObject({
      stage: "interview",
      stageSource: "activity",
    });
    const migrated = await mutateCrm(repo, 1, { type: "set_tags", tags: [] });
    expect(migrated.crm).toMatchObject({
      stage: "interview",
      stageSource: "activity",
    });
    expect(
      getApplicationCrmData(
        record({ ...legacy, crm: { ...legacy.crm, revision: 3 } }),
      ),
    ).toMatchObject({ stage: "preparing", stageSource: "user" });
  });

  test("commits a bulk stage change once and updates every selected record", async () => {
    const repo = repository([
      record(),
      record({
        id: "application_2",
        jobId: "job_2",
        title: "Backend Engineer",
      }),
    ]);
    let commitCalls = 0;
    const commit = repo.commitApplicationRecordBatch;
    repo.commitApplicationRecordBatch = async (input) => {
      commitCalls += 1;
      return commit(input);
    };

    const updated = await mutateApplicationCrmBulkStage({
      repository: repo,
      command: {
        items: [
          { applicationRecordId: "application_1", expectedRevision: 0 },
          { applicationRecordId: "application_2", expectedRevision: 0 },
        ],
        stage: "reviewing",
        customStageId: null,
        note: "Reviewed together.",
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: (() => {
        let index = 0;
        return () => `event_${++index}`;
      })(),
    });

    expect(commitCalls).toBe(1);
    expect(updated.map((entry) => entry.crm?.stage)).toEqual([
      "reviewing",
      "reviewing",
    ]);
    expect(repo.read().map((entry) => entry.crm?.revision)).toEqual([1, 1]);
  });

  test("bulk stage commit owns the CRM only and leaves top-level lifecycle fields untouched", async () => {
    const first = record({
      id: "application_1",
      lastActionLabel: "Applied",
      nextActionLabel: "Interview prep",
      lastUpdatedAt: "2026-08-01T10:00:00.000Z",
      crm: {
        revision: 2,
        stage: "applied",
        stageChangedAt: "2026-08-01T10:00:00.000Z",
        appliedAt: "2026-08-01T09:00:00.000Z",
      },
    });
    const second = record({
      id: "application_2",
      jobId: "job_2",
      title: "Backend Engineer",
      lastActionLabel: "Prepared",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-02T10:00:00.000Z",
      crm: {
        revision: 3,
        stage: "applied",
        stageChangedAt: "2026-08-02T10:00:00.000Z",
      },
    });
    const repo = repository([first, second]);

    const updated = await mutateApplicationCrmBulkStage({
      repository: repo,
      command: {
        items: [
          { applicationRecordId: "application_1", expectedRevision: 2 },
          { applicationRecordId: "application_2", expectedRevision: 3 },
        ],
        stage: "reviewing",
        customStageId: null,
        note: "Reviewed together.",
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: (() => {
        let index = 0;
        return () => `event_${++index}`;
      })(),
    });

    // Top-level lifecycle fields are owned by lifecycle transitions, not the
    // bulk CRM commit: they must survive the stage move byte-for-byte.
    expect(updated[0]).toMatchObject({
      status: "submitted",
      lastActionLabel: "Applied",
      nextActionLabel: "Interview prep",
      lastUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(updated[1]).toMatchObject({
      status: "submitted",
      lastActionLabel: "Prepared",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-02T10:00:00.000Z",
    });

    // The CRM payload is the bulk commit's owned surface: revision, stage,
    // and stage-change timestamp all move together.
    expect(updated[0]?.crm).toMatchObject({
      revision: 3,
      stage: "reviewing",
      customStageId: null,
      stageChangedAt: "2026-08-15T10:00:00.000Z",
    });
    expect(updated[1]?.crm).toMatchObject({
      revision: 4,
      stage: "reviewing",
      customStageId: null,
      stageChangedAt: "2026-08-15T10:00:00.000Z",
    });

    // The timeline event is the truthful stage-change evidence.
    expect(updated[0]?.crm?.events).toEqual([
      {
        id: "event_1",
        at: "2026-08-15T10:00:00.000Z",
        kind: "stage_changed",
        title: "Moved to reviewing",
        detail: "Reviewed together.",
        fromStage: "applied",
        toStage: "reviewing",
        source: "user",
      },
    ]);
    expect(updated[1]?.crm?.events).toEqual([
      {
        id: "event_2",
        at: "2026-08-15T10:00:00.000Z",
        kind: "stage_changed",
        title: "Moved to reviewing",
        detail: "Reviewed together.",
        fromStage: "applied",
        toStage: "reviewing",
        source: "user",
      },
    ]);
    expect(repo.read().map((entry) => entry.lastActionLabel)).toEqual([
      "Applied",
      "Prepared",
    ]);
    expect(repo.read().map((entry) => entry.lastUpdatedAt)).toEqual([
      "2026-08-01T10:00:00.000Z",
      "2026-08-02T10:00:00.000Z",
    ]);
  });

  test("returns transaction-merged bulk records without erasing concurrent application fields", async () => {
    const repo = repository();
    const commit = repo.commitApplicationRecordBatch;
    repo.commitApplicationRecordBatch = async (input) => {
      await repo.upsertApplicationRecord(
        record({
          lastActionLabel: "Application flow resumed",
          nextActionLabel: "Answer employer question",
          lastUpdatedAt: "2026-08-15T09:59:00.000Z",
        }),
      );
      return commit(input);
    };

    const updated = await mutateApplicationCrmBulkStage({
      repository: repo,
      command: {
        items: [{ applicationRecordId: "application_1", expectedRevision: 0 }],
        stage: "reviewing",
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });

    expect(updated[0]).toMatchObject({
      lastActionLabel: "Application flow resumed",
      nextActionLabel: "Answer employer question",
      lastUpdatedAt: "2026-08-15T09:59:00.000Z",
      crm: { revision: 1, stage: "reviewing" },
    });
    expect(updated).toEqual(repo.read());
  });

  test("validates unchanged selected rows at commit time", async () => {
    const repo = repository();
    const commit = repo.commitApplicationRecordBatch;
    repo.commitApplicationRecordBatch = async (input) => {
      await repo.upsertApplicationRecord(
        record({
          crm: {
            revision: 1,
            stage: "recruiter_contact",
            stageChangedAt: "2026-08-15T10:00:00.000Z",
          },
        }),
      );
      return commit(input);
    };

    await expect(
      mutateApplicationCrmBulkStage({
        repository: repo,
        command: {
          items: [
            { applicationRecordId: "application_1", expectedRevision: 0 },
          ],
          stage: "applied",
        },
      }),
    ).rejects.toMatchObject({
      name: "ApplicationCrmBulkStageRevisionConflictError",
      recordIds: ["application_1"],
    });
    expect(repo.read()[0]?.crm?.stage).toBe("recruiter_contact");
  });

  test("rejects missing and stale bulk records before any partial write", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 3,
          stage: "applied",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
        },
      }),
    ]);
    await expect(
      mutateApplicationCrmBulkStage({
        repository: repo,
        command: {
          items: [
            { applicationRecordId: "application_1", expectedRevision: 3 },
            { applicationRecordId: "missing", expectedRevision: 0 },
          ],
          stage: "reviewing",
        },
      }),
    ).rejects.toBeInstanceOf(ApplicationCrmBulkStageValidationError);
    expect(repo.read()[0]?.crm?.stage).toBe("applied");

    await expect(
      mutateApplicationCrmBulkStage({
        repository: repo,
        command: {
          items: [
            { applicationRecordId: "application_1", expectedRevision: 2 },
          ],
          stage: "reviewing",
        },
      }),
    ).rejects.toBeInstanceOf(ApplicationCrmBulkStageRevisionConflictError);
    expect(repo.read()[0]?.crm?.stage).toBe("applied");
  });

  test("manual applied tracking never invents browser submission evidence", async () => {
    const repo = repository([record({ status: "approved" })]);
    const updated = await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 0,
        mutation: {
          type: "set_stage",
          stage: "applied",
          customStageId: null,
          note: "I applied outside the app.",
        },
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });

    expect(updated.status).toBe("approved");
    expect(updated.lastAttemptState).toBeNull();
    expect(updated.crm?.stage).toBe("applied");
    expect(updated.crm?.appliedAt).toBe("2026-08-15T10:00:00.000Z");
    expect(updated).not.toHaveProperty("submittedAt");
    expect(updated).not.toHaveProperty("submitAuthorized");
  });

  test("rejects stale editors", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 2,
          stage: "reviewing",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
        },
      }),
    ]);
    await expect(
      mutateApplicationCrm({
        repository: repo,
        command: {
          applicationRecordId: "application_1",
          expectedRevision: 1,
          mutation: { type: "set_tags", tags: ["priority"] },
        },
      }),
    ).rejects.toBeInstanceOf(ApplicationCrmRevisionConflictError);
  });

  test("marks only old applied applications as no response and takes no external action", async () => {
    const repo = repository([
      record({
        crm: {
          stage: "applied",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          appliedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
      record({
        id: "application_2",
        jobId: "job_2",
        crm: {
          stage: "interview",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          appliedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
    ]);
    const updated = await runApplicationNoResponseAutomation({
      repository: repo,
      settings: {
        noResponseAutomation: { enabled: true, afterDays: 14 },
        customStages: [],
      },
      now: () => "2026-08-15T10:01:00.000Z",
      createId: () => "automation_event_1",
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.crm?.stage).toBe("no_response");
    expect(updated[0]?.status).toBe("submitted");
    expect(updated[0]?.crm?.events.at(-1)?.detail).toContain(
      "No external action was taken",
    );
    expect(repo.read()[1]?.crm?.stage).toBe("interview");
  });

  test("no-response automation preserves a non-submitted preparation status", async () => {
    const repo = repository([
      record({
        status: "approved",
        crm: {
          stage: "applied",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          appliedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
    ]);
    const [updated] = await runApplicationNoResponseAutomation({
      repository: repo,
      now: () => "2026-08-16T10:00:00.000Z",
    });
    expect(updated?.status).toBe("approved");
    expect(updated?.crm?.stage).toBe("no_response");
    expect(updated).not.toHaveProperty("submittedAt");
  });

  test("automatic no-response tracking follows a later interview without freezing metadata", async () => {
    const repo = repository([record()]);
    await mutateCrm(repo, 0, { type: "set_tags", tags: ["Follow up"] });
    const [followUp] = await runApplicationNoResponseAutomation({
      repository: repo,
      settings: {
        noResponseAutomation: { enabled: true, afterDays: 14 },
        customStages: [],
      },
      now: () => "2026-08-16T12:00:00.000Z",
    });
    expect(followUp?.crm).toMatchObject({
      stage: "no_response",
      stageSource: "activity",
    });
    expect(getApplicationCrmData(followUp!).stage).toBe("no_response");
    const interviewing = record({ ...followUp, status: "interview" });
    expect(getApplicationCrmData(interviewing)).toMatchObject({
      stage: "interview",
      stageSource: "activity",
      tags: ["Follow up"],
    });
  });

  test("projects calendar work, duplicate hints, and one recommended action", () => {
    const records = [
      record({
        crm: {
          stage: "applied",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          reminders: [
            {
              id: "reminder_1",
              title: "Follow up",
              dueAt: "2026-08-15T09:00:00.000Z",
              createdAt: "2026-08-01T10:00:00.000Z",
              updatedAt: "2026-08-01T10:00:00.000Z",
            },
          ],
          contacts: [
            {
              id: "contact_1",
              name: "Recruiter",
              email: "same@example.com",
              createdAt: "2026-08-01T10:00:00.000Z",
              updatedAt: "2026-08-01T10:00:00.000Z",
            },
          ],
        },
      }),
      record({
        id: "application_2",
        jobId: "job_2",
        company: "Example LLC",
        crm: {
          stage: "reviewing",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          contacts: [
            {
              id: "contact_2",
              name: "Recruiter",
              email: "same@example.com",
              createdAt: "2026-08-01T10:00:00.000Z",
              updatedAt: "2026-08-01T10:00:00.000Z",
            },
          ],
        },
      }),
    ];

    expect(buildApplicationCrmCalendar(records)).toHaveLength(1);
    expect(
      findApplicationCrmDuplicateHints(records).map((hint) => hint.kind),
    ).toEqual(["employer", "contact"]);
    expect(
      recommendApplicationCrmAction({
        records,
        now: "2026-08-15T10:00:00.000Z",
      })?.kind,
    ).toBe("overdue_reminder");
  });

  test("exports deterministic local JSON and escaped CSV", () => {
    const records = [record({ company: 'Example, "Labs"' })];
    const json = exportApplicationCrm({
      records,
      request: { format: "json", applicationRecordIds: [] },
      exportedAt: "2026-08-15T10:00:00.000Z",
    });
    const csv = exportApplicationCrm({
      records,
      request: { format: "csv", applicationRecordIds: [] },
      exportedAt: "2026-08-15T10:00:00.000Z",
    });

    const parsed = JSON.parse(json.content) as {
      applications: Array<{
        crm: {
          appliedAtProvenance: string | null;
          externalVerification: string;
          stageProvenance: string;
        };
      }>;
    };
    expect(parsed.applications).toHaveLength(1);
    expect(parsed.applications[0]?.crm).toMatchObject({
      appliedAtProvenance: null,
      externalVerification: "not_verified_with_employer_or_ats",
      stageProvenance: "local_historical_inference",
    });
    expect(csv.content).toContain('"Example, ""Labs"""');
    expect(csv.content).toContain(
      "Stage provenance,Tags,Applied at,Applied at provenance,External verification",
    );
    expect(csv.content).toContain(
      "Recorded by Nestor,,,,Not checked with the employer",
    );
    expect(csv.exportedCount).toBe(1);
  });

  test("exports inferred rows as local historical inference while persisted CRM rows stay user recorded", () => {
    const records = [
      record({
        id: "application_persisted",
        jobId: "job_persisted",
        crm: {
          stage: "applied",
          stageChangedAt: "2026-08-10T10:00:00.000Z",
          appliedAt: "2026-08-10T09:30:00.000Z",
        },
      }),
      record({ id: "application_inferred", jobId: "job_inferred" }),
      record({
        id: "application_inferred_unapplied",
        jobId: "job_inferred_unapplied",
        status: "shortlisted" as const,
      }),
    ];
    const request = { format: "json" as const, applicationRecordIds: [] };
    const parsed = JSON.parse(
      exportApplicationCrm({ records, request }).content,
    ) as {
      applications: Array<{
        id: string;
        crm: {
          stageProvenance: string;
          appliedAtProvenance: string | null;
          externalVerification: string;
        };
      }>;
    };
    const crmById = new Map(
      parsed.applications.map((application) => [
        application.id,
        application.crm,
      ]),
    );
    expect(crmById.get("application_persisted")).toMatchObject({
      stageProvenance: "user_recorded_local",
      appliedAtProvenance: "user_recorded_local",
      externalVerification: "not_verified_with_employer_or_ats",
    });
    expect(crmById.get("application_inferred")).toMatchObject({
      stageProvenance: "local_historical_inference",
      appliedAtProvenance: null,
      externalVerification: "not_verified_with_employer_or_ats",
    });
    expect(crmById.get("application_inferred_unapplied")).toMatchObject({
      stageProvenance: "local_historical_inference",
      appliedAtProvenance: null,
      externalVerification: "not_verified_with_employer_or_ats",
    });

    const csv = exportApplicationCrm({
      records,
      request: { format: "csv", applicationRecordIds: [] },
    });
    const [, ...lines] = csv.content.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    // One line break per row, the last row included.
    expect(csv.content.endsWith("\r\n")).toBe(true);
    expect(csv.content.match(/\r\n/gu)).toHaveLength(4);
    const csvRows = new Map(lines.map((line) => [line.split(",", 1)[0], line]));
    expect(csvRows.get("application_persisted")).toBe(
      "application_persisted,job_persisted,Software Engineer,Example Inc,Applied,,Recorded by you,,2026-08-10T09:30:00.000Z,Recorded by you,Not checked with the employer,,,2026-08-01T10:00:00.000Z,,,,,,none,,,",
    );
    expect(csvRows.get("application_inferred")).toBe(
      "application_inferred,job_inferred,Software Engineer,Example Inc,Needs you,,Recorded by Nestor,,,,Not checked with the employer,,,2026-08-01T10:00:00.000Z,,,,,,none,,,",
    );
    expect(csvRows.get("application_inferred_unapplied")).toBe(
      "application_inferred_unapplied,job_inferred_unapplied,Software Engineer,Example Inc,Shortlisted,,Recorded by Nestor,,,,Not checked with the employer,,,2026-08-01T10:00:00.000Z,,,,,,none,,,",
    );
  });

  test("builds truthful dashboard metrics only after enough applied records exist", () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      record({
        id: `application_${index}`,
        jobId: `job_${index}`,
        crm: {
          stage: index < 2 ? "interview" : "applied",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
          appliedAt: "2026-08-15T09:00:00.000Z",
        },
      }),
    );
    const projection = projectApplicationCrmDashboard({
      records,
      now: "2026-08-15T10:00:00.000Z",
    });
    expect(projection.trackingProvenance).toBe("user_recorded_local");
    expect(projection.appliedToday).toBe(5);
    expect(projection.appliedThisWeek).toBe(5);
    expect(projection.responseRate).toBe(40);
    expect(projection.interviewRate).toBe(40);
    expect(projection.rateDenominator).toBe(5);
    expect(
      projectApplicationCrmDashboard({ records: records.slice(0, 4) })
        .responseRate,
    ).toBeNull();
  });

  test("a no-op set_stage returns the existing record without upsert or revision bump", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 4,
          stage: "interview",
          stageChangedAt: "2026-08-10T10:00:00.000Z",
          appliedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
    ]);
    let upsertCalls = 0;
    const originalUpsert = repo.upsertApplicationRecord;
    repo.upsertApplicationRecord = async (next) => {
      upsertCalls += 1;
      await originalUpsert(next);
    };
    const existing = repo.read()[0];

    const updated = await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 4,
        mutation: {
          type: "set_stage",
          stage: "interview",
          customStageId: null,
          note: "No actual change.",
        },
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });

    expect(upsertCalls).toBe(0);
    expect(updated).toBe(existing);
    expect(updated.crm?.revision).toBe(4);
    expect(updated.crm?.stage).toBe("interview");
    expect(updated.crm?.events).toHaveLength(0);
    expect(updated.lastUpdatedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(updated.lastActionLabel).toBe("Prepared");
  });

  test("CSV export neutralizes spreadsheet formulas in title, company, and tags", () => {
    const csv = exportApplicationCrm({
      records: [
        record({
          title: '=HYPERLINK("http://evil.example")',
          company: "+Example Inc",
          crm: {
            stage: "applied",
            stageChangedAt: "2026-08-01T10:00:00.000Z",
            tags: ["@priority", "urgent"],
          },
        }),
        record({
          id: "application_2",
          jobId: "job_2",
          company: "-Example LLC",
          crm: {
            stage: "applied",
            stageChangedAt: "2026-08-01T10:00:00.000Z",
            tags: ["-followup"],
          },
        }),
      ],
      request: { format: "csv", applicationRecordIds: [] },
      exportedAt: "2026-08-15T10:00:00.000Z",
    });

    expect(csv.exportedCount).toBe(2);
    expect(csv.content).toContain("'=HYPERLINK(");
    expect(csv.content).toContain("'+Example Inc");
    expect(csv.content).toContain("'@priority; urgent");
    expect(csv.content).toContain("'-Example LLC");
    expect(csv.content).toContain("'-followup");
    const dataRow = csv.content.split("\r\n")[1] ?? "";
    expect(dataRow.startsWith('application_1,job_1,"')).toBe(true);
    expect(dataRow).toContain('"\'=HYPERLINK(""http://evil.example"")"');
  });

  test("set_tags dedup is case-insensitive and locale-independent", async () => {
    const repo = repository();
    const updated = await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 0,
        mutation: {
          type: "set_tags",
          tags: ["Priority", "PRIORITY", "priority", "  Priority  "],
        },
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_1",
    });

    // Dedup must use default Unicode case folding, never the runtime locale:
    // a Turkish-locale fold maps "PRIORITY" to "prıorıty" and would fail to
    // recognize it as a duplicate of "priority".
    expect("PRIORITY".toLowerCase()).toBe("priority");
    expect("PRIORITY".toLocaleLowerCase("tr")).not.toBe("priority");
    expect(updated.crm?.tags).toEqual(["Priority"]);
    expect(updated.crm?.events.at(-1)?.detail).toBe("Priority");
  });

  test("upsert_reminder adds then updates reminders with truthful event titles and persisted identity", async () => {
    const repo = repository();

    const created = await mutateCrm(repo, 0, {
      type: "upsert_reminder",
      reminder: reminder(),
    });

    expect(created.crm?.revision).toBe(1);
    expect(created.crm?.reminders).toHaveLength(1);
    expect(created.crm?.reminders[0]).toMatchObject({
      id: "reminder_1",
      title: "Follow up",
      dueAt: "2026-08-20T09:00:00.000Z",
      status: "pending",
      createdAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:00.000Z",
    });
    expect(created.crm?.events.at(-1)).toMatchObject({
      kind: "reminder_changed",
      title: "Added reminder Follow up",
      detail: "Due 2026-08-20T09:00:00.000Z",
      source: "user",
    });

    const completed = await mutateCrm(repo, 1, {
      type: "upsert_reminder",
      reminder: reminder({
        status: "completed",
        completedAt: "2026-08-16T09:00:00.000Z",
        updatedAt: "2026-08-16T09:00:00.000Z",
      }),
    });

    expect(completed.crm?.revision).toBe(2);
    expect(completed.crm?.reminders).toHaveLength(1);
    expect(completed.crm?.reminders[0]).toMatchObject({
      id: "reminder_1",
      status: "completed",
      completedAt: "2026-08-16T09:00:00.000Z",
      createdAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-16T09:00:00.000Z",
    });
    expect(completed.crm?.events.at(-1)).toMatchObject({
      kind: "reminder_changed",
      title: "Updated reminder Follow up",
    });
    expect(completed.lastUpdatedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(repo.read()[0]?.crm).toMatchObject({
      revision: 2,
      reminders: [
        {
          id: "reminder_1",
          status: "completed",
          createdAt: "2026-08-15T10:00:00.000Z",
        },
      ],
    });
  });

  test("upsert_interview validates contacts, then schedules and updates interviews with persisted status", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 1,
          stage: "recruiter_contact",
          stageChangedAt: "2026-08-10T10:00:00.000Z",
          contacts: [
            {
              id: "contact_1",
              name: "Recruiter Dana",
              email: "dana@example.com",
              createdAt: "2026-08-10T10:00:00.000Z",
              updatedAt: "2026-08-10T10:00:00.000Z",
            },
          ],
        },
      }),
    ]);

    await expect(
      mutateCrm(repo, 1, {
        type: "upsert_interview",
        interview: interview({ contactIds: ["contact_missing"] }),
      }),
    ).rejects.toThrow(/interview contact is no longer available/iu);
    expect(repo.read()[0]?.crm).toMatchObject({ revision: 1, interviews: [] });

    const scheduled = await mutateCrm(repo, 1, {
      type: "upsert_interview",
      interview: interview({ contactIds: ["contact_1"] }),
    });

    expect(scheduled.crm?.revision).toBe(2);
    expect(scheduled.crm?.interviews[0]).toMatchObject({
      id: "interview_1",
      title: "Panel interview",
      startsAt: "2026-08-21T15:00:00.000Z",
      status: "scheduled",
      contactIds: ["contact_1"],
    });
    expect(scheduled.crm?.events.at(-1)).toMatchObject({
      kind: "interview_changed",
      title: "Scheduled interview Panel interview",
      detail: "Starts 2026-08-21T15:00:00.000Z",
    });

    const completed = await mutateCrm(repo, 2, {
      type: "upsert_interview",
      interview: interview({ contactIds: ["contact_1"], status: "completed" }),
    });

    expect(completed.crm?.revision).toBe(3);
    expect(completed.crm?.interviews).toHaveLength(1);
    expect(completed.crm?.interviews[0]).toMatchObject({
      id: "interview_1",
      status: "completed",
      contactIds: ["contact_1"],
    });
    expect(completed.crm?.events.at(-1)).toMatchObject({
      kind: "interview_changed",
      title: "Updated interview Panel interview",
    });
    expect(repo.read()[0]?.crm?.interviews[0]).toMatchObject({
      status: "completed",
      contactIds: ["contact_1"],
    });
  });

  test("remove_reminder deletes only the targeted reminder and persists the removal", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 1,
          stage: "applied",
          stageChangedAt: "2026-08-10T10:00:00.000Z",
          appliedAt: "2026-08-10T09:30:00.000Z",
          reminders: [
            reminder(),
            reminder({
              id: "reminder_2",
              title: "Send thank you note",
              dueAt: "2026-08-22T09:00:00.000Z",
            }),
          ],
        },
      }),
    ]);

    const updated = await mutateCrm(repo, 1, {
      type: "remove_reminder",
      reminderId: "reminder_1",
    });

    expect(updated.crm?.revision).toBe(2);
    expect(updated.crm?.reminders.map((entry) => entry.id)).toEqual([
      "reminder_2",
    ]);
    expect(updated.crm?.events.at(-1)).toMatchObject({
      kind: "reminder_changed",
      title: "Removed a reminder",
      source: "user",
    });
    expect(repo.read()[0]?.crm?.reminders.map((entry) => entry.id)).toEqual([
      "reminder_2",
    ]);
  });

  test("remove_contact removes the contact and detaches it from every interview", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 2,
          stage: "interview",
          stageChangedAt: "2026-08-10T10:00:00.000Z",
          contacts: [
            {
              id: "contact_1",
              name: "Recruiter Dana",
              createdAt: "2026-08-10T10:00:00.000Z",
              updatedAt: "2026-08-10T10:00:00.000Z",
            },
            {
              id: "contact_2",
              name: "Engineer Lee",
              createdAt: "2026-08-10T10:00:00.000Z",
              updatedAt: "2026-08-10T10:00:00.000Z",
            },
          ],
          interviews: [interview({ contactIds: ["contact_2", "contact_1"] })],
        },
      }),
    ]);

    const updated = await mutateCrm(repo, 2, {
      type: "remove_contact",
      contactId: "contact_1",
    });

    expect(updated.crm?.revision).toBe(3);
    expect(updated.crm?.contacts.map((contact) => contact.id)).toEqual([
      "contact_2",
    ]);
    expect(updated.crm?.interviews).toHaveLength(1);
    expect(updated.crm?.interviews[0]).toMatchObject({
      id: "interview_1",
      contactIds: ["contact_2"],
    });
    expect(updated.crm?.events.at(-1)).toMatchObject({
      kind: "contact_changed",
      title: "Removed a contact",
    });
    expect(repo.read()[0]?.crm).toMatchObject({
      revision: 3,
      contacts: [{ id: "contact_2" }],
    });
    expect(repo.read()[0]?.crm?.interviews[0]?.contactIds).toEqual([
      "contact_2",
    ]);
  });

  test("add_attachment refuses missing resolvers, deleted assets, and assets outside the attachment consent scope without writing", async () => {
    const unresolvedRepo = repository();
    await expect(
      mutateCrm(unresolvedRepo, 0, {
        type: "add_attachment",
        attachment: attachment(),
      }),
    ).rejects.toThrow(/could not be verified/iu);

    const rejectingRepo = repository();
    const rejectsAddAttachment = (
      asset: {
        id: string;
        originalName: string;
        consentScope: string;
        deletedAt: string | null;
      } | null,
    ) =>
      expect(
        mutateCrm(
          rejectingRepo,
          0,
          { type: "add_attachment", attachment: attachment() },
          () => Promise.resolve(asset),
        ),
      ).rejects.toThrow(/unavailable or is not approved/iu);

    await rejectsAddAttachment(null);
    await rejectsAddAttachment({
      id: "asset_other",
      originalName: "resume-final.pdf",
      consentScope: "job_application_attachment",
      deletedAt: null,
    });
    await rejectsAddAttachment({
      id: "asset_1",
      originalName: "resume-final.pdf",
      consentScope: "job_application_attachment",
      deletedAt: "2026-08-14T00:00:00.000Z",
    });
    await rejectsAddAttachment({
      id: "asset_1",
      originalName: "resume-final.pdf",
      consentScope: "profile_only",
      deletedAt: null,
    });

    expect(unresolvedRepo.read()[0]?.crm).toBeNull();
    expect(rejectingRepo.read()[0]?.crm).toBeNull();
  });

  test("add_attachment links a verified candidate asset and remove_attachment unlinks it", async () => {
    const repo = repository();
    const resolvedCandidateAssetIds: string[] = [];

    const added = await mutateCrm(
      repo,
      0,
      { type: "add_attachment", attachment: attachment() },
      (candidateAssetId) => {
        resolvedCandidateAssetIds.push(candidateAssetId);
        return Promise.resolve({
          id: candidateAssetId,
          originalName: "resume-final.pdf",
          consentScope: "job_application_attachment",
          deletedAt: null,
        });
      },
    );

    expect(resolvedCandidateAssetIds).toEqual(["asset_1"]);
    expect(added.crm?.revision).toBe(1);
    expect(added.crm?.attachments).toEqual([
      {
        id: "attachment_1",
        candidateAssetId: "asset_1",
        label: "Resume v2",
        kind: "resume",
        addedAt: "2026-08-15T10:00:00.000Z",
      },
    ]);
    expect(added.crm?.events.at(-1)).toMatchObject({
      kind: "attachment_changed",
      title: "Linked Resume v2",
      detail: null,
      source: "user",
    });

    const removed = await mutateCrm(repo, 1, {
      type: "remove_attachment",
      attachmentId: "attachment_1",
    });

    expect(removed.crm?.revision).toBe(2);
    expect(removed.crm?.attachments).toEqual([]);
    expect(removed.crm?.events.at(-1)).toMatchObject({
      kind: "attachment_changed",
      title: "Unlinked an attachment",
    });
    expect(repo.read()[0]?.crm).toMatchObject({ revision: 2 });
    expect(repo.read()[0]?.crm?.attachments).toEqual([]);
  });

  test("serializes overlapping per-job record transitions and keeps other jobs live", async () => {
    const repo = repository();
    const activeJobIds = new Set<string>();
    const overlappedJobIds = new Set<string>();
    const order: string[] = [];

    const runOne = withApplicationRecordTransition(repo, "job_1", async () => {
      if (activeJobIds.has("job_1")) overlappedJobIds.add("job_1");
      activeJobIds.add("job_1");
      order.push("one:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("one:end");
      activeJobIds.delete("job_1");
    });
    const runTwo = withApplicationRecordTransition(repo, "job_2", () =>
      Promise.resolve(order.push("two:parallel")),
    );
    const runThree = withApplicationRecordTransition(repo, "job_1", () => {
      if (activeJobIds.has("job_1")) overlappedJobIds.add("job_1");
      activeJobIds.add("job_1");
      order.push("three:start");
      activeJobIds.delete("job_1");
      return Promise.resolve();
    });

    await Promise.all([runOne, runTwo, runThree]);

    expect(order).toEqual([
      "one:start",
      "two:parallel",
      "one:end",
      "three:start",
    ]);
    expect(overlappedJobIds).toEqual(new Set());
  });

  test("concurrent stage mutation and no-response automation keep CRM revisions continuous", async () => {
    const repo = repository([
      record({
        crm: {
          revision: 0,
          stage: "applied",
          stageChangedAt: "2026-08-01T10:00:00.000Z",
          appliedAt: "2026-07-01T10:00:00.000Z",
        },
      }),
    ]);
    let releaseHeldTransition!: () => void;
    const heldTransition = new Promise<void>((resolve) => {
      releaseHeldTransition = resolve;
    });

    const hold = withApplicationRecordTransition(
      repo,
      "job_1",
      () => heldTransition,
    );
    const automationPromise = runApplicationNoResponseAutomation({
      repository: repo,
      settings: {
        noResponseAutomation: { enabled: true, afterDays: 7 },
        customStages: [],
      },
      now: () => "2026-08-15T10:00:00.000Z",
      createId: () => "event_automation",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseHeldTransition();
    const [automation] = await Promise.all([automationPromise, hold]);

    expect(automation).toHaveLength(1);
    expect(repo.read()[0]?.crm).toMatchObject({
      revision: 1,
      stage: "no_response",
    });

    // A second automation pass re-reads fresh state and must not repeat or
    // double-bump the revision, and a later user mutation stays continuous.
    const repeat = await runApplicationNoResponseAutomation({
      repository: repo,
      settings: {
        noResponseAutomation: { enabled: true, afterDays: 7 },
        customStages: [],
      },
      now: () => "2026-08-15T11:00:00.000Z",
      createId: () => "event_repeat",
    });
    expect(repeat).toEqual([]);

    await mutateApplicationCrm({
      repository: repo,
      command: {
        applicationRecordId: "application_1",
        expectedRevision: 1,
        mutation: {
          type: "set_stage",
          stage: "recruiter_contact",
          customStageId: null,
          note: null,
        },
      },
      now: () => "2026-08-15T12:00:00.000Z",
      createId: () => "event_mutation",
    });

    expect(repo.read()[0]?.crm).toMatchObject({
      revision: 2,
      stage: "recruiter_contact",
    });
    expect(repo.read()[0]?.crm?.events.map((event) => event.id)).toEqual([
      "event_automation",
      "event_mutation",
    ]);
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
      expect(getApplicationCrmData(stopped).stage).toBe(lastAttemptState);
      const manual = record({
        ...stopped,
        crm: {
          stage: "interview",
          stageSource: "user",
          stageChangedAt: "2026-10-02T09:00:00.000Z",
        },
      });
      expect(getApplicationCrmData(manual).stage).toBe("interview");
    },
  );
});

describe("tracker bulk safety and current exports", () => {
  test("restores all 61 original stages and dates without overwriting other data", async () => {
    const initial = Array.from({ length: 61 }, (_, index) =>
      record({
        id: `bulk_${index}`,
        status: "submitted",
        crm: {
          stage: index % 2 ? "rejected" : "interview",
          stageSource: "user",
          stageChangedAt: "2026-08-01T10:00:00Z",
          appliedAt: "2026-07-01T10:00:00Z",
          tags: ["keep"],
        },
      }),
    );
    const repo = repository(initial);
    await mutateApplicationCrmBulkStage({
      repository: repo,
      command: {
        items: initial.map((entry) => ({
          applicationRecordId: entry.id,
          expectedRevision: 0,
        })),
        stage: "reviewing",
        customStageId: null,
        note: null,
      },
    });
    await mutateApplicationCrmBulkStage({
      repository: repo,
      command: {
        action: "undo",
        stage: "reviewing",
        customStageId: null,
        note: null,
        items: initial.map((entry) => ({
          applicationRecordId: entry.id,
          expectedRevision: 1,
          previousStage: { ...getApplicationCrmData(entry) },
        })),
      },
    });
    repo.read().forEach((entry, index) => {
      expect(entry.crm).toMatchObject({
        stage: initial[index]?.crm?.stage,
        stageSource: "user",
        appliedAt: "2026-07-01T10:00:00Z",
        stageChangedAt: "2026-08-01T10:00:00Z",
        tags: ["keep"],
        revision: 2,
      });
    });
  });

  test("archives and restores without changing stages or applied dates, and adds tags", async () => {
    const initial = record({
      crm: {
        stage: "rejected",
        stageSource: "user",
        stageChangedAt: "2026-08-01T10:00:00Z",
        appliedAt: "2026-07-01T10:00:00Z",
        tags: ["existing"],
      },
    });
    const repo = repository([initial]);
    for (const [revision, action] of ["tags", "archive", "restore"].entries()) {
      await mutateApplicationCrmBulkStage({
        repository: repo,
        command: {
          action: action as "tags" | "archive" | "restore",
          tags: ["new"],
          items: [
            { applicationRecordId: initial.id, expectedRevision: revision },
          ],
          stage: "reviewing",
          customStageId: null,
          note: null,
        },
      });
      expect(repo.read()[0]?.crm).toMatchObject({
        stage: "rejected",
        appliedAt: "2026-07-01T10:00:00Z",
        tags: ["existing", "new"],
      });
      expect(Boolean(repo.read()[0]?.crm?.archivedAt)).toBe(
        action === "archive",
      );
    }
  });

  test.each(["json", "csv"] as const)(
    "exports the current failed preparation to %s",
    (format) => {
      const current = record({
        status: "approved",
        lastAttemptState: "failed",
        lastUpdatedAt: "2026-10-04T09:00:00Z",
        crm: {
          stage: "preparing",
          stageSource: "activity",
          stageChangedAt: "2026-10-03T09:00:00Z",
        },
      });
      const exported = exportApplicationCrm({
        records: [current],
        request: { format, applicationRecordIds: [] },
      });
      expect(exported.content).toContain(
        format === "json" ? "failed" : "Could not apply",
      );
      expect(exported.content).toContain("2026-10-04T09:00:00Z");
    },
  );
});

test("exports offer, note and follow-up details and the exact recorded outcome", () => {
  const current = record({
    crm: {
      stage: "offer",
      stageSource: "user",
      stageChangedAt: "2026-08-15T10:00:00Z",
      compensation: {
        offerBase: { amount: 95000, currency: "EUR", period: "year" },
        offerDeadlineAt: "2026-08-20T10:00:00Z",
        offerStatus: "active",
      },
      notes: [
        {
          id: "note",
          body: "Synthetic offer discussion",
          createdAt: "2026-08-15T10:00:00Z",
          updatedAt: "2026-08-15T10:00:00Z",
        },
      ],
      reminders: [reminder()],
      interviews: [interview()],
    },
  });
  const outcome = OutcomeEventSchema.parse({
    id: "outcome",
    applicationRecordId: current.id,
    jobId: current.jobId,
    campaignId: "plan",
    source: "local",
    company: current.company,
    jobTitle: current.title,
    outcome: "interview",
    occurredAt: "2026-08-15T10:00:00Z",
    note: "Recruiter debrief synthetic unique note",
    userControlled: true,
  });
  const csv = exportApplicationCrm({
    records: [current],
    request: { format: "csv", applicationRecordIds: [] },
  }).content;
  expect(csv).toContain("95000,EUR");
  expect(csv).toContain("Synthetic offer discussion");
  expect(csv).toContain("Follow up");
  expect(csv).toContain("Panel interview");
  const json = JSON.parse(
    exportApplicationCrm({
      records: [current],
      request: { format: "json", applicationRecordIds: [] },
      outcomes: [outcome],
    }).content,
  ) as { applications: { outcomes: (typeof outcome)[] }[] };
  expect(json.applications[0]?.outcomes).toEqual([outcome]);
  expect(buildApplicationCrmCalendar([current])[0]?.title).toContain(
    "Software Engineer at Example Inc",
  );
  expect(
    buildApplicationCrmCalendar([
      {
        ...current,
        crm: { ...current.crm!, archivedAt: "2026-08-15T10:00:00Z" },
      },
    ]),
  ).toEqual([]);
});

test.each(["csv", "json"] as const)(
  "%s export projects a failed result on a record with blank attempt state",
  (format) => {
    const current = record({
      status: "ready_for_review",
      lastAttemptState: null,
    });
    const result = ApplyJobResultSchema.parse({
      id: "failed",
      runId: "run",
      jobId: current.jobId,
      applicationRecordId: current.id,
      state: "failed",
      summary: "Stopped",
      detail: "Interrupted",
      startedAt: current.lastUpdatedAt,
      updatedAt: current.lastUpdatedAt,
    });
    const exported = exportApplicationCrm({
      records: [current],
      results: [result],
      request: { format, applicationRecordIds: [] },
    });
    expect(exported.content).toContain(
      format === "csv" ? "Could not apply" : '"stage": "failed"',
    );
    expect(exported.content).not.toContain('"stage": "ready_for_approval"');
  },
);

test("CSV writes readable stage, reminder and interview text without their internal IDs", () => {
  const current = record({
    crm: {
      stage: "no_response",
      stageSource: "user",
      stageChangedAt: "2026-08-01T10:00:00Z",
      reminders: [
        {
          id: "private-reminder-id",
          title: "Follow up",
          dueAt: "2026-10-05T10:00:00Z",
          createdAt: "2026-08-01T10:00:00Z",
          updatedAt: "2026-08-01T10:00:00Z",
        },
      ],
      interviews: [
        {
          id: "private-interview-id",
          title: "Technical interview",
          startsAt: "2026-10-05T10:00:00Z",
          timeZone: "America/Denver",
          createdAt: "2026-08-01T10:00:00Z",
          updatedAt: "2026-08-01T10:00:00Z",
        },
      ],
    },
  });
  const exported = exportApplicationCrm({
    records: [current],
    request: { format: "csv", applicationRecordIds: [] },
  });
  expect(exported.content).toContain("No response");
  expect(exported.content).toContain(
    "Follow up · 2026-10-05T10:00:00Z · pending",
  );
  expect(exported.content).toContain(
    "Technical interview · 2026-10-05T10:00:00Z (America/Denver) · scheduled",
  );
  expect(exported.content).not.toContain("private-reminder-id");
  expect(exported.content).not.toContain("private-interview-id");
});
